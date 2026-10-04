#include "dot_capture.h"
#include <assert.h>
#include <stdio.h>
int main(void)
{
    assert(dot_camera_esp32_backend() == NULL);
    assert(!dot_camera_esp32_active() && dot_camera_esp32_last_sensor_pid() == 0);
    puts("PASS: driver absent by default");
    return 0;
}
