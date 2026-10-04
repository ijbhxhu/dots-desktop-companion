import { randomBytes } from 'node:crypto';
import { digest, secureEqual, text, object, RpcError } from './validation.mjs';

export const SCOPES = ['device:read', 'screen:write', 'events:subscribe'];
const token = () => randomBytes(32).toString('base64url');
const htmlEscape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const oauthError = (code, message = code, status = 400) => { const error = new Error(message); error.oauthCode = code; error.httpStatus = status; throw error; };

export class OAuth {
  constructor({ store, publicBaseUrl, pairingCode, owner = 'owner', devices, redirectUris, now = Date.now, ownerEnabled = () => true }) {
    const base = new URL(publicBaseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('publicBaseUrl must be a canonical HTTPS origin');
    if (typeof pairingCode !== 'string' || Buffer.byteLength(pairingCode) < 24) throw new Error('A private pairing code of at least 24 bytes is required');
    if (!Array.isArray(redirectUris) || !redirectUris.length) throw new Error('Exact OAuth redirect URI allowlist is required');
    for (const uri of redirectUris) {
      const value = new URL(uri);
      if (value.protocol !== 'https:' || value.username || value.password || value.hash) throw new Error('OAuth redirects must be HTTPS');
    }
    this.base = base.origin;
    this.resource = `${this.base}/mcp`;
    this.owner = owner;
    this.devices = new Set(devices);
    this.redirectUris = new Set(redirectUris);
    this.ownerEnabled = ownerEnabled;
    this.pairingHash = digest(pairingCode);
    this.store = store;
    this.now = now;
    this.forms = new Map();
  }
  metadata() {
    return {
      issuer: this.base, authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${this.base}/oauth/authorize`, token_endpoint: `${this.base}/oauth/token`,
      registration_endpoint: `${this.base}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: SCOPES,
    };
  }
  resourceMetadata() { return { resource: this.resource, authorization_servers: [this.base], scopes_supported: SCOPES }; }
  currentPrincipal(record) {
    if (!record || record.owner !== this.owner || !this.ownerEnabled()) return null;
    return { id: this.owner, devices: this.devices, scopes: new Set(record.scopes) };
  }
  authenticate(header) {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/u.test(header)) return null;
    const record = this.store.data.oauth.access[digest(header.slice(7))];
    if (!record || record.expiresAt <= this.now() || record.resource !== this.resource) return null;
    return this.currentPrincipal(record);
  }
  principalForOwner(owner, scopes = SCOPES) { return this.currentPrincipal({ owner, scopes }); }
  scopes(input) {
    if (typeof input !== 'string' || input.length > 256) oauthError('invalid_scope');
    const scopes = [...new Set(input.split(' ').filter(Boolean))];
    if (!scopes.length || scopes.some(scope => !SCOPES.includes(scope))) oauthError('invalid_scope');
    return scopes;
  }
  cleanup() {
    const now = this.now();
    for (const category of ['codes', 'access', 'refresh']) for (const [hash, item] of Object.entries(this.store.data.oauth[category])) if (item.expiresAt <= now) delete this.store.data.oauth[category][hash];
    for (const [key, value] of this.forms) if (value.expiresAt <= now) this.forms.delete(key);
  }
  register(input) {
    object(input, ['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope'], ['redirect_uris']);
    this.cleanup();
    if (Object.keys(this.store.data.oauth.clients).length >= 32) oauthError('temporarily_unavailable');
    if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 4 || input.redirect_uris.some(uri => !this.redirectUris.has(uri))) oauthError('invalid_redirect_uri');
    if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') oauthError('invalid_client_metadata');
    if (input.grant_types && (!Array.isArray(input.grant_types) || input.grant_types.some(v => !['authorization_code', 'refresh_token'].includes(v)))) oauthError('invalid_client_metadata');
    if (input.response_types && (!Array.isArray(input.response_types) || input.response_types.length !== 1 || input.response_types[0] !== 'code')) oauthError('invalid_client_metadata');
    const client_id = `client_${token()}`;
    const record = { client_id, redirect_uris: [...new Set(input.redirect_uris)], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: input.client_name ? text(input.client_name, 80) : 'ESP32 dot connection', issuedAt: this.now() };
    this.store.data.oauth.clients[client_id] = record;
    this.store.save();
    const { issuedAt, ...visible } = record;
    return { ...visible, client_id_issued_at: Math.floor(issuedAt / 1000) };
  }
  authorizePage(params) {
    this.cleanup();
    if (this.forms.size >= 64) oauthError('temporarily_unavailable');
    for (const key of ['client_id', 'redirect_uri', 'resource', 'scope', 'response_type', 'code_challenge', 'code_challenge_method', 'state']) if (params.getAll(key).length !== 1) oauthError('invalid_request');
    if (params.get('response_type') !== 'code' || params.get('resource') !== this.resource || params.get('code_challenge_method') !== 'S256') oauthError('invalid_request');
    const client_id = params.get('client_id');
    const redirect_uri = params.get('redirect_uri');
    const client = this.store.data.oauth.clients[client_id];
    if (!client || !client.redirect_uris.includes(redirect_uri) || !this.redirectUris.has(redirect_uri)) oauthError('invalid_client');
    const challenge = params.get('code_challenge');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) oauthError('invalid_request');
    const state = params.get('state');
    if (!state || state.length > 1024) oauthError('invalid_request');
    const scopes = this.scopes(params.get('scope'));
    if (!this.ownerEnabled()) oauthError('access_denied');
    const ticket = token();
    this.forms.set(digest(ticket), { client_id, redirect_uri, scopes, challenge, state, expiresAt: this.now() + 120_000 });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Connect ESP32 dot</title></head><body><h1>Connect your ESP32 to ChatGPT</h1><p>Client: ${htmlEscape(client.client_name)}</p><p>Allow: ${htmlEscape(scopes.join(', '))}</p><p>Devices: ${htmlEscape([...this.devices].join(', '))}</p><form method="post" action="${this.base}/oauth/authorize"><input type="hidden" name="ticket" value="${ticket}"><label>Local pairing code <input type="password" name="pairing_code" autocomplete="off" required></label><button name="decision" value="allow">Allow connection</button><button name="decision" value="deny">Deny</button></form></body></html>`;
  }
  consent(params, origin) {
    if (origin !== this.base) oauthError('access_denied');
    if (params.getAll('ticket').length !== 1 || params.getAll('decision').length !== 1) oauthError('invalid_request');
    const key = digest(params.get('ticket') ?? '');
    const form = this.forms.get(key);
    this.forms.delete(key); // Single use, including denial/incorrect pairing attempts.
    if (!form || form.expiresAt <= this.now()) oauthError('access_denied');
    const destination = new URL(form.redirect_uri);
    destination.searchParams.set('state', form.state);
    destination.searchParams.set('iss', this.base);
    if (params.get('decision') !== 'allow' || !this.ownerEnabled() || !secureEqual(digest(params.get('pairing_code') ?? ''), this.pairingHash)) {
      destination.searchParams.set('error', 'access_denied');
      return destination.href;
    }
    this.cleanup();
    if (Object.keys(this.store.data.oauth.codes).length >= 64) oauthError('temporarily_unavailable');
    const code = token();
    this.store.data.oauth.codes[digest(code)] = { ...form, owner: this.owner, resource: this.resource, expiresAt: this.now() + 60_000 };
    this.store.save();
    destination.searchParams.set('code', code);
    return destination.href;
  }
  issue(record) {
    this.cleanup();
    if (Object.keys(this.store.data.oauth.access).length >= 256 || Object.keys(this.store.data.oauth.refresh).length >= 256) oauthError('temporarily_unavailable');
    const access_token = token();
    const refresh_token = token();
    const value = { owner: record.owner, resource: record.resource, client_id: record.client_id, scopes: record.scopes };
    this.store.data.oauth.access[digest(access_token)] = { ...value, expiresAt: this.now() + 3_600_000 };
    this.store.data.oauth.refresh[digest(refresh_token)] = { ...value, expiresAt: this.now() + 86_400_000 };
    this.store.save();
    return { token_type: 'Bearer', access_token, refresh_token, expires_in: 3600, scope: value.scopes.join(' ') };
  }
  exchange(params) {
    for (const key of ['grant_type', 'client_id', 'resource']) if (params.getAll(key).length !== 1) oauthError('invalid_request');
    const client_id = params.get('client_id');
    if (!this.store.data.oauth.clients[client_id]) oauthError('invalid_client');
    if (params.get('resource') !== this.resource) oauthError('invalid_target');
    if (!this.ownerEnabled()) oauthError('access_denied');
    const now = this.now();
    if (params.get('grant_type') === 'authorization_code') {
      for (const key of ['code', 'redirect_uri', 'code_verifier']) if (params.getAll(key).length !== 1) oauthError('invalid_request');
      const key = digest(params.get('code'));
      const record = this.store.data.oauth.codes[key];
      if (!record || record.expiresAt <= now || record.client_id !== client_id || record.resource !== this.resource || record.redirect_uri !== params.get('redirect_uri')) oauthError('invalid_grant');
      const verifier = params.get('code_verifier');
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || !secureEqual(Buffer.from(digest(verifier), 'hex').toString('base64url'), record.challenge)) oauthError('invalid_grant');
      delete this.store.data.oauth.codes[key];
      this.store.save();
      return this.issue(record);
    }
    if (params.get('grant_type') === 'refresh_token') {
      if (params.getAll('refresh_token').length !== 1) oauthError('invalid_request');
      const key = digest(params.get('refresh_token'));
      const record = this.store.data.oauth.refresh[key];
      if (!record || record.expiresAt <= now || record.client_id !== client_id || record.resource !== this.resource) oauthError('invalid_grant');
      delete this.store.data.oauth.refresh[key];
      this.store.save();
      if (params.has('scope')) {
        const requested = this.scopes(params.get('scope'));
        if (requested.some(scope => !record.scopes.includes(scope))) oauthError('invalid_scope');
        record.scopes = requested;
      }
      return this.issue(record);
    }
    oauthError('unsupported_grant_type');
  }
  require(principal, deviceId, scope) {
    if (!principal || principal.id !== this.owner || !this.ownerEnabled() || !principal.scopes.has(scope) || !this.devices.has(deviceId) || !principal.devices.has(deviceId)) throw new RpcError(-32003, 'Device access denied');
  }
}
