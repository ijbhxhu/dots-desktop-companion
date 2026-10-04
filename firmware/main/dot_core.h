#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum { DOT_WIDTH = 128, DOT_HEIGHT = 160, DOT_FRAME_BYTES = DOT_WIDTH * DOT_HEIGHT * 2 };
typedef enum { DOT_AUTO, DOT_HAPPY, DOT_WHITE } dot_face_t;
typedef struct { bool status; dot_face_t face; unsigned seconds; } dot_request_t;
typedef struct {
    dot_face_t face, rendered_face;
    uint32_t revision, rendered_revision, frames;
    int64_t expires_us;
} dot_state_t;

const char *dot_face_name(dot_face_t face);
bool dot_parse_line(const char *line, dot_request_t *request);
void dot_state_apply(dot_state_t *state, const dot_request_t *request, int64_t now_us);
void dot_state_tick(dot_state_t *state, int64_t now_us);
void dot_state_frame_done(dot_state_t *state, dot_face_t face, uint32_t revision);
void dot_render(uint8_t pixels[DOT_FRAME_BYTES], dot_face_t face);
