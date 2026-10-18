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


def trend_direction(changes: list[str]) -> str:
    if len(changes) < 2:
        return "insufficient data"

    outcomes = [change.split("→")[-1].strip() for change in changes]
    up = sum("Uptrend" in outcome or "(increase)" in outcome for outcome in outcomes)
    down = sum("Downtrend" in outcome or "(decrease)" in outcome for outcome in outcomes)
    stable = sum("Stable" in outcome or outcome == "unchanged" for outcome in outcomes)
    volatile = sum("Volatile" in outcome for outcome in outcomes)

    if up > down and up > volatile:
        return "improving"
    if down > up and down > volatile:
        return "declining"
    if volatile > up and volatile > down:
        return "volatile"
    return "stable"


def find_client_name(snapshot: dict[str, Any], client_id: int) -> str:
    client = find_prev_client(snapshot, client_id)
    return str(client.get("clientName") or "Unknown client") if client else "Unknown client"


def build_cycle_trends(history_path=CYCLE_HISTORY_PATH) -> dict[str, Any]:
    history = load_cycle_history(history_path)
    generated_at = history[-1].get("generated_at") if history else None
    if len(history) < 2:
        return {"generated_at": generated_at, "trends": []}

    client_ids = {
        client["clientId"]
        for snapshot in history
        for client in snapshot.get("clients", [])
        if client.get("clientId") is not None
    }
    trends = []
    for client_id in sorted(client_ids):
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

        trends.append({
            "clientId": client_id,
            "clientName": find_client_name(history[-1], client_id),
            "regime_trend": trend_direction(regime_changes),
            "confidence_trend": trend_direction(confidence_changes),
            "volume_trend": trend_direction(volume_changes),
            "risk_trend": trend_direction(risk_changes),
        })
    return {"generated_at": generated_at, "trends": trends}


def main() -> None:
    print(json.dumps(build_cycle_trends(), default=str))


if __name__ == "__main__":
    main()
