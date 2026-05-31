import json
from datetime import UTC, datetime
from typing import Any

import aiosqlite


class MemoryStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path

    async def init(self) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS incidents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    severity TEXT NOT NULL,
                    category TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS asset_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    asset_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            await db.commit()

    async def record_incident(
        self, severity: str, category: str, summary: str, payload: dict[str, Any]
    ) -> None:
        await self._execute(
            "INSERT INTO incidents(severity, category, summary, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (severity, category, summary, json.dumps(payload), self._now()),
        )

    async def record_asset_event(self, asset_id: str, event_type: str, payload: dict[str, Any]) -> None:
        await self._execute(
            "INSERT INTO asset_events(asset_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)",
            (asset_id, event_type, json.dumps(payload), self._now()),
        )

    async def set_preference(self, key: str, value: Any) -> None:
        await self._execute(
            """
            INSERT INTO preferences(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
            """,
            (key, json.dumps(value), self._now()),
        )

    async def get_preference(self, key: str) -> Any | None:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("SELECT value FROM preferences WHERE key = ?", (key,))
            row = await cursor.fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    async def recent_incidents(self, limit: int = 10) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            rows = await db.execute_fetchall(
                "SELECT * FROM incidents ORDER BY id DESC LIMIT ?", (limit,)
            )
        return [self._row_to_dict(row) for row in rows]

    async def _execute(self, sql: str, params: tuple[Any, ...]) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(sql, params)
            await db.commit()

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    @staticmethod
    def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
        item = dict(row)
        if "payload" in item:
            item["payload"] = json.loads(item["payload"])
        return item
