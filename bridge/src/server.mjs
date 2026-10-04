import http from 'node:http';
import { isObject, RpcError } from './validation.mjs';

function send(res, status, body, headers = {}) {
  const bytes = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(bytes), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(bytes);
}
async function readBody(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) { const error = new Error('Request too large'); error.httpStatus = 413; throw error; } chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export function createHttpServer({ bridge, oauth, publicBaseUrl, localHosts = [] }) {
  const publicOrigin = new URL(publicBaseUrl).origin;
  const allowedHosts = new Set([new URL(publicOrigin).host, ...localHosts]);
  const buckets = new Map();
  const server = http.createServer(async (req, res) => {
    let rpcId = null;
    let onMcp = false;
    try {
      const socketHost = `127.0.0.1:${req.socket.localPort}`;
      if (!allowedHosts.has(String(req.headers.host ?? '')) && req.headers.host !== socketHost) return send(res, 421, { error: 'Unrecognized host' });
      if (req.headers.origin && req.headers.origin !== publicOrigin && !localHosts.some(host => req.headers.origin === `http://${host}`)) return send(res, 403, { error: 'Origin rejected' });
      const url = new URL(req.url, publicOrigin);
      // Only the origin server's socket identity is trusted; never X-Forwarded-*.
      const bucketKey = `${req.socket.remoteAddress}:${url.pathname}`;
      const now = Date.now();
      const current = buckets.get(bucketKey);
      const bucket = current && current.expires > now ? current : { count: 0, expires: now + 60_000 };
      if (++bucket.count > (url.pathname === '/mcp' ? 240 : 60)) return send(res, 429, { error: 'Rate limited' }, { 'Retry-After': '60' });
      buckets.set(bucketKey, bucket);
      for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, hardware_adapter: bridge.adapter.constructor.name, dot_connected: false });
      if (oauth.privateTunnel && (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/oauth/'))) return send(res, 404, { error: 'Not found' });
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return send(res, 200, oauth.resourceMetadata());
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return send(res, 200, oauth.metadata());
      if (req.method === 'POST' && url.pathname === '/oauth/register') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'application/json required' });
        let input;
        try { input = JSON.parse(await readBody(req, 8192)); } catch (error) { if (error.httpStatus) throw error; return send(res, 400, { error: 'invalid_client_metadata' }); }
        return send(res, 201, oauth.register(input));
      }
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        return send(res, 200, oauth.authorizePage(url.searchParams), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      }
      if (req.method === 'POST' && ['/oauth/authorize', '/oauth/token'].includes(url.pathname)) {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return send(res, 415, { error: 'Form encoding required' });
        const params = new URLSearchParams(await readBody(req, 8192));
        if (url.pathname === '/oauth/authorize') return send(res, 303, '', { Location: oauth.consent(params, req.headers.origin) });
        return send(res, 200, oauth.exchange(params), { Pragma: 'no-cache' });
      }
      if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found' });
      onMcp = true;
      if (req.method !== 'POST') return send(res, 405, { error: 'Stateless MCP endpoint supports POST' }, { Allow: 'POST' });
      const principal = oauth.authenticate(req.headers.authorization);
      if (!principal) return send(res, 401, { error: 'Authentication required' }, { 'WWW-Authenticate': oauth.privateTunnel ? 'Bearer realm="esp32-white-mcp-local"' : `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource", scope="device:read screen:write events:subscribe"` });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'application/json required' });
      const version = req.headers['mcp-protocol-version'];
      if (version && !['2026-07-28', '2025-06-18'].includes(version)) return send(res, 400, { error: 'Unsupported MCP protocol version' });
      let input;
      try { input = JSON.parse(await readBody(req)); } catch (error) { if (error.httpStatus) throw error; throw new RpcError(-32700, 'Parse error'); }
      if (!isObject(input) || input.jsonrpc !== '2.0' || typeof input.method !== 'string' || !input.method || input.method.length > 128 || Object.keys(input).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) || (input.id !== undefined && !['string', 'number'].includes(typeof input.id))) throw new RpcError(-32600, 'Invalid request');
      rpcId = input.id ?? null;
      if ((typeof rpcId === 'string' && rpcId.length > 128) || (typeof rpcId === 'number' && !Number.isSafeInteger(rpcId))) throw new RpcError(-32600, 'Invalid request');
      if (req.headers['mcp-method'] && req.headers['mcp-method'] !== input.method) throw new RpcError(-32600, 'MCP method header mismatch');
      if (req.headers['mcp-name'] && req.headers['mcp-name'] !== input.params?.name) throw new RpcError(-32600, 'MCP name header mismatch');
      if (input.id === undefined && input.method !== 'notifications/initialized') throw new RpcError(-32600, 'Request ID required');
      if (input.params !== undefined && !isObject(input.params)) throw new RpcError(-32602, 'Invalid parameters');
      const value = await bridge.rpc(principal, input.method, input.params ?? {});
      if (input.id === undefined) { res.writeHead(202); return res.end(); }
      return send(res, 200, { jsonrpc: '2.0', id: rpcId, result: value }, { 'MCP-Protocol-Version': version ?? (input.method === 'initialize' ? '2025-06-18' : '2026-07-28') });
    } catch (error) {
      if (res.headersSent) return res.end();
      if (onMcp && error instanceof RpcError) return send(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } });
      if (error.oauthCode) return send(res, error.httpStatus ?? 400, { error: error.oauthCode });
      // Do not emit stack traces, raw device output, secrets or request bodies.
      return send(res, error.httpStatus ?? 500, { error: error.httpStatus === 413 ? 'Request too large' : 'Request failed' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 32;
  return server;
}
