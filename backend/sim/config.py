"""Shared config loader for the simulator (reads the repo-root config.json)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_PATH = Path(__file__).resolve().parents[2] / "config.json"

with _PATH.open("r", encoding="utf-8") as _fh:
    _CONFIG: dict[str, Any] = json.load(_fh)


def get(key: str, default: Any = None) -> Any:
    return _CONFIG.get(key, default)
