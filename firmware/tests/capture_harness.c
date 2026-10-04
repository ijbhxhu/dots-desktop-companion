#include "dot_capture.h"
#include "esp_camera.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t pixels[DOT_CAMERA_FRAME_BYTES];
static dot_capture_frame_t frame;
static camera_fb_t esp_frame;
static sensor_t sensor = {.id = {.PID = 0x26}}; // Synthetic PID; not hardware evidence.
static camera_config_t saved_config;
static int starts, frame_get_count, releases, stops, emitted, clocks;
static bool start_ok = true, get_ok = true, stop_ok = true, sink_ok = true;
static uint16_t pid = 0x26;
static uint8_t saved_header[DOT_CAPTURE_HEADER_BYTES];
static const char *fixture;

static bool start(void *ctx, const dot_camera_pins_t *pins, uint16_t *out_pid)
{ (void)ctx; assert(pins == &dot_goouuu_camera_pins); ++starts; *out_pid = pid; return start_ok; }
static bool get(void *ctx, dot_capture_frame_t *out)
{ (void)ctx; ++frame_get_count; *out = frame; return get_ok; }
static void release(void *ctx, dot_capture_frame_t *out)
{ (void)ctx; assert(out->lease == pixels); ++releases; }
static bool stop(void *ctx) { (void)ctx; ++stops; return stop_ok; }
static int64_t clock_us(void *ctx) { (void)ctx; return clocks++ == 0 ? 1000000 : 1200000; }
static bool sink(void *ctx, const uint8_t *header, const uint8_t *bytes, size_t length)
{
    (void)ctx; assert(bytes == pixels && length == DOT_CAMERA_FRAME_BYTES);
    ++emitted; memcpy(saved_header, header, DOT_CAPTURE_HEADER_BYTES);
    if (fixture) {
        FILE *file = fopen(fixture, "wb"); assert(file);
        assert(fwrite(header, 1, DOT_CAPTURE_HEADER_BYTES, file) == DOT_CAPTURE_HEADER_BYTES);
        assert(fwrite(bytes, 1, length, file) == length); assert(fclose(file) == 0);
    }
    return sink_ok;
}
static uint64_t read_le(const uint8_t *bytes, size_t length)
{ uint64_t value = 0; for (size_t i = 0; i < length; ++i) value |= (uint64_t)bytes[i] << (8 * i); return value; }
static void reset(void)
{
    starts = frame_get_count = releases = stops = emitted = clocks = 0;
    start_ok = get_ok = stop_ok = sink_ok = true; pid = 0x26;
    memset(pixels, 0xff, sizeof(pixels));
    frame = (dot_capture_frame_t){.pixels = pixels, .length = sizeof(pixels), .width = 160, .height = 120,
        .captured_us = 1100000, .pixel_format = DOT_CAPTURE_RGB565_BE, .lease = pixels};
    esp_frame = (camera_fb_t){.buf = pixels, .len = sizeof(pixels), .width = 160, .height = 120,
        .format = PIXFORMAT_RGB565, .timestamp = {.tv_sec = 1, .tv_usec = 100000}};
}
static dot_capture_request_t request(void)
{
    return (dot_capture_request_t){.capture_authorized = true, .source_epoch = 0x123456789abcdef0ULL, .sequence = 7,
        .prerequisites = {.board_revision_verified = true, .sensor_verified = false, .driver_available = true,
            .psram_free = 8 * 1024 * 1024, .internal_free = 128 * 1024}};
}
static const dot_capture_backend_t backend = {.start = start, .acquire = get, .release = release, .stop = stop, .clock_us = clock_us};
static const char *capture(const dot_capture_request_t *req, dot_capture_result_t *result)
{ return dot_capture_once(&backend, &dot_goouuu_camera_pins, req, sink, NULL, result); }

// Fakes below exercise the production esp32-camera adapter's configuration,
// buffer lease and cleanup calls. They do not load or test a real sensor driver.
esp_err_t esp_camera_init(const camera_config_t *config)
{ ++starts; saved_config = *config; return start_ok ? ESP_OK : -1; }
esp_err_t esp_camera_deinit(void) { ++stops; return stop_ok ? ESP_OK : -1; }
camera_fb_t *esp_camera_fb_get(void) { ++frame_get_count; return get_ok ? &esp_frame : NULL; }
void esp_camera_fb_return(camera_fb_t *fb) { assert(fb == &esp_frame); ++releases; }
sensor_t *esp_camera_sensor_get(void) { return &sensor; }
int64_t esp_timer_get_time(void) { return clock_us(NULL); }

