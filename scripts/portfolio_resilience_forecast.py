from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_cycle_momentum import build_cycle_momentum
    from .portfolio_resilience import build_portfolio_resilience
    from .portfolio_stability import build_portfolio_stability
    from .portfolio_stability_forecast import build_stability_forecast
except ImportError:
    from portfolio_cycle_momentum import build_cycle_momentum
    from portfolio_resilience import build_portfolio_resilience
    from portfolio_stability import build_portfolio_stability
    from portfolio_stability_forecast import build_stability_forecast


def forecast_resilience_score(
    current_score: int,
    stability_forecast: str,
    momentum_total: int,
    volatility: int,
) -> int:
    score = current_score
    if stability_forecast == "Highly Stable":
        score += 10
    elif stability_forecast == "Stable":
        score += 5
    elif stability_forecast == "Unstable":
        score -= 10
    else:
        score -= 20

    score += min(10, int(momentum_total * (10 / 24)))
    if volatility == 0:
        score += 10
    elif volatility == 1:
        score += 5
    elif volatility == 2:
        score -= 5
    elif volatility == 3:
        score -= 10
    else:
        score -= 15
    return max(0, min(100, score))


def forecast_resilience_level(score: int) -> str:
    if score >= 75:
        return "High"
    if score >= 45:
        return "Medium"
    return "Low"


def forecast_confidence(stability_confidence: int, momentum_total: int, volatility: int) -> int:
    confidence = stability_confidence + min(20, int(momentum_total * (20 / 24)))
    if volatility == 0:
        confidence += 10
    elif volatility == 1:
        confidence += 5
    elif volatility == 2:
        confidence -= 10
    elif volatility == 3:
        confidence -= 20
    else:
        confidence -= 30
    return max(0, min(100, confidence))


def build_rationale(current_level: str, forecast_level: str, forecast_score: int, confidence: int) -> str:
    return (
        f"Current resilience: {current_level}. "
        f"Forecast resilience: {forecast_level}. "
        f"Projected score: {forecast_score}. "
        f"Confidence: {confidence}%. "
        "Derived from stability forecast, momentum strength, and volatility profile."
    )


def build_resilience_forecast() -> dict[str, Any]:
    resilience_result = build_portfolio_resilience()
    stability_forecast_result = build_stability_forecast()
    momentum_result = build_cycle_momentum()
    stability_result = build_portfolio_stability()
    forecasts_by_client = {forecast["clientId"]: forecast for forecast in stability_forecast_result["forecasts"]}
    momentum_by_client = {entry["clientId"]: entry for entry in momentum_result["momentum"]}
    stability_by_client = {entry["clientId"]: entry for entry in stability_result["stability"]}
    entries = []

    for resilience in resilience_result["resilience"]:
        client_id = resilience["clientId"]
        stability_forecast = forecasts_by_client.get(client_id)
        momentum = momentum_by_client.get(client_id)
        stability = stability_by_client.get(client_id)
        if not stability_forecast or not momentum or not stability:
            continue
        momentum_total = (
            momentum["momentum_regime"]
            + momentum["momentum_confidence"]
            + momentum["momentum_volume"]
            + momentum["momentum_risk"]
        )
        forecast_score = forecast_resilience_score(
            resilience["resilience_score"],
            stability_forecast["forecast_stability"],
            momentum_total,
            stability["total_volatility"],
        )
        forecast_level = forecast_resilience_level(forecast_score)
        confidence = forecast_confidence(
            stability_forecast["forecast_confidence"],
            momentum_total,
            stability["total_volatility"],
        )
        entries.append({
            "clientId": client_id,
            "clientName": resilience["clientName"],
            "current_resilience_level": resilience["resilience_level"],
            "current_resilience_score": resilience["resilience_score"],
            "forecast_resilience_level": forecast_level,
            "forecast_resilience_score": forecast_score,
            "forecast_confidence": confidence,
            "rationale": build_rationale(
                resilience["resilience_level"],
                forecast_level,
                forecast_score,
                confidence,
            ),
        })

    return {"generated_at": resilience_result["generated_at"], "forecasts": entries}


def main() -> None:
    print(json.dumps(build_resilience_forecast(), default=str))


if __name__ == "__main__":
    main()
