---
name: esp32-dots
description: Read the user's ESP32 Dots device, receive camera scene-change events, and control its READY or HAPPY TFT display.
---

Use the existing ESP32 MCP tools. Device ID: `esp32-demo`.

1. Start with `device_status` and `camera_status` to verify the real device. The camera watcher captures repeatedly only when explicitly enabled in the runtime.
2. For a scene-change workflow, subscribe to `camera.scene_changed` using the host's supported event/automation flow and this device ID. Use the host-issued callback and signing secret; do not invent either.
3. When an actual scene event is received, call `screen_set` with `face: happy`, `seconds: 3`, and an `idempotency_key` derived from that event ID. The firmware returns to READY automatically.
4. A successful render requires `state: completed` and a completed rendered revision. An accepted command or webhook acknowledgement is not proof of an LCD update. After an uncertain result, use `command_status`; do not send the same physical command with a new key.
5. `camera.white_detected` remains available for the original white-event workflow.

Do not upload frames or expose credentials. The camera detector emits aggregate evidence. Do not enable motors, audio, Wi-Fi, reset, or flashing through this workflow.

The package's stdio connection is for this Windows computer. ChatGPT cloud must separately connect the existing Secure MCP Tunnel; local installation does not prove cloud or dot connectivity.
