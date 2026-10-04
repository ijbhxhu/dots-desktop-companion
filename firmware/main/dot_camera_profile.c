#include "dot_camera_profile.h"

// GOOUUU vendor pin diagram and schematic, commit
// 3ffc1e909a60c17d43b9b6d3e3a7355e903eea89:
// https://github.com/zhuhai-esp/ESP32-S3-Goouuu-Cam/tree/main/Documents
// Y2..Y9 map to D0..D7. RESET is tied to board EN, PWDN to ground
// through a resistor: neither has an independent software GPIO here.
const dot_camera_pins_t dot_goouuu_camera_pins = {
    .data = {11, 9, 8, 10, 12, 18, 17, 16},
    .sda = 4, .scl = 5, .vsync = 6, .href = 7, .xclk = 15, .pclk = 13,
    .pwdn = -1, .reset = -1,
};

static bool reserved(int pin)
{
    // Current TFT, native USB, Octal PSRAM, SD, BOOT and motor reservation.
    static const int pins[] = {1, 21, 41, 42, 47, 19, 20, 35, 36, 37,
                               38, 39, 40, 0, 14};
    for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); ++i)
        if (pins[i] == pin) return true;
    return false;
}

bool dot_camera_pins_valid(const dot_camera_pins_t *pins)
{
    if (!pins) return false;
    int all[16];
    for (size_t i = 0; i < 8; ++i) all[i] = pins->data[i];
    all[8] = pins->sda; all[9] = pins->scl; all[10] = pins->vsync;
    all[11] = pins->href; all[12] = pins->xclk; all[13] = pins->pclk;
    all[14] = pins->pwdn; all[15] = pins->reset;
    for (size_t i = 0; i < 16; ++i) {
        if (i >= 14 && all[i] == -1) continue;
        // S3 GPIO22..25 are absent; GPIO46 is not an output for control.
        if (all[i] < 0 || all[i] > 48 || (all[i] >= 22 && all[i] <= 25)
                || (i >= 8 && all[i] == 46) || reserved(all[i])) return false;
        for (size_t j = 0; j < i; ++j)
            if (all[i] == all[j]) return false;
    }
    return true;
}

uint32_t dot_camera_blockers(const dot_camera_pins_t *pins,
                            const dot_camera_prerequisites_t *prerequisites)
{
    if (!prerequisites) return UINT32_MAX;
    uint32_t blockers = dot_camera_pins_valid(pins) ? 0 : DOT_CAMERA_BLOCK_PINS;
    if (!prerequisites->board_revision_verified) blockers |= DOT_CAMERA_BLOCK_BOARD;
    if (!prerequisites->sensor_verified) blockers |= DOT_CAMERA_BLOCK_SENSOR;
    if (!prerequisites->driver_available) blockers |= DOT_CAMERA_BLOCK_DRIVER;
    // Planning floors for one QQVGA RGB565 frame; not a driver's allocation proof.
    if (prerequisites->psram_free < DOT_CAMERA_FRAME_BYTES + DOT_CAMERA_PSRAM_RESERVE)
        blockers |= DOT_CAMERA_BLOCK_PSRAM;
    if (prerequisites->internal_free < DOT_CAMERA_INTERNAL_RESERVE)
        blockers |= DOT_CAMERA_BLOCK_INTERNAL;
    return blockers;
}
