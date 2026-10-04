import { randomBytes } from 'node:crypto';
import { canonical, digest, id, integer, object, RpcError, secureEqual } from './validation.mjs';
import { callbackUrl, signingKey, signedPost, publicHttpsPost } from './webhook.mjs';

const deviceInput = { type: 'object', properties: { device_id: { type: 'string', description: 'An owned ESP32 device ID.' } }, required: ['device_id'], additionalProperties: false };
const eventDefinition = {
  name: 'camera.white_detected', description: 'The owned ESP32 camera observed sustained white in its central ROI; only aggregate evidence is delivered.',
  delivery: ['webhook'], inputSchema: deviceInput,
  payloadSchema: {
    type: 'object', properties: {
      device_id: { type: 'string' }, source_epoch: { type: 'string', pattern: '^[a-f0-9]{16}$' },
      frame_sequence: { type: 'string', pattern: '^[0-9]+$' }, captured_at: { type: 'string', format: 'date-time' },
      white_fraction: { type: 'number', minimum: 0.7, maximum: 1 }, held_seconds: { type: 'number', minimum: 1, maximum: 30 },
      samples: { type: 'integer', minimum: 3 }, sensor_pid: { type: 'integer', minimum: 1, maximum: 65535 }, simulation: { const: false },
    }, required: ['device_id', 'source_epoch', 'frame_sequence', 'captured_at', 'white_fraction', 'held_seconds', 'samples', 'sensor_pid', 'simulation'], additionalProperties: false,
  },
};
const sceneDefinition = {
  name: 'camera.scene_changed', description: 'A clear change in the owned ESP32 camera scene was confirmed in consecutive valid frames; aggregate evidence only.',
  delivery: ['webhook'], inputSchema: deviceInput,
  payloadSchema: {
    type: 'object', properties: {
      device_id: eventDefinition.payloadSchema.properties.device_id, source_epoch: eventDefinition.payloadSchema.properties.source_epoch,
      frame_sequence: eventDefinition.payloadSchema.properties.frame_sequence, captured_at: eventDefinition.payloadSchema.properties.captured_at,
      sensor_pid: eventDefinition.payloadSchema.properties.sensor_pid, simulation: { const: false },
      changed_fraction: { type: 'number', minimum: 0.30, maximum: 1 }, mean_delta: { type: 'number', minimum: 0.08, maximum: 1 },
      held_seconds: { type: 'number', minimum: 0.20, maximum: 30 }, samples: { type: 'integer', minimum: 2, maximum: 1000 },
    }, required: ['device_id', 'source_epoch', 'frame_sequence', 'captured_at', 'sensor_pid', 'simulation', 'changed_fraction', 'mean_delta', 'held_seconds', 'samples'], additionalProperties: false,
  },
};
const eventDefinitions = new Map([eventDefinition, sceneDefinition].map(definition => [definition.name, definition]));
const tool = (name, description, schema, readOnlyHint) => ({ name, title: name.replaceAll('_', ' '), description, inputSchema: schema, annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false }, securitySchemes: [{ type: 'oauth2', scopes: readOnlyHint ? ['device:read'] : ['screen:write'] }] });
const tools = [
  tool('device_status', 'Read the owned ESP32 identity and actual requested/completed LCD frame revisions.', deviceInput, true),
  tool('camera_status', 'Read camera driver, capture permission and sensor metadata; this does not initialize or capture.', deviceInput, true),
  tool('screen_set', 'Set the owned LCD to happy for 1–60 seconds or restore auto. Reuse the idempotency key after a lost response. Completion is reported only after the firmware confirms its rendered revision.', {
    type: 'object', properties: { device_id: { type: 'string' }, face: { enum: ['happy', 'auto'] }, seconds: { type: 'integer', minimum: 1, maximum: 60 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 96 } }, required: ['device_id', 'face', 'idempotency_key'], additionalProperties: false,
  }, false),
  tool('command_status', 'Read a previous LCD command receipt without sending the command again.', {
    type: 'object', properties: { device_id: { type: 'string' }, command_id: { type: 'string' } }, required: ['device_id', 'command_id'], additionalProperties: false,
  }, true),
];
const result = value => ({ resultType: 'complete', structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });

