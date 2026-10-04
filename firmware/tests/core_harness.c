#include "dot_core.h"
#include "dot_camera_profile.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv)
{
    assert(argc == 2);
    dot_request_t request;
    dot_state_t state = {0};
    int group = atoi(argv[1]);
    if (group == 1) {
        const char *bad[] = {NULL, "", " \t", "happy 0", "happy 61", "happy -1", "happy 1.5", "happy +1",
            "white 61", "white 0", "happy 10 extra", "happy 1 2", "status 1", "auto 60", "nod", "idle",
            "happy 99999999999999999999999999999999999999999999"};
        for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) assert(!dot_parse_line(bad[i], &request));
        char boundary[65]; memset(boundary, ' ', sizeof(boundary)); memcpy(boundary, "happy 60", 8);
        boundary[63] = 0; assert(dot_parse_line(boundary, &request));
        boundary[63] = ' '; boundary[64] = 0; assert(!dot_parse_line(boundary, &request));
        assert(dot_parse_line(" \tstatus\t ", &request) && request.status);
    } else if (group == 2) {
        assert(dot_parse_line("happy", &request) && request.face == DOT_HAPPY && request.seconds == 60);
        assert(dot_parse_line("white", &request) && request.face == DOT_WHITE && request.seconds == 60);
        assert(dot_parse_line("happy 1", &request) && request.seconds == 1);
        assert(dot_parse_line("white\t60", &request) && request.seconds == 60);
        assert(dot_parse_line("auto", &request) && request.seconds == 0 && request.face == DOT_AUTO);
    } else if (group == 3) {
        assert(dot_parse_line("happy 60", &request)); dot_state_apply(&state, &request, 1000000);
        dot_state_tick(&state, 60999999); assert(state.face == DOT_HAPPY && state.revision == 1);
        dot_state_tick(&state, 61000000); assert(state.face == DOT_AUTO && state.revision == 2);
        dot_state_tick(&state, 999999999); assert(state.revision == 2);
        assert(dot_parse_line("white 30", &request)); dot_state_apply(&state, &request, 2000000);
        assert(dot_parse_line("auto", &request)); dot_state_apply(&state, &request, 2000001);
        assert(state.face == DOT_AUTO && state.expires_us == 0);
    } else if (group == 4) {
        uint8_t *guarded = malloc(DOT_FRAME_BYTES + 2); assert(guarded);
        guarded[0] = 0x5a; guarded[DOT_FRAME_BYTES + 1] = 0xa5;
        dot_render(guarded + 1, DOT_HAPPY); dot_render(guarded + 1, DOT_WHITE);
        for (int i = 1; i <= DOT_FRAME_BYTES; ++i) assert(guarded[i] == 0xff);
        assert(guarded[0] == 0x5a && guarded[DOT_FRAME_BYTES + 1] == 0xa5); free(guarded);
    } else if (group == 5) {
        dot_state_frame_done(&state, DOT_AUTO, 0);
        assert(dot_parse_line("happy", &request)); dot_state_apply(&state, &request, 1);
        assert(state.revision == 1 && state.rendered_revision == 0 && state.rendered_face == DOT_AUTO);
        dot_state_frame_done(&state, DOT_HAPPY, 1);
        assert(state.rendered_revision == state.revision && state.rendered_face == DOT_HAPPY && state.frames == 2);
        dot_state_tick(&state, 60000001);
        assert(state.face == DOT_AUTO && state.rendered_face == DOT_HAPPY && state.rendered_revision != state.revision);
        dot_state_frame_done(&state, DOT_AUTO, state.revision);
        assert(state.rendered_face == DOT_AUTO && state.rendered_revision == state.revision);
    } else if (group == 6) {
        uint8_t *ready = malloc(DOT_FRAME_BYTES), *happy = malloc(DOT_FRAME_BYTES); assert(ready && happy);
        dot_render(ready, DOT_AUTO); dot_render(happy, DOT_HAPPY);
        assert(memcmp(ready, happy, DOT_FRAME_BYTES) != 0);
        // The user avatar replaces the geometric smiley. Both states retain
        // the same background while their rendered status remains distinct.
        assert(ready[0] == happy[0] && ready[1] == happy[1]);
        free(ready); free(happy);
    } else if (group == 7) {
        assert(dot_camera_pins_valid(&dot_goouuu_camera_pins));
        assert(dot_goouuu_camera_pins.pwdn == -1 && dot_goouuu_camera_pins.reset == -1);
        const int conflicts[] = {1, 21, 41, 42, 47, 19, 20, 35, 36, 37, 38, 39, 40, 0, 14};
        for (size_t i = 0; i < sizeof(conflicts) / sizeof(conflicts[0]); ++i) {
            dot_camera_pins_t bad = dot_goouuu_camera_pins;
            bad.data[0] = conflicts[i]; assert(!dot_camera_pins_valid(&bad));
        }
        dot_camera_pins_t bad = dot_goouuu_camera_pins;
        bad.data[0] = bad.data[1]; assert(!dot_camera_pins_valid(&bad));
        bad = dot_goouuu_camera_pins; bad.sda = -1; assert(!dot_camera_pins_valid(&bad));
        bad = dot_goouuu_camera_pins; bad.scl = 46; assert(!dot_camera_pins_valid(&bad));
        bad = dot_goouuu_camera_pins; bad.pclk = 22; assert(!dot_camera_pins_valid(&bad));
        assert(!dot_camera_pins_valid(NULL));
    } else if (group == 8) {
        dot_camera_prerequisites_t prerequisites = {.psram_free = 8 * 1024 * 1024, .internal_free = 128 * 1024};
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites) ==
               (DOT_CAMERA_BLOCK_BOARD | DOT_CAMERA_BLOCK_SENSOR | DOT_CAMERA_BLOCK_DRIVER));
        prerequisites.board_revision_verified = true; prerequisites.sensor_verified = true;
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites) == DOT_CAMERA_BLOCK_DRIVER);
        prerequisites.driver_available = true;
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites) == 0);
        assert(dot_camera_blockers(NULL, &prerequisites) == DOT_CAMERA_BLOCK_PINS);
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, NULL) == UINT32_MAX);
    } else if (group == 9) {
        dot_camera_prerequisites_t prerequisites = {
            .board_revision_verified = true, .sensor_verified = true, .driver_available = true,
            .psram_free = DOT_CAMERA_FRAME_BYTES + DOT_CAMERA_PSRAM_RESERVE,
            .internal_free = DOT_CAMERA_INTERNAL_RESERVE,
        };
        assert(DOT_CAMERA_FRAME_BYTES == 38400);
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites) == 0);
        --prerequisites.psram_free;
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites) == DOT_CAMERA_BLOCK_PSRAM);
        --prerequisites.internal_free;
        assert(dot_camera_blockers(&dot_goouuu_camera_pins, &prerequisites) ==
               (DOT_CAMERA_BLOCK_PSRAM | DOT_CAMERA_BLOCK_INTERNAL));
    } else assert(0);
    puts("PASS");
    return 0;
}
