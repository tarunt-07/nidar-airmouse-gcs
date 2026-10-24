"""NIDAR AirMouse GCS launcher.

    python run.py          # backend only (serves frontend/dist if built)
    python run.py --sim    # backend + the drone simulator

Add ``--speed N`` and ``--fail link|battery|geofence`` to control the
simulator when it is spawned.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"


def main() -> None:
    ap = argparse.ArgumentParser(description="NIDAR AirMouse GCS")
    ap.add_argument("--sim", action="store_true", help="also start the simulator")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--fail", choices=["link", "battery", "geofence"], default=None)
    args = ap.parse_args()

    # The backend exposes POST /api/reset only in simulator mode.
    if args.sim:
        os.environ["NIDAR_SIM"] = "1"

    os.chdir(ROOT)
    sys.path.insert(0, str(BACKEND))

    import uvicorn

    sim_proc = None
    if args.sim:
        cmd = [
            sys.executable, "-m", "sim.run",
            "--backend", f"ws://{args.host}:{args.port}/ingest",
            "--speed", str(args.speed),
        ]
        if args.fail:
            cmd += ["--fail", args.fail]
        print(f"[run] starting simulator: {' '.join(cmd)}")
        sim_proc = subprocess.Popen(cmd, cwd=str(BACKEND))

    print(f"[run] GCS at http://{args.host}:{args.port}  (WS /ws, ingest /ingest)")
    try:
        uvicorn.run("app.main:app", host=args.host, port=args.port)
    finally:
        if sim_proc is not None:
            sim_proc.terminate()
            try:
                sim_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sim_proc.kill()


if __name__ == "__main__":
    main()
