import json
import struct
import unittest
import zlib

from usb_adapter import ClockMapping, HEADER, ProtocolError, Reader, WhiteHold, SceneChange, read_frame_header, white_fraction_rgb565, scene_grid_rgb565


EPOCH = "0102030405060708"


class FakePort:
    def __init__(self, data=b"", chunk_size=997):
        self.data = bytearray(data)
        self.chunk_size = chunk_size
        self.now = 0

    @property
    def in_waiting(self):
        return len(self.data)

    def read(self, count):
        self.now += 0.001
        length = min(count, len(self.data), self.chunk_size)
        value = bytes(self.data[:length])
        del self.data[:length]
        return value


def packet(pixels=None, sequence=7, captured_us=1_000_000, epoch=EPOCH, stopped=True, crc=None):
    pixels = pixels if pixels is not None else b"\xff\xff" * (160 * 120)
    header = HEADER.pack(b"DCF1", 1, 1, 44, int(epoch, 16), sequence, captured_us, 160, 120, len(pixels), zlib.crc32(pixels) & 0xFFFFFFFF if crc is None else crc)
    completion = json.dumps({"ok": True, "capture_complete": True, "sequence": sequence, "sensor_pid": 0x3660, "camera_stopped": stopped}).encode() + b"\n"
    return header + pixels + completion


class CaptureProtocolTests(unittest.TestCase):
    def test_full_frame_is_bounded_and_binary_bytes_do_not_become_json_lines(self):
        pixels = b"\x0a\xff" * (160 * 120)  # Many embedded newline bytes.
        port = FakePort(b"I (100) camera: initialization\n" + packet(pixels))
        reader = Reader(port, lambda: port.now)
        header, actual, sensor_pid = reader.frame(EPOCH, 0, 2)
        self.assertEqual(actual, pixels)
        self.assertEqual(header["sequence"], 7)
        self.assertEqual(sensor_pid, 0x3660)
        self.assertEqual(len(actual), 38400)
        self.assertEqual(port.data, b"")

    def test_crc_corruption_rejected(self):
        port = FakePort(packet(crc=0))
        with self.assertRaisesRegex(ProtocolError, "frame_crc_mismatch"):
            Reader(port, lambda: port.now).frame(EPOCH, 0, 2)

    def test_epoch_replay_dimensions_and_unbounded_header_rejected(self):
        valid = packet()[:44]
        with self.assertRaisesRegex(ProtocolError, "frame_identity_mismatch"):
            read_frame_header(valid, "ffffffffffffffff")
        with self.assertRaisesRegex(ProtocolError, "frame_identity_mismatch"):
            read_frame_header(valid, EPOCH, 7)
        bad = bytearray(valid)
        struct.pack_into("<I", bad, 36, 0xFFFFFFFF)
        with self.assertRaisesRegex(ProtocolError, "invalid_frame_header"):
            read_frame_header(bad, EPOCH)
        struct.pack_into("<H", bad, 32, 640)
        with self.assertRaisesRegex(ProtocolError, "invalid_frame_header"):
            read_frame_header(bad, EPOCH)

    def test_truncation_and_failed_stop_are_never_completed(self):
        port = FakePort(packet()[:100])
        with self.assertRaisesRegex(ProtocolError, "serial_timeout"):
            Reader(port, lambda: port.now).frame(EPOCH, 0, 0.1)
        port = FakePort(packet(stopped=False))
        with self.assertRaisesRegex(ProtocolError, "capture_not_complete"):
            Reader(port, lambda: port.now).frame(EPOCH, 0, 2)

    def test_firmware_disabled_rejection_is_consumed_without_pixel_allocation(self):
        port = FakePort(b'{"ok":false,"error":{"code":"camera_disabled"}}\n')
        with self.assertRaisesRegex(ProtocolError, "firmware_rejected"):
            Reader(port, lambda: port.now).frame(EPOCH, 0, 2)

    def test_firmware_rejection_retains_only_known_code_for_safe_diagnostics(self):
        port = FakePort(b'{"ok":false,"error":{"code":"camera_frame_stale"}}\n')
        with self.assertRaises(ProtocolError) as caught:
            Reader(port, lambda: port.now).frame(EPOCH, 0, 2)
        self.assertEqual(caught.exception.firmware_code, "camera_frame_stale")
        port = FakePort(b'{"ok":false,"error":{"code":"private-value-never-log"}}\n')
        with self.assertRaises(ProtocolError) as caught:
            Reader(port, lambda: port.now).frame(EPOCH, 0, 2)
        self.assertIsNone(caught.exception.firmware_code)

    def test_serial_io_exception_is_classified_without_raw_message(self):
        class BrokenPort:
            in_waiting = 0

            def read(self, _count):
                raise OSError("private-value-never-log")

        with self.assertRaisesRegex(ProtocolError, "serial_read_failed") as caught:
            Reader(BrokenPort(), lambda: 0).exact(1, 1)
        self.assertNotIn("private-value", str(caught.exception))

    def test_rgb565_be_aggregate_distinguishes_white_dark_and_saturated_color(self):
        self.assertEqual(white_fraction_rgb565(b"\xff\xff" * 19200), 1)
        self.assertEqual(white_fraction_rgb565(b"\x00\x00" * 19200), 0)
        self.assertEqual(white_fraction_rgb565(b"\xf8\x00" * 19200), 0)


