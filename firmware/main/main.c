// TFT wiring and ST7735 settings match the user's verified GOOUUU display.
// Camera stays off at boot; only explicit probe/frame requests initialize it.
// SD, Bluetooth, Wi-Fi and servo GPIO are never initialized here.
#include "dot_core.h"
#include "dot_camera_profile.h"
#include "dot_capture.h"
#include "dot_transport.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "driver/spi_master.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_st7735.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_psram.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

enum { LCD_CS = 47, LCD_MOSI = 41, LCD_CLK = 42, LCD_DC = 21, LCD_RST = 1 };
static dot_state_t state;
static SemaphoreHandle_t mutex, completed;
static esp_lcd_panel_handle_t panel;
static uint8_t *pixels;
static bool display_ready, display_timeout;
static uint64_t source_epoch, capture_sequence;
static char board_mac[18];

static bool capture_allowed(void)
{
#if CONFIG_DOT_CAMERA_CAPTURE_ALLOWED && CONFIG_DOT_CAMERA_BOARD_CONFIRMED
    return true;
#else
    return false;
#endif
}

static dot_camera_prerequisites_t camera_prerequisites(void)
{
    return (dot_camera_prerequisites_t){
#if CONFIG_DOT_CAMERA_BOARD_CONFIRMED
        .board_revision_verified = true,
#else
        .board_revision_verified = false,
#endif
        .sensor_verified = dot_camera_esp32_last_sensor_pid() != 0,
        .driver_available = dot_camera_esp32_backend() != NULL,
        .psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        .internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
    };
}

static bool frame_sink(void *context, const uint8_t header[DOT_CAPTURE_HEADER_BYTES],
                       const uint8_t *frame, size_t length)
{
    (void)context;
    // Prevent ordinary stdout logging from splitting a frame packet. The lock
    // is released before camera deinit; driver tasks can still log during init.
    flockfile(stdout);
    fflush(stdout);
    int64_t deadline_us = esp_timer_get_time() + 5000000;
    bool ok = dot_transport_write_exact(header, DOT_CAPTURE_HEADER_BYTES, deadline_us)
              && dot_transport_write_exact(frame, length, deadline_us);
    funlockfile(stdout);
    return ok;
}

static bool draw_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *event, void *context)
{
    (void)io; (void)event;
    BaseType_t wake = pdFALSE;
    xSemaphoreGiveFromISR((SemaphoreHandle_t)context, &wake);
    return wake == pdTRUE;
}

static void display_task(void *context)
{
    (void)context;
    TickType_t wake = xTaskGetTickCount();
    while (true) {
        xSemaphoreTake(mutex, portMAX_DELAY);
        dot_state_tick(&state, esp_timer_get_time());
        dot_face_t face = state.face;
        uint32_t revision = state.revision;
        dot_render(pixels, face);
        esp_err_t err = esp_lcd_panel_draw_bitmap(panel, 0, 0, DOT_WIDTH, DOT_HEIGHT, pixels);
        if (err != ESP_OK || xSemaphoreTake(completed, pdMS_TO_TICKS(2000)) != pdTRUE) {
            display_ready = false;
            display_timeout = true;
            xSemaphoreGive(mutex);
            ESP_LOGE("dot.tft", "Transfer failed; DMA buffer retained and display task stopped");
            vTaskDelete(NULL);
            return;
        }
        // The revision is reported rendered only after DMA completed for this frame.
        dot_state_frame_done(&state, face, revision);
        xSemaphoreGive(mutex);
        xTaskDelayUntil(&wake, pdMS_TO_TICKS(50));
    }
}

