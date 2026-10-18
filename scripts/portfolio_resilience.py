from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_cycle_momentum import build_cycle_momentum
    from .portfolio_stability import build_portfolio_stability
    from .portfolio_stability_forecast import build_stability_forecast
except ImportError:
    from portfolio_cycle_momentum import build_cycle_momentum
    from portfolio_stability import build_portfolio_stability
    from portfolio_stability_forecast import build_stability_forecast


def score_stability_level(level: str) -> int:
    return {
        "Highly Stable": 30,
        "Stable": 20,
        "Unstable": 10,
        "Highly Unstable": 0,
    }.get(level, 0)


def score_forecast_level(level: str) -> int:
    return {
        "Highly Stable": 30,
        "Stable": 20,
        "Unstable": 10,
        "Highly Unstable": 0,
    }.get(level, 0)


def score_confidence(confidence: int) -> int:
    return int(confidence * 0.2)


def score_momentum(momentum_total: int) -> int:
    return min(20, int(momentum_total * (20 / 24)))


def score_volatility(total_volatility: int) -> int:
    if total_volatility == 0:
        return 20
    if total_volatility == 1:
        return 15
    if total_volatility == 2:
        return 10
    if total_volatility == 3:
        return 5
    return 0


def classify_resilience(score: int) -> str:
    if score >= 75:
        return "High"
    if score >= 45:
        return "Medium"
    return "Low"


def build_rationale(stability: str, forecast: str, confidence: int, momentum_total: int, volatility: int) -> str:
    return (
        f"Current stability: {stability}. "
        f"Forecast stability: {forecast}. "
        f"Confidence: {confidence}%. "
        f"Momentum total: {momentum_total}. "
        f"Total volatility: {volatility}. "
        "Resilience score derived from stability, forecast strength, confidence, momentum, and volatility."
    )


def build_portfolio_resilience() -> dict[str, Any]:
    stability_result = build_portfolio_stability()
    forecast_result = build_stability_forecast()
    momentum_result = build_cycle_momentum()
    forecasts_by_client = {forecast["clientId"]: forecast for forecast in forecast_result["forecasts"]}
    momentum_by_client = {entry["clientId"]: entry for entry in momentum_result["momentum"]}
    resilience_entries = []

    for stability in stability_result["stability"]:
        client_id = stability["clientId"]
        forecast = forecasts_by_client.get(client_id)
        momentum = momentum_by_client.get(client_id)
        if not forecast or not momentum:
            continue
        momentum_total = (
            momentum["momentum_regime"]
            + momentum["momentum_confidence"]
            + momentum["momentum_volume"]
            + momentum["momentum_risk"]
        )
        score = min(100, (
            score_stability_level(stability["stability"])
            + score_forecast_level(forecast["forecast_stability"])
            + score_confidence(forecast["forecast_confidence"])
            + score_momentum(momentum_total)
            + score_volatility(stability["total_volatility"])
        ))
        resilience_entries.append({
            "clientId": client_id,
            "clientName": stability["clientName"],
            "resilience_score": score,
            "resilience_level": classify_resilience(score),
            "rationale": build_rationale(
                stability["stability"],
                forecast["forecast_stability"],
                forecast["forecast_confidence"],
                momentum_total,
                stability["total_volatility"],
            ),
        })

    return {"generated_at": forecast_result["generated_at"], "resilience": resilience_entries}


def main() -> None:
    print(json.dumps(build_portfolio_resilience(), default=str))


if __name__ == "__main__":
    main()
