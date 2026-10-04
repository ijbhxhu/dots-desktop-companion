#include "dot_core.h"
#include <string.h>

const char *dot_face_name(dot_face_t face)
{
    static const char *const names[] = {"auto", "happy", "white"};
    return (unsigned)face < sizeof(names) / sizeof(names[0]) ? names[face] : "auto";
}

bool dot_parse_line(const char *line, dot_request_t *request)
{
    if (!line || !request) return false;
    char buffer[64];
    size_t length = 0;
    while (length < sizeof(buffer) && line[length]) ++length;
    if (length == sizeof(buffer)) return false;
    memcpy(buffer, line, length + 1);
    char *name = buffer;
    while (*name == ' ' || *name == '\t') ++name;
    char *end = buffer + length;
    while (end > name && (end[-1] == ' ' || end[-1] == '\t')) *--end = 0;
    if (!*name) return false;
    char *duration = name;
    while (*duration && *duration != ' ' && *duration != '\t') ++duration;
    bool has_duration = *duration != 0;
    unsigned seconds = 60;
    if (has_duration) {
        *duration++ = 0;
        while (*duration == ' ' || *duration == '\t') ++duration;
        seconds = 0;
        for (const char *digit = duration; *digit; ++digit) {
            if (*digit < '0' || *digit > '9') return false;
            seconds = seconds * 10 + (unsigned)(*digit - '0');
            if (seconds > 60) return false;
        }
        if (seconds < 1) return false;
    }
    dot_request_t parsed = {.seconds = seconds};
    if (strcmp(name, "status") == 0) {
        if (has_duration) return false;
        parsed.status = true;
    } else if (strcmp(name, "auto") == 0) {
        if (has_duration) return false;
        parsed.face = DOT_AUTO;
        parsed.seconds = 0;
    } else if (strcmp(name, "happy") == 0) parsed.face = DOT_HAPPY;
    else if (strcmp(name, "white") == 0) parsed.face = DOT_WHITE;
    else return false;
    *request = parsed;
    return true;
}

void dot_state_apply(dot_state_t *state, const dot_request_t *request, int64_t now_us)
{
    if (request->status) return;
    state->face = request->face;
    state->expires_us = request->face == DOT_AUTO ? 0 : now_us + (int64_t)request->seconds * 1000000;
    ++state->revision;
}

void dot_state_tick(dot_state_t *state, int64_t now_us)
{
    if (state->face != DOT_AUTO && now_us >= state->expires_us) {
        state->face = DOT_AUTO;
        state->expires_us = 0;
        ++state->revision;
    }
}

void dot_state_frame_done(dot_state_t *state, dot_face_t face, uint32_t revision)
{
    state->rendered_face = face;
    state->rendered_revision = revision;
    ++state->frames;
}
