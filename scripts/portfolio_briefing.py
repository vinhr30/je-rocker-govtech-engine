from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from .client_briefing import CLIENT_DB, build_client_briefing
except ImportError:
    from client_briefing import CLIENT_DB, build_client_briefing

REGIME_ORDER = ("Uptrend", "Downtrend", "Volatile", "Stable")
CONFIDENCE_ORDER = {"None": 0, "Low": 1, "Medium": 2, "High": 3}


def load_all_clients(database_path: Path = CLIENT_DB) -> list[dict[str, Any]]:
    if not database_path.exists():
        return []
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        return [
            {"id": row["client_id"], "name": row["client_name"] or "Unnamed client"}
            for row in connection.execute("SELECT client_id, client_name FROM clients ORDER BY client_id ASC")
        ]
    finally:
        connection.close()


def summarize_regime(forecast_rows: list[dict[str, Any]]) -> str:
    if not forecast_rows:
        return "None"
    counts = Counter(str(row.get("regime") or "Stable") for row in forecast_rows)
    return max(REGIME_ORDER, key=lambda regime: (counts[regime], -REGIME_ORDER.index(regime)))


def summarize_confidence(forecast_rows: list[dict[str, Any]]) -> str:
    if not forecast_rows:
        return "None"
    return max(
        (str(row.get("confidence") or "Low") for row in forecast_rows),
        key=lambda confidence: CONFIDENCE_ORDER.get(confidence, 0),
    )


def score_regime(regime: str) -> int:
    if regime == "Uptrend":
        return 3
    if regime == "Stable":
        return 2
    if regime == "Volatile":
        return 1
    return 0


def score_confidence(conf: str) -> int:
    if conf == "High":
        return 3
    if conf == "Medium":
        return 2
    if conf == "Low":
        return 1
    return 0


def score_volume(forecast_rows: list[dict[str, Any]]) -> int:
    if not forecast_rows:
        return 0
    total = sum(float(row.get("projected_30_day_opportunity_count", 0) or 0) for row in forecast_rows)
    if total > 1000:
        return 3
    if total > 200:
        return 2
    if total > 50:
        return 1
    return 0


def score_modernization(forecast_rows: list[dict[str, Any]]) -> int:
    if not forecast_rows:
        return 0
    regimes = [row.get("regime") for row in forecast_rows]
    if "Uptrend" in regimes:
        return 3
    if "Stable" in regimes:
        return 2
    if "Volatile" in regimes:
        return 1
    return 0


def build_portfolio_briefing() -> dict[str, Any]:
    portfolio = []
    for client in load_all_clients():
        briefing = build_client_briefing(client["id"])
        if briefing is None:
            continue
        pipeline_regime = summarize_regime(briefing["pipeline"]["forecast"])
        pipeline_confidence = summarize_confidence(briefing["pipeline"]["forecast"])
        portfolio.append({
            "clientId": client["id"],
            "clientName": client["name"],
            "pipeline_regime": pipeline_regime,
            "grants_regime": summarize_regime(briefing["grants"]["forecast"]),
            "modernization_regime": summarize_regime(briefing["modernization"]["forecast"]),
            "pipeline_confidence": pipeline_confidence,
            "grants_confidence": summarize_confidence(briefing["grants"]["forecast"]),
            "modernization_confidence": summarize_confidence(briefing["modernization"]["forecast"]),
            "risk_score": score_regime(pipeline_regime) + score_confidence(pipeline_confidence),
            "opportunity_score": (
                score_volume(briefing["pipeline"]["forecast"])
                + score_modernization(briefing["modernization"]["forecast"])
            ),
            "narrative": {
                "pipeline": briefing["pipeline"]["narrative"],
                "grants": briefing["grants"]["narrative"],
                "modernization": briefing["modernization"]["narrative"],
            },
        })
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "clients": portfolio}


def main() -> None:
    print(json.dumps(build_portfolio_briefing(), default=str))


if __name__ == "__main__":
    main()
