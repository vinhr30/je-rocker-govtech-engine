from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_cycle import (
        CYCLE_HISTORY_PATH,
        compare_confidence,
        compare_regime,
        compare_risk,
        compare_volume,
        find_prev_client,
        load_cycle_history,
    )
    from .portfolio_cycle_trends import build_cycle_trends
except ImportError:
    from portfolio_cycle import (
        CYCLE_HISTORY_PATH,
        compare_confidence,
        compare_regime,
        compare_risk,
        compare_volume,
        find_prev_client,
        load_cycle_history,
    )
    from portfolio_cycle_trends import build_cycle_trends


def score_direction(direction: str) -> int:
    if direction == "improving":
        return 3
    if direction == "stable":
        return 2
    if direction == "declining":
        return 1
    if direction == "volatile":
        return 0
    return 0


def score_consistency(changes: list[str]) -> int:
    if len(changes) < 2:
        return 0
    consistent = 0
    for index in range(1, len(changes)):
        previous_direction = changes[index - 1].split("→")[-1].strip()
        current_direction = changes[index].split("→")[-1].strip()
        if previous_direction == current_direction:
            consistent += 1
    if consistent >= 3:
        return 3
    if consistent == 2:
        return 2
    if consistent == 1:
        return 1
    return 0


def raw_changes(history: list[dict[str, Any]], client_id: int) -> tuple[list[str], list[str], list[str], list[str]]:
    regime_changes = []
    confidence_changes = []
    volume_changes = []
    risk_changes = []
    for index in range(1, len(history)):
        previous = find_prev_client(history[index - 1], client_id)
        current = find_prev_client(history[index], client_id)
        if not previous or not current:
            continue
        regime_changes.append(compare_regime(previous.get("pipeline_regime", "None"), current.get("pipeline_regime", "None")))
        confidence_changes.append(compare_confidence(previous.get("pipeline_confidence", "None"), current.get("pipeline_confidence", "None")))
        volume_changes.append(compare_volume(previous.get("pipeline_forecast", []), current.get("pipeline_forecast", [])))
        risk_changes.append(compare_risk(int(previous.get("risk_score", 0) or 0), int(current.get("risk_score", 0) or 0)))
    return regime_changes, confidence_changes, volume_changes, risk_changes


def build_cycle_momentum(history_path=CYCLE_HISTORY_PATH) -> dict[str, Any]:
    history = load_cycle_history(history_path)
    trends = build_cycle_trends(history_path)["trends"]
    momentum_entries = []

    for trend in trends:
        regime_changes, confidence_changes, volume_changes, risk_changes = raw_changes(history, trend["clientId"])
        momentum_entries.append({
            "clientId": trend["clientId"],
            "clientName": trend["clientName"],
            "momentum_regime": score_direction(trend["regime_trend"]) + score_consistency(regime_changes),
            "momentum_confidence": score_direction(trend["confidence_trend"]) + score_consistency(confidence_changes),
            "momentum_volume": score_direction(trend["volume_trend"]) + score_consistency(volume_changes),
            "momentum_risk": score_direction(trend["risk_trend"]) + score_consistency(risk_changes),
        })

    return {"generated_at": history[-1].get("generated_at") if history else None, "momentum": momentum_entries}


def main() -> None:
    print(json.dumps(build_cycle_momentum(), default=str))


if __name__ == "__main__":
    main()
