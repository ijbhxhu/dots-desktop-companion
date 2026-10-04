import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { OAuth } from '../src/oauth.mjs';
import { Bridge, UnavailableAdapter } from '../src/bridge.mjs';
import { createHttpServer } from '../src/server.mjs';
import { callbackUrl, isPublicAddress, signingKey, signature, verifySignature, publicHttpsPost } from '../src/webhook.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import { PrivateTunnelAuth } from '../src/private-auth.mjs';
import { RpcError, safeErrorDetails } from '../src/validation.mjs';

const DEVICE = 'esp32-demo';
const BASE = 'https://bridge.example';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const pairing = randomBytes(32).toString('base64url');
const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
function fixture(options = {}) {
  let current = 1_800_000_000_000;
  let enabled = true;
  const store = options.store ?? new StateStore(null, randomBytes(32));
  const now = () => current;
  const oauth = new OAuth({ store, publicBaseUrl: BASE, pairingCode: pairing, devices: [DEVICE], redirectUris: [REDIRECT], now, ownerEnabled: () => enabled });
  const deliveries = [];
  const post = options.post ?? (async (url, body, headers) => {
    const value = JSON.parse(body);
    deliveries.push({ url, value, body, headers });
    return { status: 200, body: JSON.stringify(value.type === 'verification' ? { challenge: value.challenge } : {}) };
  });
  const bridge = new Bridge({ store, oauth, post, now, adapter: options.adapter ?? new UnavailableAdapter() });
  return { store, oauth, bridge, deliveries, principal: oauth.principalForOwner('owner'), now, advance: delta => { current += delta; }, revoke: () => { enabled = false; } };
}
const subscribe = (s = secret(), device = DEVICE) => ({ name: 'camera.white_detected', arguments: { device_id: device }, delivery: { mode: 'webhook', url: 'https://callback.example/events', secret: s }, cursor: null });
const unsubscribe = subscription => ({ name: subscription.name, arguments: subscription.arguments, delivery: { mode: 'webhook', url: subscription.delivery.url } });
const evidence = (f, sequence = '7') => ({ device_id: DEVICE, source_epoch: '0102030405060708', frame_sequence: sequence, captured_at: new Date(f.now()).toISOString(), white_fraction: 0.96, held_seconds: 1.2, samples: 4, sensor_pid: 0x2642, simulation: false });
const sceneEvidence = (f, sequence = '7') => ({ device_id: DEVICE, source_epoch: '0102030405060708', frame_sequence: sequence, captured_at: new Date(f.now()).toISOString(), changed_fraction: 0.5, mean_delta: 0.20, held_seconds: 1.5, samples: 2, sensor_pid: 0x3660, simulation: false });
function oauthParams(oauth, client, verifier = randomBytes(32).toString('base64url')) {
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, resource: oauth.resource, scope: 'device:read screen:write events:subscribe', state: 'state-unique', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  return { params, verifier };
}
function pair(f) {
  const client = f.oauth.register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const { params, verifier } = oauthParams(f.oauth, client);
  const page = f.oauth.authorizePage(params);
  const ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/u.exec(page)[1];
  const location = f.oauth.consent(new URLSearchParams({ ticket, decision: 'allow', pairing_code: pairing }), BASE);
  const code = new URL(location).searchParams.get('code');
  const exchange = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, resource: f.oauth.resource, code_verifier: verifier });
  return { client, verifier, exchange, tokens: f.oauth.exchange(exchange) };
}

test('MCP discover advertises exact events version; tools and events require ownership', async () => {
  const f = fixture();
  const discovery = await f.bridge.rpc(f.principal, 'server/discover');
  assert.deepEqual(discovery.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discovery.capabilities, { tools: {}, events: {} });
  assert.ok((await f.bridge.rpc(f.principal, 'tools/list')).tools.every(tool => tool.securitySchemes[0].type === 'oauth2'));
  assert.equal((await f.bridge.rpc(f.principal, 'events/list')).events[0].name, 'camera.white_detected');
  await assert.rejects(f.bridge.subscribe(f.principal, subscribe(secret(), 'another-device')), { code: -32003 });
  await assert.rejects(f.bridge.rpc(null, 'tools/list'), { code: -32003 });
});

