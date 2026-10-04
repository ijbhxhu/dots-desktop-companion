# Dots 桌面夥伴

GOOUUU ESP32 S3-CAM 相機、ST7735 TFT 與本機 MCP bridge。LCD 使用提供的 Dots 角色；相機偵測明顯影像變化後，顯示綠色大字 **HAPPY** 8 秒，再回到 READY。

## 目前可用

- ESP32-S3 / 16 MB flash / 8 MB PSRAM，ESP-IDF 6.0.1。
- ST7735 128 × 160 TFT，Dots 圖形、READY、明顯 HAPPY 提示。
- 板上相機單張 160 × 120 RGB565 擷取；實機讀到 sensor PID `0x3660`。
- CH340 UART0，460800 / 8N1；先核對自己的 COM、VID/PID、MAC。
- MCP tools：`device_status`、`camera_status`、`screen_set`、`command_status`。
- Events：`camera.white_detected`、`camera.scene_changed`；只傳統計資料，影像留在 RAM。
- 本機 scene feedback 已實作；ChatGPT Dots 的實際事件訂閱仍須由該 Dots 建立及驗證。

MG90S、MAX98357A 音訊與 Wi-Fi 尚未在此 firmware 啟用。

## 原始碼

| 目錄 | 用途 |
| --- | --- |
| `firmware/` | ESP-IDF 韌體、相機介面、LCD renderer、host tests |
| `bridge/` | Node MCP server、Python USB adapter、加密事件/指令狀態 |
| `plugin/` | Agent Plugins 1.0 本機 connection package |
| `assets/` | 提供的 Dots PNG 與韌體所用圖形來源 |

## 接線

TFT：CLK GPIO42、MOSI GPIO41、CS GPIO47、DC GPIO21、RST GPIO1；SPI 10 MHz / BGR，offset X=2、Y=1。

GOOUUU camera：D0..D7 = 11,9,8,10,12,18,17,16；SDA4、SCL5、VSYNC6、HREF7、XCLK15、PCLK13；RESET/PWDN=-1。請核對自己的板型，其他 ESP32-CAM 腳位不能直接套用。

## Build 與驗證

已驗證工具版本：ESP-IDF 6.0.1、官方 `espressif/esp32-camera` 2.1.8、Python 3.12、Node 26（bridge 要求 >=22）。測試不操作硬體。

```powershell
# 已安裝 ESP-IDF 的 Windows 環境；build 本身不開 serial port。
pwsh -File firmware/build_preflight.ps1 -CameraReady -Transport Uart0 -StageDir C:\Espressif\projects\dots-desktop-companion
pwsh -File firmware/host_test.ps1 -HostCompiler C:/path/to/llvm-mingw/bin/clang.exe
cd bridge
node --test --test-isolation=none test/*.test.mjs
python -m unittest discover -s python -p 'test_*.py'
```

本次 source 驗證：19 firmware host tests、29 Node tests、22 Python adapter tests 通過；camera-ready app build 與 app-only flash hash verification 通過。這些結果不表示 ChatGPT Dots 已收到事件，也不代替 LCD 的肉眼確認。

## 啟動本機 bridge / Tunnel

1. 在 `bridge/` 把 `config.private-tunnel.example.json` 複製為 `config.local.json`，填自己的 Python 路徑、device ID、COM 和預期 MAC；example MAC 是假值。
2. 把 `runtime.example.json` 複製為 `runtime.local.json`，填已建立的 Tunnel ID 和官方 tunnel-client 路徑。
3. 將自己的 runtime API key **私下**存入忽略的 `bridge/.env.local`，格式為 `CONTROL_PLANE_API_KEY=...`；不要貼在聊天、commit 或 README。
4. `node run-tunnel-session.mjs --capture-watch`。這會開啟相機定期單張擷取，需在已確認硬體與授權的環境執行。

bridge 只 listen `127.0.0.1:8787/mcp`，使用獨立 local bearer capability；Tunnel 使用自己的 platform runtime credential。`.state/` 含私有 capability 和加密 state，不可上傳。launcher 保留首次啟動後 24 小時截止；這不是 API key 到期設定。

ChatGPT Plugins 的 Connection 選 **Tunnel**，使用自己的 existing Tunnel ID，再掃描 tools/events。要由目前的 Dots 訂閱 `camera.scene_changed`，事件後呼叫 `screen_set`，並比對 signed callback 與實際 `rendered_revision` 才能證明完整連線。本機自動 HAPPY 不能作為 cloud round-trip 證據。

`plugin/mcp.json` 是本機 stdio connection；先填自己的 `ESP32_BRIDGE_STATE_DIR` 絕對路徑。此套件不等於已建立 ChatGPT cloud connection。

參考：[Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[MCP events](https://developers.openai.com/plugins/build/mcp-events)。

## 相機協定與資料界線

`camera.status` 不擷取；`camera.probe` 只初始化探測後停止；`camera.frame` 回傳 DCF1 header + RGB565 frame + completion JSON，單次結束後關閉相機。USB adapter 檢查長度、CRC、epoch、sequence、MCU capture timestamp、freshness 與 camera stop receipt。UART 範例 max age/gap 為 2 秒，不能以收到時間替代 capture time。

變化偵測使用中央 80% 的 8 × 6 RGB grid，至少 30% cells 明顯變化、mean delta >=0.08、兩張連續有效 frame 確認，3 秒 cooldown。光線变化也可能觸發，並非物件辨識。可用 `localSceneFeedbackSeconds` 調整 HAPPY 1–60 秒，預設 8 秒。

## 第三方內容

`firmware/components/st7735` 保留上游 waveshare/esp_lcd_st7735 2.0.0 的來源與 notices；partition table 的既有 notices 亦保留。相機使用官方 Espressif component。Dots 圖形為本專案提供的素材，未另行宣告可再授權條款。
