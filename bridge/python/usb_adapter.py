"""Bounded DCF1 reader; RGB565 remains in memory and is never logged or uploaded.

Running unit tests does not open a port. The stdio worker requires --allow-open
and an explicit verified transport/port. No port guessing, reset, or flashing.
"""
import argparse
import datetime
import json
import math
import re
import struct
import sys
import time
import zlib


class ProtocolError(Exception):
    def __init__(self, reason, firmware_code=None):
        super().__init__(reason)
        self.firmware_code = firmware_code if firmware_code in FIRMWARE_CODES else None


FIRMWARE_CODES = {
    "invalid_params", "display_unavailable", "invalid_capture_request", "camera_disabled", "camera_driver_missing",
    "camera_preconditions_failed", "invalid_capture_clock", "camera_init_failed", "camera_sensor_unidentified",
    "camera_frame_unavailable", "camera_frame_invalid", "camera_frame_stale", "camera_transfer_failed", "camera_stop_failed",
}


def firmware_rejection(reply):
    error = reply.get("error")
    code = error.get("code") if isinstance(error, dict) else None
    return ProtocolError("firmware_rejected", code)


HEADER = struct.Struct("<4sBBHQQQHHII")
PROFILES = {
    "native_jtag": (0x303A, 0x1001, "usb_serial_jtag", 115200),
    "verified_ch340_uart0": (0x1A86, 0x7523, "uart0", 460800),
}


def read_frame_header(data, epoch, previous_sequence=0):
    if len(data) != HEADER.size:
        raise ProtocolError("truncated_header")
    magic, version, pixel_format, size, source_epoch, sequence, captured_us, width, height, length, crc = HEADER.unpack(data)
    if (magic, version, pixel_format, size, width, height, length) != (b"DCF1", 1, 1, 44, 160, 120, 38400):
        raise ProtocolError("invalid_frame_header")
    if f"{source_epoch:016x}" != epoch or sequence <= previous_sequence or captured_us >= 2**63:
        raise ProtocolError("frame_identity_mismatch")
    return {"source_epoch": epoch, "sequence": sequence, "captured_us": captured_us, "width": width, "height": height, "length": length, "crc": crc}