test('Standard Webhooks signature uses exact body bytes and detects tampering/expiry', () => {
  const key = Buffer.alloc(32, 0x61);
  const value = `whsec_${key.toString('base64')}`;
  const body = '{"eventId":"evt_123","data":{"n":1}}';
  const timestamp = '1800000000';
  const expected = `v1,${createHmac('sha256', key).update(`evt_123.${timestamp}.${body}`).digest('base64')}`;
  assert.equal(signature(value, 'evt_123', timestamp, body), expected);
  const headers = { 'webhook-id': 'evt_123', 'webhook-timestamp': timestamp, 'webhook-signature': expected };
  assert.equal(verifySignature(value, headers, body, Number(timestamp)), true);
  assert.equal(verifySignature(value, headers, `${body} `, Number(timestamp)), false);
  assert.equal(verifySignature(value, headers, body, Number(timestamp) + 301), false);
  for (const invalid of ['token', 'whsec_YQ==', `whsec_${randomBytes(65).toString('base64')}`, 'whsec_!!!!']) assert.throws(() => signingKey(invalid));
});

test('callback validation rejects private, mapped, reserved, local and unsafe URLs', () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '172.31.1.2', '192.168.1.1', '100.64.0.2', '169.254.169.254', '0.0.0.0', '224.0.0.1', '198.18.0.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://callback.example/', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:pass@callback.example/', 'https://localhost/', 'https://metadata.local/', 'https://callback.example:8443/', 'https://callback.example/#frag']) assert.throws(() => callbackUrl(url));
});

test('callback DNS is revalidated on connection and pinned with original TLS hostname', async () => {
  let requests = 0;
  await assert.rejects(publicHttpsPost('https://callback.example/events', '{}', {}, { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { requests++; } }), { code: -32015 });
  assert.equal(requests, 0);
  let optionsSeen;
  const response = await publicHttpsPost('https://callback.example/events', '{}', {}, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (url, options, callback) => {
      assert.equal(url.hostname, 'callback.example');
      optionsSeen = options;
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => { const res = Readable.from([Buffer.from('{}')]); res.statusCode = 302; callback(res); });
      req.destroy = () => {};
      return req;
    },
  });
  assert.equal(response.status, 302); // Returned, never followed.
  assert.equal(optionsSeen.agent, false);
  assert.equal(optionsSeen.servername, 'callback.example');
  let pinned;
  optionsSeen.lookup('callback.example', {}, (_error, address) => { pinned = address; });
  assert.equal(pinned, '8.8.8.8');
});

