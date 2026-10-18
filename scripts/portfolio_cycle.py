from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from .client_briefing import build_client_briefing
    from .portfolio_action_queue import build_action_queue
    from .portfolio_actions import build_portfolio_actions
    from .portfolio_briefing import build_portfolio_briefing
except ImportError:
    from client_briefing import build_client_briefing
    from portfolio_action_queue import build_action_queue
    from portfolio_actions import build_portfolio_actions
    from portfolio_briefing import build_portfolio_briefing

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
CYCLE_SNAPSHOT_PATH = DASHBOARD_ROOT / "data" / "cycle_snapshot.json"
CYCLE_HISTORY_PATH = DASHBOARD_ROOT / "data" / "cycle_history.json"
MAX_CYCLE_HISTORY = 10


def compare_regime(prev: str, curr: str) -> str:
    if prev == curr:
        return "unchanged"
    return f"{prev} → {curr}"


def compare_confidence(prev: str, curr: str) -> str:
    if prev == curr:
        return "unchanged"
    return f"{prev} → {curr}"


def compare_volume(prev_rows: list[dict[str, Any]], curr_rows: list[dict[str, Any]]) -> str:
    prev_total = sum(float(row.get("projected_30_day_opportunity_count", 0) or 0) for row in prev_rows)
    curr_total = sum(float(row.get("projected_30_day_opportunity_count", 0) or 0) for row in curr_rows)
    if prev_total == curr_total:
        return "unchanged"
    direction = "increase" if curr_total > prev_total else "decrease"
    return f"{prev_total} → {curr_total} ({direction})"


def compare_risk(prev: int, curr: int) -> str:
    if prev == curr:
        return "unchanged"
    direction = "increase" if curr > prev else "decrease"
    return f"{prev} → {curr} ({direction})"


def load_cycle_snapshot(snapshot_path: Path = CYCLE_SNAPSHOT_PATH) -> dict[str, Any] | None:
    if not snapshot_path.exists():
        return None
    try:
        return json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_cycle_snapshot(snapshot: dict[str, Any], snapshot_path: Path = CYCLE_SNAPSHOT_PATH) -> None:
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = snapshot_path.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(snapshot, default=str), encoding="utf-8")
    temporary_path.replace(snapshot_path)


def load_cycle_history(history_path: Path = CYCLE_HISTORY_PATH) -> list[dict[str, Any]]:
    if not history_path.exists():
        return []
    try:
        history = json.loads(history_path.read_text(encoding="utf-8"))
        return history if isinstance(history, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def append_cycle_history(
    snapshot: dict[str, Any],
    history_path: Path = CYCLE_HISTORY_PATH,
    max_history: int = MAX_CYCLE_HISTORY,
) -> None:
    history = load_cycle_history(history_path)
    if not history or history[-1].get("generated_at") != snapshot.get("generated_at"):
        history.append(snapshot)
    history_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = history_path.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(history[-max_history:], default=str), encoding="utf-8")
    temporary_path.replace(history_path)


def find_prev_client(snapshot: dict[str, Any], client_id: int) -> dict[str, Any] | None:
    return next(
        (client for client in snapshot.get("clients", []) if client.get("clientId") == client_id),
        None,
    )


def build_cycle_snapshot(portfolio: dict[str, Any]) -> dict[str, Any]:
    clients = []
    for client in portfolio["clients"]:
        briefing = build_client_briefing(client["clientId"])
        clients.append({
            **client,
            "pipeline_forecast": briefing["pipeline"]["forecast"] if briefing else [],
        })
    return {"generated_at": portfolio["generated_at"], "clients": clients}


def build_cycle_summary(
    snapshot_path: Path = CYCLE_SNAPSHOT_PATH,
    history_path: Path | None = None,
) -> dict[str, Any]:
    current = build_portfolio_briefing()
    previous = load_cycle_snapshot(snapshot_path)
    history_path = history_path or snapshot_path.with_name("cycle_history.json")
    current_snapshot = build_cycle_snapshot(current)
    summaries = []

    for client in current_snapshot["clients"]:
        client_id = client["clientId"]
        if not previous:
            summaries.append({
                "clientId": client_id,
                "clientName": client["clientName"],
                "cycle_status": "initial",
                "regime_change": "initial",
                "confidence_change": "initial",
                "volume_change": "initial",
                "risk_change": "initial",
            })
            continue

        previous_client = find_prev_client(previous, client_id)
        if not previous_client:
            summaries.append({
                "clientId": client_id,
                "clientName": client["clientName"],
                "cycle_status": "new",
                "regime_change": "new",
                "confidence_change": "new",
                "volume_change": "new",
                "risk_change": "new",
            })
            continue

        summaries.append({
            "clientId": client_id,
            "clientName": client["clientName"],
            "cycle_status": "updated",
            "regime_change": compare_regime(previous_client.get("pipeline_regime", "None"), client["pipeline_regime"]),
            "confidence_change": compare_confidence(previous_client.get("pipeline_confidence", "None"), client["pipeline_confidence"]),
            "volume_change": compare_volume(previous_client.get("pipeline_forecast", []), client["pipeline_forecast"]),
            "risk_change": compare_risk(int(previous_client.get("risk_score", 0) or 0), int(client.get("risk_score", 0) or 0)),
        })

    if not load_cycle_history(history_path) and previous:
        append_cycle_history(previous, history_path)
    save_cycle_snapshot(current_snapshot, snapshot_path)
    append_cycle_history(current_snapshot, history_path)
    return {"generated_at": current["generated_at"], "cycle": summaries}


def main() -> None:
    print(json.dumps(build_cycle_summary(), default=str))


if __name__ == "__main__":
    main()
