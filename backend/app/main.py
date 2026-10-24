"""NIDAR AirMouse GCS - backend.

Responsibilities
---------------
* ``/ingest`` : WebSocket endpoint spoken by the drone (or the simulator).
* ``/ws``     : WebSocket endpoint spoken by the dashboard.  On connect the
  full cached state is flushed, then live messages are streamed.  The only
  accepted inbound messages are ``{"cmd":"START"}`` and ``{"cmd":"ABORT"}``
  which are forwarded verbatim to the connected ``/ingest`` client.
* ``/api/config`` and ``/api/health`` REST helpers.
* A watchdog that reports ``{"type":"gcs_link","ok":false}`` when no ingest
  message has arrived for 2 s (and ``ok:true`` when they resume).
* Every message and command is appended to ``logs/mission-<ts>.jsonl``.
* ``frontend/dist`` is served as static files when it exists.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Optional

import base64
import re

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, ValidationError

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "config.json"
LOGS_DIR = ROOT / "logs"
FRONTEND_DIST = ROOT / "frontend" / "dist"

WATCHDOG_TIMEOUT_S = 2.0

MissionState = Literal[
    "IDLE", "PREFLIGHT", "READY", "EXPLORING",
    "RETURNING", "EXITED", "ABORTED", "FAILSAFE",
]


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


CONFIG = load_config()

# Set by run.py --sim. The reset endpoint is a simulator-only convenience and
# is never offered to (or honoured for) real drone hardware.
SIM_MODE = os.environ.get("NIDAR_SIM") == "1"

# States from which a simulator reset is safe. EXPLORING/RETURNING must be
# aborted first; PREFLIGHT is left alone.
RESETTABLE_STATES = {"IDLE", "READY", "EXITED", "ABORTED", "FAILSAFE"}


# --------------------------------------------------------------------------- #
# Pydantic models (drone -> GCS contract)
# --------------------------------------------------------------------------- #
class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Pose(_Base):
    x: float
    y: float
    yaw: float


class Battery(_Base):
    v: float
    pct: float


class LinkStat(_Base):
    rssi: float
    latency_ms: float
    loss_pct: float


class Telemetry(_Base):
    type: Literal["telemetry"]
    t: float
    pose: Pose
    speed: float
    alt: float
    battery: Battery
    link: LinkStat


class Mission(_Base):
    type: Literal["mission"]
    state: MissionState
    elapsed_s: float
    explored_pct: float
    survivors_found: int
    distance_m: float


class Origin(_Base):
    x: float
    y: float


class MapMessage(_Base):
    type: Literal["map"]
    res: float
    w: int
    h: int
    origin: Origin
    data: str


class PathMessage(_Base):
    type: Literal["path"]
    trail: list[list[float]]
    plan: list[list[float]]


class Survivor(_Base):
    type: Literal["survivor"]
    id: int
    x: float
    y: float
    conf: float
    t: float
    snapshot: Optional[str] = None


class Failsafe(_Base):
    type: Literal["failsafe"]
    low_battery: bool
    link_loss: bool
    geofence: bool
    abort: bool
    recall: bool


class Checks(_Base):
    link: bool
    video: bool
    map_stream: bool
    battery: bool
    sensors: bool
    failsafes: bool


class Preflight(_Base):
    type: Literal["preflight"]
    checks: Checks


class Event(_Base):
    type: Literal["event"]
    level: Literal["info", "warn", "crit"]
    msg: str


MODEL_FOR_TYPE: dict[str, type[BaseModel]] = {
    "telemetry": Telemetry,
    "mission": Mission,
    "map": MapMessage,
    "path": PathMessage,
    "survivor": Survivor,
    "failsafe": Failsafe,
    "preflight": Preflight,
    "event": Event,
}


# --------------------------------------------------------------------------- #
# JSONL mission logger
# --------------------------------------------------------------------------- #
class MissionLogger:
    def __init__(self) -> None:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.path = LOGS_DIR / f"mission-{stamp}.jsonl"
        self._fh = self.path.open("a", encoding="utf-8")

    def log(self, direction: str, kind: str, payload: Any) -> None:
        record = {
            "ts": datetime.now().isoformat(timespec="milliseconds"),
            "dir": direction,
            "kind": kind,
            "payload": payload,
        }
        self._fh.write(json.dumps(record, separators=(",", ":")) + "\n")
        self._fh.flush()

    def close(self) -> None:
        try:
            self._fh.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Connection hub
# --------------------------------------------------------------------------- #
class Hub:
    def __init__(self) -> None:
        self.ingest_ws: Optional[WebSocket] = None
        self.ingest_is_sim: bool = False
        self.clients: set[WebSocket] = set()
        self.latest: dict[str, dict] = {}
        self.survivors: dict[int, dict] = {}
        self.last_ingest_ts: float = 0.0
        self.link_ok: bool = True
        self.reset_pending: bool = False
        self.reset_started: float = 0.0
        self.logger = MissionLogger()

    # -- ingest ----------------------------------------------------------- #
    async def attach_ingest(self, ws: WebSocket) -> None:
        self.ingest_ws = ws
        self.ingest_is_sim = False

    def detach_ingest(self, ws: WebSocket) -> None:
        if self.ingest_ws is ws:
            self.ingest_ws = None
            self.ingest_is_sim = False
            self.reset_pending = False

    def ingest_connected(self) -> bool:
        return self.ingest_ws is not None

    async def forward_command(self, cmd: str) -> bool:
        ws = self.ingest_ws
        if ws is None:
            return False
        await ws.send_text(json.dumps({"cmd": cmd}))
        return True

    async def request_reset(self) -> tuple[bool, str]:
        """Ask the simulator to return to READY. Never used for real hardware."""
        if not SIM_MODE:
            return False, "reset is only available in simulator mode"
        if self.ingest_ws is None:
            return False, "simulator not connected"
        if not self.ingest_is_sim:
            return False, "ingest client is not a simulator"
        state = (self.latest.get("mission") or {}).get("state")
        if state not in RESETTABLE_STATES:
            return False, "abort the mission before resetting"
        self.reset_pending = True
        self.reset_started = time.time()
        self.logger.log("cmd", "RESET", {"cmd": "RESET"})
        await self.forward_command("RESET")
        return True, ""

    # -- dashboard clients ------------------------------------------------ #
    def add_client(self, ws: WebSocket) -> None:
        self.clients.add(ws)

    def remove_client(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    def snapshot(self) -> list[dict]:
        order = ["preflight", "mission", "telemetry", "map", "path", "failsafe", "event"]
        out = [self.latest[k] for k in order if k in self.latest]
        out.extend(self.survivors.values())
        return out

    async def broadcast(self, payload: dict) -> None:
        text = json.dumps(payload)
        dead: list[WebSocket] = []
        for client in list(self.clients):
            try:
                await client.send_text(text)
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    # -- message handling ------------------------------------------------- #
    async def handle_ingest(self, raw: str) -> None:
        self.last_ingest_ts = time.time()
        if not self.link_ok:
            self.link_ok = True
            await self.broadcast({"type": "gcs_link", "ok": True})
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            self.logger.log("in", "invalid-json", raw[:512])
            return
        if not isinstance(msg, dict):
            self.logger.log("in", "invalid", raw[:512])
            return
        mtype = msg.get("type")
        if mtype == "hello":
            # Only the simulator sends this. Real drone hardware never does,
            # so the reset path can never target real hardware.
            self.ingest_is_sim = msg.get("role") == "simulator"
            self.logger.log("in", "hello", msg)
            print(f"[ingest] client role: {'simulator' if self.ingest_is_sim else 'drone'}")
            return
        model = MODEL_FOR_TYPE.get(mtype)
        if model is None:
            self.logger.log("in", "unknown", msg)
            return
        try:
            validated = model.model_validate(msg)
        except ValidationError as exc:
            self.logger.log("in", f"invalid-{mtype}", msg)
            print(f"[ingest] rejected {mtype}: {exc.errors()[:1]}")
            return
        payload = validated.model_dump()
        if self.reset_pending:
            if mtype == "mission" and payload["state"] in ("IDLE", "READY"):
                # The simulator is back at READY: drop everything from the old
                # run, tell the dashboard to clear, then seed the fresh state.
                self.reset_pending = False
                self.latest.clear()
                self.survivors.clear()
                self.latest[mtype] = payload
                self.logger.log("in", mtype, payload)
                await self.broadcast({"type": "reset"})
                await self.broadcast(payload)
                return
            # Ignore stale ABORTED/FAILSAFE frames while the reset is in flight.
            return
        if mtype == "survivor":
            self.survivors[payload["id"]] = payload
        else:
            self.latest[mtype] = payload
        self.logger.log("in", mtype, payload)
        await self.broadcast(payload)

    async def watchdog(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            if self.link_ok and self.last_ingest_ts and (
                time.time() - self.last_ingest_ts > WATCHDOG_TIMEOUT_S
            ):
                self.link_ok = False
                print("[watchdog] ingest link lost")
                await self.broadcast({"type": "gcs_link", "ok": False})
            if self.reset_pending and time.time() - self.reset_started > 6.0:
                self.reset_pending = False
                print("[watchdog] simulator reset timed out")
                await self.broadcast({"type": "event", "level": "warn",
                                      "msg": "simulator reset timed out"})


hub = Hub()


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(title="NIDAR AirMouse GCS")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(hub.watchdog())
    print(f"[gcs] logging to {hub.logger.path}")


@app.websocket("/ingest")
async def ingest(ws: WebSocket) -> None:
    await ws.accept()
    await hub.attach_ingest(ws)
    print("[gcs] drone connected on /ingest")
    try:
        while True:
            raw = await ws.receive_text()
            await hub.handle_ingest(raw)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[ingest] error: {exc!r}")
    finally:
        hub.detach_ingest(ws)
        print("[gcs] drone disconnected from /ingest")


@app.websocket("/ws")
async def dashboard(ws: WebSocket) -> None:
    await ws.accept()
    hub.add_client(ws)
    print("[gcs] dashboard connected on /ws")
    try:
        for cached in hub.snapshot():
            await ws.send_text(json.dumps(cached))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                hub.logger.log("cmd", "invalid-json", raw[:512])
                continue
            cmd = msg.get("cmd") if isinstance(msg, dict) else None
            if cmd in ("START", "ABORT"):
                hub.logger.log("cmd", cmd, msg)
                forwarded = await hub.forward_command(cmd)
                if not forwarded:
                    await ws.send_text(json.dumps(
                        {"type": "event", "level": "warn",
                         "msg": f"{cmd} ignored: no drone connected"}
                    ))
            else:
                hub.logger.log("cmd", "rejected", msg)
                await ws.send_text(json.dumps(
                    {"type": "event", "level": "warn",
                     "msg": "only START and ABORT commands are accepted"}
                ))
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[ws] error: {exc!r}")
    finally:
        hub.remove_client(ws)
        print("[gcs] dashboard disconnected from /ws")


@app.get("/api/config")
async def api_config() -> JSONResponse:
    return JSONResponse({**CONFIG, "sim_mode": SIM_MODE})


@app.get("/api/health")
async def api_health() -> JSONResponse:
    age = None
    if hub.last_ingest_ts:
        age = int((time.time() - hub.last_ingest_ts) * 1000)
    return JSONResponse({
        "ingest_connected": hub.ingest_connected(),
        "ingest_is_sim": hub.ingest_is_sim,
        "sim_mode": SIM_MODE,
        "reset_pending": hub.reset_pending,
        "last_msg_age_ms": age,
    })


@app.post("/api/reset")
async def api_reset() -> JSONResponse:
    """Simulator-only: return to READY and clear the dashboard for a new run."""
    ok, detail = await hub.request_reset()
    if not ok:
        return JSONResponse({"detail": detail}, status_code=403 if not SIM_MODE else 409)
    return JSONResponse({"ok": True, "pending": True})


_LOG_NAME = re.compile(r"^[A-Za-z0-9._-]+\.jsonl$")


@app.get("/api/logs")
async def api_logs() -> JSONResponse:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        (p.name for p in LOGS_DIR.glob("*.jsonl")),
        reverse=True,
    )
    return JSONResponse({"files": files})


@app.get("/api/logs/{name}", response_model=None)
async def api_log_file(name: str) -> FileResponse | JSONResponse:
    if not _LOG_NAME.match(name):
        return JSONResponse({"detail": "invalid log name"}, status_code=400)
    path = (LOGS_DIR / name).resolve()
    if path.parent != LOGS_DIR.resolve() or not path.is_file():
        return JSONResponse({"detail": "not found"}, status_code=404)
    return FileResponse(str(path), media_type="application/x-ndjson")


@app.post("/api/report")
async def api_report(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"detail": "invalid json"}, status_code=400)

    report = body.get("report", body)
    png = body.get("png")
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    saved: list[str] = []

    json_path = LOGS_DIR / f"mission-report-{stamp}.json"
    with json_path.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)
    saved.append(json_path.name)

    if isinstance(png, str) and png.startswith("data:image"):
        try:
            _, b64 = png.split(",", 1)
            raw = base64.b64decode(b64)
            png_path = LOGS_DIR / f"mission-map-{stamp}.png"
            png_path.write_bytes(raw)
            saved.append(png_path.name)
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[report] png save failed: {exc!r}")

    print(f"[report] saved {', '.join(saved)}")
    return JSONResponse({"ok": True, "saved": saved})


if FRONTEND_DIST.exists():
    assets = FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        candidate = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and candidate.is_file()
            and FRONTEND_DIST.resolve() in candidate.parents
        ):
            return FileResponse(str(candidate))
        index = FRONTEND_DIST / "index.html"
        if index.is_file():
            return FileResponse(str(index))
        return JSONResponse({"detail": "frontend not built"}, status_code=404)
