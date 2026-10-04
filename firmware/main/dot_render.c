#include "dot_core.h"
#include "dot_avatar.h"
#include <string.h>

_Static_assert(DOT_AVATAR_WIDTH > 0 && DOT_AVATAR_WIDTH <= DOT_WIDTH - 8, "Avatar width must fit the TFT");
_Static_assert(DOT_AVATAR_HEIGHT > 0 && DOT_AVATAR_HEIGHT <= DOT_HEIGHT - 24, "Avatar height must leave space for status");
_Static_assert(sizeof(dot_avatar_rgb565) == DOT_AVATAR_WIDTH * DOT_AVATAR_HEIGHT * 2, "Avatar RGB565 data length mismatch");

static void pixel(uint8_t *frame, int x, int y, uint16_t color)
{
    if (x < 0 || x >= DOT_WIDTH || y < 0 || y >= DOT_HEIGHT) return;
    size_t index = ((size_t)y * DOT_WIDTH + x) * 2;
    frame[index] = color >> 8;
    frame[index + 1] = color;
}

static const uint8_t *glyph(char ch)
{
    static const char letters[] = "DOTREAYHP";
    static const uint8_t rows[][5] = {
        {6,5,5,5,6}, {7,5,5,5,7}, {7,2,2,2,2},
        {6,5,6,5,5}, {7,4,6,4,7}, {2,5,7,5,5},
        {5,5,2,2,2}, {5,5,7,5,5}, {6,5,6,4,4},
    };
    const char *match = strchr(letters, ch);
    return match ? rows[match - letters] : NULL;
}

static void text(uint8_t *frame, const char *label, int y, int scale, uint16_t color)
{
    int x = (DOT_WIDTH - ((int)strlen(label) * 4 - 1) * scale) / 2;
    for (; *label; ++label, x += 4 * scale) {
        const uint8_t *rows = glyph(*label);
        if (!rows) continue;
        for (int row = 0; row < 5; ++row) for (int col = 0; col < 3; ++col) {
            if (!(rows[row] & (1u << (2 - col)))) continue;
            for (int dy = 0; dy < scale; ++dy) for (int dx = 0; dx < scale; ++dx)
                pixel(frame, x + col * scale + dx, y + row * scale + dy, color);
        }
    }
}

void dot_render(uint8_t pixels[DOT_FRAME_BYTES], dot_face_t face)
{
    if (face == DOT_WHITE) {
        memset(pixels, 0xff, DOT_FRAME_BYTES);
        return;
    }
    for (size_t i = 0; i < DOT_FRAME_BYTES; i += 2) {
        pixels[i] = DOT_AVATAR_BACKGROUND >> 8;
        pixels[i + 1] = DOT_AVATAR_BACKGROUND & 0xff;
    }
    const int x = (DOT_WIDTH - DOT_AVATAR_WIDTH) / 2;
    const int y = 4 + (DOT_HEIGHT - 24 - DOT_AVATAR_HEIGHT) / 2;
    for (int row = 0; row < DOT_AVATAR_HEIGHT; ++row) {
        size_t destination = ((size_t)(y + row) * DOT_WIDTH + x) * 2;
        memcpy(pixels + destination, dot_avatar_rgb565 + (size_t)row * DOT_AVATAR_WIDTH * 2,
               DOT_AVATAR_WIDTH * 2);
    }
    if (face == DOT_HAPPY) {
        // Keep the supplied character intact; use a large, high-contrast state
        // banner and side bars so a scene-change response is easy to see.
        for (int row = 4; row < 140; ++row) {
            for (int col = 4; col < 8; ++col) {
                pixel(pixels, col, row, 0x07e0);
                pixel(pixels, DOT_WIDTH - 1 - col, row, 0x07e0);
            }
        }
        for (int row = 141; row < DOT_HEIGHT; ++row)
            for (int col = 0; col < DOT_WIDTH; ++col)
                pixel(pixels, col, row, 0x07e0);
        text(pixels, "HAPPY", 143, 3, 0x0000);
    } else {
        text(pixels, "READY", 146, 2, 0xffff);
    }
}