static void init_display(void)
{
    mutex = xSemaphoreCreateMutex();
    completed = xSemaphoreCreateBinary();
    pixels = heap_caps_malloc(DOT_FRAME_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    ESP_ERROR_CHECK(mutex && completed && pixels ? ESP_OK : ESP_ERR_NO_MEM);
    const spi_bus_config_t bus = {.sclk_io_num = LCD_CLK, .mosi_io_num = LCD_MOSI, .miso_io_num = -1,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = DOT_FRAME_BYTES};
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
    esp_lcd_panel_io_handle_t io;
    const esp_lcd_panel_io_spi_config_t io_config = {.cs_gpio_num = LCD_CS, .dc_gpio_num = LCD_DC,
        .pclk_hz = 10000000, .spi_mode = 0, .lcd_cmd_bits = 8, .lcd_param_bits = 8, .trans_queue_depth = 1};
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_config, &io));
    const esp_lcd_panel_io_callbacks_t callbacks = {.on_color_trans_done = draw_done};
    ESP_ERROR_CHECK(esp_lcd_panel_io_register_event_callbacks(io, &callbacks, completed));
    const esp_lcd_panel_dev_config_t panel_config = {.reset_gpio_num = LCD_RST, .bits_per_pixel = 16,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR};
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7735(io, &panel_config, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, false, false));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 2, 1));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, false));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    display_ready = true;
    ESP_ERROR_CHECK(xTaskCreate(display_task, "dot_display", 4096, NULL, 3, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
}

static void reject(const char *code)
{
    printf("{\"ok\":false,\"error\":{\"code\":\"%s\"}}\n", code);
}

static void command(const char *line)
{
    if (strcmp(line, "camera.status") == 0) {
        printf("{\"ok\":true,\"payload\":{\"source_epoch\":\"%016" PRIx64 "\","
               "\"clock_us\":%" PRId64 ",\"time_base\":\"esp_timer_monotonic_us\","
               "\"camera_driver_present\":%s,\"camera_capture_allowed\":%s,"
               "\"camera_active\":%s,\"last_sensor_pid\":%u,"
               "\"board_mac\":\"%s\",\"transport\":\"%s\",\"baud_rate\":%u}}\n",
               source_epoch, esp_timer_get_time(), dot_camera_esp32_backend() ? "true" : "false",
               capture_allowed() ? "true" : "false", dot_camera_esp32_active() ? "true" : "false",
               (unsigned)dot_camera_esp32_last_sensor_pid(), board_mac,
               dot_transport_name(), dot_transport_baud_rate());
        return;
    }
    if (strcmp(line, "camera.probe") == 0) {
        const dot_capture_request_t probe = {
            .capture_authorized = capture_allowed(), .prerequisites = camera_prerequisites(),
            .source_epoch = source_epoch,
        };
        dot_capture_result_t result;
        const char *error = dot_camera_probe_once(dot_camera_esp32_backend(),
                                &dot_goouuu_camera_pins, &probe, &result);
        if (error) reject(error);
        else printf("{\"ok\":true,\"probe_complete\":true,\"sensor_pid\":%u,"
                    "\"camera_stopped\":true}\n", (unsigned)result.sensor_pid);
        return;
    }
    if (strcmp(line, "camera.frame") == 0) {
        dot_capture_request_t capture = {
            .capture_authorized = capture_allowed(), .prerequisites = camera_prerequisites(),
            .source_epoch = source_epoch, .sequence = ++capture_sequence,
        };
        dot_capture_result_t result;
        const char *error = dot_capture_once(dot_camera_esp32_backend(), &dot_goouuu_camera_pins,
                                            &capture, frame_sink, NULL, &result);
        if (error) reject(error);
        else printf("{\"ok\":true,\"capture_complete\":true,\"sequence\":%" PRIu64 ","
                    "\"sensor_pid\":%u,\"camera_stopped\":true}\n",
                    capture.sequence, (unsigned)result.sensor_pid);
        return;
    }
    dot_request_t request;
    if (!dot_parse_line(line, &request)) { reject("invalid_params"); return; }
    xSemaphoreTake(mutex, portMAX_DELAY);
    bool ready = display_ready, timeout = display_timeout;
    if (!request.status && ready) dot_state_apply(&state, &request, esp_timer_get_time());
    dot_state_t snapshot = state;
    xSemaphoreGive(mutex);
    if (request.status) {
        const dot_camera_prerequisites_t prerequisites = camera_prerequisites();
        uint32_t camera_blockers = dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites);
        printf("{\"ok\":true,\"payload\":{\"firmware\":\"dot-device-bridge-usb-v1\","
               "\"board\":\"GOOUUU ESP32 S3-CAM N16R8\",\"connection\":\"LOCAL USB\","
               "\"board_mac\":\"%s\",\"transport\":\"%s\",\"baud_rate\":%u,"
               "\"face\":\"%s\",\"rendered_face\":\"%s\",\"revision\":%lu,\"rendered_revision\":%lu,"
               "\"frames\":%lu,\"width\":128,\"height\":160,\"psram_bytes\":%u,"
               "\"display_ready\":%s,\"display_timeout\":%s,\"motor_enabled\":false,"
               "\"camera_enabled\":%s,\"wifi_enabled\":false,\"dot_connected\":false,"
               "\"camera_profile_valid\":%s,\"camera_capture_ready\":%s,"
               "\"camera_blockers\":%lu,\"camera_driver_present\":%s,"
               "\"camera_capture_allowed\":%s,\"last_sensor_pid\":%u}}\n",
               board_mac, dot_transport_name(), dot_transport_baud_rate(),
               dot_face_name(snapshot.face), dot_face_name(snapshot.rendered_face), (unsigned long)snapshot.revision,
               (unsigned long)snapshot.rendered_revision, (unsigned long)snapshot.frames,
               (unsigned)(esp_psram_is_initialized() ? esp_psram_get_size() : 0),
               ready ? "true" : "false", timeout ? "true" : "false",
               dot_camera_esp32_active() ? "true" : "false",
               dot_camera_pins_valid(&dot_goouuu_camera_pins) ? "true" : "false",
               capture_allowed() && camera_blockers == 0 ? "true" : "false",
               (unsigned long)camera_blockers,
               dot_camera_esp32_backend() ? "true" : "false", capture_allowed() ? "true" : "false",
               (unsigned)dot_camera_esp32_last_sensor_pid());
    } else if (!ready) reject("display_unavailable");
    else {
        printf("{\"ok\":true,\"accepted\":true,\"payload\":{\"face\":\"%s\",\"seconds\":%u,\"revision\":%lu}}\n",
               dot_face_name(request.face), request.seconds, (unsigned long)snapshot.revision);
    }
}

