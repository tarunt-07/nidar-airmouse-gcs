"""Frontier-based exploration over the drone's known occupancy map.

Planning runs directly on the known map's native resolution (0.1 m by
default) so that 1 m corridors and room doorways are never sealed off by
coarse down-sampling.  A breadth-first wavefront from the robot's cell finds
the nearest *frontier* (a known-free cell next to an unknown cell) and returns
the waypoint path to it.  A plain BFS is also used to plan a route back to the
entry when exploration is complete.
"""

from __future__ import annotations

from collections import deque
from typing import Optional

import numpy as np

from .arena import Arena
from .occupancy import FREE, OCCUPIED, UNKNOWN, KnownMap


class Explorer:
    def __init__(self, arena: Arena, known: KnownMap, plan_res: float = 0.5) -> None:
        self.arena = arena
        self.known = known
        self.res = known.res
        self.w = known.w
        self.h = known.h

    # ------------------------------------------------------------------ #
    def _world_to_cell(self, x: float, y: float) -> tuple[int, int]:
        return (
            min(self.w - 1, max(0, int(x / self.res))),
            min(self.h - 1, max(0, int(y / self.res))),
        )

    def _cell_to_world(self, cx: int, cy: int) -> list[float]:
        return [(cx + 0.5) * self.res, (cy + 0.5) * self.res]

    def _nearest_free(self, cx: int, cy: int) -> Optional[tuple[int, int]]:
        """Nearest known-free cell to (cx, cy), searched in square rings."""
        g = self.known.grid
        if g[cy, cx] == FREE:
            return cx, cy
        for r in range(1, 40):
            x0, x1 = max(0, cx - r), min(self.w, cx + r + 1)
            y0, y1 = max(0, cy - r), min(self.h, cy + r + 1)
            sub = g[y0:y1, x0:x1]
            ys, xs = np.where(sub == FREE)
            if xs.size:
                best = int(np.argmin((xs + x0 - cx) ** 2 + (ys + y0 - cy) ** 2))
                return int(xs[best]) + x0, int(ys[best]) + y0
        return None

    # ------------------------------------------------------------------ #
    def _bfs(self, start: tuple[int, int]):
        """Wavefront over known-free cells. Returns (dist, parent) maps."""
        g = self.known.grid
        free = g == FREE
        dist = -np.ones((self.h, self.w), dtype=np.int32)
        parent = -np.ones((self.h, self.w, 2), dtype=np.int32)
        sx, sy = start
        if not free[sy, sx]:
            return dist, parent
        dist[sy, sx] = 0
        q = deque([(sx, sy)])
        while q:
            cx, cy = q.popleft()
            d = dist[cy, cx] + 1
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < self.w and 0 <= ny < self.h:
                    if not free[ny, nx] or dist[ny, nx] != -1:
                        continue
                    dist[ny, nx] = d
                    parent[ny, nx] = (cx, cy)
                    q.append((nx, ny))
        return dist, parent

    def _reconstruct(self, parent, cell, start) -> list[list[float]]:
        path = []
        cx, cy = cell
        while (cx, cy) != start:
            path.append(self._cell_to_world(cx, cy))
            px, py = parent[cy, cx]
            if px < 0:
                break
            cx, cy = int(px), int(py)
        path.reverse()
        return path

    # ------------------------------------------------------------------ #
    def plan_frontier(self, x: float, y: float) -> Optional[list[list[float]]]:
        """Waypoints to the nearest reachable frontier, or None if none."""
        g = self.known.grid
        start = self._world_to_cell(x, y)
        if g[start[1], start[0]] != FREE:
            near = self._nearest_free(*start)
            if near is None:
                return None
            start = near

        free = g == FREE
        unknown = g == UNKNOWN
        adj = np.zeros_like(free)
        adj[1:, :] |= unknown[:-1, :]
        adj[:-1, :] |= unknown[1:, :]
        adj[:, 1:] |= unknown[:, :-1]
        adj[:, :-1] |= unknown[:, 1:]
        frontier = free & adj

        dist, parent = self._bfs(start)
        reachable = frontier & (dist >= 0)
        reachable[start[1], start[0]] = False
        if not reachable.any():
            return None
        ys, xs = np.where(reachable)
        costs = dist[ys, xs]
        best = int(np.argmin(costs))
        target = (int(xs[best]), int(ys[best]))
        return self._reconstruct(parent, target, start)

    def plan_to(self, x: float, y: float, gx: float, gy: float) -> Optional[list[list[float]]]:
        """BFS route from the robot to a goal world point over known-free."""
        start = self._world_to_cell(x, y)
        near = self._nearest_free(*start)
        if near is None:
            return None
        start = near
        goal = self._world_to_cell(gx, gy)
        near_goal = self._nearest_free(*goal)
        if near_goal is None:
            return None
        goal = near_goal

        dist, parent = self._bfs(start)
        if dist[goal[1], goal[0]] < 0:
            return None
        path = self._reconstruct(parent, goal, start)
        path.append([gx, gy])
        return path