int main(int argc, char **argv)
{
    assert(argc == 2 || argc == 3); fixture = argc == 3 ? argv[2] : NULL;
    int group = atoi(argv[1]); reset();
    dot_capture_request_t req = request(); dot_capture_result_t result;
    if (group == 1) {
        req.capture_authorized = false;
        assert(strcmp(capture(&req, &result), "camera_disabled") == 0);
        assert(starts == 0 && frame_get_count == 0 && emitted == 0);
        req = request(); req.prerequisites.board_revision_verified = false;
        assert(strcmp(capture(&req, &result), "camera_preconditions_failed") == 0 && starts == 0);
        req = request(); req.prerequisites.driver_available = false;
        assert(strcmp(capture(&req, &result), "camera_preconditions_failed") == 0 && starts == 0);
        req = request();
        assert(strcmp(dot_capture_once(NULL, &dot_goouuu_camera_pins, &req, sink, NULL, &result), "camera_driver_missing") == 0);
        req.source_epoch = 0; assert(strcmp(capture(&req, &result), "invalid_capture_request") == 0);
        req = request(); req.prerequisites.psram_free = 0;
        assert(strcmp(capture(&req, &result), "camera_preconditions_failed") == 0 && starts == 0);
    } else if (group == 2) {
        assert(capture(&req, &result) == NULL);
        assert(starts == 1 && frame_get_count == 1 && releases == 1 && stops == 1 && emitted == 1);
        assert(result.sensor_pid == 0x26 && result.frame_transferred && result.camera_stopped);
        assert(result.captured_us == 1100000); // Not the 1200000-us arrival/check time.
        assert(memcmp(saved_header, "DCF1", 4) == 0 && saved_header[4] == 1 && saved_header[5] == 1);
        assert(read_le(saved_header + 6, 2) == 44);
        assert(read_le(saved_header + 8, 8) == req.source_epoch && read_le(saved_header + 16, 8) == req.sequence);
        assert(read_le(saved_header + 24, 8) == 1100000);
        assert(read_le(saved_header + 32, 2) == 160 && read_le(saved_header + 34, 2) == 120);
        assert(read_le(saved_header + 36, 4) == sizeof(pixels));
        assert(read_le(saved_header + 40, 4) == dot_capture_crc32(pixels, sizeof(pixels)));
    } else if (group == 3) {
        for (int variant = 0; variant < 7; ++variant) {
            reset();
            if (variant == 0) --frame.length;
            if (variant == 1) frame.width = 320;
            if (variant == 2) frame.pixel_format = 0;
            if (variant == 3) frame.pixels = NULL;
            if (variant == 4) frame.captured_us = 999999;
            if (variant == 5) frame.captured_us = 1200001;
            if (variant == 6) frame.captured_us = -1;
            assert(capture(&req, &result) != NULL);
            assert(releases == 1 && stops == 1 && emitted == 0 && !result.frame_transferred);
        }
    } else if (group == 4) {
        start_ok = false; assert(strcmp(capture(&req, &result), "camera_init_failed") == 0 && frame_get_count == 0 && stops == 0);
        reset(); pid = 0; assert(strcmp(capture(&req, &result), "camera_sensor_unidentified") == 0 && frame_get_count == 0 && stops == 1);
        reset(); get_ok = false; assert(strcmp(capture(&req, &result), "camera_frame_unavailable") == 0 && releases == 0 && stops == 1);
        reset(); sink_ok = false; assert(strcmp(capture(&req, &result), "camera_transfer_failed") == 0 && releases == 1 && stops == 1);
        reset(); stop_ok = false; assert(strcmp(capture(&req, &result), "camera_stop_failed") == 0 && result.frame_transferred && !result.camera_stopped);
    } else if (group == 5) {
        const dot_capture_backend_t *real_adapter = dot_camera_esp32_backend(); assert(real_adapter);
        assert(dot_capture_once(real_adapter, &dot_goouuu_camera_pins, &req, sink, NULL, &result) == NULL);
        assert(saved_config.pin_d0 == 11 && saved_config.pin_d1 == 9 && saved_config.pin_d2 == 8 && saved_config.pin_d3 == 10);
        assert(saved_config.pin_d4 == 12 && saved_config.pin_d5 == 18 && saved_config.pin_d6 == 17 && saved_config.pin_d7 == 16);
        assert(saved_config.pin_sccb_sda == 4 && saved_config.pin_sccb_scl == 5);
        assert(saved_config.pin_xclk == 15 && saved_config.pin_pclk == 13 && saved_config.pin_vsync == 6 && saved_config.pin_href == 7);
        assert(saved_config.pin_pwdn == -1 && saved_config.pin_reset == -1);
        assert(saved_config.fb_count == 1 && saved_config.fb_location == CAMERA_FB_IN_PSRAM);
        assert(saved_config.pixel_format == PIXFORMAT_RGB565 && saved_config.frame_size == FRAMESIZE_QQVGA);
        assert(!dot_camera_esp32_active() && dot_camera_esp32_last_sensor_pid() == 0x26);
        assert(releases == 1 && stops == 1 && result.frame_transferred);
        reset(); esp_frame.format = PIXFORMAT_JPEG;
        assert(strcmp(dot_capture_once(real_adapter, &dot_goouuu_camera_pins, &req, sink, NULL, &result), "camera_frame_invalid") == 0);
        assert(releases == 1 && stops == 1 && emitted == 0);
        reset(); esp_frame.timestamp.tv_usec = 1000000;
        assert(strcmp(dot_capture_once(real_adapter, &dot_goouuu_camera_pins, &req, sink, NULL, &result), "camera_frame_stale") == 0);
        assert(releases == 1 && stops == 1 && emitted == 0);
    } else if (group == 6) {
        assert(dot_capture_crc32((const uint8_t *)"123456789", 9) == 0xcbf43926u);
        assert(dot_capture_crc32(NULL, 0) == 0);
        dot_capture_result_t out;
        assert(strcmp(dot_capture_once(&backend, NULL, &req, sink, NULL, &out), "camera_preconditions_failed") == 0);
        assert(starts == 0);
    } else if (group == 7) {
        assert(dot_camera_probe_once(&backend, &dot_goouuu_camera_pins, &req, &result) == NULL);
        assert(starts == 1 && stops == 1 && frame_get_count == 0 && releases == 0 && emitted == 0);
        assert(result.sensor_pid == 0x26 && result.camera_stopped && !result.frame_transferred);
        reset(); req.capture_authorized = false;
        assert(strcmp(dot_camera_probe_once(&backend, &dot_goouuu_camera_pins, &req, &result), "camera_disabled") == 0);
        assert(starts == 0 && frame_get_count == 0 && stops == 0);
        reset(); req = request(); req.prerequisites.board_revision_verified = false;
        assert(strcmp(dot_camera_probe_once(&backend, &dot_goouuu_camera_pins, &req, &result), "camera_preconditions_failed") == 0);
        assert(starts == 0 && stops == 0);
    } else if (group == 8) {
        start_ok = false;
        assert(strcmp(dot_camera_probe_once(&backend, &dot_goouuu_camera_pins, &req, &result), "camera_init_failed") == 0);
        assert(starts == 1 && stops == 0 && frame_get_count == 0);
        reset(); pid = 0;
        assert(strcmp(dot_camera_probe_once(&backend, &dot_goouuu_camera_pins, &req, &result), "camera_sensor_unidentified") == 0);
        assert(stops == 1 && frame_get_count == 0 && result.camera_stopped);
        reset(); stop_ok = false;
        assert(strcmp(dot_camera_probe_once(&backend, &dot_goouuu_camera_pins, &req, &result), "camera_stop_failed") == 0);
        assert(stops == 1 && frame_get_count == 0 && !result.camera_stopped);
        reset();
        assert(dot_camera_probe_once(dot_camera_esp32_backend(), &dot_goouuu_camera_pins, &req, &result) == NULL);
        assert(starts == 1 && stops == 1 && frame_get_count == 0 && releases == 0 && emitted == 0);
        assert(!dot_camera_esp32_active() && result.sensor_pid == 0x26);
    } else assert(0);
    puts("PASS: synthetic capture test only");
    return 0;
}
