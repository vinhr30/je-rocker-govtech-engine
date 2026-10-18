from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_cycle import (
        CYCLE_HISTORY_PATH,
        compare_confidence,
        compare_regime,
        compare_volume,
        find_prev_client,
        load_cycle_history,
    )
    from .portfolio_cycle_momentum import raw_changes, score_consistency, score_direction
    from .portfolio_cycle_trends import trend_direction
    from .portfolio_resilience import (
        classify_resilience,
        score_confidence,
        score_forecast_level,
        score_momentum,
        score_stability_level,
        score_volatility,
        build_portfolio_resilience,
    )
    from .portfolio_stability import build_portfolio_stability, classify_stability, volatility_score
    from .portfolio_stability_forecast import forecast_confidence, forecast_stability
except ImportError:
    from portfolio_cycle import (
        CYCLE_HISTORY_PATH,
        compare_confidence,
        compare_regime,
        compare_volume,
        find_prev_client,
        load_cycle_history,
    )
    from portfolio_cycle_momentum import raw_changes, score_consistency, score_direction
    from portfolio_cycle_trends import trend_direction
    from portfolio_resilience import (
        classify_resilience,
        score_confidence,
        score_forecast_level,
        score_momentum,
        score_stability_level,
        score_volatility,
        build_portfolio_resilience,
    )
    from portfolio_stability import build_portfolio_stability, classify_stability, volatility_score
    from portfolio_stability_forecast import forecast_confidence, forecast_stability

REGIME_SHOCKS = {
    ("Stable", "Downtrend"): True,
    ("Stable", "Volatile"): True,
    ("Uptrend", "Downtrend"): True,
    ("Uptrend", "Volatile"): True,
    ("Downtrend", "Uptrend"): True,
    ("Downtrend", "Volatile"): True,
}


def confidence_shock(previous: str, current: str) -> bool:
    levels = ["Low", "Medium", "High"]
    try:
        return abs(levels.index(previous) - levels.index(current)) >= 2
    except ValueError:
        return False


def volume_shock(previous_total: float, current_total: float) -> bool:
    if previous_total == 0:
        return False
    return abs(current_total - previous_total) / previous_total >= 0.5


def risk_posture(score: int) -> str:
    if score >= 4:
        return "High"
    if score >= 2:
        return "Medium"
    return "Low"


def risk_shock(previous: str, current: str) -> bool:
    return previous != current and "High" in (previous, current)


def stability_shock(previous: str, current: str) -> bool:
    transitions = {
        ("Highly Stable", "Unstable"),
        ("Highly Stable", "Highly Unstable"),
        ("Stable", "Highly Unstable"),
        ("Unstable", "Highly Stable"),
    }
    return (previous, current) in transitions


def resilience_shock(previous_score: int, current_score: int) -> bool:
    return previous_score - current_score >= 30


def shock_severity(shock_type: str) -> str:
    if shock_type in ["Regime", "Risk", "Stability", "Resilience"]:
        return "High"
    if shock_type in ["Confidence", "Volume"]:
        return "Medium"
    return "Low"


def build_rationale(shock_type: str, previous: Any, current: Any) -> str:
    return (
        f"Detected {shock_type} shock. "
        f"Previous value: {previous}. "
        f"Current value: {current}. "
        "Shock classification derived from discontinuity thresholds."
    )


def pipeline_total(client: dict[str, Any]) -> float:
    return sum(float(row.get("projected_30_day_opportunity_count", 0) or 0) for row in client.get("pipeline_forecast", []))


