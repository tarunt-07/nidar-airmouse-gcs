"""Fake first-person camera: a raycast renderer served as MJPEG.

The renderer casts one ray per screen column through the ground-truth arena,
draws shaded wall slices, a floor/ceiling, and survivor figures visible within
the field of view.  A timestamp and light sensor noise are overlaid before the
frame is JPEG encoded.
"""

from __future__ import annotations

import io
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import numpy as np
from PIL import Image, ImageDraw

from .arena import Arena

WIDTH = 640
HEIGHT = 480
FOV = math.radians(90.0)
MAX_RANGE = 6.0
WALL_HEIGHT = 1.6
EYE_HEIGHT = 0.8


class Renderer:
    def __init__(self, arena: Arena) -> None:
        self.arena = arena
        self.cols = np.arange(WIDTH, dtype=np.float64)
        self.angles_offset = (self.cols / WIDTH - 0.5) * FOV
        self.rows = np.arange(HEIGHT, dtype=np.float64)[:, None]
        self._latest = self._blank()
        self._rng = np.random.default_rng(7)

    def _blank(self) -> bytes:
        img = Image.new("RGB", (WIDTH, HEIGHT), (10, 10, 14))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return buf.getvalue()

    # ------------------------------------------------------------------ #
    def render(self, x: float, y: float, yaw: float, survivors: list[dict]) -> bytes:
        angles = yaw + self.angles_offset
        dist = self.arena.cast_rays(x, y, angles, max_range=MAX_RANGE, step=0.06)
        dist = np.maximum(dist, 0.05)

        # perspective: projected wall half-height in pixels
        focal = WIDTH / (2.0 * math.tan(FOV / 2.0))
        half = (focal * (WALL_HEIGHT / 2.0)) / dist  # (W,)
        mid = HEIGHT / 2.0
        top = mid - half
        bot = mid + half

        shade = np.clip(210.0 / (1.0 + dist * 0.55), 20, 210).astype(np.uint8)
        img = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)

        # ceiling gradient
        ceil = (14 + (self.rows / (HEIGHT / 2.0)) * 20).astype(np.uint8)
        img[:, :, 0] = ceil
        img[:, :, 1] = ceil
        img[:, :, 2] = ceil

        # floor gradient
        floor = (26 + (1.0 - (self.rows - HEIGHT / 2.0) / (HEIGHT / 2.0)) * 34)
        floor = np.clip(floor, 0, 255).astype(np.uint8)
        img[:, :, 0] = np.where(self.rows > mid, floor, img[:, :, 0])
        img[:, :, 1] = np.where(self.rows > mid, floor, img[:, :, 1])
        img[:, :, 2] = np.where(self.rows > mid, floor, img[:, :, 2])

        # walls
        wall_mask = (self.rows >= top) & (self.rows <= bot)
        img[:, :, 0] = np.where(wall_mask, shade, img[:, :, 0])
        img[:, :, 1] = np.where(wall_mask, shade, img[:, :, 1])
        img[:, :, 2] = np.where(wall_mask, (shade * 0.92).astype(np.uint8), img[:, :, 2])

        # survivors as coloured figures
        for s in survivors:
            self._draw_survivor(img, x, y, yaw, s, dist)

        # sensor noise
        noise = self._rng.normal(0.0, 4.0, img.shape)
        img = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)

        pil = Image.fromarray(img)
        self._overlay(pil, x, y, yaw)
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=70)
        frame = buf.getvalue()
        self._latest = frame
        return frame

    # ------------------------------------------------------------------ #
    def _draw_survivor(self, img, x, y, yaw, s: dict, dist):
        dx = s["x"] - x
        dy = s["y"] - y
        d = math.hypot(dx, dy)
        if d < 0.2 or d > MAX_RANGE:
            return
        rel = math.atan2(dy, dx) - yaw
        rel = (rel + math.pi) % (2 * math.pi) - math.pi
        if abs(rel) > FOV / 2.0 + 0.05:
            return
        if not self.arena.line_of_sight(x, y, s["x"], s["y"]):
            return
        col = int((rel / FOV + 0.5) * WIDTH)
        focal = WIDTH / (2.0 * math.tan(FOV / 2.0))
        figure_h = focal * 1.5 / d
        figure_w = max(2, int(figure_h * 0.32))
        mid = HEIGHT / 2.0
        top = int(mid - figure_h)
        bot = int(mid + figure_h * 0.15)
        c0 = max(0, col - figure_w // 2)
        c1 = min(WIDTH, col + figure_w // 2)
        r0 = max(0, top)
        r1 = min(HEIGHT, bot)
        if c1 <= c0 or r1 <= r0:
            return
        fade = min(1.0, 3.0 / d)
        colour = np.array([230, 70, 70], dtype=np.float32)
        region = img[r0:r1, c0:c1].astype(np.float32)
        img[r0:r1, c0:c1] = np.clip(
            region * (1.0 - fade) + colour * fade, 0, 255
        ).astype(np.uint8)

    # ------------------------------------------------------------------ #
    def _overlay(self, pil: Image.Image, x: float, y: float, yaw: float) -> None:
        draw = ImageDraw.Draw(pil)
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        draw.rectangle((0, 0, WIDTH, 18), fill=(0, 0, 0))
        draw.text((6, 4), f"CAM  {ts}  pos=({x:4.1f},{y:4.1f}) yaw={math.degrees(yaw):5.0f}",
                  fill=(200, 230, 200))
        draw.text((6, HEIGHT - 14), "LIVE / NO SIGNAL FALLBACK: NONE", fill=(180, 180, 180))

    # ------------------------------------------------------------------ #
    def latest(self) -> bytes:
        return self._latest


class _Handler(BaseHTTPRequestHandler):
    renderer: Renderer
    stream_path: str = "/stream"

    def log_message(self, *args) -> None:  # silence stderr spam
        pass

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path != self.stream_path:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Age", "0")
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("Pragma", "no-cache")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while True:
                frame = self.renderer.latest()
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode())
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                time.sleep(1.0 / 15.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def start_mjpeg_server(renderer: Renderer, host: str = "0.0.0.0", port: int = 8081) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (_Handler,), {"renderer": renderer})
    server = ThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
