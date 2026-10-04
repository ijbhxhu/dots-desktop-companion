#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// A documented board profile, not evidence of an initialized camera.
typedef struct {
    int data[8];
    int sda, scl, vsync, href, xclk, pclk, pwdn, reset;
} dot_camera_pins_t;

extern const dot_camera_pins_t dot_goouuu_camera_pins;

enum {
    DOT_CAMERA_WIDTH = 160,
    DOT_CAMERA_HEIGHT = 120,
    DOT_CAMERA_FRAME_BYTES = DOT_CAMERA_WIDTH * DOT_CAMERA_HEIGHT * 2,
    DOT_CAMERA_PSRAM_RESERVE = 64 * 1024,
    DOT_CAMERA_INTERNAL_RESERVE = 32 * 1024,
    DOT_CAMERA_BLOCK_PINS = 1u << 0,
    DOT_CAMERA_BLOCK_BOARD = 1u << 1,
    DOT_CAMERA_BLOCK_SENSOR = 1u << 2,
    DOT_CAMERA_BLOCK_DRIVER = 1u << 3,
    DOT_CAMERA_BLOCK_PSRAM = 1u << 4,
    DOT_CAMERA_BLOCK_INTERNAL = 1u << 5,
};

typedef struct {
    bool board_revision_verified;
    bool sensor_verified;
    bool driver_available;
    size_t psram_free;
    size_t internal_free;
} dot_camera_prerequisites_t;

bool dot_camera_pins_valid(const dot_camera_pins_t *pins);
uint32_t dot_camera_blockers(const dot_camera_pins_t *pins,
                            const dot_camera_prerequisites_t *prerequisites);
