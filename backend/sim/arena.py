"""Ground-truth arena for the NIDAR simulator.

The arena is a 15 x 15 m grid of 1 m cells.  Two horizontal corridors, two
vertical corridors, six 2 x 2 m rooms, one shared entry/exit lane and four
junctions make up the traversable space.  Everything else is wall.

Layout (row 0 at the bottom, y up)::

    y14 ###############
    y13 #..#####..####.#     <- top rooms (rows 12-13)
    y12 #..#####..####.#
    y11 ...............#     <- top corridor (row 11)
    y10 #.#.....#.....#
    ...  (vertical corridors at col 4 and col 10)
    y03 ...............#     <- bottom corridor (row 3)
    y02 #..#####..####.#     <- bottom rooms (rows 1-2)
    y01 #..#####..####.#
    y00 ...............#     <- entry lane (col 0, rows 0-3)
         ^entry (0,0)
"""

from __future__ import annotations

import math

import numpy as np

from . import config


class Arena:
    def __init__(self) -> None:
        self.w = float(config.get("arena_w_m", 15))
        self.h = float(config.get("arena_h_m", 15))
        self.cell = float(config.get("cell_size_m", 1.0))
        self.res = float(config.get("map_res_m", 0.1))

        self.gw = int(round(self.w / self.cell))
        self.gh = int(round(self.h / self.cell))

        self.wp = int(round(self.w / self.res))  # grid width  (x)
        self.hp = int(round(self.h / self.res))  # grid height (y)

        self.free_cells = self._free_cells()
        self.ground_truth = self._build_ground_truth()

        self.entry = (
            float(config.get("entry", {}).get("x", 0.5)),
            float(config.get("entry", {}).get("y", 0.5)),
        )
        self.survivors = self._survivors()

    # ------------------------------------------------------------------ #
    # Construction
    # ------------------------------------------------------------------ #
    def _free_cells(self) -> set[tuple[int, int]]:
        free: set[tuple[int, int]] = set()
        # horizontal corridors
        for x in range(0, 15):
            free.add((x, 3))
            free.add((x, 11))
        # vertical corridors
        for y in range(3, 12):
            free.add((4, y))
            free.add((10, y))
        # entry lane (bottom-left)
        for y in range(0, 4):
            free.add((0, y))
        # six 2x2 rooms
        for cols in ((1, 2), (6, 7), (11, 12)):
            for rows in ((1, 2), (12, 13)):
                for x in cols:
                    for y in rows:
                        free.add((x, y))
        return free

    def _build_ground_truth(self) -> np.ndarray:
        gt = np.ones((self.hp, self.wp), dtype=np.int8)  # 1 = occupied
        for cx in range(self.gw):
            for cy in range(self.gh):
                if (cx, cy) in self.free_cells:
                    x0 = int(round(cx * self.cell / self.res))
                    y0 = int(round(cy * self.cell / self.res))
                    x1 = int(round((cx + 1) * self.cell / self.res))
                    y1 = int(round((cy + 1) * self.cell / self.res))
                    gt[y0:y1, x0:x1] = 0
        return gt

    def _survivors(self) -> list[dict]:
        # one survivor in the centre cell of each room
        centres = [(1, 1), (6, 1), (11, 1), (1, 12), (6, 12), (11, 12)]
        out = []
        for i, (cx, cy) in enumerate(centres, start=1):
            out.append({
                "id": i,
                "x": cx * self.cell + self.cell / 2.0,
                "y": cy * self.cell + self.cell / 2.0,
            })
        return out

    # ------------------------------------------------------------------ #
    # Queries
    # ------------------------------------------------------------------ #
    def in_bounds(self, x: float, y: float) -> bool:
        return 0.0 <= x < self.w and 0.0 <= y < self.h

    def occupied(self, x: float, y: float) -> bool:
        if not self.in_bounds(x, y):
            return True
        ix = int(x / self.res)
        iy = int(y / self.res)
        return bool(self.ground_truth[iy, ix])

    @property
    def free_area(self) -> float:
        return float((self.ground_truth == 0).sum()) * self.res * self.res

    def cell_label(self, x: float, y: float) -> str:
        col = int(x / self.cell)
        row = int(y / self.cell)
        return f"{chr(ord('A') + col)}{row + 1}"

    # ------------------------------------------------------------------ #
    # Ray casting (vectorised)
    # ------------------------------------------------------------------ #
    def cast_rays(
        self,
        x: float,
        y: float,
        angles: np.ndarray,
        max_range: float = 5.0,
        step: float = 0.05,
    ) -> np.ndarray:
        angles = np.atleast_1d(np.asarray(angles, dtype=np.float64))
        n_steps = max(1, int(math.ceil(max_range / step)))
        dists = np.arange(1, n_steps + 1, dtype=np.float64) * step  # (S,)

        px = x + np.cos(angles)[:, None] * dists[None, :]  # (N,S)
        py = y + np.sin(angles)[:, None] * dists[None, :]

        ix = (px / self.res).astype(np.int32)
        iy = (py / self.res).astype(np.int32)
        valid = (ix >= 0) & (ix < self.wp) & (iy >= 0) & (iy < self.hp)

        hit = np.ones(valid.shape, dtype=bool)  # out-of-bounds counts as hit
        vi = np.where(valid)
        hit[vi] = self.ground_truth[iy[vi], ix[vi]] > 0

        first = np.argmax(hit, axis=1)
        any_hit = hit.any(axis=1)
        ranges = np.where(any_hit, dists[first], max_range)
        return ranges

    def line_of_sight(self, x: float, y: float, tx: float, ty: float) -> bool:
        dx = tx - x
        dy = ty - y
        dist = math.hypot(dx, dy)
        if dist <= 1e-6:
            return True
        ang = math.atan2(dy, dx)
        rng = self.cast_rays(x, y, np.array([ang]), max_range=dist, step=0.04)[0]
        return rng >= dist - 0.05
