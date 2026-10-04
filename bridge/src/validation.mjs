import { createHash, timingSafeEqual } from 'node:crypto';

export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const safeReasons = new Set([
  'adapter_disabled', 'adapter_failed', 'adapter_type_error', 'adapter_value_error', 'adapter_import_failed', 'adapter_io_failed',
  'adapter_reply_too_large', 'invalid_adapter_reply', 'adapter_reply_mismatch', 'worker_failed', 'worker_exited', 'adapter_timeout', 'adapter_closed', 'serial_busy',
  'truncated_header', 'invalid_frame_header', 'frame_identity_mismatch', 'frame_source_epoch_mismatch', 'frame_sequence_replayed', 'invalid_capture_clock', 'invalid_pixels', 'invalid_scene_sample', 'invalid_clock_status',
  'host_clock_jump', 'clock_mapping_uncertain', 'stale_capture_clock', 'capture_not_fresh', 'invalid_detector_sample',
  'serial_timeout', 'serial_read_failed', 'serial_write_failed', 'serial_write_timeout', 'serial_line_too_large', 'serial_noise_limit',
  'firmware_rejected', 'frame_crc_mismatch', 'capture_not_complete', 'port_identity_mismatch', 'port_open_failed',
  'invalid_command', 'firmware_identity_mismatch', 'invalid_screen_command', 'invalid_command_receipt', 'capture_not_authorized',
  'camera_not_ready', 'invalid_operation', 'request_too_large', 'invalid_params', 'access_denied', 'capacity_reached', 'unexpected_error',
]);
const firmwareCodes = new Set([
  'invalid_params', 'display_unavailable', 'invalid_capture_request', 'camera_disabled', 'camera_driver_missing',
  'camera_preconditions_failed', 'invalid_capture_clock', 'camera_init_failed', 'camera_sensor_unidentified',
  'camera_frame_unavailable', 'camera_frame_invalid', 'camera_frame_stale', 'camera_transfer_failed', 'camera_stop_failed',
]);
export const safeFirmwareCode = value => firmwareCodes.has(value) ? value : null;
export function safeErrorDetails(error) {
  const code = Number.isSafeInteger(error?.code) ? error.code : null;
  const reason = safeReasons.has(error?.data?.reason) ? error.data.reason
    : code === -32602 ? 'invalid_params' : code === -32003 ? 'access_denied' : code === -32005 ? 'capacity_reached' : 'unexpected_error';
  const firmware_code = safeFirmwareCode(error?.data?.firmware_code);
  return { code, reason, ...(firmware_code ? { firmware_code } : {}) };
}
export const invalid = (reason = 'Invalid parameters') => { throw new RpcError(-32602, reason); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export const secureEqual = (a, b) => timingSafeEqual(Buffer.from(digest(String(a))), Buffer.from(digest(String(b))));
export const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function object(v, allowed, required = []) {
  if (!isObject(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) invalid();
  return v;
}
export function text(v, max = 128) { if (typeof v !== 'string' || !v.length || v.length > max || /[\u0000-\u001f]/u.test(v)) invalid(); return v; }
export function id(v) { if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/u.test(v)) invalid('Invalid identifier'); return v; }
export function integer(v, min, max) { if (!Number.isSafeInteger(v) || v < min || v > max) invalid(); return v; }
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
