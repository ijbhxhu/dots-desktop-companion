// Local launcher: credentials remain in memory; child logs redact capabilities.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const runtimeConfig = JSON.parse(readFileSync(join(root, 'runtime.local.json'), 'utf8'));
if (!/^tunnel_[a-f0-9]+$/u.test(runtimeConfig.tunnelId ?? '') || typeof runtimeConfig.tunnelExecutable !== 'string') throw new Error('Configure runtime.local.json with your existing Tunnel ID and executable');
const stateDir = join(root, '.state');
mkdirSync(stateDir, { recursive: true });
for (const path of [root, stateDir, join(root, '.env.local')]) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Credential path is not a regular local destination');
}
const keyLine = readFileSync(join(root, '.env.local'), 'utf8').trim();
const match = /^CONTROL_PLANE_API_KEY=(sk-[A-Za-z0-9_-]{32,512})$/u.exec(keyLine);
if (!match) throw new Error('Local runtime credential unavailable');
const runtimeKey = match[1];
const capsPath = join(stateDir, 'local-capabilities.json');
const caps = existsSync(capsPath) ? JSON.parse(readFileSync(capsPath, 'utf8'))
  : { stateKey: randomBytes(32).toString('base64'), localBearer: randomBytes(32).toString('base64url') };
if (!existsSync(capsPath)) writeFileSync(capsPath, JSON.stringify(caps), { flag: 'wx', mode: 0o600 });
const deadlinePath = join(stateDir, 'session-limit.json');
const expiresAt = existsSync(deadlinePath) ? JSON.parse(readFileSync(deadlinePath, 'utf8')).stopsAt
  : new Date(Date.now() + 86400_000).toISOString();
const remainingMs = Date.parse(expiresAt) - Date.now();
if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 86400_000) throw new Error('The authorized runtime session has expired');
if (!existsSync(deadlinePath)) writeFileSync(deadlinePath, JSON.stringify({stopsAt: expiresAt}), {flag:'wx'});
const logPath = join(stateDir, 'session-redacted.log');
const redact = text => String(text).replaceAll(runtimeKey, '[REDACTED_API_KEY]')
  .replaceAll(caps.localBearer, '[REDACTED_LOCAL_CAPABILITY]')
  .replace(/sk-[A-Za-z0-9_-]{32,512}/gu, '[REDACTED_API_KEY]');
const pendingLogLines = new Map();
const record = (name, data) => {
  const text = (pendingLogLines.get(name) ?? '') + String(data);
  const lines = text.split('\n');
  pendingLogLines.set(name, lines.pop());
  for (const line of lines) appendFileSync(logPath, `${name}: ${redact(line)}\n`);
};
const bridgeEnv = { ...process.env, DOT_STATE_KEY: caps.stateKey, DOT_TUNNEL_LOCAL_BEARER: caps.localBearer };
delete bridgeEnv.CONTROL_PLANE_API_KEY; delete bridgeEnv.OPENAI_API_KEY;
const bridgeArgs = ['src/cli.mjs', '--config', 'config.local.json', '--enable-serial'];
if (process.argv.includes('--capture-watch')) bridgeArgs.push('--capture-watch');
const bridge = spawn(process.execPath, bridgeArgs, { cwd: root, env: bridgeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
bridge.stdout.on('data', data => record('bridge', data));
bridge.stderr.on('data', data => record('bridge-error', data));
bridge.on('error', () => console.error('Bridge process could not start'));
let tunnel;
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; tunnel?.kill(); bridge.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('exit', stop);
const expiryTimer = setTimeout(() => { console.log('24-hour runtime session limit reached'); stop(); }, remainingMs);
const auth = `Bearer ${caps.localBearer}`;
let discover;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8787/mcp', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }) });
    if (!response.ok) throw new Error('Bridge discovery was rejected');
    discover = await response.json(); break;
  } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
}
if (!discover?.result) { stop(); clearTimeout(expiryTimer); throw new Error('Local bridge did not become ready'); }
const executable = runtimeConfig.tunnelExecutable;
const healthPath = join(stateDir, 'tunnel-health.url');
const tunnelArgs = ['run', '--control-plane.tunnel-id', runtimeConfig.tunnelId,
  '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp.server-url', 'http://127.0.0.1:8787/mcp',
  '--mcp.extra-headers', 'Authorization: env:DOT_TUNNEL_LOCAL_AUTHORIZATION',
  '--mcp.discovery-extra-headers', 'Authorization: env:DOT_TUNNEL_LOCAL_AUTHORIZATION',
  '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthPath, '--log.level', 'info', '--log.format', 'json'];
tunnel = spawn(executable, tunnelArgs, { cwd: root, windowsHide: true, env: { ...process.env, CONTROL_PLANE_API_KEY: runtimeKey, DOT_TUNNEL_LOCAL_AUTHORIZATION: auth }, stdio: ['ignore', 'pipe', 'pipe'] });
tunnel.stdout.on('data', data => record('tunnel', data));
tunnel.stderr.on('data', data => record('tunnel-error', data));
tunnel.on('error', () => { console.error('Tunnel process could not start'); stop(); clearTimeout(expiryTimer); });
tunnel.on('exit', (code) => { console.log(JSON.stringify({ tunnel_process_exited: true, code })); stop(); clearTimeout(expiryTimer); });
const evidence = { local_mcp_ready: true, discover: discover.result, bridge_pid: bridge.pid, tunnel_pid: tunnel.pid,
  tunnel_id: runtimeConfig.tunnelId, capture_watch: process.argv.includes('--capture-watch'),
  session_stops_at: expiresAt, key_expiry_verified: false, dot_connection_verified: false };
writeFileSync(join(root, 'runtime-start-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
