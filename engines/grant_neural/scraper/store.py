"""Persistent storage for normalized Grant Neural Engine signals."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from threading import Lock
from typing import Any


STATE_PATH = Path(__file__).resolve().parents[3] / "core" / "state" / "grant_signals.json"
_STORE_LOCK = Lock()
LOGGER = logging.getLogger(__name__)


def _dedupe_key(signal: dict[str, Any]) -> tuple[str, str]:
    title = re.sub(r"\s+", " ", str(signal.get("title") or "")).strip().casefold()
    return title, str(signal.get("published_date") or "").strip()


def _load_signals() -> list[dict[str, Any]]:
    if not STATE_PATH.exists():
        return []
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise ValueError(f"Unable to read grant signal state: {error}") from error
    if not isinstance(data, list):
        raise ValueError("grant_signals.json must contain a JSON array")
    return data


def store_signal(signal: dict[str, Any]) -> bool:
    """Append a signal unless another signal has the same title and date."""
    result = store_signals([signal])
    if result["errors"]:
        raise ValueError(result["errors"][0])
    return result["stored"] == 1


def store_signals(incoming: list[dict[str, Any]]) -> dict[str, Any]:
    """Store a batch atomically while deduplicating against state and the batch."""
    stored = 0
    duplicates = 0
    errors: list[str] = []
    with _STORE_LOCK:
        signals = _load_signals()
        existing_keys = {_dedupe_key(item) for item in signals}
        for signal in incoming:
            key = _dedupe_key(signal)
            if not all(key):
                message = "Signal title and published_date are required"
                LOGGER.error("grant_signal_error source_type=%s title=%r date=%r", signal.get("source_type", "unknown"), signal.get("title"), signal.get("published_date"))
                errors.append(message)
                continue
            if key in existing_keys:
                duplicates += 1
                LOGGER.info("grant_signal_duplicate source_type=%s title=%r date=%s", signal.get("source_type", "unknown"), signal.get("title"), signal.get("published_date"))
                continue
            signals.append(signal)
            existing_keys.add(key)
            stored += 1
            LOGGER.info("grant_signal_stored source_type=%s title=%r date=%s", signal.get("source_type", "unknown"), signal.get("title"), signal.get("published_date"))

        if stored:
            try:
                STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
                temporary_path = STATE_PATH.with_suffix(".json.tmp")
                temporary_path.write_text(json.dumps(signals, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
                temporary_path.replace(STATE_PATH)
            except Exception as error:
                LOGGER.exception("grant_signal_error source_type=batch")
                raise error

            try:
                from core.state import gne_state

                gne_state.grant_signals[:] = signals
            except ImportError:
                pass
    return {"stored": stored, "duplicates": duplicates, "errors": errors}
