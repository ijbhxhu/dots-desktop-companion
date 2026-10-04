# ESP32 Dots local plugin

Portable Agent Plugins 1.0 package. Set `ESP32_BRIDGE_STATE_DIR` in `mcp.json` to your own running bridge's `.state` directory before local installation. No API key belongs in the package.
The stdio adapter forwards the existing authenticated loopback MCP; it never opens another serial reader.
For ChatGPT cloud, use your own Secure MCP Tunnel connection and explicitly activate the current Dots event subscription. Account saving and cloud event receipt are separate steps.
