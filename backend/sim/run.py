"""Simulated NIDAR drone.

The simulator is just another drone-side client of the backend's ``/ingest``
WebSocket.  It renders a fake camera as MJPEG (see :mod:`sim.camera`), runs a
frontier-based exploration policy over a lidar-built occupancy grid, and emits
every message defined by the wire contract at the specified rates.

Run with::

    python -m sim.run                 # from the backend/ directory
    python -m sim.run --speed 2 --fail link
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import random
import time
from typing import Optional
from urllib.parse import urlparse

import numpy as np
import websockets

from . import config
from .arena import Arena
from .camera import Renderer, start_mjpeg_server
from .explore import Explorer
from .occupancy import KnownMap

# emission periods (seconds)
T_TELEMETRY = 0.1     # 10 Hz
T_MISSION = 0.5       # 2 Hz
T_MAP = 0.5           # 2 Hz
T_PATH = 1.0          # 1 Hz
T_FAILSAFE = 1.0      # 1 Hz
T_PREFLIGHT = 1.0     # 1 Hz
T_LIDAR = 0.2         # 5 Hz scan
T_REPLAN = 1.0        # 1 Hz
T_CAMERA = 1.0 / 15.0

LIDAR_RAYS = 360
LIDAR_RANGE = 5.0
DETECT_RANGE = 3.0
PREFLIGHT_DELAY = 3.0
FAIL_DELAY = 60.0


class FailsafeState:
    def __init__(self) -> None:
        self.low_battery = False
        self.link_loss = False
        self.geofence = False
        self.abort = False
        self.recall = False

    def as_dict(self) -> dict:
        return {
            "low_battery": self.low_battery,
            "link_loss": self.link_loss,
            "geofence": self.geofence,
            "abort": self.abort,
            "recall": self.recall,
        }


class Sim:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.arena = Arena()
        self.known = KnownMap(self.arena)
        self.explorer = Explorer(self.arena, self.known)
        self.renderer = Renderer(self.arena)

        # pose
        self.x, self.y = self.arena.entry
        self.yaw = math.radians(90.0)
        self.speed_nom = 0.6 * args.speed
        self.speed = 0.0
        self.alt = 0.8
        self.batt_pct = 100.0

        # mission state
        self.state = "IDLE"
        self.start_time: Optional[float] = None
        self.elapsed = 0.0
        self.distance_m = 0.0
        self.preflight_ok = False
        self.failsafe = FailsafeState()
        self.found: set[int] = set()
        self.plan: list[list[float]] = []
        self.trail: list[list[float]] = [[self.x, self.y]]
        self.force_emit = False

        self.cmd_queue: asyncio.Queue[str] = asyncio.Queue()
        self.events_out: list[dict] = []
        self.ws: Optional[websockets.WebSocketClientProtocol] = None

        # emit accumulators
        self.acc = {k: 1e9 for k in
                    ("telemetry", "mission", "map", "path", "failsafe", "preflight")}
        self.acc_lidar = 1e9
        self.acc_replan = 1e9
        self.acc_camera = 1e9

        self.rng = np.random.default_rng(1234)
        self.link_rssi = -55.0
        self.last_mission_key = None

        # wake the lazy accumulators on the first loop
        self.t0 = time.time()

    # ------------------------------------------------------------------ #
    # transport
    # ------------------------------------------------------------------ #
    async def send(self, msg: dict) -> None:
        if self.ws is None:
            return
        await self.ws.send(json.dumps(msg))

    async def recv_loop(self) -> None:
        assert self.ws is not None
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                cmd = msg.get("cmd") if isinstance(msg, dict) else None
                if cmd in ("START", "ABORT", "RESET"):
                    await self.cmd_queue.put(cmd)
        except websockets.ConnectionClosed:
            return

    # ------------------------------------------------------------------ #
    def on_command(self, cmd: str) -> None:
        if cmd == "RESET":
            # Simulator-only demo control. Refused mid-flight: ABORT first.
            if self.state in ("IDLE", "READY", "ABORTED", "EXITED", "FAILSAFE"):
                self._reset_mission()
                print("[sim] RESET received -> READY")
            return
        if cmd == "START":
            if self.state in ("IDLE", "READY"):
                self.state = "EXPLORING"
                self.start_time = time.time()
                self.elapsed = 0.0
                self.distance_m = 0.0
                self.plan = []
                self.acc_replan = 1e9
                self._queue_event("info", "mission started - autonomous exploration")
                print("[sim] START received -> EXPLORING")
            return
        if cmd == "ABORT":
            if self.state not in ("IDLE", "ABORTED"):
                self.state = "ABORTED"
                self.failsafe.abort = True
                self.speed = 0.0
                self._queue_event("crit", "ABORT - mission terminated by operator")
                print("[sim] ABORT received -> ABORTED")

    # ------------------------------------------------------------------ #
    def _reset_mission(self) -> None:
        """Return to READY and wipe every trace of the previous run."""
        self.known = KnownMap(self.arena)
        self.explorer = Explorer(self.arena, self.known)
        self.x, self.y = self.arena.entry
        self.yaw = math.radians(90.0)
        self.speed = 0.0
        self.alt = 0.8
        self.batt_pct = 100.0
        self.state = "READY"
        self.start_time = None
        self.elapsed = 0.0
        self.distance_m = 0.0
        self.preflight_ok = True
        self.failsafe = FailsafeState()
        self.found.clear()
        self.plan = []
        self.trail = [[self.x, self.y]]
        # Seed the fresh map with one entry scan. Without this the explorer
        # sees an all-unknown grid and immediately declares exploration done.
        self._lidar()
        self.acc = {k: 0.0 for k in
                    ("telemetry", "mission", "map", "path", "failsafe", "preflight")}
        self.acc_lidar = 0.0
        self.acc_replan = 0.0
        self.acc_camera = 0.0
        self.last_mission_key = None
        self.force_emit = True
        self._queue_event("info", "simulation reset - ready for a new run")

    # ------------------------------------------------------------------ #
    def _drain_commands(self) -> None:
        while not self.cmd_queue.empty():
            cmd = self.cmd_queue.get_nowait()
            self.on_command(cmd)
            # Let the READY burst go out before a START that arrived in the
            # same tick. Otherwise the backend would see EXPLORING instead of
            # READY and never complete the pending reset.
            if cmd == "RESET":
                break

    # ------------------------------------------------------------------ #
    def _update_battery(self, dt: float, now: float) -> None:
        if self.state in ("PREFLIGHT", "READY", "EXPLORING", "RETURNING"):
            self.batt_pct = max(0.0, self.batt_pct - (100.0 / 1800.0) * dt)
        if self.state == "ABORTED":
            self.batt_pct = max(0.0, self.batt_pct - (100.0 / 3600.0) * dt)

    def _battery_voltage(self) -> float:
        return 3.4 + 0.8 * (self.batt_pct / 100.0)

    def _link_stats(self, now: float) -> tuple[float, float, float]:
        self.link_rssi += random.uniform(-0.6, 0.6)
        self.link_rssi = max(-85.0, min(-40.0, self.link_rssi))
        latency = 25.0 + random.uniform(-8, 20)
        loss = max(0.0, random.uniform(0.0, 1.2))
        if self.args.fail == "link" and self.start_time and now - self.start_time > FAIL_DELAY:
            self.link_rssi = -82.0 + random.uniform(-3, 3)
            latency = 180.0 + random.uniform(-20, 60)
            loss = 25.0 + random.uniform(0, 10)
        return round(self.link_rssi, 1), round(latency, 1), round(loss, 1)

    def _update_failsafes(self, now: float) -> None:
        fs = self.failsafe
        fs.abort = self.state == "ABORTED"
        fs.low_battery = self.batt_pct < 25.0
        fs.recall = bool(self.start_time and self.elapsed > float(config.get("max_flight_s", 1800)))
        if self.args.fail and self.start_time and now - self.start_time > FAIL_DELAY:
            if self.args.fail == "link":
                fs.link_loss = True
            elif self.args.fail == "battery":
                fs.low_battery = True
            elif self.args.fail == "geofence":
                fs.geofence = True

        # A real failsafe stops the mission. The dashboard shows the FAILSAFE
        # debrief and the simulator can then be reset for another run.
        if self.state in ("EXPLORING", "RETURNING"):
            reason = None
            if fs.link_loss:
                reason = "link loss"
            elif fs.low_battery:
                reason = "low battery"
            elif fs.geofence:
                reason = "geofence breach"
            elif fs.recall:
                reason = "recall / flight-time limit"
            if reason:
                self.state = "FAILSAFE"
                self.speed = 0.0
                self.plan = []
                self._queue_event("crit", f"failsafe triggered - {reason}")
                print(f"[sim] failsafe ({reason}) -> FAILSAFE")

    # ------------------------------------------------------------------ #
    def _lidar(self) -> None:
        angles = np.linspace(-math.pi, math.pi, LIDAR_RAYS, endpoint=False) + self.yaw
        ranges = self.arena.cast_rays(
            self.x, self.y, angles, max_range=LIDAR_RANGE, step=0.05
        )
        self.known.integrate(
            self.x, self.y, angles, ranges, LIDAR_RANGE, step=0.05
        )

    def _replan(self) -> None:
        if self.state == "EXPLORING":
            path = self.explorer.plan_frontier(self.x, self.y)
            if path is None:
                self.state = "RETURNING"
                self._queue_event("info", "exploration complete - returning to entry")
                print("[sim] exploration complete -> RETURNING")
                self.plan = []
            else:
                self.plan = path
        elif self.state == "RETURNING":
            ex, ey = self.arena.entry
            path = self.explorer.plan_to(self.x, self.y, ex, ey)
            if path is None:
                self.plan = [[ex, ey]]
            else:
                self.plan = path

    def _move(self, dt: float) -> None:
        if self.state not in ("EXPLORING", "RETURNING"):
            self.speed = 0.0
            return

        # arriving home wins regardless of any pending plan
        if self.state == "RETURNING":
            ex, ey = self.arena.entry
            if math.hypot(self.x - ex, self.y - ey) < 0.35:
                self.state = "EXITED"
                self.speed = 0.0
                self._queue_event("info", "mission complete - drone exited the arena")
                print("[sim] returned to entry -> EXITED")
                return

        if not self.plan:
            self.speed = 0.0
            return

        # drop waypoints already reached (distances below half a map cell so
        # the drone actually visits corners instead of cutting them)
        while self.plan and math.hypot(
                self.plan[0][0] - self.x, self.plan[0][1] - self.y) < 0.06:
            self.plan.pop(0)
        if not self.plan:
            self.speed = 0.0
            return

        # aim for the furthest waypoint with a clear line of sight so the
        # smoothed path never clips a wall corner
        target = self.plan[0]
        for wt in self.plan[1:14]:
            if self.arena.line_of_sight(self.x, self.y, wt[0], wt[1]):
                target = wt
            else:
                break
        tx, ty = target
        dx, dy = tx - self.x, ty - self.y
        dist = math.hypot(dx, dy)

        desired = math.atan2(dy, dx)
        dphi = (desired - self.yaw + math.pi) % (2 * math.pi) - math.pi
        self.yaw += max(-3.5 * dt, min(3.5 * dt, dphi))

        step = self.speed_nom * dt
        nx = self.x + math.cos(self.yaw) * step
        ny = self.y + math.sin(self.yaw) * step
        if not self.arena.occupied(nx, ny):
            moved = math.hypot(nx - self.x, ny - self.y)
            self.x, self.y = nx, ny
            self.distance_m += moved
            self.speed = self.speed_nom
        else:
            self.speed = 0.0

        # pose drift (never allowed to nudge the drone into a wall)
        dx = self.rng.normal(0.0, 0.003)
        dy = self.rng.normal(0.0, 0.003)
        if not self.arena.occupied(self.x + dx, self.y + dy):
            self.x += dx
            self.y += dy
        self.yaw += self.rng.normal(0.0, 0.004)
        self.x = min(self.arena.w - 0.05, max(0.05, self.x))
        self.y = min(self.arena.h - 0.05, max(0.05, self.y))

        if math.hypot(self.trail[-1][0] - self.x, self.trail[-1][1] - self.y) > 0.1:
            self.trail.append([round(self.x, 2), round(self.y, 2)])
            if len(self.trail) > 4000:
                self.trail = self.trail[-4000:]

    def _detect_survivors(self) -> list[dict]:
        # Only search while the mission is active; READY/PREFLIGHT should not
        # pre-populate survivor cards before the operator presses START.
        if self.state not in ("EXPLORING", "RETURNING", "FAILSAFE"):
            return []
        new: list[dict] = []
        for s in self.arena.survivors:
            if s["id"] in self.found:
                continue
            d = math.hypot(s["x"] - self.x, s["y"] - self.y)
            if d <= DETECT_RANGE and self.arena.line_of_sight(self.x, self.y, s["x"], s["y"]):
                self.found.add(s["id"])
                conf = round(0.75 + 0.25 * float(self.rng.random()), 2)
                snapshot = base64.b64encode(self.renderer.latest()).decode("ascii")
                new.append({
                    "type": "survivor",
                    "id": s["id"],
                    "x": round(s["x"], 2),
                    "y": round(s["y"], 2),
                    "conf": conf,
                    "t": round(self.elapsed, 1),
                    "snapshot": snapshot,
                })
                print(f"[sim] survivor {s['id']} detected at "
                      f"{self.arena.cell_label(s['x'], s['y'])}")
                self._queue_event("warn", f"survivor {s['id']} detected")
        return new

    # ------------------------------------------------------------------ #
    # message builders
    # ------------------------------------------------------------------ #
    def _telemetry(self) -> dict:
        rssi, lat, loss = self._link_stats(time.time())
        return {
            "type": "telemetry",
            "t": round(time.time(), 3),
            "pose": {"x": round(self.x, 3), "y": round(self.y, 3),
                     "yaw": round(self.yaw, 4)},
            "speed": round(self.speed, 3),
            "alt": round(self.alt, 2),
            "battery": {"v": round(self._battery_voltage(), 2),
                        "pct": round(self.batt_pct, 1)},
            "link": {"rssi": rssi, "latency_ms": lat, "loss_pct": loss},
        }

    def _mission(self) -> dict:
        return {
            "type": "mission",
            "state": self.state,
            "elapsed_s": round(self.elapsed, 1),
            "explored_pct": round(self.known.explored_pct(), 1),
            "survivors_found": len(self.found),
            "distance_m": round(self.distance_m, 2),
        }

    def _path(self) -> dict:
        return {
            "type": "path",
            "trail": self.trail[-600:],
            "plan": [[round(p[0], 2), round(p[1], 2)] for p in self.plan],
        }

    def _preflight(self) -> dict:
        ok = self.preflight_ok
        return {
            "type": "preflight",
            "checks": {
                "link": ok, "video": ok, "map_stream": ok,
                "battery": ok, "sensors": ok, "failsafes": ok,
            },
        }

    async def _emit_events(self, now: float) -> None:
        while self.events_out:
            await self.send(self.events_out.pop(0))

    def _queue_event(self, level: str, msg: str) -> None:
        self.events_out.append({"type": "event", "level": level, "msg": msg})

    # ------------------------------------------------------------------ #
    async def step(self, dt: float) -> None:
        now = time.time()
        self._drain_commands()

        if self.force_emit:
            self.force_emit = False
            # READY first: the backend uses it to finish a pending reset.
            await self.send(self._mission())
            await self.send(self._telemetry())
            await self.send(self.known.to_message())
            await self.send(self._path())
            await self.send({"type": "failsafe", **self.failsafe.as_dict()})
            await self.send(self._preflight())

        await self._emit_events(now)

        if self.state == "IDLE":
            if not self.preflight_ok and now - self.t0 >= PREFLIGHT_DELAY:
                self.preflight_ok = True
                self.state = "READY"
                await self.send(self._preflight())
                await self.send({"type": "event", "level": "info",
                                 "msg": "all systems go - ready for START"})
        elif self.start_time is not None and self.state in ("EXPLORING", "RETURNING"):
            self.elapsed = now - self.start_time

        self._update_battery(dt, now)
        self._update_failsafes(now)

        # lidar + replan
        self.acc_lidar += dt
        if self.acc_lidar >= T_LIDAR:
            self.acc_lidar = 0.0
            self._lidar()

        self.acc_replan += dt
        if self.acc_replan >= T_REPLAN:
            self.acc_replan = 0.0
            if self.state in ("EXPLORING", "RETURNING"):
                self._replan()

        self._move(dt)

        for msg in self._detect_survivors():
            await self.send(msg)

        # camera
        self.acc_camera += dt
        if self.acc_camera >= T_CAMERA:
            self.acc_camera = 0.0
            self.renderer.render(self.x, self.y, self.yaw, self.arena.survivors)

        # periodic messages
        self.acc["telemetry"] += dt
        if self.acc["telemetry"] >= T_TELEMETRY:
            self.acc["telemetry"] = 0.0
            await self.send(self._telemetry())

        self.acc["map"] += dt
        if self.acc["map"] >= T_MAP:
            self.acc["map"] = 0.0
            await self.send(self.known.to_message())

        self.acc["path"] += dt
        if self.acc["path"] >= T_PATH:
            self.acc["path"] = 0.0
            await self.send(self._path())

        self.acc["failsafe"] += dt
        if self.acc["failsafe"] >= T_FAILSAFE:
            self.acc["failsafe"] = 0.0
            await self.send({"type": "failsafe", **self.failsafe.as_dict()})

        self.acc["preflight"] += dt
        if self.acc["preflight"] >= T_PREFLIGHT and self.state in ("IDLE", "PREFLIGHT", "READY"):
            self.acc["preflight"] = 0.0
            await self.send(self._preflight())

        self.acc["mission"] += dt
        key = (self.state, len(self.found),
               int(self.known.explored_pct() // 5))
        if self.acc["mission"] >= T_MISSION or key != self.last_mission_key:
            self.acc["mission"] = 0.0
            self.last_mission_key = key
            await self.send(self._mission())

    # ------------------------------------------------------------------ #
    async def run(self) -> None:
        # initial state burst once the link is up
        base_dt = 1.0 / 30.0

        while True:
            t_begin = time.time()
            await self.step(base_dt)
            elapsed = time.time() - t_begin
            await asyncio.sleep(max(0.0, base_dt - elapsed))


async def _connect(uri: str) -> websockets.WebSocketClientProtocol:
    while True:
        try:
            return await websockets.connect(uri, max_size=None, ping_interval=20)
        except (OSError, websockets.InvalidURI) as exc:
            print(f"[sim] waiting for backend at {uri} ({exc})")
            await asyncio.sleep(1.0)


async def main_async(args: argparse.Namespace) -> None:
    sim = Sim(args)

    # fake camera server
    video = urlparse(config.get("video_url", "http://localhost:8081/stream"))
    port = video.port or 8081
    start_mjpeg_server(sim.renderer, port=port)
    print(f"[sim] camera stream on http://localhost:{port}/stream")

    ws = await _connect(args.backend)
    sim.ws = ws
    await ws.send(json.dumps({"type": "hello", "role": "simulator"}))
    print(f"[sim] connected to {args.backend}")
    recv = asyncio.create_task(sim.recv_loop())
    try:
        await sim.run()
    finally:
        recv.cancel()
        await ws.close()


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="NIDAR drone simulator")
    ap.add_argument("--backend", default="ws://127.0.0.1:8000/ingest")
    ap.add_argument("--speed", type=float, default=1.0,
                    help="multiplier on the 0.6 m/s nominal speed")
    ap.add_argument("--fail", choices=["link", "battery", "geofence"], default=None,
                    help="inject this failsafe 60 s after START")
    return ap.parse_args(argv)


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("[sim] stopped")


if __name__ == "__main__":
    main()
