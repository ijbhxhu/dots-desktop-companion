import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StateStore } from './state.mjs';
import { OAuth } from './oauth.mjs';
import { Bridge, UnavailableAdapter } from './bridge.mjs';
import { createHttpServer } from './server.mjs';
import { PythonUsbAdapter } from './device.mjs';
import { PrivateTunnelAuth } from './private-auth.mjs';
import { integer, safeErrorDetails } from './validation.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'enable-serial': { type: 'boolean', default: false }, 'capture-watch': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('node src/cli.mjs --config <nonsecret-config.json> [--enable-serial] [--capture-watch]');
  console.log('Requires process-only DOT_STATE_KEY (base64, 32 bytes) and DOT_PAIRING_CODE (>=24 bytes).');
  console.log('Without --enable-serial no port is opened. --capture-watch explicitly enables repeated one-shot frames.');
} else {
  if (!values.config || /(?:^|[\\/])\.env(?:\.|$)/iu.test(values.config)) throw new Error('An explicit nonsecret JSON config is required');
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  if (config.localSceneFeedback !== undefined && typeof config.localSceneFeedback !== 'boolean') throw new Error('localSceneFeedback must be a boolean');
  const localSceneFeedbackSeconds = integer(config.localSceneFeedbackSeconds ?? 8, 1, 60);
  if (values['capture-watch'] && !values['enable-serial']) throw new Error('--capture-watch requires --enable-serial');
  if (!Array.isArray(config.devices) || config.devices.length !== 1 || !config.devices[0].id) throw new Error('This local bridge requires exactly one configured device');
  const key = Buffer.from(process.env.DOT_STATE_KEY ?? '', 'base64');
  const store = new StateStore(resolve(config.stateFile ?? '.state/state.enc.json'), key);
  const port = config.listenPort ?? 8787;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port');
  const publicBaseUrl = config.privateTunnel === true ? `http://127.0.0.1:${port}` : config.publicBaseUrl;
  const oauth = config.privateTunnel === true
    ? new PrivateTunnelAuth({ localBearer: process.env.DOT_TUNNEL_LOCAL_BEARER, devices: config.devices.map(device => device.id) })
    : new OAuth({ store, publicBaseUrl, pairingCode: process.env.DOT_PAIRING_CODE, devices: config.devices.map(device => device.id), redirectUris: config.oauthRedirectUris });
  const device = config.devices[0];
  const adapter = values['enable-serial'] ? new PythonUsbAdapter({ python: config.python, device, allowCapture: values['capture-watch'] }) : new UnavailableAdapter();
  const bridge = new Bridge({ store, oauth, adapter });
  const server = createHttpServer({ bridge, oauth, publicBaseUrl, localHosts: [`127.0.0.1:${port}`, `localhost:${port}`] });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ service: 'esp32-white-mcp', listen: `http://127.0.0.1:${port}/mcp`, serial_enabled: values['enable-serial'], capture_enabled: values['capture-watch'], dot_connection_verified: false })));
  const pump = setInterval(() => { bridge.pump().catch(() => console.error('Webhook delivery state update failed')); }, 1000);
  let captureRunning = false;
  const intervalMs = config.captureIntervalMs ?? 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) throw new Error('Invalid capture interval');
  const capture = values['capture-watch'] ? setInterval(async () => {
    if (captureRunning) return;
    captureRunning = true;
    let phase = 'capture';
    try {
      const received = await bridge.serialized(device.id, () => adapter.execute(device.id, { operation: 'capture_once' }));
      phase = 'event_ingest';
      const report = await bridge.consumeCapture(oauth.owner, received, { localSceneFeedback: config.localSceneFeedback === true, localSceneFeedbackSeconds });
      if (received.scene_event) console.log(JSON.stringify({
        name: 'camera.scene_changed', device_id: received.scene_event.device_id, frame_sequence: received.scene_event.frame_sequence,
        captured_at: received.scene_event.captured_at, changed_fraction: received.scene_event.changed_fraction, mean_delta: received.scene_event.mean_delta,
        event_id: report.scene.eventId, queued: report.scene.queued ?? 0, duplicate: report.scene.duplicate,
        local_feedback_enabled: config.localSceneFeedback === true, local_feedback_completed: report.local_feedback?.state === 'completed',
        local_feedback_seconds: localSceneFeedbackSeconds, local_feedback_state: report.local_feedback?.state ?? 'disabled',
        ...(report.local_feedback?.reason ? { local_feedback_reason: safeErrorDetails({ data: { reason: report.local_feedback.reason } }).reason } : {}),
        rendered_revision: report.local_feedback?.receipt?.rendered_revision ?? null,
      }));
    } catch (error) { console.error(JSON.stringify({ name: 'camera.watcher_error', timestamp: new Date().toISOString(), device_id: device.id, phase, ...safeErrorDetails(error) })); }
    finally { captureRunning = false; }
  }, intervalMs) : null;
  const stop = () => {
    clearInterval(pump); if (capture) clearInterval(capture);
    adapter.close?.(); server.close();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
