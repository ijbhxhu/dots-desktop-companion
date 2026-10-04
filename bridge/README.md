# ESP32 white event MCP bridge

This is a real MCP HTTP server and a bounded USB host adapter. It does not establish that the user's current dot is connected. No OpenAI model API or separate chatbot is used.

## Private Secure MCP Tunnel (fast path)

Use `config.private-tunnel.example.json`. It binds **127.0.0.1:8787/mcp** and has one owner and one device. It exposes no OAuth discovery metadata (404). The authenticated OpenAI Secure MCP Tunnel protects the external connection; a separate random capability protects the loopback origin. Do not publish this mode through a public/quick Cloudflare URL.

Provide these process environment variables without printing them:

- `DOT_STATE_KEY`: base64 of exactly 32 random bytes, retained securely to decrypt durable state after restart.
- `DOT_TUNNEL_LOCAL_BEARER`: 32 random bytes encoded as base64url, used only by the local bridge.
- `DOT_TUNNEL_LOCAL_AUTHORIZATION`: `Bearer ` followed by the same local capability, used in the tunnel client's Authorization `extraHeaders` with its supported `env:DOT_TUNNEL_LOCAL_AUTHORIZATION` indirection.
- `CONTROL_PLANE_API_KEY`: the official tunnel client's authorized runtime credential, separate from the bridge's capability. Never put it in this config or source.

```powershell
node src/cli.mjs --config config.private-tunnel.example.json
```

This starts the endpoint without opening a serial port. Add `--enable-serial` only when the root agent releases COM4 ownership and the firmware identity is verified. Add `--capture-watch` only after explicit capture authorization and timing calibration.

The official tunnel configuration must use the already authorized tunnel ID, forward to `http://127.0.0.1:8787/mcp`, and inject the local Authorization capability. Do not invent a public OAuth issuer at api.openai.com; the private origin has no OAuth endpoints.

See [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). A tunnel is a transport. Workspace association, developer-mode/plugin access, event scan, and a subscription created **inside the user's current dot** are still necessary.

## Public HTTPS OAuth mode (separate option)

`config.example.json` requires a real publicly reachable canonical HTTPS origin and the exact redirect URI shown in ChatGPT's MCP management page. Replace the example origin; never treat it as deployed. Supply `DOT_PAIRING_CODE` (at least 24 private bytes) and the same `DOT_STATE_KEY` securely. OAuth uses DCR, PKCE S256, exact resource/audience binding, explicit owner consent, short-lived single-use codes, hashed access credentials, and rotating refresh credentials. Never expose the older unauthenticated Python prototype.

## Tools and events

Authenticated `/mcp` supports `server/discover` (2026-07-28), `tools/list`, `tools/call`, `events/list`, `events/subscribe`, and `events/unsubscribe`. Legacy initialization is tool-only. Tools are `device_status`, `camera_status`, `screen_set`, and `command_status`. `screen_set` supports happy 1–60 seconds or auto and requires a device-scoped idempotency key. An accepted firmware reply is distinct from a completed rendered revision. A restart during an ambiguous physical send produces an uncertain receipt and never resends automatically.

`camera.white_detected` filters by owned `device_id`. Subscriptions verify a signed challenge, persist encrypted owner/filter/callback/key/expiry state, refresh deterministically, rotate webhook signing keys, and stop after expiration, revocation, unsubscribe or HTTP410. Webhooks sign exact request bytes with Standard Webhooks HMAC and preserve event IDs across at most five retries. HTTPS destinations are resolved and pinned at each connection, private/reserved IPs and redirects are blocked. There is no public HTTP event-ingest route. No images or credentials enter event data.

`camera.scene_changed` adds clear scene changes while preserving the white event and its existing IDs. It uses an8×6 grid of RGB means sampled over the central80% of the frame. A cell changes at mean RGB difference≥24/255; a candidate needs≥30% changed cells and a whole-grid normalized mean difference≥0.08. Two consecutive valid frames over≥0.2 seconds confirm the same reference change; a single flash is ignored. There is a3-second cooldown, small exposure drift is followed slowly, and invalid/gapped frames reset the reference. The capture timestamp/CRC/epoch/sequence checks remain unchanged. These thresholds detect clear image differences, including lighting changes; they do not identify objects.

The Python `capture_once` reply retains `event` for white compatibility and adds nullable `scene_event`. Scene data contains `device_id`, `source_epoch`, `frame_sequence`, `captured_at`, `sensor_pid`, `simulation:false`, `changed_fraction`, `mean_delta`, `held_seconds` and `samples`. Only the small comparison grid remains in RAM; pixels are neither saved nor uploaded.

Set the nonsecret config `localSceneFeedback:true` with authorized `--enable-serial --capture-watch` to send an idempotent local `happy8` command on a confirmed scene change, through the same serial queue. `localSceneFeedbackSeconds` optionally selects an integer from1 to60 (default8). The firmware restores auto/READY when that duration expires. This immediate local action is independent of a dot subscription; the scene event is separately available to the current dot. CLI emits one aggregate JSON receipt for each confirmed scene with `local_feedback_completed`, `local_feedback_seconds` and `rendered_revision`; an accepted-only reply is never reported as completed. Restart the bridge and rescan plugin events to enable the new event catalog.

Watcher failures emit controlled `camera.watcher_error` JSON with timestamp, device ID, phase, numeric error code and an allowlisted reason; firmware rejections can also include an allowlisted `firmware_code`. No raw exception messages, stack traces, credentials or pixel bytes are logged. Normal frames without white/scene events are successful no-ops. Runtime error counts must be measured since the latest service start; old generic messages are cumulative history and cannot establish the current failure rate.

The native USB profile is VID303A/PID1001 at115200. The verified CH340 UART0 profile is VID1A86/PID7523 at460800, explicitly COM4 and MACaa:bb:cc:dd:ee:ff. The adapter checks firmware `board_mac`, `transport` and `baud_rate` on the actual command channel. It never flashes or changes DTR/RTS. Camera DCF1 validates the44-byte header,160×120 RGB565BE payload,38400-byte length, CRC32, epoch, sequence and completion/stop receipt. Capture time is mapped once from MCU monotonic time; pixels remain in memory.

The native policy defaults to500ms age/gap. The UART example permits2 seconds age/gap and requires at least3 valid white samples over at least1 second, with hysteresis/clearing/3-second cooldown. This is an explicitly different timing profile. **Calibrate actual capture age/cadence before capture watch**; a2-second age check has already rejected one real transfer and must not be bypassed with arrival timestamps.

## Validation

```powershell
node --test --test-isolation=none test/bridge.test.mjs
& 'C:\Espressif\tools\python\v6.0.1\venv\Scripts\python.exe' -m unittest discover -s python -p 'test_*.py'
```

Tests use ephemeral loopback HTTP, random in-memory credentials, mock public callbacks and synthetic DCF1 bytes. They do not open COM4, initialize a camera, start a tunnel, create an external subscription, or prove dot receipt.

## Final connection proof

Connect this private MCP server through the existing authorized Secure MCP Tunnel, scan its tools/events in the user's plugin, and ask the current dot to subscribe to `camera.white_detected` for `esp32-demo` and call `screen_set` with an event-derived idempotency key. Verify signed callback activation and actual event receipt in that dot. Then compare the returned firmware rendered revision with the LCD. Webhook2xx proves callback receipt; it does not prove that the dot ran its task or completed a physical frame.

Protocol sources: [official MCP events](https://developers.openai.com/plugins/build/mcp-events), [official authentication](https://developers.openai.com/plugins/build/auth), [official MCP server guide](https://developers.openai.com/plugins/build/mcp-server).
