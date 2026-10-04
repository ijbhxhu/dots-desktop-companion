import { secureEqual, RpcError } from './validation.mjs';
import { SCOPES } from './oauth.mjs';

// Capability shared only with the authenticated Secure MCP Tunnel client.
// This is origin protection, not a custom API-key scheme presented to ChatGPT.
export class PrivateTunnelAuth {
  constructor({ localBearer, devices, owner = 'owner', ownerEnabled = () => true }) {
    if (typeof localBearer !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(localBearer)) throw new Error('DOT_TUNNEL_LOCAL_BEARER must be a private random token of at least 43 characters');
    this.expectedAuthorization = `Bearer ${localBearer}`;
    this.owner = owner;
    this.devices = new Set(devices);
    this.ownerEnabled = ownerEnabled;
    this.privateTunnel = true;
  }
  authenticate(header) {
    if (typeof header !== 'string' || !this.ownerEnabled() || !secureEqual(header, this.expectedAuthorization)) return null;
    return this.principalForOwner(this.owner);
  }
  principalForOwner(owner) {
    return owner === this.owner && this.ownerEnabled() ? { id: owner, devices: this.devices, scopes: new Set(SCOPES) } : null;
  }
  require(principal, deviceId, scope) {
    if (!principal || principal.id !== this.owner || !this.ownerEnabled() || !principal.scopes.has(scope) || !this.devices.has(deviceId) || !principal.devices.has(deviceId)) throw new RpcError(-32003, 'Device access denied');
  }
}
