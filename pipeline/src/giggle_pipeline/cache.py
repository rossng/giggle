"""A small persistent cache keyed on a hash of everything that shapes a result.

Every expensive step (LLM calls, lookups) stores its output under the hash of its
inputs, prompt version and model. Change any of them and the key changes, so exactly
the affected results are recomputed; nothing needs clearing by hand. (A new model can
keep its predecessor's answers: see `llm.PREVIOUS_MODELS`.)
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any


def key_for(*parts: Any) -> str:
    payload = json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


class Cache:
    """SQLite-backed, one table per namespace ("lineup", "musicbrainz", …)."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS cache "
            "(namespace TEXT, key TEXT, value TEXT, created REAL, PRIMARY KEY (namespace, key))"
        )

    def get(self, namespace: str, key: str, max_age: float | None = None) -> Any | None:
        """The stored value, or None if missing or older than `max_age` seconds."""
        row = self.db.execute(
            "SELECT value, created FROM cache WHERE namespace = ? AND key = ?", (namespace, key)
        ).fetchone()
        if row is None or (max_age is not None and time.time() - row[1] > max_age):
            return None
        return json.loads(row[0])

    def age(self, namespace: str, key: str) -> float | None:
        """Seconds since the entry was stored, or None if there is none."""
        row = self.db.execute(
            "SELECT created FROM cache WHERE namespace = ? AND key = ?", (namespace, key)
        ).fetchone()
        return None if row is None else time.time() - row[0]

    def put(self, namespace: str, key: str, value: Any) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO cache VALUES (?, ?, ?, ?)",
            (namespace, key, json.dumps(value, ensure_ascii=False), time.time()),
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()
