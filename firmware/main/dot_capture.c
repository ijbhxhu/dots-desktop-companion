#include "dot_capture.h"
#include <string.h>

uint32_t dot_capture_crc32(const uint8_t *bytes, size_t length)
{
    uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < length; ++i) {
        crc ^= bytes[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

static void le(uint8_t *bytes, uint64_t value, size_t length)
{
    for (size_t i = 0; i < length; ++i) { bytes[i] = (uint8_t)value; value >>= 8; }
}

const char *dot_capture_once(const dot_capture_backend_t *backend,
                            const dot_camera_pins_t *pins, const dot_capture_request_t *request,
                            dot_capture_sink_t sink, void *sink_context, dot_capture_result_t *result)
{
    if (!result) return "invalid_capture_request";
    memset(result, 0, sizeof(*result));
    if (!request || !sink || !request->source_epoch || !request->sequence)
        return "invalid_capture_request";
    if (!request->capture_authorized) return "camera_disabled";
    if (!backend || !backend->start || !backend->acquire || !backend->release
            || !backend->stop || !backend->clock_us) return "camera_driver_missing";
    uint32_t blockers = dot_camera_blockers(pins, &request->prerequisites);
    // Sensor identification happens inside the explicitly authorized init.
    // A photo/guessed sensor model is not substituted for the actual probe.
    blockers &= ~((uint32_t)DOT_CAMERA_BLOCK_SENSOR);
    if (blockers) return "camera_preconditions_failed";
    int64_t started_us = backend->clock_us(backend->context);
    if (started_us < 0) return "invalid_capture_clock";
    if (!backend->start(backend->context, pins, &result->sensor_pid))
        return "camera_init_failed";
    const char *error = NULL;
    dot_capture_frame_t frame = {0};
    bool acquired = false;
    if (!result->sensor_pid) error = "camera_sensor_unidentified";
    else if (!(acquired = backend->acquire(backend->context, &frame))) error = "camera_frame_unavailable";
    else if (!frame.pixels || frame.width != DOT_CAMERA_WIDTH || frame.height != DOT_CAMERA_HEIGHT
            || frame.length != DOT_CAMERA_FRAME_BYTES || frame.pixel_format != DOT_CAPTURE_RGB565_BE)
        error = "camera_frame_invalid";
    else {
        int64_t now_us = backend->clock_us(backend->context);
        if (frame.captured_us < started_us || frame.captured_us > now_us
                || now_us < 0 || now_us - frame.captured_us > 500000)
            error = "camera_frame_stale";
        else {
            result->frame_crc32 = dot_capture_crc32(frame.pixels, frame.length);
            result->captured_us = frame.captured_us;
            uint8_t header[DOT_CAPTURE_HEADER_BYTES] = {0};
            memcpy(header, "DCF1", 4);
            header[4] = 1; header[5] = DOT_CAPTURE_RGB565_BE;
            le(header + 6, DOT_CAPTURE_HEADER_BYTES, 2);
            le(header + 8, request->source_epoch, 8);
            le(header + 16, request->sequence, 8);
            le(header + 24, (uint64_t)frame.captured_us, 8);
            le(header + 32, frame.width, 2); le(header + 34, frame.height, 2);
            le(header + 36, frame.length, 4); le(header + 40, result->frame_crc32, 4);
            if (!sink(sink_context, header, frame.pixels, frame.length)) error = "camera_transfer_failed";
            else result->frame_transferred = true;
        }
    }
    if (acquired) backend->release(backend->context, &frame);
    result->camera_stopped = backend->stop(backend->context);
    if (!result->camera_stopped) return "camera_stop_failed";
    return error;
}

const char *dot_camera_probe_once(const dot_capture_backend_t *backend,
                            const dot_camera_pins_t *pins, const dot_capture_request_t *request,
                            dot_capture_result_t *result)
{
    if (!result) return "invalid_capture_request";
    memset(result, 0, sizeof(*result));
    if (!request) return "invalid_capture_request";
    if (!request->capture_authorized) return "camera_disabled";
    if (!backend || !backend->start || !backend->stop) return "camera_driver_missing";
    uint32_t blockers = dot_camera_blockers(pins, &request->prerequisites);
    blockers &= ~((uint32_t)DOT_CAMERA_BLOCK_SENSOR); // The probe establishes PID.
    if (blockers) return "camera_preconditions_failed";
    if (!backend->start(backend->context, pins, &result->sensor_pid))
        return "camera_init_failed";
    const char *error = result->sensor_pid ? NULL : "camera_sensor_unidentified";
    result->camera_stopped = backend->stop(backend->context);
    if (!result->camera_stopped) return "camera_stop_failed";
    return error;
}
