import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RpcError, id, safeFirmwareCode } from './validation.mjs';

export class PythonUsbAdapter {
  constructor({ python, device, allowCapture = false, workerFactory = spawn }) {
    id(device.id);
    if (!/^COM[1-9][0-9]*$/iu.test(device.port) || !['native_jtag', 'verified_ch340_uart0'].includes(device.profile) || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(device.expectedMac)) throw new Error('Explicit port, transport profile and board MAC are required');
    this.python = python; this.device = device; this.allowCapture = allowCapture; this.workerFactory = workerFactory;
    this.worker = null; this.pending = null; this.buffer = ''; this.counter = 0;
  }
  start() {
    if (this.worker) return;
    const script = fileURLToPath(new URL('../python/usb_adapter.py', import.meta.url));
    const args = ['-u', script, '--allow-open', '--port', this.device.port, '--profile', this.device.profile, '--expected-mac', this.device.expectedMac, '--device-id', this.device.id, '--max-age', String(this.device.maxCaptureAgeSeconds ?? 0.5), '--max-gap', String(this.device.maxFrameGapSeconds ?? 0.5)];
    if (this.allowCapture) args.push('--allow-capture');
    // State encryption and owner pairing secrets are never passed to the worker.
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONUTF8: '1' };
    const worker = this.workerFactory(this.python, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.worker = worker;
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (this.worker !== worker) return;
      this.buffer += chunk;
      if (this.buffer.length > 8192) return this.fail('adapter_reply_too_large', worker);
      while (this.buffer.includes('\n')) {
        const position = this.buffer.indexOf('\n');
        const line = this.buffer.slice(0, position);
        this.buffer = this.buffer.slice(position + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { this.fail('invalid_adapter_reply', worker); return; }
        const pending = this.pending;
        if (!pending || pending.worker !== worker || reply.id !== pending.id || typeof reply.ok !== 'boolean') { this.fail('adapter_reply_mismatch', worker); return; }
        this.pending = null;
        clearTimeout(pending.timer);
        if (reply.ok === true) pending.resolve(reply.result);
        else pending.reject(new RpcError(-32004, 'Device operation failed', { reason: /^[a-z_]{1,64}$/u.test(reply.reason ?? '') ? reply.reason : 'adapter_failed', ...(safeFirmwareCode(reply.firmware_code) ? { firmware_code: reply.firmware_code } : {}) }));
      }
    });
    worker.stderr.on('data', () => {}); // Device pixels/logs/tracebacks never enter MCP results.
    for (const stream of [worker.stdin, worker.stdout, worker.stderr]) stream.on('error', () => this.fail('worker_failed', worker));
    worker.on('error', () => this.fail('worker_failed', worker));
    worker.on('exit', () => this.fail('worker_exited', worker));
  }
  fail(reason, expectedWorker = this.worker) {
    // kill() and stream callbacks can arrive after a replacement has started.
    if (this.worker !== expectedWorker) return;
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new RpcError(-32004, 'Device adapter unavailable', { reason })); }
    const worker = this.worker;
    this.worker = null;
    this.buffer = '';
    if (worker && worker.exitCode === null) worker.kill();
  }
  failRequest(reason, worker, requestId) {
    if (this.worker === worker && this.pending?.id === requestId) this.fail(reason, worker);
  }
  async execute(deviceId, request) {
    if (deviceId !== this.device.id) throw new RpcError(-32003, 'Device access denied');
    if (request.operation === 'capture_once' && !this.allowCapture) throw new RpcError(-32003, 'Capture is disabled');
    if (this.pending) throw new RpcError(-32004, 'Serial adapter is busy', { reason: 'serial_busy' });
    this.start();
    return await new Promise((resolve, reject) => {
      const requestId = ++this.counter;
      const worker = this.worker;
      const timer = setTimeout(() => this.failRequest('adapter_timeout', worker, requestId), 14_000);
      this.pending = { id: requestId, worker, resolve, reject, timer };
      try {
        worker.stdin.write(`${JSON.stringify({ id: requestId, request })}\n`, error => { if (error) this.failRequest('worker_failed', worker, requestId); });
      } catch { this.failRequest('worker_failed', worker, requestId); }
    });
  }
  close() { this.fail('adapter_closed'); }
}
