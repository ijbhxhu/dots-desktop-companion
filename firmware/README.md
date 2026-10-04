# Dots ESP32 firmware

Current build, pins, transport and validation are documented in [the root README](../README.md).
The default build has camera capture disabled. `build_preflight.ps1 -CameraReady -Transport Uart0` enables the explicit single-frame camera interface with the pinned official driver.
`status`, `auto`, `happy [1..60]`, `white [1..60]`, `camera.status`, `camera.probe`, `camera.frame` are supported. Binary frames require the bounded Python reader, never a text serial monitor.
Only one host process may own the serial port. Use your own verified board identity and unchanged partition table before any app-only flash; no automatic flash helper is bundled.