class TimeAndDetectorTests(unittest.TestCase):
    def mapping(self):
        return ClockMapping({"source_epoch": EPOCH, "clock_us": 1_000_000, "time_base": "esp_timer_monotonic_us"}, 1000, 1000.02, 10, 10.02)

    def test_stable_clock_mapping_uses_capture_time_instead_of_arrival_time(self):
        mapped = self.mapping()
        frame = {"source_epoch": EPOCH, "captured_us": 1_100_000}
        captured = mapped.captured_at(frame, 1000.2, 10.2, 0.5)
        self.assertAlmostEqual(captured, 1000.11)
        self.assertNotEqual(captured, 1000.2)

    def test_clock_jump_stale_and_future_frames_are_rejected(self):
        frame = {"source_epoch": EPOCH, "captured_us": 1_100_000}
        with self.assertRaisesRegex(ProtocolError, "host_clock_jump"):
            self.mapping().captured_at(frame, 1001, 10.2)
        with self.assertRaisesRegex(ProtocolError, "capture_not_fresh"):
            self.mapping().captured_at(frame, 1000.8, 10.8)
        with self.assertRaisesRegex(ProtocolError, "capture_not_fresh"):
            self.mapping().captured_at({"source_epoch": EPOCH, "captured_us": 3_000_000}, 1000.2, 10.2)
        mapped = self.mapping()
        mapped.captured_at(frame, 1000.2, 10.2)
        with self.assertRaisesRegex(ProtocolError, "stale_capture_clock"):
            mapped.captured_at(frame, 1000.2, 10.2)

    def test_uncertain_mapping_is_rejected(self):
        with self.assertRaisesRegex(ProtocolError, "clock_mapping_uncertain"):
            ClockMapping({"source_epoch": EPOCH, "clock_us": 0, "time_base": "esp_timer_monotonic_us"}, 1000, 1001, 10, 11)

    def test_one_white_frame_is_not_an_event_three_fresh_samples_and_hold_are_required(self):
        detector = WhiteHold()
        self.assertIsNone(detector.update(1, 10))
        self.assertIsNone(detector.update(1, 10.5))
        event = detector.update(1, 11)
        self.assertEqual(event["samples"], 3)
        self.assertEqual(event["held_seconds"], 1)
        self.assertIsNone(detector.update(1, 11.5))
        detector.update(0, 12)
        detector.update(0, 12.5)
        self.assertFalse(detector.latched)
        self.assertIsNone(detector.update(1, 13))
        self.assertIsNone(detector.update(1, 13.5))
        self.assertIsNone(detector.update(1, 14))  # Cooldown expires, then a new hold starts.
        self.assertIsNone(detector.update(1, 14.5))
        self.assertIsNotNone(detector.update(1, 15))

    def test_gap_or_ambiguous_color_breaks_hold(self):
        detector = WhiteHold()
        detector.update(1, 10)
        detector.update(1, 10.4)
        self.assertIsNone(detector.update(1, 11))
        detector.update(0.6, 11.4)
        self.assertIsNone(detector.update(1, 11.8))
        self.assertIsNone(detector.update(1, 12.2))
        self.assertIsNone(detector.update(1, 12.6))
        self.assertIsNotNone(detector.update(1, 13))