def white_fraction_rgb565(pixels, width=160, height=120):
    if (width, height, len(pixels)) != (160, 120, 38400):
        raise ProtocolError("invalid_pixels")
    count = total = 0
    for y in range(height // 4, height * 3 // 4):
        for x in range(width // 4, width * 3 // 4):
            offset = (y * width + x) * 2
            value = (pixels[offset] << 8) | pixels[offset + 1]
            r5, g6, b5 = (value >> 11) & 31, (value >> 5) & 63, value & 31
            rgb = ((r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2))
            maximum, minimum = max(rgb), min(rgb)
            if maximum >= 220 and (maximum - minimum) / maximum <= 0.12:
                count += 1
            total += 1
    return count / total


def scene_grid_rgb565(pixels, width=160, height=120):
    """48 RGB cell averages over the center 80%; retain no full-frame history."""
    if (width, height, len(pixels)) != (160, 120, 38400):
        raise ProtocolError("invalid_pixels")
    grid = []
    for row in range(6):
        for column in range(8):
            channels = [0, 0, 0]
            for dy in (4, 8, 12):
                for dx in (4, 8, 12):
                    x, y = 16 + column * 16 + dx, 12 + row * 16 + dy
                    offset = (y * width + x) * 2
                    value = (pixels[offset] << 8) | pixels[offset + 1]
                    r5, g6, b5 = (value >> 11) & 31, (value >> 5) & 63, value & 31
                    channels[0] += (r5 << 3) | (r5 >> 2)
                    channels[1] += (g6 << 2) | (g6 >> 4)
                    channels[2] += (b5 << 3) | (b5 >> 2)
            grid.append(tuple(channel / 9 for channel in channels))
    return tuple(grid)


class SceneChange:
    """Debounce a clear change against one reference, then rebase and cool down."""
    CELL_DELTA = 24 / 255
    FRACTION_MIN = 0.30
    MEAN_DELTA_MIN = 0.08
    DEBOUNCE_SECONDS = 0.20
    COOLDOWN_SECONDS = 3.0

    def __init__(self, max_gap=0.5):
        if not 0 < max_gap <= 2:
            raise ValueError("max_gap must be in (0, 2]")
        self.max_gap = max_gap
        self.last_trigger = None
        self.invalidate()

    def invalidate(self):
        self.baseline = self.last = self.candidate_since = None
        self.samples = 0

    def update(self, grid, timestamp):
        if (not math.isfinite(timestamp) or len(grid) != 48
                or any(len(cell) != 3 or any(not math.isfinite(channel) or not 0 <= channel <= 255 for channel in cell) for cell in grid)
                or (self.last is not None and timestamp <= self.last)):
            self.invalidate()
            raise ProtocolError("invalid_scene_sample")
        if self.baseline is None or self.last is None or timestamp - self.last > self.max_gap:
            self.baseline, self.last = grid, timestamp
            self.candidate_since = None
            self.samples = 0
            return {"changed_fraction": 0, "mean_delta": 0, "event": None}
        self.last = timestamp
        deltas = [sum(abs(a - b) for a, b in zip(cell, reference)) / (3 * 255) for cell, reference in zip(grid, self.baseline)]
        fraction = sum(delta >= self.CELL_DELTA for delta in deltas) / 48
        mean_delta = sum(deltas) / 48
        measured = {"changed_fraction": round(fraction, 6), "mean_delta": round(mean_delta, 6), "event": None}
        if self.last_trigger is not None and timestamp - self.last_trigger < self.COOLDOWN_SECONDS:
            self.baseline = grid
            self.candidate_since = None
            self.samples = 0
            return measured
        if fraction >= self.FRACTION_MIN and mean_delta >= self.MEAN_DELTA_MIN:
            if self.candidate_since is None:
                self.candidate_since = timestamp
                self.samples = 0
            self.samples += 1
            held = timestamp - self.candidate_since
            if self.samples >= 2 and held >= self.DEBOUNCE_SECONDS:
                measured["event"] = {"changed_fraction": measured["changed_fraction"], "mean_delta": measured["mean_delta"], "held_seconds": held, "samples": self.samples}
                self.baseline = grid
                self.last_trigger = timestamp
                self.candidate_since = None
                self.samples = 0
        else:
            self.candidate_since = None
            self.samples = 0
            # Follow small sensor/exposure drift without chasing a candidate change.
            if mean_delta < 0.04:
                self.baseline = tuple(tuple(0.9 * old + 0.1 * new for old, new in zip(reference, cell)) for reference, cell in zip(self.baseline, grid))
        return measured


class ClockMapping:
    def __init__(self, status, wall0, wall1, mono0, mono1, max_uncertainty=0.1):
        if not re.fullmatch(r"[a-f0-9]{16}", str(status.get("source_epoch", ""))) or type(status.get("clock_us")) is not int or status["clock_us"] < 0 or status.get("time_base") != "esp_timer_monotonic_us":
            raise ProtocolError("invalid_clock_status")
        if mono1 < mono0 or abs((wall1 - wall0) - (mono1 - mono0)) > 0.05:
            raise ProtocolError("host_clock_jump")
        self.uncertainty = (mono1 - mono0) / 2
        if self.uncertainty > max_uncertainty:
            raise ProtocolError("clock_mapping_uncertain")
        self.epoch = status["source_epoch"]
        self.offset = (wall0 + wall1) / 2 - status["clock_us"] / 1_000_000
        self.wall_minus_mono = (wall0 + wall1 - mono0 - mono1) / 2
        self.last_us = -1

    def captured_at(self, frame, wall_now, mono_now, max_age=0.5):
        if abs((wall_now - mono_now) - self.wall_minus_mono) > 0.1:
            raise ProtocolError("host_clock_jump")
        if frame["source_epoch"] != self.epoch or frame["captured_us"] <= self.last_us:
            raise ProtocolError("stale_capture_clock")
        captured = self.offset + frame["captured_us"] / 1_000_000
        age = wall_now - captured
        if age < -self.uncertainty - 0.05 or age + self.uncertainty > max_age:
            raise ProtocolError("capture_not_fresh")
        self.last_us = frame["captured_us"]
        return captured


class WhiteHold:
    def __init__(self, max_gap=0.5):
        if not 0 < max_gap <= 2:
            raise ValueError("max_gap must be in (0, 2]")
        self.max_gap = max_gap
        self.last = self.white_since = self.clear_since = self.last_trigger = None
        self.samples = 0
        self.latched = False

    def invalidate(self):
        self.last = self.white_since = self.clear_since = None
        self.samples = 0

    def update(self, fraction, timestamp):
        if not math.isfinite(timestamp) or not math.isfinite(fraction) or not 0 <= fraction <= 1 or (self.last is not None and timestamp <= self.last):
            self.invalidate()
            raise ProtocolError("invalid_detector_sample")
        if self.last is None or timestamp - self.last > self.max_gap:
            self.white_since = self.clear_since = None
            self.samples = 0
        self.last = timestamp
        if fraction >= 0.7:
            self.clear_since = None
            cooled = self.last_trigger is None or timestamp - self.last_trigger >= 3
            if not self.latched and cooled:
                if self.white_since is None:
                    self.white_since = timestamp
                    self.samples = 0
                self.samples += 1
                held = timestamp - self.white_since
                if held >= 1 and self.samples >= 3:
                    self.latched = True
                    self.last_trigger = timestamp
                    evidence = {"white_fraction": fraction, "held_seconds": held, "samples": self.samples}
                    self.white_since = None
                    return evidence
            else:
                self.white_since = None
                self.samples = 0
        elif fraction <= 0.45:
            self.white_since = None
            self.samples = 0
            if self.latched:
                if self.clear_since is None:
                    self.clear_since = timestamp
                if timestamp - self.clear_since >= 0.5:
                    self.latched = False
                    self.clear_since = None
        else:
            self.white_since = self.clear_since = None
            self.samples = 0
        return None


class Reader:
    def __init__(self, port, monotonic=time.monotonic):
        self.port, self.monotonic = port, monotonic
        self.buffer = bytearray()

    def add(self, deadline):
        if self.monotonic() >= deadline:
            raise ProtocolError("serial_timeout")
        try:
            chunk = self.port.read(max(1, min(getattr(self.port, "in_waiting", 0), 4096)))
        except Exception:
            raise ProtocolError("serial_read_failed") from None
        if chunk:
            self.buffer.extend(chunk)

    def exact(self, count, deadline):
        while len(self.buffer) < count:
            self.add(deadline)
        value = bytes(self.buffer[:count])
        del self.buffer[:count]
        return value

    def json_reply(self, predicate, deadline):
        noise = 0
        while True:
            while b"\n" not in self.buffer:
                if len(self.buffer) > 4096:
                    raise ProtocolError("serial_line_too_large")
                self.add(deadline)
            line, _, rest = self.buffer.partition(b"\n")
            self.buffer[:] = rest
            noise += len(line) + 1
            if noise > 16384:
                raise ProtocolError("serial_noise_limit")
            brace = line.find(b"{")
            if brace < 0:
                continue
            try:
                value = json.loads(line[brace:])
            except (UnicodeError, ValueError):
                continue
            if isinstance(value, dict) and value.get("ok") is False:
                raise firmware_rejection(value)
            if isinstance(value, dict) and predicate(value):
                return value

    def frame(self, epoch, previous_sequence, deadline):
        noise = 0
        while True:
            position = self.buffer.find(b"DCF1")
            newline = self.buffer.find(b"\n")
            if position >= 0 and (newline < 0 or position < newline):
                noise += position
                del self.buffer[:position]
                break
            if newline >= 0:
                line = bytes(self.buffer[:newline])
                del self.buffer[:newline + 1]
                noise += len(line) + 1
                brace = line.find(b"{")
                if brace >= 0:
                    try:
                        value = json.loads(line[brace:])
                        if isinstance(value, dict) and value.get("ok") is False:
                            raise firmware_rejection(value)
                    except (UnicodeError, ValueError):
                        pass
            if noise + len(self.buffer) > 16384:
                raise ProtocolError("serial_noise_limit")
            self.add(deadline)
        header = read_frame_header(self.exact(44, deadline), epoch, previous_sequence)
        pixels = self.exact(header["length"], deadline)
        if zlib.crc32(pixels) & 0xFFFFFFFF != header["crc"]:
            raise ProtocolError("frame_crc_mismatch")
        completion = self.json_reply(lambda value: value.get("capture_complete") is True, deadline)
        if completion.get("ok") is not True or completion.get("camera_stopped") is not True or completion.get("sequence") != header["sequence"] or type(completion.get("sensor_pid")) is not int or not 1 <= completion["sensor_pid"] <= 65535:
            raise ProtocolError("capture_not_complete")
        return header, pixels, completion["sensor_pid"]


class UsbDevice:
    def __init__(self, port_name, profile, expected_mac, device_id, allow_capture=False, max_age=0.5, max_gap=0.5, max_uncertainty=0.1, port_factory=None, port_info=None, wall=time.time, monotonic=time.monotonic):
        if profile not in PROFILES or not re.fullmatch(r"COM[1-9][0-9]*", port_name, re.I) or not re.fullmatch(r"(?:[a-f0-9]{2}:){5}[a-f0-9]{2}", expected_mac):
            raise ValueError("Explicit verified port/profile/MAC is required")
        if not 0 < max_age <= 2 or not 0 < max_uncertainty <= 0.25:
            raise ValueError("Invalid timing policy")
        self.name, self.profile, self.mac, self.device_id = port_name, profile, expected_mac, device_id
        self.allow_capture, self.max_age, self.max_uncertainty = allow_capture, max_age, max_uncertainty
        self.wall, self.mono = wall, monotonic
        self.port_factory, self.port_info = port_factory, port_info
        self.port = self.reader = self.mapping = None
        self.sequence = 0
        self.detector = WhiteHold(max_gap)
        self.scene_detector = SceneChange(max_gap)

    def open(self):
        if self.port is not None:
            return
        import serial
        from serial.tools import list_ports
        vid, pid, _, baud = PROFILES[self.profile]
        info = self.port_info or next((p for p in list_ports.comports() if p.device.upper() == self.name.upper()), None)
        if info is None or (info.vid, info.pid) != (vid, pid):
            raise ProtocolError("port_identity_mismatch")
        port = (self.port_factory or serial.Serial)(port=None, baudrate=baud, timeout=0.05, write_timeout=2)
        port.dtr = False
        port.rts = False
        port.port = self.name
        try:
            port.open()
        except Exception:
            port.close()
            raise ProtocolError("port_open_failed") from None
        self.port = port
        self.reader = Reader(port, self.mono)
        try:
            self.status()
        except Exception:
            self.close()
            raise

    def close(self):
        if self.port is not None:
            self.port.close()
        self.port = self.reader = self.mapping = None
        self.detector.invalidate()
        self.scene_detector.invalidate()

    def send(self, line):
        if self.port is None or len(line) > 63 or "\n" in line:
            raise ProtocolError("invalid_command")
        try:
            self.port.write((line + "\n").encode("ascii"))
            self.port.flush()
        except Exception as error:
            reason = "serial_write_timeout" if isinstance(error, TimeoutError) or type(error).__name__ == "SerialTimeoutException" else "serial_write_failed"
            raise ProtocolError(reason) from None

    def identity(self, payload):
        _, _, transport, baud = PROFILES[self.profile]
        if payload.get("board_mac") != self.mac or payload.get("transport") != transport or payload.get("baud_rate") != baud:
            raise ProtocolError("firmware_identity_mismatch")

    def status(self):
        self.send("status")
        payload = self.reader.json_reply(lambda value: isinstance(value.get("payload"), dict) and "firmware" in value["payload"], self.mono() + 3)["payload"]
        self.identity(payload)
        if payload.get("firmware") != "dot-device-bridge-usb-v1" or payload.get("board") != "GOOUUU ESP32 S3-CAM N16R8":
            raise ProtocolError("firmware_identity_mismatch")
        allowed = {"board_mac", "transport", "baud_rate", "firmware", "board", "face", "rendered_face", "revision", "rendered_revision", "frames", "width", "height", "display_ready", "display_timeout", "motor_enabled", "camera_enabled", "camera_capture_ready"}
        return {key: value for key, value in payload.items() if key in allowed and isinstance(value, (str, bool, int))}

    def camera_status(self, bind_clock=False):
        wall0, mono0 = self.wall(), self.mono()
        self.send("camera.status")
        payload = self.reader.json_reply(lambda value: isinstance(value.get("payload"), dict) and "source_epoch" in value["payload"], self.mono() + 3)["payload"]
        wall1, mono1 = self.wall(), self.mono()
        self.identity(payload)
        if bind_clock:
            self.mapping = ClockMapping(payload, wall0, wall1, mono0, mono1, self.max_uncertainty)
        allowed = {"source_epoch", "clock_us", "time_base", "board_mac", "transport", "baud_rate", "camera_driver_present", "camera_capture_allowed", "camera_active", "last_sensor_pid"}
        return {key: value for key, value in payload.items() if key in allowed and isinstance(value, (str, bool, int))}

    def screen(self, face, seconds=None):
        if face not in {"happy", "auto"} or (face == "happy" and (type(seconds) is not int or not 1 <= seconds <= 60)) or (face == "auto" and seconds is not None):
            raise ProtocolError("invalid_screen_command")
        self.send("auto" if face == "auto" else f"happy {seconds}")
        reply = self.reader.json_reply(lambda value: value.get("accepted") is True, self.mono() + 3)
        payload = reply.get("payload", {})
        revision = payload.get("revision")
        if payload.get("face") != face or type(revision) is not int or not 0 <= revision < 2**32:
            raise ProtocolError("invalid_command_receipt")
        deadline = self.mono() + 2
        latest = {}
        while self.mono() < deadline:
            latest = self.status()
            if latest.get("display_ready") is True and latest.get("display_timeout") is False and latest.get("rendered_revision") == revision and latest.get("rendered_face") == face:
                return {"accepted": True, "completed": True, "revision": revision, "rendered_revision": revision, "face": face}
            if latest.get("revision") != revision:
                break
            time.sleep(0.02)
        return {"accepted": True, "completed": False, "revision": revision, "face": face}

    def capture_once(self):
        if not self.allow_capture:
            raise ProtocolError("capture_not_authorized")
        if self.mapping is None:
            status = self.camera_status(bind_clock=True)
            if status.get("camera_capture_allowed") is not True or status.get("camera_active") is not False:
                raise ProtocolError("camera_not_ready")
        self.send("camera.frame")
        header, pixels, sensor_pid = self.reader.frame(self.mapping.epoch, self.sequence, self.mono() + 10)
        captured_at = self.mapping.captured_at(header, self.wall(), self.mono(), self.max_age)
        self.sequence = header["sequence"]
        fraction = white_fraction_rgb565(pixels)
        scene = self.scene_detector.update(scene_grid_rgb565(pixels), captured_at)
        del pixels
        evidence = self.detector.update(fraction, captured_at)
        metadata = {"source_epoch": header["source_epoch"], "sequence": str(header["sequence"]), "captured_at": datetime.datetime.fromtimestamp(captured_at, datetime.timezone.utc).isoformat().replace("+00:00", "Z"), "sensor_pid": sensor_pid, "crc_valid": True, "camera_stopped": True, "white_fraction": fraction, "clock_uncertainty_seconds": self.mapping.uncertainty}
        event = {"device_id": self.device_id, "source_epoch": metadata["source_epoch"], "frame_sequence": metadata["sequence"], "captured_at": metadata["captured_at"], "sensor_pid": sensor_pid, "simulation": False, **evidence} if evidence else None
        scene_event = {"device_id": self.device_id, "source_epoch": metadata["source_epoch"], "frame_sequence": metadata["sequence"], "captured_at": metadata["captured_at"], "sensor_pid": sensor_pid, "simulation": False, **scene["event"]} if scene["event"] else None
        metadata.update({"scene_changed": scene_event is not None, "scene_changed_fraction": scene["changed_fraction"], "scene_mean_delta": scene["mean_delta"]})
        return {"metadata": metadata, "event": event, "scene_event": scene_event}

    def execute(self, request):
        if not isinstance(request, dict) or request.get("operation") not in {"status", "camera_status", "screen", "capture_once"}:
            raise ProtocolError("invalid_operation")
        self.open()
        try:
            if request["operation"] == "status":
                return self.status()
            if request["operation"] == "camera_status":
                return self.camera_status()
            if request["operation"] == "screen":
                return self.screen(request.get("face"), request.get("seconds"))
            return self.capture_once()
        except Exception:
            self.close()  # A truncated frame cannot leave a text parser on pixel bytes.
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-open", action="store_true", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--profile", choices=list(PROFILES), required=True)
    parser.add_argument("--expected-mac", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--allow-capture", action="store_true")
    parser.add_argument("--max-age", type=float, default=0.5)
    parser.add_argument("--max-gap", type=float, default=0.5)
    args = parser.parse_args()
    device = UsbDevice(args.port, args.profile, args.expected_mac, args.device_id, args.allow_capture, args.max_age, args.max_gap)
    try:
        while True:
            line = sys.stdin.buffer.readline(4097)
            if not line:
                break
            request_id = None
            try:
                if len(line) > 4096 or not line.endswith(b"\n"):
                    raise ProtocolError("request_too_large")
                request = json.loads(line)
                request_id = request.get("id")
                result = device.execute(request.get("request"))
                reply = {"id": request_id, "ok": True, "result": result}
            except ProtocolError as error:
                reply = {"id": request_id, "ok": False, "reason": str(error)}
                if error.firmware_code:
                    reply["firmware_code"] = error.firmware_code
            except Exception as error:
                reason = "adapter_type_error" if isinstance(error, TypeError) else "adapter_value_error" if isinstance(error, ValueError) else "adapter_import_failed" if isinstance(error, ImportError) else "adapter_io_failed" if isinstance(error, OSError) else "adapter_failed"
                reply = {"id": request_id, "ok": False, "reason": reason}
            sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    finally:
        device.close()


if __name__ == "__main__":
    main()
