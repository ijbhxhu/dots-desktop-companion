from pathlib import Path
import subprocess
import os
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DotCoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.tmp.name) / ("dot_core.exe" if os.name == "nt" else "dot_core")
        result = subprocess.run([os.environ.get("DOT_HOST_CC", "gcc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
                                 "-I", str(ROOT / "main"), str(ROOT / "main/dot_core.c"),
                                 str(ROOT / "main/dot_render.c"), str(ROOT / "main/dot_camera_profile.c"),
                                 str(ROOT / "tests/core_harness.c"),
                                 "-o", str(cls.binary)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_group(self, group):
        result = subprocess.run([str(self.binary), str(group)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS", result.stdout)

    def test_usb_validation(self): self.run_group(1)
    def test_duration_defaults_and_bounds(self): self.run_group(2)
    def test_expiry_and_cancel(self): self.run_group(3)
    def test_white_pixels_include_every_edge_without_overlays(self): self.run_group(4)
    def test_rendered_revision_requires_completed_frame(self): self.run_group(5)
    def test_dot_ready_and_happy_are_distinct(self): self.run_group(6)
    def test_camera_profile_avoids_existing_peripherals(self): self.run_group(7)
    def test_camera_readiness_requires_verified_hardware_and_driver(self): self.run_group(8)
    def test_camera_memory_floor_is_checked(self): self.run_group(9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
