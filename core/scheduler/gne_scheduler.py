"""Configurable scheduler for the complete Grant Neural Engine pipeline."""

from __future__ import annotations

import json
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from core.api.gne_snapshot import run_full_pipeline
from core.state import gne_state


CONFIG_PATH = Path(__file__).with_name("schedule_config.json")
STATE_LAYERS = (
    ("gne_signals", "grant_signals", "signals_added"),
    ("gne_semantics", "gne_semantics", "semantics_added"),
    ("gne_classifications", "gne_classifications", "classifications_added"),
    ("gne_forecasts", "gne_forecasts", "forecasts_added"),
    ("gne_modernization", "gne_modernization", "modernization_added"),
    ("gne_partners", "gne_partners", "partners_added"),
)


def load_config(config_path: Path | str = CONFIG_PATH) -> dict[str, Any]:
    """Load and validate scheduler configuration."""
    data = json.loads(Path(config_path).read_text(encoding="utf-8"))
    enabled = data.get("enabled")
    run_on_startup = data.get("run_on_startup")
    interval_minutes = data.get("interval_minutes")
    if not isinstance(enabled, bool) or not isinstance(run_on_startup, bool):
        raise ValueError("enabled and run_on_startup must be booleans")
    if not isinstance(interval_minutes, (int, float)) or isinstance(interval_minutes, bool) or interval_minutes <= 0:
        raise ValueError("interval_minutes must be greater than zero")
    return {
        "enabled": enabled,
        "interval_minutes": interval_minutes,
        "run_on_startup": run_on_startup,
    }


def _identity(item: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(item.get("source") or ""),
        str(item.get("title") or ""),
        str(item.get("published_date") or ""),
    )


def _state_identities() -> dict[str, set[tuple[str, str, str]]]:
    return {
        snapshot_name: {_identity(item) for item in getattr(gne_state, state_name)}
        for snapshot_name, state_name, _ in STATE_LAYERS
    }


def run_once(logger: Callable[[str], None] = print) -> dict[str, Any]:
    """Run the full pipeline once and log additions to every state layer."""
    started = datetime.now(timezone.utc)
    logger(json.dumps({"event": "gne_pipeline_start", "start_time": started.isoformat()}))
    before = _state_identities()
    snapshot = run_full_pipeline()
    finished = datetime.now(timezone.utc)
    added = {
        log_name: len({_identity(item) for item in snapshot[snapshot_name]} - before[snapshot_name])
        for snapshot_name, _, log_name in STATE_LAYERS
    }
    result = {
        "event": "gne_pipeline_complete",
        "start_time": started.isoformat(),
        "end_time": finished.isoformat(),
        **added,
    }
    logger(json.dumps(result))
    return result


def run_scheduler(
    config_path: Path | str = CONFIG_PATH,
    sleep_fn: Callable[[float], None] = time.sleep,
    max_runs: int | None = None,
    logger: Callable[[str], None] = print,
) -> int:
    """Run the configured scheduler loop; max_runs is available for deterministic tests."""
    config = load_config(config_path)
    if not config["enabled"]:
        logger(json.dumps({"event": "gne_scheduler_disabled"}))
        return 0

    interval_seconds = float(config["interval_minutes"]) * 60.0
    completed = 0
    if not config["run_on_startup"]:
        sleep_fn(interval_seconds)

    while max_runs is None or completed < max_runs:
        try:
            run_once(logger=logger)
        except Exception as error:
            logger(json.dumps({
                "event": "gne_pipeline_error",
                "time": datetime.now(timezone.utc).isoformat(),
                "error": str(error),
            }))
        completed += 1
        if max_runs is None or completed < max_runs:
            sleep_fn(interval_seconds)
    return completed


def main() -> None:
    stop_event = Event()

    def request_stop(*_: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    config = load_config()
    if not config["enabled"]:
        print(json.dumps({"event": "gne_scheduler_disabled"}), flush=True)
        return

    interval_seconds = float(config["interval_minutes"]) * 60.0
    if not config["run_on_startup"] and stop_event.wait(interval_seconds):
        return
    while not stop_event.is_set():
        try:
            run_once(logger=lambda message: print(message, flush=True))
        except Exception as error:
            print(json.dumps({
                "event": "gne_pipeline_error",
                "time": datetime.now(timezone.utc).isoformat(),
                "error": str(error),
            }), flush=True)
        stop_event.wait(interval_seconds)


if __name__ == "__main__":
    main()