export class UnavailableAdapter {
  async execute() { throw new RpcError(-32004, 'Hardware adapter is disabled', { reason: 'adapter_disabled' }); }
}

export class Bridge {
  constructor({ store, oauth, adapter = new UnavailableAdapter(), post = publicHttpsPost, now = Date.now, ttlMs = 3_600_000 }) {
    this.store = store; this.oauth = oauth; this.adapter = adapter; this.post = post; this.now = now; this.ttlMs = ttlMs;
    this.verified = new Map(); this.pumping = false; this.queues = new Map();
    // A restart after a physical send cannot prove whether it executed. Never resend.
    let changed = false;
    for (const command of Object.values(store.data.commands)) if (command.state === 'pending') { command.state = 'uncertain'; command.reason = 'restart_during_command'; changed = true; }
    if (changed) store.save();
  }
  async serialized(device, action) {
    const previous = this.queues.get(device) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(action);
    this.queues.set(device, running);
    try { return await running; } finally { if (this.queues.get(device) === running) this.queues.delete(device); }
  }
  subscriptionParams(principal, input, subscribing) {
    object(input, subscribing ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', '_meta'] : ['name', 'arguments', 'delivery', '_meta'], ['name', 'arguments', 'delivery']);
    if (!eventDefinitions.has(input.name)) throw new RpcError(-32602, 'Unknown event');
    object(input.arguments, ['device_id'], ['device_id']);
    const device = id(input.arguments.device_id);
    this.oauth.require(principal, device, 'events:subscribe');
    object(input.delivery, subscribing ? ['mode', 'url', 'secret'] : ['mode', 'url'], subscribing ? ['mode', 'url', 'secret'] : ['mode', 'url']);
    if (input.delivery.mode !== 'webhook' || typeof input.delivery.url !== 'string') throw new RpcError(-32602, 'Only webhook delivery is supported');
    const url = callbackUrl(input.delivery.url).href;
    if (subscribing) {
      signingKey(input.delivery.secret);
      if (input.cursor !== undefined && input.cursor !== null) throw new RpcError(-32602, 'This event has no replay cursor');
      if (input.ttlMs !== undefined && input.ttlMs !== null) integer(input.ttlMs, 1, 86_400_000);
    }
    const identity = canonical({ owner: principal.id, name: input.name, arguments: { device_id: device }, url });
    return { id: `sub_${digest(identity)}`, owner: principal.id, name: input.name, device_id: device, url };
  }
  async subscribe(principal, input) {
    const identity = this.subscriptionParams(principal, input, true);
    const previous = this.store.data.subscriptions[identity.id];
    if (!previous && Object.keys(this.store.data.subscriptions).length >= 128) throw new RpcError(-32005, 'Subscription capacity reached');
    const now = this.now();
    const secret = input.delivery.secret;
    const grantedTtl = input.ttlMs === undefined || input.ttlMs === null ? this.ttlMs : Math.min(input.ttlMs, this.ttlMs);
    const subscription = { ...identity, secret, expiresAt: now + grantedTtl };
    const verificationKey = digest(`${principal.id}\n${identity.url}\n${secret}`);
    if ((this.verified.get(verificationKey) ?? 0) <= now) {
      const challenge = randomBytes(32).toString('base64url');
      const body = JSON.stringify({ type: 'verification', challenge });
      const eventId = `msg_verification_${randomBytes(16).toString('hex')}`;
      let response;
      try { response = await signedPost(subscription, eventId, body, this.post, this.now()); }
      catch (error) { if (error instanceof RpcError && error.code === -32015) throw error; throw new RpcError(-32015, 'Callback verification failed', { reason: 'connection_failed' }); }
      let echoed;
      try { echoed = JSON.parse(response.body).challenge; } catch { /* Categorized below. */ }
      if (response.status < 200 || response.status >= 300 || typeof echoed !== 'string' || !secureEqual(challenge, echoed)) throw new RpcError(-32015, 'Callback verification failed', { reason: response.status >= 300 && response.status < 400 ? 'redirect' : 'challenge_failed' });
      this.verified.set(verificationKey, this.now() + 300_000);
      for (const [key, expires] of this.verified) if (expires <= this.now()) this.verified.delete(key);
    }
    // Access is rechecked after the network challenge, before saving activation.
    this.oauth.require(principal, identity.device_id, 'events:subscribe');
    if (previous && previous.secret !== secret) { subscription.previousSecret = previous.secret; subscription.rotationUntil = this.now() + 300_000; }
    else if (previous?.rotationUntil > this.now()) { subscription.previousSecret = previous.previousSecret; subscription.rotationUntil = previous.rotationUntil; }
    this.store.data.subscriptions[identity.id] = subscription;
    this.store.save();
    return { id: identity.id, refreshBefore: new Date(subscription.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(principal, input) {
    const identity = this.subscriptionParams(principal, input, false);
    delete this.store.data.subscriptions[identity.id];
    for (const [key, pending] of Object.entries(this.store.data.outbox)) if (pending.subscriptionId === identity.id) delete this.store.data.outbox[key];
    this.store.save();
    return {};
  }
  async callTool(principal, input) {
    object(input, ['name', 'arguments', '_meta'], ['name', 'arguments']);
    const args = input.arguments;
    if (!tools.some(t => t.name === input.name)) throw new RpcError(-32602, 'Unknown tool');
    const allowed = input.name === 'screen_set' ? ['device_id', 'face', 'seconds', 'idempotency_key'] : input.name === 'command_status' ? ['device_id', 'command_id'] : ['device_id'];
    object(args, allowed, input.name === 'screen_set' ? ['device_id', 'face', 'idempotency_key'] : input.name === 'command_status' ? ['device_id', 'command_id'] : ['device_id']);
    const device = id(args.device_id);
    this.oauth.require(principal, device, input.name === 'screen_set' ? 'screen:write' : 'device:read');
    if (input.name === 'command_status') {
      const command = this.store.data.commands[id(args.command_id)];
      if (!command || command.owner !== principal.id || command.device_id !== device) throw new RpcError(-32003, 'Command access denied');
      return result(this.visibleCommand(command));
    }
    if (input.name !== 'screen_set') {
      const response = await this.serialized(device, () => this.adapter.execute(device, { operation: input.name === 'camera_status' ? 'camera_status' : 'status' }));
      return result(response);
    }
    if (!['happy', 'auto'].includes(args.face)) throw new RpcError(-32602, 'Unsupported face');
    if (args.face === 'happy') integer(args.seconds, 1, 60);
    else if (args.seconds !== undefined) throw new RpcError(-32602, 'auto does not take seconds');
    const identity = `cmd_${digest(canonical({ owner: principal.id, device, key: id(args.idempotency_key) }))}`;
    const request = { operation: 'screen', face: args.face, ...(args.face === 'happy' ? { seconds: args.seconds } : {}) };
    const fingerprint = digest(canonical(request));
    const existing = this.store.data.commands[identity];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RpcError(-32602, 'Idempotency key already belongs to a different command');
      return result(this.visibleCommand(existing));
    }
    if (Object.keys(this.store.data.commands).length >= 4096) throw new RpcError(-32005, 'Command history capacity reached');
    const command = { id: identity, owner: principal.id, device_id: device, fingerprint, state: 'pending', created_at: new Date(this.now()).toISOString() };
    this.store.data.commands[identity] = command;
    this.store.save();
    try {
      const receipt = await this.serialized(device, async () => { this.oauth.require(principal, device, 'screen:write'); return this.adapter.execute(device, request); });
      command.state = receipt.completed === true ? 'completed' : receipt.accepted === true ? 'accepted' : 'failed';
      command.receipt = receipt;
    } catch (error) {
      command.state = error.data?.reason === 'adapter_disabled' ? 'failed' : 'uncertain';
      command.reason = error.data?.reason ?? 'transport_failed';
    }
    this.store.save();
    return result(this.visibleCommand(command));
  }
  visibleCommand(command) { return { command_id: command.id, device_id: command.device_id, state: command.state, ...(command.receipt ? { receipt: command.receipt } : {}), ...(command.reason ? { reason: command.reason } : {}) }; }
  async rpc(principal, method, params = {}) {
    if (!principal || !this.oauth.principalForOwner(principal.id)) throw new RpcError(-32003, 'Account access denied');
    if (method === 'server/discover') { object(params, ['_meta', 'versions']); return { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } }; }
    if (method === 'initialize') { object(params, ['protocolVersion', 'capabilities', 'clientInfo', '_meta']); return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'esp32-white-mcp', version: '0.1.0' }, instructions: 'Use only owned device IDs. LCD commands require an idempotency key. Check command_status before retrying. Camera events contain aggregate evidence and never images.' }; }
    if (method === 'ping') { object(params, []); return {}; }
    if (method === 'notifications/initialized') return {};
    if (method === 'tools/list') {
      object(params, ['cursor', '_meta']);
      if (params.cursor) throw new RpcError(-32602, 'Invalid cursor');
      const visible = tools.filter(t => principal.scopes.has(t.name === 'screen_set' ? 'screen:write' : 'device:read'));
      // Secure Tunnel supplies owner authentication; ChatGPT has no OAuth flow
      // against this private origin. The injected loopback Bearer is still checked.
      return { tools: this.oauth.privateTunnel ? visible.map(t => ({ ...t, securitySchemes: [{ type: 'noauth' }] })) : visible };
    }
    if (method === 'tools/call') return this.callTool(principal, params);
    if (method === 'events/list') { object(params, ['cursor', '_meta']); if (params.cursor) throw new RpcError(-32602, 'Invalid cursor'); return { events: principal.scopes.has('events:subscribe') && principal.devices.size ? [...eventDefinitions.values()] : [] }; }
    if (method === 'events/subscribe') return this.subscribe(principal, params);
    if (method === 'events/unsubscribe') return this.unsubscribe(principal, params);
    throw new RpcError(-32601, 'Method not found');
  }
  // Internal adapter boundary, never an unauthenticated HTTP ingest route.
  publishCamera(owner, data) {
    return this.publishCameraEvent(owner, eventDefinition.name, data);
  }
  publishScene(owner, data) {
    return this.publishCameraEvent(owner, sceneDefinition.name, data);
  }
  async consumeCapture(owner, received, { localSceneFeedback = false, localSceneFeedbackSeconds = 8 } = {}) {
    integer(localSceneFeedbackSeconds, 1, 60);
    const report = {};
    if (received.event) report.white = this.publishCamera(owner, received.event);
    if (received.scene_event) {
      report.scene = this.publishScene(owner, received.scene_event);
      if (localSceneFeedback) {
        const response = await this.callTool(this.oauth.principalForOwner(owner), {
          name: 'screen_set', arguments: { device_id: received.scene_event.device_id, face: 'happy', seconds: localSceneFeedbackSeconds, idempotency_key: `scene-${report.scene.eventId.slice(4)}` },
        });
        report.local_feedback = response.structuredContent;
      }
    }
    return report;
  }
  publishCameraEvent(owner, name, data) {
    const definition = eventDefinitions.get(name);
    if (!definition) throw new RpcError(-32602, 'Unknown event');
    object(data, Object.keys(definition.payloadSchema.properties), definition.payloadSchema.required);
    const device = id(data.device_id);
    const principal = this.oauth.principalForOwner(owner);
    this.oauth.require(principal, device, 'events:subscribe');
    if (!/^[a-f0-9]{16}$/u.test(data.source_epoch) || typeof data.frame_sequence !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(data.frame_sequence) || BigInt(data.frame_sequence) > 0xffffffffffffffffn) throw new RpcError(-32602, 'Invalid frame identity');
    const timestamp = Date.parse(data.captured_at);
    if (typeof data.captured_at !== 'string' || !/Z$|[+-]\d\d:\d\d$/u.test(data.captured_at) || !Number.isFinite(timestamp)) throw new RpcError(-32602, 'Invalid capture timestamp');
    if (!Number.isFinite(data.held_seconds) || data.held_seconds < (name === sceneDefinition.name ? 0.2 : 1) || data.held_seconds > 30 || data.simulation !== false) throw new RpcError(-32602, 'Unqualified camera event');
    if (name === sceneDefinition.name) {
      if (!Number.isFinite(data.changed_fraction) || data.changed_fraction < 0.30 || data.changed_fraction > 1 || !Number.isFinite(data.mean_delta) || data.mean_delta < 0.08 || data.mean_delta > 1) throw new RpcError(-32602, 'Unqualified scene change');
    } else if (!Number.isFinite(data.white_fraction) || data.white_fraction < 0.7 || data.white_fraction > 1) throw new RpcError(-32602, 'Unqualified camera event');
    integer(data.samples, name === sceneDefinition.name ? 2 : 3, 1000); integer(data.sensor_pid, 1, 65535);
    // Preserve existing white-event identities; scene changes have a distinct namespace.
    const eventId = `evt_${digest(`${name === sceneDefinition.name ? `${name}\n` : ''}${device}\n${data.source_epoch}\n${data.frame_sequence}`)}`;
    const fingerprint = digest(canonical(data));
    const previous = this.store.data.seen[eventId];
    if (previous) { if (previous.fingerprint !== fingerprint) throw new RpcError(-32602, 'Event ID reused with changed evidence'); return { eventId, duplicate: true }; }
    const active = Object.values(this.store.data.subscriptions).filter(s => s.owner === owner && s.name === name && s.device_id === device && s.expiresAt > this.now());
    if (Object.keys(this.store.data.outbox).length + active.length > 2048 || Object.keys(this.store.data.seen).length >= 8192) throw new RpcError(-32005, 'Event history capacity reached');
    const event = { eventId, name, timestamp: data.captured_at, data, cursor: null };
    this.store.data.seen[eventId] = { fingerprint, timestamp: this.now() };
    for (const subscription of active) {
      const key = `${subscription.id}:${eventId}`;
      this.store.data.outbox[key] = { subscriptionId: subscription.id, event, attempts: 0, due: this.now() };
    }
    this.store.save();
    return { eventId, duplicate: false, queued: active.length };
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const [key, pending] of Object.entries(this.store.data.outbox).slice(0, 64)) {
        if (pending.due > this.now()) continue;
        const subscription = this.store.data.subscriptions[pending.subscriptionId];
        const principal = subscription ? this.oauth.principalForOwner(subscription.owner) : null;
        try { this.oauth.require(principal, subscription?.device_id, 'events:subscribe'); }
        catch { delete this.store.data.outbox[key]; this.store.save(); continue; }
        if (subscription.expiresAt <= this.now()) { delete this.store.data.outbox[key]; this.store.save(); continue; }
        let response;
        try { response = await signedPost(subscription, pending.event.eventId, JSON.stringify(pending.event), this.post, this.now()); }
        catch { response = { status: 0 }; }
        if (!this.store.data.outbox[key]) continue; // Unsubscribe while delivery was in flight.
        pending.attempts++;
        const transient = response.status === 0 || response.status === 408 || response.status === 429 || response.status >= 500;
        if (response.status === 410) delete this.store.data.subscriptions[subscription.id];
        if ((response.status >= 200 && response.status < 300) || !transient || pending.attempts >= 5) delete this.store.data.outbox[key];
        else pending.due = this.now() + Math.min(60_000, 1000 * 2 ** (pending.attempts - 1));
        this.store.save();
      }
    } finally { this.pumping = false; }
  }
}
