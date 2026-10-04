#include "dot_transport.h"
#include "sdkconfig.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if CONFIG_DOT_TRANSPORT_UART0
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#if !CONFIG_ESP_CONSOLE_UART || CONFIG_ESP_CONSOLE_UART_NUM != 0
#error "DOT UART0 transport requires the primary console on UART0"
#endif
_Static_assert(CONFIG_ESP_CONSOLE_UART_BAUDRATE == CONFIG_DOT_UART0_BAUDRATE,
               "UART console and command baud must match");
// GOOUUU schematic commit 3ffc1e909a60c17d43b9b6d3e3a7355e903eea89:
// module TXD0=GPIO43 -> CH340 RXD; module RXD0=GPIO44 <- CH340 TXD.
enum { DOT_UART_TX = 43, DOT_UART_RX = 44 };
#else
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#if !CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#error "DOT native USB transport requires the primary USB Serial/JTAG console"
#endif
#endif

void dot_transport_init(void)
{
#if CONFIG_DOT_TRANSPORT_UART0
    // IDF startup registers the console VFS without installing a UART driver.
    // Never install or reconfigure a second driver over an existing owner.
    ESP_ERROR_CHECK(uart_is_driver_installed(UART_NUM_0) ? ESP_ERR_INVALID_STATE : ESP_OK);
    const uart_config_t config = {
        .baud_rate = CONFIG_DOT_UART0_BAUDRATE, .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE, .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_param_config(UART_NUM_0, &config));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_0, DOT_UART_TX, DOT_UART_RX,
                                UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    // TX ring disabled so uart_tx_chars can perform bounded raw packet writes.
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 2048, 0, 0, NULL, 0));
    uart_vfs_dev_use_driver(UART_NUM_0);
    ESP_ERROR_CHECK(uart_vfs_dev_port_set_rx_line_endings(UART_NUM_0, ESP_LINE_ENDINGS_LF) == 0
                    ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(uart_vfs_dev_port_set_tx_line_endings(UART_NUM_0, ESP_LINE_ENDINGS_LF) == 0
                    ? ESP_OK : ESP_FAIL);
#else
    const usb_serial_jtag_driver_config_t usb = {.tx_buffer_size = 2048, .rx_buffer_size = 256};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
    usb_serial_jtag_vfs_use_driver();
#endif
}

const char *dot_transport_name(void)
{
#if CONFIG_DOT_TRANSPORT_UART0
    return "uart0";
#else
    return "usb_serial_jtag";
#endif
}

unsigned dot_transport_baud_rate(void)
{
#if CONFIG_DOT_TRANSPORT_UART0
    return CONFIG_DOT_UART0_BAUDRATE;
#else
    return 115200; // Host setting only; native USB transfers at USB speed.
#endif
}

bool dot_transport_write_exact(const uint8_t *bytes, size_t length, int64_t deadline_us)
{
    if (!bytes && length) return false;
    size_t offset = 0;
    while (offset < length) {
        int64_t remaining_us = deadline_us - esp_timer_get_time();
        if (remaining_us <= 0) return false;
        size_t chunk = length - offset < 512 ? length - offset : 512;
#if CONFIG_DOT_TRANSPORT_UART0
        // Nonblocking FIFO fill: no unbounded uart_write_bytes call for pixels.
        int sent = uart_tx_chars(UART_NUM_0, (const char *)bytes + offset, chunk);
#else
        uint32_t wait_ms = (uint32_t)(remaining_us / 1000);
        if (wait_ms > 200) wait_ms = 200;
        int sent = usb_serial_jtag_write_bytes(bytes + offset, chunk, pdMS_TO_TICKS(wait_ms));
#endif
        if (sent < 0 || (size_t)sent > chunk) return false;
        if (sent == 0) {
#if CONFIG_DOT_TRANSPORT_UART0
            // Keep interrupts enabled; a 10ms RTOS tick throttles the 128-byte FIFO.
            esp_rom_delay_us(100);
#else
            vTaskDelay(1);
#endif
        }
        else offset += (size_t)sent;
    }
    return true;
}
