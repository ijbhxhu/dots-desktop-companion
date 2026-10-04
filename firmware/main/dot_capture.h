#pragma once
#include "dot_camera_profile.h"

enum { DOT_CAPTURE_HEADER_BYTES = 44, DOT_CAPTURE_RGB565_BE = 1 };
typedef struct {
    const uint8_t *pixels;
    size_t length, width, height;
    int64_t captured_us;
    unsigned pixel_format;
    void *lease;
} dot_capture_frame_t;

typedef struct {
    void *context;
    bool (*start)(void *context, const dot_camera_pins_t *pins, uint16_t *sensor_pid);
    bool (*acquire)(void *context, dot_capture_frame_t *frame);
    void (*release)(void *context, dot_capture_frame_t *frame);
    bool (*stop)(void *context);
    int64_t (*clock_us)(void *context);
} dot_capture_backend_t;

typedef bool (*dot_capture_sink_t)(void *context, const uint8_t header[DOT_CAPTURE_HEADER_BYTES],
                                   const uint8_t *pixels, size_t length);

typedef struct {
    bool capture_authorized;
    dot_camera_prerequisites_t prerequisites;
    uint64_t source_epoch, sequence;
} dot_capture_request_t;

typedef struct {
    uint16_t sensor_pid;
    uint32_t frame_crc32;
    int64_t captured_us;
    bool frame_transferred, camera_stopped;
} dot_capture_result_t;

// The caller must serialize capture requests. No backend is invoked unless
// capture_authorized, a verified board profile, a driver and memory checks pass.
const char *dot_capture_once(const dot_capture_backend_t *backend,
                            const dot_camera_pins_t *pins, const dot_capture_request_t *request,
                            dot_capture_sink_t sink, void *sink_context, dot_capture_result_t *result);

// Initializes the approved backend only to read PID, then always deinitializes.
// Does not call acquire/release/sink and never returns pixel data.
const char *dot_camera_probe_once(const dot_capture_backend_t *backend,
                            const dot_camera_pins_t *pins, const dot_capture_request_t *request,
                            dot_capture_result_t *result);
uint32_t dot_capture_crc32(const uint8_t *bytes, size_t length);
const dot_capture_backend_t *dot_camera_esp32_backend(void);
bool dot_camera_esp32_active(void);
uint16_t dot_camera_esp32_last_sensor_pid(void);
