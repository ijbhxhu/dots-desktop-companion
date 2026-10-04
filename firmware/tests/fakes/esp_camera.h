#pragma once
// Hand-written API-shaped test double; not the Espressif driver or ABI proof.
#include <stddef.h>
#include <stdint.h>
#include <sys/time.h>
typedef int esp_err_t;
enum { ESP_OK = 0, LEDC_TIMER_0 = 0, LEDC_CHANNEL_0 = 0 };
typedef enum { PIXFORMAT_RGB565 = 1, PIXFORMAT_JPEG = 2 } pixformat_t;
typedef enum { FRAMESIZE_QQVGA = 1 } framesize_t;
typedef enum { CAMERA_FB_IN_PSRAM = 1 } camera_fb_location_t;
typedef enum { CAMERA_GRAB_WHEN_EMPTY = 1 } camera_grab_mode_t;
typedef struct {
    int pin_d0, pin_d1, pin_d2, pin_d3, pin_d4, pin_d5, pin_d6, pin_d7;
    int pin_sccb_sda, pin_sccb_scl, pin_vsync, pin_href, pin_pclk, pin_xclk, pin_pwdn, pin_reset;
    int xclk_freq_hz, ledc_timer, ledc_channel;
    pixformat_t pixel_format;
    framesize_t frame_size;
    size_t fb_count;
    camera_fb_location_t fb_location;
    camera_grab_mode_t grab_mode;
} camera_config_t;
typedef struct {
    uint8_t *buf;
    size_t len, width, height;
    pixformat_t format;
    struct timeval timestamp;
} camera_fb_t;
typedef struct { struct { uint16_t PID; } id; } sensor_t;
esp_err_t esp_camera_init(const camera_config_t *config);
esp_err_t esp_camera_deinit(void);
camera_fb_t *esp_camera_fb_get(void);
void esp_camera_fb_return(camera_fb_t *frame);
sensor_t *esp_camera_sensor_get(void);
