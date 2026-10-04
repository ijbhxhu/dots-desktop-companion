import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const empty = () => ({ subscriptions: {}, outbox: {}, seen: {}, commands: {}, oauth: { clients: {}, codes: {}, access: {}, refresh: {} } });

// Only this project's encrypted application state is read. No credential discovery.
export class StateStore {
  constructor(file, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte state encryption key is required');
    this.file = file ? resolve(file) : null;
    this.key = key;
    this.data = empty();
    if (this.file && existsSync(this.file)) {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) throw new Error('Unsafe state file');
      const envelope = JSON.parse(readFileSync(this.file, 'utf8'));
      if (envelope.version !== 1) throw new Error('Unsupported state version');
      const decoder = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decoder.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const value = JSON.parse(Buffer.concat([decoder.update(Buffer.from(envelope.ciphertext, 'base64')), decoder.final()]).toString('utf8'));
      for (const name of Object.keys(empty())) if (!value[name] || typeof value[name] !== 'object' || Array.isArray(value[name])) throw new Error('Invalid state');
      this.data = value;
    }
  }

  save() {
    if (!this.file) return;
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('State directory must not be a symlink');
    const iv = randomBytes(12);
    const encoder = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([encoder.update(JSON.stringify(this.data), 'utf8'), encoder.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: encoder.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    if (Buffer.byteLength(envelope) > 8 * 1024 * 1024) throw new Error('State capacity reached');
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, envelope, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
