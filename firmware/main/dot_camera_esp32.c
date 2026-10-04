#include "dot_capture.h"

#if defined(DOT_CAMERA_WITH_ESP32_DRIVER) && DOT_CAMERA_WITH_ESP32_DRIVER
#include "esp_camera.h"
#include "esp_timer.h"

// API targeted: espressif/esp32-camera v2.1.8. The dependency is NOT vendored
// or downloaded automatically. Compile this branch only after dependency approval.
static bool active;
static uint16_t last_sensor_pid;

static bool start(void *context, const dot_camera_pins_t *pins, uint16_t *sensor_pid)
{
    (void)context;
    if (active || !pins || !sensor_pid) return false;
    const camera_config_t config = {
        .pin_d0 = pins->data[0], .pin_d1 = pins->data[1], .pin_d2 = pins->data[2], .pin_d3 = pins->data[3],
        .pin_d4 = pins->data[4], .pin_d5 = pins->data[5], .pin_d6 = pins->data[6], .pin_d7 = pins->data[7],
        .pin_sccb_sda = pins->sda, .pin_sccb_scl = pins->scl,
        .pin_vsync = pins->vsync, .pin_href = pins->href, .pin_pclk = pins->pclk,
        .pin_xclk = pins->xclk, .pin_pwdn = pins->pwdn, .pin_reset = pins->reset,
        .xclk_freq_hz = 20000000, .ledc_timer = LEDC_TIMER_0, .ledc_channel = LEDC_CHANNEL_0,
        .pixel_format = PIXFORMAT_RGB565, .frame_size = FRAMESIZE_QQVGA,
        .fb_count = 1, .fb_location = CAMERA_FB_IN_PSRAM, .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
    };
    if (esp_camera_init(&config) != ESP_OK) return false; // Driver cleans a failed probe/init.
    active = true;
    sensor_t *sensor = esp_camera_sensor_get();
    *sensor_pid = sensor ? sensor->id.PID : 0;
    last_sensor_pid = *sensor_pid;
    return true;
}

static bool acquire(void *context, dot_capture_frame_t *frame)
{
    (void)context;
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) return false;
    int64_t seconds = (int64_t)fb->timestamp.tv_sec;
    int64_t micros = (int64_t)fb->timestamp.tv_usec;
    int64_t captured_us = -1;
    if (seconds >= 0 && micros >= 0 && micros < 1000000
            && seconds <= (INT64_MAX - micros) / 1000000)
        captured_us = seconds * 1000000 + micros;
    // The lease is always returned by the capture core, including invalid frames.
    *frame = (dot_capture_frame_t){
        .pixels = fb->buf, .length = fb->len, .width = fb->width, .height = fb->height,
        .captured_us = captured_us,
        .pixel_format = fb->format == PIXFORMAT_RGB565 ? DOT_CAPTURE_RGB565_BE : 0,
        .lease = fb,
    };
    return true;
}

static void release(void *context, dot_capture_frame_t *frame)
{
    (void)context;
    esp_camera_fb_return((camera_fb_t *)frame->lease);
    frame->lease = NULL;
}

static bool stop(void *context)
{
    (void)context;
    bool stopped = esp_camera_deinit() == ESP_OK;
    if (stopped) active = false;
    return stopped;
}

static int64_t clock_us(void *context) { (void)context; return esp_timer_get_time(); }
const dot_capture_backend_t *dot_camera_esp32_backend(void)
{
    static const dot_capture_backend_t backend = {
        .start = start, .acquire = acquire, .release = release, .stop = stop, .clock_us = clock_us,
    };
    return &backend;
}
bool dot_camera_esp32_active(void) { return active; }
uint16_t dot_camera_esp32_last_sensor_pid(void) { return last_sensor_pid; }
#else
const dot_capture_backend_t *dot_camera_esp32_backend(void) { return NULL; }
bool dot_camera_esp32_active(void) { return false; }
uint16_t dot_camera_esp32_last_sensor_pid(void) { return 0; }
#endif
