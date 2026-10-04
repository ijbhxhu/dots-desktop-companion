import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PythonUsbAdapter } from '../src/device.mjs';

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.requests = [];
    this.callbacks = [];
    this.stdin.write = (line, callback) => { this.requests.push(JSON.parse(line)); this.callbacks.push(callback); };
    this.exitCode = null;
    this.killed = false;
  }
  kill() { this.killed = true; }
  reply(result = { verified: true }, index = this.requests.length - 1) {
    this.stdout.emit('data', `${JSON.stringify({ id: this.requests[index].id, ok: true, result })}\n`);
  }
}

function fixture() {
  const workers = [];
  const adapter = new PythonUsbAdapter({
    python: 'unused-python',
    device: { id: 'esp32-test', port: 'COM4', profile: 'verified_ch340_uart0', expectedMac: 'aa:bb:cc:dd:ee:ff' },
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
  });
  const request = () => adapter.execute('esp32-test', { operation: 'status' }).then(value => ({ value }), error => ({ error }));
  return { adapter, workers, request };
}

test('late exit/error from a replaced worker cannot reject or kill its successor', async () => {
  const f = fixture();
  const first = f.request();
  const old = f.workers[0];
  f.adapter.fail('adapter_timeout');
  assert.equal((await first).error.data.reason, 'adapter_timeout');
  const next = f.request();
  const current = f.workers[1];
  try {
    old.emit('exit', 1);
    old.emit('error', new Error('private-error-never-log'));
    assert.equal(f.adapter.worker, current);
    assert.equal(current.killed, false);
    current.reply();
    assert.deepEqual((await next).value, { verified: true });
  } finally { f.adapter.close(); await next; }
});

test('stale stdout and write callback cannot corrupt the replacement reply', async () => {
  const f = fixture();
  const first = f.request();
  const old = f.workers[0];
  f.adapter.fail('adapter_timeout');
  await first;
  const next = f.request();
  const current = f.workers[1];
  try {
    old.stdout.emit('data', 'x'.repeat(9000));
    old.callbacks[0](new Error('private-error-never-log'));
    assert.equal(f.adapter.worker, current);
    assert.equal(f.adapter.buffer, '');
    current.reply({ current: true });
    assert.deepEqual((await next).value, { current: true });
  } finally { f.adapter.close(); await next; }
});

test('a completed request write callback cannot fail a later request on the same worker', async () => {
  const f = fixture();
  const first = f.request();
  const worker = f.workers[0];
  worker.reply();
  await first;
  const next = f.request();
  try {
    worker.callbacks[0](new Error('late-private-error'));
    assert.equal(f.adapter.worker, worker);
    worker.reply({ later: true });
    assert.deepEqual((await next).value, { later: true });
  } finally { f.adapter.close(); await next; }
});

test('current worker failure rejects safely and allows a subsequent worker', async () => {
  const f = fixture();
  const first = f.request();
  f.workers[0].emit('exit', 1);
  assert.equal((await first).error.data.reason, 'worker_exited');
  assert.equal(f.adapter.worker, null);
  const next = f.request();
  f.workers[1].reply();
  assert.deepEqual((await next).value, { verified: true });
  f.adapter.close();
});