test('private tunnel full Bearer capability protects MCP; OAuth metadata remains 404', async () => {
  const store = new StateStore(null, randomBytes(32));
  const localBearer = randomBytes(32).toString('base64url');
  const oauth = new PrivateTunnelAuth({ localBearer, devices: [DEVICE] });
  const bridge = new Bridge({ store, oauth });
  const server = createHttpServer({ bridge, oauth, publicBaseUrl: 'http://127.0.0.1:8787' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
    const noAuth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('www-authenticate').includes('resource_metadata'), false);
    const wrongAuth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, body });
    assert.equal(wrongAuth.status, 401);
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localBearer}` }, body });
    assert.deepEqual((await response.json()).result.capabilities, { tools: {}, events: {} });
    const catalog = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localBearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const privateTools = (await catalog.json()).result.tools;
    assert.equal(privateTools.length, 4);
    assert.ok(privateTools.every(tool => JSON.stringify(tool.securitySchemes) === JSON.stringify([{ type: 'noauth' }])));
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth/authorize']) assert.equal((await fetch(`${base}${path}`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('subscription challenge is signed, single-use, and activation rejects wrong echo', async () => {
  const f = fixture();
  const input = subscribe();
  const response = await f.bridge.subscribe(f.principal, input);
  const delivery = f.deliveries[0];
  assert.equal(delivery.value.type, 'verification');
  assert.equal(verifySignature(input.delivery.secret, delivery.headers, delivery.body, f.now() / 1000), true);
  assert.equal(delivery.headers['X-MCP-Subscription-Id'], response.id);
  const bad = fixture({ post: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
  await assert.rejects(bad.bridge.subscribe(bad.principal, input), error => error.code === -32015 && error.data.reason === 'challenge_failed');
  assert.equal(Object.keys(bad.store.data.subscriptions).length, 0);
});

test('deterministic subscriptions refresh with bounded TTL and key rotation', async () => {
  const f = fixture();
  const input = subscribe();
  input.ttlMs = 5000;
  const first = await f.bridge.subscribe(f.principal, input);
  const repeated = await f.bridge.subscribe(f.principal, input);
  assert.equal(first.id, repeated.id);
  assert.equal(f.deliveries.length, 1);
  assert.equal(Date.parse(first.refreshBefore) - f.now(), 5000);
  f.advance(1000);
  const oldSecret = input.delivery.secret;
  input.delivery.secret = secret();
  const refreshed = await f.bridge.subscribe(f.principal, input);
  assert.equal(refreshed.id, first.id);
  const data = evidence(f);
  f.bridge.publishCamera('owner', data);
  await f.bridge.pump();
  const eventDelivery = f.deliveries.at(-1);
  assert.equal(verifySignature(oldSecret, eventDelivery.headers, eventDelivery.body, f.now() / 1000), true);
  assert.equal(verifySignature(input.delivery.secret, eventDelivery.headers, eventDelivery.body, f.now() / 1000), true);
  assert.equal(Object.keys(f.store.data.outbox).length, 0);
});

test('event filters, idempotent event IDs, and immutable evidence prevent duplicates', async () => {
  const f = fixture();
  await f.bridge.subscribe(f.principal, subscribe());
  const data = evidence(f);
  const first = f.bridge.publishCamera('owner', data);
  assert.equal(first.queued, 1);
  assert.equal(f.bridge.publishCamera('owner', data).duplicate, true);
  assert.throws(() => f.bridge.publishCamera('owner', { ...data, white_fraction: 0.95 }), { code: -32602 });
  assert.throws(() => f.bridge.publishCamera('owner', { ...data, simulation: true }), { code: -32602 });
  assert.throws(() => f.bridge.publishCamera('owner', { ...data, samples: 1 }), { code: -32602 });
  await f.bridge.pump();
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.deliveries[1].value.eventId, first.eventId);
  assert.equal(f.deliveries[1].headers['webhook-id'], first.eventId);
  assert.equal(f.deliveries[1].value.cursor, null);
});

test('scene changes have independent owned subscriptions and IDs from white events', async () => {
  const f = fixture();
  await f.bridge.subscribe(f.principal, subscribe());
  await f.bridge.subscribe(f.principal, { ...subscribe(), name: 'camera.scene_changed' });
  const catalog = (await f.bridge.rpc(f.principal, 'events/list')).events;
  assert.deepEqual(catalog.map(event => event.name), ['camera.white_detected', 'camera.scene_changed']);
  const white = f.bridge.publishCamera('owner', evidence(f));
  const scene = f.bridge.publishScene('owner', sceneEvidence(f));
  assert.notEqual(white.eventId, scene.eventId);
  assert.equal(white.queued, 1);
  assert.equal(scene.queued, 1);
  assert.equal(f.bridge.publishScene('owner', sceneEvidence(f)).duplicate, true);
  assert.throws(() => f.bridge.publishScene('owner', { ...sceneEvidence(f, '8'), changed_fraction: 0.1 }), { code: -32602 });
  assert.throws(() => f.bridge.publishScene('owner', { ...sceneEvidence(f, '8'), mean_delta: 0.01 }), { code: -32602 });
  assert.throws(() => f.bridge.publishScene('owner', { ...sceneEvidence(f, '8'), samples: 1 }), { code: -32602 });
  await f.bridge.pump();
  assert.deepEqual(f.deliveries.filter(delivery => delivery.value.eventId).map(delivery => delivery.value.name), ['camera.white_detected', 'camera.scene_changed']);
});

test('local scene feedback is opt-in, serialized, happy8, idempotent and reports completed LCD revision', async () => {
  const sent = [];
  const f = fixture({ adapter: { execute: async (device, request) => { sent.push({ device, request }); return { accepted: true, completed: true, revision: 8, rendered_revision: 8, face: request.face }; } } });
  const received = { event: null, scene_event: sceneEvidence(f) };
  const first = await f.bridge.consumeCapture('owner', received);
  assert.equal(first.local_feedback, undefined);
  assert.equal(sent.length, 0);
  const enabled = await f.bridge.consumeCapture('owner', received, { localSceneFeedback: true });
  assert.equal(enabled.local_feedback.state, 'completed');
  assert.equal(enabled.local_feedback.receipt.rendered_revision, 8);
  assert.deepEqual(sent, [{ device: DEVICE, request: { operation: 'screen', face: 'happy', seconds: 8 } }]);
  await f.bridge.consumeCapture('owner', received, { localSceneFeedback: true });
  assert.equal(sent.length, 1);
  await f.bridge.consumeCapture('owner', { event: evidence(f, '8'), scene_event: null }, { localSceneFeedback: true });
  assert.equal(sent.length, 1); // White compatibility does not trigger scene feedback.
});

test('frames with null or absent events are successful no-ops even with feedback enabled', async () => {
  let writes = 0;
  const f = fixture({ adapter: { execute: async () => { writes++; } } });
  assert.deepEqual(await f.bridge.consumeCapture('owner', { event: null, scene_event: null, metadata: { sequence: '1' } }, { localSceneFeedback: true }), {});
  assert.deepEqual(await f.bridge.consumeCapture('owner', { metadata: { sequence: '2' } }, { localSceneFeedback: true }), {});
  assert.equal(writes, 0);
  assert.equal(Object.keys(f.store.data.seen).length, 0);
});

test('scene feedback duration is explicitly bounded and configurable', async () => {
  const writes = [];
  const f = fixture({ adapter: { execute: async (_device, request) => { writes.push(request); return { accepted: true, completed: true, rendered_revision: 1 }; } } });
  await f.bridge.consumeCapture('owner', { scene_event: sceneEvidence(f) }, { localSceneFeedback: true, localSceneFeedbackSeconds: 10 });
  assert.equal(writes[0].seconds, 10);
  for (const seconds of [0, 61, 8.5, '8']) await assert.rejects(f.bridge.consumeCapture('owner', { scene_event: sceneEvidence(f, '8') }, { localSceneFeedback: true, localSceneFeedbackSeconds: seconds }), { code: -32602 });
});

test('watcher diagnostics expose controlled reasons/codes without exception messages or secrets', () => {
  const sentinel = 'private-value-never-log';
  const error = new RpcError(-32004, sentinel, { reason: 'firmware_rejected', firmware_code: 'camera_frame_stale', raw: sentinel });
  assert.deepEqual(safeErrorDetails(error), { code: -32004, reason: 'firmware_rejected', firmware_code: 'camera_frame_stale' });
  const unknown = new RpcError(-32004, sentinel, { reason: sentinel, firmware_code: sentinel });
  assert.deepEqual(safeErrorDetails(unknown), { code: -32004, reason: 'unexpected_error' });
  assert.equal(JSON.stringify(safeErrorDetails(unknown)).includes(sentinel), false);
  assert.deepEqual(safeErrorDetails(new TypeError(sentinel)), { code: null, reason: 'unexpected_error' });
});

test('local scene feedback does not claim accepted-only LCD writes completed', async () => {
  const f = fixture({ adapter: { execute: async () => ({ accepted: true, completed: false, revision: 2 }) } });
  const report = await f.bridge.consumeCapture('owner', { scene_event: sceneEvidence(f) }, { localSceneFeedback: true });
  assert.equal(report.local_feedback.state, 'accepted');
  await assert.rejects(f.bridge.consumeCapture('owner', { scene_event: { ...sceneEvidence(f, '8'), simulation: true } }, { localSceneFeedback: true }), { code: -32602 });
});

test('transient retries preserve event ID with a fresh signing timestamp and stop at five', async () => {
  const attempts = [];
  const f = fixture({ post: async (_url, body, headers) => {
    const value = JSON.parse(body);
    if (value.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
    attempts.push({ value, headers, body });
    return { status: 503, body: '{}' };
  } });
  const input = subscribe();
  await f.bridge.subscribe(f.principal, input);
  f.bridge.publishCamera('owner', evidence(f));
  for (let n = 0; n < 5; n++) { await f.bridge.pump(); f.advance(60_000); }
  assert.equal(attempts.length, 5);
  assert.equal(new Set(attempts.map(a => a.value.eventId)).size, 1);
  assert.equal(new Set(attempts.map(a => a.headers['webhook-timestamp'])).size, 5);
  assert.equal(Object.keys(f.store.data.outbox).length, 0);
});

for (const status of [410, 413, 400]) test(`HTTP ${status} deliveries are terminal and not retried`, async () => {
  const f = fixture({ post: async (_url, body) => { const value = JSON.parse(body); return value.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: value.challenge }) } : { status, body: '{}' }; } });
  await f.bridge.subscribe(f.principal, subscribe());
  f.bridge.publishCamera('owner', evidence(f));
  await f.bridge.pump();
  assert.equal(Object.keys(f.store.data.outbox).length, 0);
  if (status === 410) assert.equal(Object.keys(f.store.data.subscriptions).length, 0);
});

test('expired subscriptions, revoked owner access and unsubscribe stop event delivery', async () => {
  const f = fixture();
  const input = subscribe(); input.ttlMs = 1;
  await f.bridge.subscribe(f.principal, input);
  f.bridge.publishCamera('owner', evidence(f));
  f.advance(2);
  await f.bridge.pump();
  assert.equal(f.deliveries.length, 1);
  await f.bridge.subscribe(f.principal, subscribe());
  f.bridge.publishCamera('owner', evidence(f, '8'));
  f.revoke();
  await f.bridge.pump();
  assert.equal(f.deliveries.length, 2);
  const g = fixture();
  const requested = subscribe();
  await g.bridge.subscribe(g.principal, requested);
  g.bridge.publishCamera('owner', evidence(g));
  g.bridge.unsubscribe(g.principal, unsubscribe(requested));
  g.bridge.unsubscribe(g.principal, unsubscribe(requested));
  await g.bridge.pump();
  assert.equal(g.deliveries.length, 1);
});

test('encrypted state survives restart without plaintext subscription signing keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'esp32-white-mcp-test-'));
  try {
    const file = join(dir, 'state.enc.json');
    const key = randomBytes(32);
    const store = new StateStore(file, key);
    const f = fixture({ store });
    const input = subscribe();
    await f.bridge.subscribe(f.principal, input);
    f.bridge.publishCamera('owner', evidence(f));
    const encrypted = readFileSync(file, 'utf8');
    assert.equal(encrypted.includes(input.delivery.secret), false);
    assert.equal(encrypted.includes('callback.example'), false);
    assert.throws(() => new StateStore(file, randomBytes(32)));
    const restarted = fixture({ store: new StateStore(file, key) });
    assert.equal(Object.keys(restarted.store.data.subscriptions).length, 1);
    await restarted.bridge.pump();
    assert.equal(restarted.deliveries.length, 1);
    assert.equal(restarted.deliveries[0].value.name, 'camera.white_detected');
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('esp32-white-mcp-test-'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LCD write is owned, bounded and idempotent, with completed revision evidence', async () => {
  const sent = [];
  const f = fixture({ adapter: { execute: async (device, request) => { sent.push({ device, request }); return { accepted: true, completed: true, revision: 5, rendered_revision: 5, face: request.face }; } } });
  const input = { name: 'screen_set', arguments: { device_id: DEVICE, face: 'happy', seconds: 60, idempotency_key: 'event-abc' } };
  const first = (await f.bridge.callTool(f.principal, input)).structuredContent;
  assert.equal(first.state, 'completed');
  assert.equal((await f.bridge.callTool(f.principal, input)).structuredContent.command_id, first.command_id);
  assert.equal(sent.length, 1);
  await assert.rejects(f.bridge.callTool(f.principal, { ...input, arguments: { ...input.arguments, seconds: 59 } }), { code: -32602 });
  await assert.rejects(f.bridge.callTool(f.principal, { ...input, arguments: { ...input.arguments, seconds: 61, idempotency_key: 'invalid' } }), { code: -32602 });
  await assert.rejects(f.bridge.callTool(f.principal, { ...input, arguments: { ...input.arguments, device_id: 'other' } }), { code: -32003 });
  const checked = await f.bridge.callTool(f.principal, { name: 'command_status', arguments: { device_id: DEVICE, command_id: first.command_id } });
  assert.equal(checked.structuredContent.state, 'completed');
});

test('accepted replies and crashed commands never become fabricated completed LCD receipts', async () => {
  const f = fixture({ adapter: { execute: async () => ({ accepted: true, completed: false, revision: 9 }) } });
  const requested = { name: 'screen_set', arguments: { device_id: DEVICE, face: 'auto', idempotency_key: 'auto-1' } };
  const reply = (await f.bridge.callTool(f.principal, requested)).structuredContent;
  assert.equal(reply.state, 'accepted');
  f.store.data.commands[reply.command_id].state = 'pending';
  const restarted = fixture({ store: f.store });
  assert.equal(restarted.store.data.commands[reply.command_id].state, 'uncertain');
  assert.equal((await restarted.bridge.callTool(restarted.principal, requested)).structuredContent.state, 'uncertain');
});

test('OAuth PKCE pairing issues scoped audience-bound credentials; codes are single use', () => {
  const f = fixture();
  const linked = pair(f);
  assert.equal(f.oauth.authenticate(`Bearer ${linked.tokens.access_token}`).id, 'owner');
  assert.throws(() => f.oauth.exchange(linked.exchange), error => error.oauthCode === 'invalid_grant');
  const refresh = new URLSearchParams({ grant_type: 'refresh_token', client_id: linked.client.client_id, resource: f.oauth.resource, refresh_token: linked.tokens.refresh_token });
  const rotated = f.oauth.exchange(refresh);
  assert.notEqual(rotated.refresh_token, linked.tokens.refresh_token);
  assert.throws(() => f.oauth.exchange(refresh), error => error.oauthCode === 'invalid_grant');
  f.revoke();
  assert.equal(f.oauth.authenticate(`Bearer ${rotated.access_token}`), null);
});

test('OAuth rejects redirect/resource substitution, weak PKCE, wrong pairing and cross-origin consent', () => {
  const f = fixture();
  assert.throws(() => f.oauth.register({ redirect_uris: ['https://evil.example/callback'] }), error => error.oauthCode === 'invalid_redirect_uri');
  const client = f.oauth.register({ redirect_uris: [REDIRECT] });
  const request = oauthParams(f.oauth, client);
  const bad = new URLSearchParams(request.params); bad.set('resource', 'https://evil.example/mcp');
  assert.throws(() => f.oauth.authorizePage(bad), error => error.oauthCode === 'invalid_request');
  bad.set('resource', f.oauth.resource); bad.set('code_challenge_method', 'plain');
  assert.throws(() => f.oauth.authorizePage(bad), error => error.oauthCode === 'invalid_request');
  let page = f.oauth.authorizePage(request.params);
  let ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/u.exec(page)[1];
  assert.throws(() => f.oauth.consent(new URLSearchParams({ ticket, decision: 'allow', pairing_code: pairing }), 'https://evil.example'), error => error.oauthCode === 'access_denied');
  page = f.oauth.authorizePage(request.params); ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/u.exec(page)[1];
  const denied = f.oauth.consent(new URLSearchParams({ ticket, decision: 'allow', pairing_code: 'wrong' }), BASE);
  assert.equal(new URL(denied).searchParams.get('error'), 'access_denied');
});

test('real ephemeral HTTP OAuth → authenticated MCP lifecycle uses same endpoint', async () => {
  const f = fixture();
  const server = createHttpServer({ bridge: f.bridge, oauth: f.oauth, publicBaseUrl: BASE });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Host: 'bridge.example' };
  const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers }, redirect: 'manual' });
  try {
    const unauthorized = await request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/u);
    const metadata = await (await request('/.well-known/oauth-protected-resource')).json();
    assert.equal(metadata.resource, `${BASE}/mcp`);
    const registration = await request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const { params, verifier } = oauthParams(f.oauth, client);
    const page = await (await request(`/oauth/authorize?${params}`)).text();
    const ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/u.exec(page)[1];
    const consent = await request('/oauth/authorize', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, decision: 'allow', pairing_code: pairing }) });
    assert.equal(consent.status, 303);
    const destination = new URL(consent.headers.get('location'));
    assert.equal(destination.origin, 'https://chatgpt.com');
    assert.equal(destination.searchParams.get('iss'), BASE);
    const tokens = await (await request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: destination.searchParams.get('code'), redirect_uri: REDIRECT, resource: f.oauth.resource, code_verifier: verifier }) })).json();
    const rpc = async (method, params = {}) => (await request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method, params }) })).json();
    assert.deepEqual((await rpc('server/discover')).result.supportedVersions, ['2026-07-28']);
    assert.equal((await rpc('tools/list')).result.tools.length, 4);
    assert.equal((await rpc('events/list')).result.events.length, 2);
    const subscription = subscribe();
    assert.ok((await rpc('events/subscribe', subscription)).result.id.startsWith('sub_'));
    assert.deepEqual((await rpc('events/unsubscribe', unsubscribe(subscription))).result, {});
    assert.equal((await rpc('does/not/exist')).error.code, -32601);
    assert.equal((await rpc('tools/call', { name: 'device_status', arguments: { device_id: DEVICE } })).error.data.reason, 'adapter_disabled');
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/health`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(badHostStatus, 421);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
