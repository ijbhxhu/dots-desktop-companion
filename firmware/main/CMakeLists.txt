set(dot_camera_requires "")
# Resolve optional dependencies from an explicit CMake argument, including IDF's
# early dependency scan where Kconfig variables are not yet available.
if(DOT_CAMERA_DRIVER_COMPONENT)
    list(APPEND dot_camera_requires "${DOT_CAMERA_DRIVER_COMPONENT}")
endif()
idf_component_register(SRCS "main.c" "dot_core.c" "dot_render.c" "dot_camera_profile.c"
                           "dot_capture.c" "dot_camera_esp32.c" "dot_transport.c"
    INCLUDE_DIRS "."
    REQUIRES esp_driver_spi esp_driver_usb_serial_jtag esp_driver_uart esp_lcd esp_psram
             heap freertos vfs esp_timer st7735 esp_hw_support ${dot_camera_requires})
if(CONFIG_DOT_CAMERA_DRIVER_ENABLED)
    if(NOT DOT_CAMERA_DRIVER_COMPONENT)
        message(FATAL_ERROR "Camera backend requested without an approved DOT_CAMERA_DRIVER_COMPONENT")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DOT_CAMERA_WITH_ESP32_DRIVER=1)
endif()
