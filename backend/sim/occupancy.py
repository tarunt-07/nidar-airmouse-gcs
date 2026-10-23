"""The drone's own occupancy map, built from simulated lidar scans.

Values follow the wire format: -1 unknown, 0 free, 100 occupied.
The grid is stored row-major at ``arena.res`` (0.1 m by default).
"""

from __future__ import annotations

import numpy as np

from .arena import Arena

UNKNOWN = -1
FREE = 0
OCCUPIED = 100


class KnownMap:
    def __init__(self, arena: Arena) -> None:
        self.arena = arena
        self.res = arena.res
        self.w = arena.wp
        self.h = arena.hp
        self.grid = np.full((self.h, self.w), UNKNOWN, dtype=np.int8)

    # ------------------------------------------------------------------ #
    def integrate(
        self,
        x: float,
        y: float,
        angles: np.ndarray,
        ranges: np.ndarray,
        max_range: float,
        step: float = 0.05,
    ) -> None:
        angles = np.atleast_1d(np.asarray(angles, dtype=np.float64))
        ranges = np.atleast_1d(np.asarray(ranges, dtype=np.float64))
        n_steps = max(1, int(np.ceil(max_range / step)))
        dists = np.arange(1, n_steps + 1, dtype=np.float64) * step  # (S,)

        px = x + np.cos(angles)[:, None] * dists[None, :]
        py = y + np.sin(angles)[:, None] * dists[None, :]
        ix = (px / self.res).astype(np.int32)
        iy = (py / self.res).astype(np.int32)
        valid = (ix >= 0) & (ix < self.w) & (iy >= 0) & (iy < self.h)

        # free space: samples strictly before the hit distance
        free_mask = (dists[None, :] < (ranges - 1e-6)[:, None]) & valid
        fx = ix[free_mask]
        fy = iy[free_mask]
        if fx.size:
            cur = self.grid[fy, fx]
            cur[cur != OCCUPIED] = FREE
            self.grid[fy, fx] = cur

        # occupied cells at the hit point
        hit = ranges < (max_range - 1e-6)
        if np.any(hit):
            hx = ((x + np.cos(angles) * ranges) / self.res).astype(np.int32)[hit]
            hy = ((y + np.sin(angles) * ranges) / self.res).astype(np.int32)[hit]
            ok = (hx >= 0) & (hx < self.w) & (hy >= 0) & (hy < self.h)
            self.grid[hy[ok], hx[ok]] = OCCUPIED

        # the robot's own cell is definitely free
        cx = int(x / self.res)
        cy = int(y / self.res)
        if 0 <= cx < self.w and 0 <= cy < self.h and self.grid[cy, cx] != OCCUPIED:
            self.grid[cy, cx] = FREE

    # ------------------------------------------------------------------ #
    @property
    def known_free_area(self) -> float:
        return float((self.grid == FREE).sum()) * self.res * self.res

    def explored_pct(self) -> float:
        total = self.arena.free_area
        if total <= 0:
            return 0.0
        return float(min(100.0, 100.0 * self.known_free_area / total))

    def frontier_open_cells(self) -> list[tuple[int, int]]:
        """Free res-cells adjacent to an unknown res-cell (debug helper)."""
        g = self.grid
        free = g == FREE
        unknown = g == UNKNOWN
        adj = np.zeros_like(free)
        adj[1:, :] |= unknown[:-1, :]
        adj[:-1, :] |= unknown[1:, :]
        adj[:, 1:] |= unknown[:, :-1]
        adj[:, :-1] |= unknown[:, 1:]
        ys, xs = np.where(free & adj)
        return list(zip(xs.tolist(), ys.tolist()))

    # ------------------------------------------------------------------ #
    def to_message(self, origin=(0.0, 0.0)) -> dict:
        import base64
        import zlib

        data = zlib.compress(self.grid.tobytes(), level=6)
        return {
            "type": "map",
            "res": self.res,
            "w": self.w,
            "h": self.h,
            "origin": {"x": float(origin[0]), "y": float(origin[1])},
            "data": base64.b64encode(data).decode("ascii"),
        }
