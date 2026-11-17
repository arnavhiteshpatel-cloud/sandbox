"""Tiny thread-safe pub/sub used to stream state to the UI (WebSocket) and the menu-bar shell."""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable

Listener = Callable[[dict], None]


class EventBus:
    def __init__(self) -> None:
        self._listeners: list[Listener] = []
        self._queues: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self.state: dict[str, Any] = {"status": "idle"}

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, fn: Listener) -> None:
        with self._lock:
            self._listeners.append(fn)

    def queue(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._queues.add(q)
        return q

    def unqueue(self, q: asyncio.Queue) -> None:
        self._queues.discard(q)

    def emit(self, type_: str, **data: Any) -> None:
        event = {"type": type_, "ts": time.time(), **data}
        if type_ == "status":
            self.state["status"] = data.get("status", "idle")
        with self._lock:
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(event)
            except Exception:  # a broken listener must never break the assistant
                pass
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._fanout(event)
        else:
            loop.call_soon_threadsafe(self._fanout, event)

    def _fanout(self, event: dict) -> None:
        for q in list(self._queues):
            if q.full():
                try:
                    q.get_nowait()  # drop oldest; UI only needs recent state
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)
