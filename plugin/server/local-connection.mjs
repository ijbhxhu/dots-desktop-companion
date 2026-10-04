// Connect this machine's plugin client to the existing loopback MCP runtime.
// No camera/serial/flash operations are performed by this transport adapter.
import { createInterface } from 'node:readline';
import { readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
const stateDir = process.env.ESP32_BRIDGE_STATE_DIR;
if (!stateDir || !/^[A-Za-z]:[\\/]/u.test(stateDir)) throw new Error('Explicit local bridge state directory required');
const capPath = join(resolve(stateDir), 'local-capabilities.json');
if (lstatSync(stateDir).isSymbolicLink() || lstatSync(capPath).isSymbolicLink()) throw new Error('Indirect credential path refused');
const localBearer = JSON.parse(readFileSync(capPath, 'utf8')).localBearer;
if (typeof localBearer !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(localBearer)) throw new Error('Local bridge capability unavailable');
const methods = new Set(['initialize','notifications/initialized','ping','server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    if (Buffer.byteLength(line) > 65536) throw new Error('Request limit exceeded');
    request = JSON.parse(line);
    if (request?.jsonrpc !== '2.0' || !methods.has(request.method)) throw new Error('Unsupported request');
    const response = await fetch('http://127.0.0.1:8787/mcp', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localBearer}` },
      body: JSON.stringify(request)
    });
    if (!response.ok && response.status !== 204) throw new Error('Local bridge request rejected');
    if (request.id !== undefined && response.status !== 204) {
      const body = await response.text();
      if (Buffer.byteLength(body) > 1048576) throw new Error('Response limit exceeded');
      const result = JSON.parse(body);
      if (result.jsonrpc !== '2.0' || result.id !== request.id) throw new Error('Response identity mismatch');
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'ESP32 local MCP connection unavailable'}})+'\n');
    else process.stderr.write('Local MCP request was not completed\n');
  }
}