def derived_state(history: list[dict[str, Any]], client_id: int) -> dict[str, Any] | None:
    client = find_prev_client(history[-1], client_id) if history else None
    if not client:
        return None
    regime_changes, confidence_changes, volume_changes, risk_changes = raw_changes(history, client_id)
    volatility = sum(volatility_score(changes) for changes in (regime_changes, confidence_changes, volume_changes, risk_changes))
    stability = classify_stability(volatility)
    momentum = sum(
        score_direction(trend_direction(changes)) + score_consistency(changes)
        for changes in (regime_changes, confidence_changes, volume_changes, risk_changes)
    )
    stability_forecast = forecast_stability(stability, trend_direction(regime_changes), momentum)
    confidence = forecast_confidence(stability, trend_direction(regime_changes), momentum)
    resilience_score = min(100, (
        score_stability_level(stability)
        + score_forecast_level(stability_forecast)
        + score_confidence(confidence)
        + score_momentum(momentum)
        + score_volatility(volatility)
    ))
    return {
        "stability": stability,
        "resilience_score": resilience_score,
        "resilience_level": classify_resilience(resilience_score),
    }


def no_shock(client: dict[str, Any]) -> dict[str, Any]:
    return {
        "clientId": client["clientId"],
        "clientName": client["clientName"],
        "shock_detected": False,
        "shock_type": None,
        "shock_severity": None,
        "shock_rationale": "No shock detected.",
    }


def shock_entry(client: dict[str, Any], shock_type: str, previous: Any, current: Any) -> dict[str, Any]:
    return {
        "clientId": client["clientId"],
        "clientName": client["clientName"],
        "shock_detected": True,
        "shock_type": shock_type,
        "shock_severity": shock_severity(shock_type),
        "shock_rationale": build_rationale(shock_type, previous, current),
    }


def build_portfolio_shock(history_path=CYCLE_HISTORY_PATH) -> dict[str, Any]:
    history = load_cycle_history(history_path)
    if len(history) < 2:
        return {"generated_at": history[-1].get("generated_at") if history else None, "shocks": []}

    previous_snapshot = history[-2]
    current_snapshot = history[-1]
    current_stability = {entry["clientId"]: entry for entry in build_portfolio_stability(history_path)["stability"]}
    current_resilience = {entry["clientId"]: entry for entry in build_portfolio_resilience()["resilience"]}
    previous_history = history[:-1]
    shocks = []

    for client in current_snapshot.get("clients", []):
        client_id = client["clientId"]
        previous_client = find_prev_client(previous_snapshot, client_id)
        if not previous_client:
            continue

        if REGIME_SHOCKS.get((previous_client.get("pipeline_regime"), client.get("pipeline_regime")), False):
            shocks.append(shock_entry(client, "Regime", previous_client.get("pipeline_regime"), client.get("pipeline_regime")))
            continue
        if confidence_shock(previous_client.get("pipeline_confidence", ""), client.get("pipeline_confidence", "")):
            shocks.append(shock_entry(client, "Confidence", previous_client.get("pipeline_confidence"), client.get("pipeline_confidence")))
            continue
        previous_total = pipeline_total(previous_client)
        current_total = pipeline_total(client)
        if volume_shock(previous_total, current_total):
            shocks.append(shock_entry(client, "Volume", previous_total, current_total))
            continue
        previous_risk = risk_posture(int(previous_client.get("risk_score", 0) or 0))
        current_risk = risk_posture(int(client.get("risk_score", 0) or 0))
        if risk_shock(previous_risk, current_risk):
            shocks.append(shock_entry(client, "Risk", previous_risk, current_risk))
            continue

        previous_state = derived_state(previous_history, client_id)
        current_stability_entry = current_stability.get(client_id)
        current_resilience_entry = current_resilience.get(client_id)
        if previous_state and current_stability_entry and stability_shock(previous_state["stability"], current_stability_entry["stability"]):
            shocks.append(shock_entry(client, "Stability", previous_state["stability"], current_stability_entry["stability"]))
            continue
        if previous_state and current_resilience_entry and resilience_shock(previous_state["resilience_score"], current_resilience_entry["resilience_score"]):
            shocks.append(shock_entry(client, "Resilience", previous_state["resilience_score"], current_resilience_entry["resilience_score"]))
            continue
        shocks.append(no_shock(client))

    return {"generated_at": current_snapshot.get("generated_at"), "shocks": shocks}


def main() -> None:
    print(json.dumps(build_portfolio_shock(), default=str))


if __name__ == "__main__":
    main()