void app_main(void)
{
    dot_transport_init();
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA)); // Read eFuse identity; no Wi-Fi init.
    snprintf(board_mac, sizeof(board_mac), "%02x:%02x:%02x:%02x:%02x:%02x",
             (unsigned)mac[0], (unsigned)mac[1], (unsigned)mac[2],
             (unsigned)mac[3], (unsigned)mac[4], (unsigned)mac[5]);
    setvbuf(stdin, NULL, _IONBF, 0);
    source_epoch = ((uint64_t)esp_random() << 32) | esp_random();
    if (!source_epoch) source_epoch = 1; // Correlation identity, never an authentication token.
    init_display();
    puts("DOT / READY: independent TFT USB firmware; commands: status | auto | happy [1-60] | white [1-60] | camera.status | camera.probe | camera.frame");
    char line[64];
    size_t used = 0;
    bool overflow = false;
    while (true) {
        int ch = getchar();
        if (ch == EOF) { clearerr(stdin); vTaskDelay(pdMS_TO_TICKS(20)); }
        else if (ch == '\r' || ch == '\n') {
            line[used] = 0;
            if (overflow) reject("invalid_params");
            else if (used) command(line);
            used = 0;
            overflow = false;
        } else if (!overflow) {
            if (used < sizeof(line) - 1) line[used++] = (char)ch;
            else overflow = true;
        }
    }
}
