import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHmac } from 'node:crypto';
import { RpcError, secureEqual } from './validation.mjs';

export function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(secret)) throw new RpcError(-32602, 'Invalid webhook signing secret');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) throw new RpcError(-32602, 'Invalid webhook signing secret');
  return key;
}
export function signature(secret, eventId, timestamp, body) {
  return `v1,${createHmac('sha256', signingKey(secret)).update(`${eventId}.${timestamp}.`).update(body).digest('base64')}`;
}
export function verifySignature(secret, headers, body, nowSeconds = Math.floor(Date.now() / 1000), tolerance = 300) {
  const timestamp = headers['webhook-timestamp'];
  if (typeof timestamp !== 'string' || !/^\d+$/u.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > tolerance) return false;
  const expected = signature(secret, headers['webhook-id'], timestamp, body);
  return String(headers['webhook-signature'] ?? '').split(' ').some(part => secureEqual(part, expected));
}
function ipv4Number(address) { return address.split('.').reduce((v, part) => (v * 256) + Number(part), 0) >>> 0; }
function ipv4In(address, base, bits) { const shift = 32 - bits; return (ipv4Number(address) >>> shift) === (ipv4Number(base) >>> shift); }
function ipv6Bytes(address) {
  if (address.includes('%')) return null;
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const split = value.lastIndexOf(':');
    const v4 = value.slice(split + 1);
    if (isIP(v4) !== 4) return null;
    const n = ipv4Number(v4);
    value = `${value.slice(0, split)}:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length > 1 && pieces[1] ? pieces[1].split(':') : [];
  const zeros = pieces.length === 2 ? 8 - left.length - right.length : 0;
  if (zeros < 0 || (pieces.length === 2 && zeros < 1)) return null;
  const words = [...left, ...Array(zeros).fill('0'), ...right];
  if (words.length !== 8 || words.some(w => !/^[a-f0-9]{1,4}$/u.test(w))) return null;
  return Buffer.from(words.flatMap(w => [parseInt(w, 16) >>> 8, parseInt(w, 16) & 255]));
}
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => ipv4In(address, base, bits));
  }
  if (isIP(address) !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes || (bytes[0] & 0xe0) !== 0x20) return false; // Unicast global 2000::/3 only.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4 embedded destinations.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && ((bytes[2] === 0 && bytes[3] < 0x20) || (bytes[2] === 0x0d && bytes[3] === 0xb8))) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return false; // Documentation 3fff::/20.
  return true;
}
export function callbackUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new RpcError(-32602, 'Invalid callback URL'); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || input.length > 2048 || /(?:^|\.)(?:localhost|local|internal|lan)$/iu.test(hostname)) throw new RpcError(-32602, 'Callback must be public HTTPS');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new RpcError(-32602, 'Callback must be public HTTPS');
  if (!isIP(hostname) && (!hostname.includes('.') || hostname.endsWith('.'))) throw new RpcError(-32602, 'Invalid callback hostname');
  return url;
}

export async function publicHttpsPost(input, body, headers, options = {}) {
  const url = callbackUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await (options.resolve ?? lookup)(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new RpcError(-32015, 'Callback address rejected', { reason: 'non_public_address' });
  const chosen = addresses[0];
  // DNS resolves on every connection, then this lookup pins the validated result.
  // TLS still verifies the original hostname. No redirects or pooled old sockets.
  const pinnedLookup = (_host, opts, cb) => opts?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family);
  return await new Promise((resolve, reject) => {
    const req = (options.request ?? https.request)(url, {
      method: 'POST', agent: false, lookup: pinnedLookup,
      autoSelectFamily: false, servername: isIP(hostname) ? undefined : hostname,
      timeout: options.timeoutMs ?? 10_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8192) { req.destroy(); reject(new RpcError(-32015, 'Callback response too large', { reason: 'response_too_large' })); } else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new RpcError(-32015, 'Callback connection failed', { reason: 'connection_failed' })));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => reject(new RpcError(-32015, 'Callback connection failed', { reason: error.message === 'timeout' ? 'timeout' : 'connection_failed' })));
    req.end(body);
  });
}

export async function signedPost(subscription, eventId, body, post, now = Date.now()) {
  if (Buffer.byteLength(body) > 262144) throw new RpcError(-32602, 'Event exceeds 256 KiB');
  const timestamp = String(Math.floor(now / 1000));
  const secrets = [subscription.secret];
  if (subscription.previousSecret && subscription.rotationUntil > now) secrets.push(subscription.previousSecret);
  return post(subscription.url, body, {
    'webhook-id': eventId, 'webhook-timestamp': timestamp,
    'webhook-signature': secrets.map(secret => signature(secret, eventId, timestamp, body)).join(' '),
    'X-MCP-Subscription-Id': subscription.id,
  });
}