class SceneChangeTests(unittest.TestCase):
    BLACK = tuple((0, 0, 0) for _ in range(48))
    WHITE = tuple((255, 255, 255) for _ in range(48))

    def test_rgb565_grid_is_small_central_roi_and_keeps_color_channels(self):
        grid = scene_grid_rgb565(b"\xff\xff" * 19200)
        self.assertEqual(grid, self.WHITE)
        red = scene_grid_rgb565(b"\xf8\x00" * 19200)
        self.assertEqual(red, tuple((255, 0, 0) for _ in range(48)))
        self.assertEqual(len(grid), 48)

    def test_stable_scene_and_small_noise_never_emit(self):
        detector = SceneChange()
        self.assertIsNone(detector.update(self.BLACK, 10)["event"])
        for index in range(1, 20):
            grid = tuple((8 if index % 2 else 0,) * 3 for _ in range(48))
            self.assertIsNone(detector.update(grid, 10 + index * 0.25)["event"])

    def test_one_flash_is_ignored_but_stable_new_scene_is_confirmed(self):
        detector = SceneChange()
        detector.update(self.BLACK, 10)
        self.assertIsNone(detector.update(self.WHITE, 10.5)["event"])
        self.assertIsNone(detector.update(self.BLACK, 11)["event"])
        self.assertIsNone(detector.update(self.WHITE, 11.5)["event"])
        confirmed = detector.update(self.WHITE, 12)["event"]
        self.assertEqual(confirmed["changed_fraction"], 1)
        self.assertEqual(confirmed["mean_delta"], 1)
        self.assertEqual(confirmed["samples"], 2)
        self.assertEqual(confirmed["held_seconds"], 0.5)
        self.assertIsNone(detector.update(self.WHITE, 12.5)["event"])

    def test_small_local_patch_or_low_global_delta_is_not_clear_change(self):
        detector = SceneChange()
        detector.update(self.BLACK, 10)
        patch = self.WHITE[:8] + self.BLACK[8:]
        self.assertIsNone(detector.update(patch, 10.5)["event"])
        self.assertIsNone(detector.update(patch, 11)["event"])
        dim = tuple((20, 20, 20) for _ in range(48))
        self.assertIsNone(detector.update(dim, 11.5)["event"])
        self.assertIsNone(detector.update(dim, 12)["event"])

    def test_debounce_minimum_and_cooldown_prevent_bursts(self):
        detector = SceneChange()
        detector.update(self.BLACK, 10)
        detector.update(self.WHITE, 10.2)
        self.assertIsNone(detector.update(self.WHITE, 10.3)["event"])
        self.assertIsNotNone(detector.update(self.WHITE, 10.5)["event"])
        for index in range(1, 12):
            grid = self.BLACK if index % 2 else self.WHITE
            self.assertIsNone(detector.update(grid, 10.5 + index * 0.25)["event"])
        self.assertIsNone(detector.update(self.WHITE, 13.5)["event"])
        self.assertIsNotNone(detector.update(self.WHITE, 14)["event"])

    def test_gap_and_invalid_timestamp_reset_reference_without_phantom_change(self):
        detector = SceneChange()
        detector.update(self.BLACK, 10)
        detector.update(self.WHITE, 10.5)
        self.assertIsNone(detector.update(self.WHITE, 11.5)["event"])
        self.assertIsNone(detector.update(self.WHITE, 12)["event"])
        with self.assertRaisesRegex(ProtocolError, "invalid_scene_sample"):
            detector.update(self.BLACK, 12)
        self.assertIsNone(detector.update(self.BLACK, 12.5)["event"])


if __name__ == "__main__":
    unittest.main()
