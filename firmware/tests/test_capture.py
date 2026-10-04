from pathlib import Path
import struct
import subprocess
import os
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]


class CaptureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.tmp.name) / ("capture.exe" if os.name == "nt" else "capture")
        cls.disabled = Path(cls.tmp.name) / ("capture_disabled.exe" if os.name == "nt" else "capture_disabled")
        flags = [os.environ.get("DOT_HOST_CC", "gcc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
                 "-I", str(ROOT / "main")]
        sources = [str(ROOT / "main" / name) for name in
                   ("dot_camera_profile.c", "dot_capture.c", "dot_camera_esp32.c")]
        for args in (flags + ["-DDOT_CAMERA_WITH_ESP32_DRIVER=1", "-I", str(ROOT / "tests/fakes")]
                     + sources + [str(ROOT / "tests/capture_harness.c"), "-o", str(cls.binary)],
                     flags + [str(ROOT / "main/dot_camera_esp32.c"),
                              str(ROOT / "tests/capture_disabled_harness.c"), "-o", str(cls.disabled)]):
            result = subprocess.run(args, capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_group(self, group):
        result = subprocess.run([str(self.binary), str(group)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS", result.stdout)

    def test_disabled_capture_never_calls_driver(self): self.run_group(1)
    def test_capture_header_and_buffer_cleanup(self): self.run_group(2)
    def test_invalid_or_stale_frames_are_not_emitted(self): self.run_group(3)
    def test_failure_paths_release_and_stop(self): self.run_group(4)
    def test_esp32_adapter_uses_goouuu_signals_and_one_psram_frame(self): self.run_group(5)
    def test_crc_and_invalid_requests(self): self.run_group(6)

    def test_probe_reads_pid_without_acquiring_or_emitting_pixels(self): self.run_group(7)
    def test_probe_failure_paths_stop_driver_without_acquisition(self): self.run_group(8)

    def test_driver_absent_in_default_build(self):
        result = subprocess.run([str(self.disabled)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_synthetic_packet_is_independently_decodable(self):
        path = Path(self.tmp.name) / "synthetic-first-frame.dcf"
        result = subprocess.run([str(self.binary), "2", str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        packet = path.read_bytes()
        fields = struct.unpack("<4sBBHQQQHHII", packet[:44])
        self.assertEqual(fields[:4], (b"DCF1", 1, 1, 44))
        self.assertEqual(fields[4:9], (0x123456789ABCDEF0, 7, 1100000, 160, 120))
        self.assertEqual(fields[9], 38400)
        self.assertEqual(len(packet), 44 + fields[9])
        self.assertEqual(fields[10], zlib.crc32(packet[44:]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
