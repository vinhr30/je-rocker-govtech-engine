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


def volatility_score(changes: list[str]) -> int:
    if len(changes) < 2:
        return 0
    flips = 0
    for index in range(1, len(changes)):
        previous_direction = changes[index - 1].split("→")[-1].strip()
        current_direction = changes[index].split("→")[-1].strip()
        if previous_direction != current_direction:
            flips += 1
    return flips


def classify_stability(total_volatility: int) -> str:
    if total_volatility == 0:
        return "Highly Stable"
    if total_volatility == 1:
        return "Stable"
    if total_volatility == 2:
        return "Unstable"
    return "Highly Unstable"


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


def build_portfolio_stability(history_path=CYCLE_HISTORY_PATH) -> dict[str, Any]:
    history = load_cycle_history(history_path)
    trends = build_cycle_trends(history_path)["trends"]
    stability_entries = []

    for trend in trends:
        regime_changes, confidence_changes, volume_changes, risk_changes = raw_changes(history, trend["clientId"])
        regime_volatility = volatility_score(regime_changes)
        confidence_volatility = volatility_score(confidence_changes)
        volume_volatility = volatility_score(volume_changes)
        risk_volatility = volatility_score(risk_changes)
        total_volatility = regime_volatility + confidence_volatility + volume_volatility + risk_volatility
        stability_entries.append({
            "clientId": trend["clientId"],
            "clientName": trend["clientName"],
            "volatility_regime": regime_volatility,
            "volatility_confidence": confidence_volatility,
            "volatility_volume": volume_volatility,
            "volatility_risk": risk_volatility,
            "total_volatility": total_volatility,
            "stability": classify_stability(total_volatility),
        })

    return {"generated_at": history[-1].get("generated_at") if history else None, "stability": stability_entries}


def main() -> None:
    print(json.dumps(build_portfolio_stability(), default=str))


if __name__ == "__main__":
    main()
