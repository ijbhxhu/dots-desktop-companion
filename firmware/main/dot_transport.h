#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void dot_transport_init(void);
const char *dot_transport_name(void);
unsigned dot_transport_baud_rate(void);
// Raw bytes only: no newline conversion. One caller owns commands and DCF1.
bool dot_transport_write_exact(const uint8_t *bytes, size_t length, int64_t deadline_us);
