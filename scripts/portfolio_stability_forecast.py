from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_cycle_momentum import build_cycle_momentum
    from .portfolio_cycle_trends import build_cycle_trends
    from .portfolio_stability import build_portfolio_stability
except ImportError:
    from portfolio_cycle_momentum import build_cycle_momentum
    from portfolio_cycle_trends import build_cycle_trends
    from portfolio_stability import build_portfolio_stability


def forecast_stability(stability: str, trend: str, momentum: int) -> str:
    if trend == "improving" and momentum >= 4:
        if stability in ["Unstable", "Highly Unstable"]:
            return "Stable"
        return "Highly Stable"
    if trend == "stable" and momentum >= 2:
        return stability
    if trend == "declining":
        if stability == "Highly Stable":
            return "Stable"
        if stability == "Stable":
            return "Unstable"
        return "Highly Unstable"
    if trend == "volatile":
        if momentum >= 4:
            return stability
        return "Unstable"
    return stability


def forecast_confidence(stability: str, trend: str, momentum: int) -> int:
    base = 50
    if trend == "improving":
        base += 20
    elif trend == "declining":
        base -= 10
    elif trend == "volatile":
        base -= 20
    return max(0, min(100, base + momentum * 5))


def build_rationale(stability: str, trend: str, momentum: int) -> str:
    return (
        f"Current stability: {stability}. "
        f"Trend direction: {trend}. "
        f"Momentum score: {momentum}. "
        "Projection derived from multi-cycle volatility and temporal momentum."
    )


def build_stability_forecast() -> dict[str, Any]:
    stability_result = build_portfolio_stability()
    trends_result = build_cycle_trends()
    momentum_result = build_cycle_momentum()
    trends_by_client = {trend["clientId"]: trend for trend in trends_result["trends"]}
    momentum_by_client = {entry["clientId"]: entry for entry in momentum_result["momentum"]}
    forecasts = []

    for stability in stability_result["stability"]:
        client_id = stability["clientId"]
        trend = trends_by_client.get(client_id)
        momentum = momentum_by_client.get(client_id)
        if not trend or not momentum:
            continue
        momentum_total = (
            momentum["momentum_regime"]
            + momentum["momentum_confidence"]
            + momentum["momentum_volume"]
            + momentum["momentum_risk"]
        )
        current_stability = stability["stability"]
        trend_direction = trend["regime_trend"]
        forecasts.append({
            "clientId": client_id,
            "clientName": stability["clientName"],
            "current_stability": current_stability,
            "forecast_stability": forecast_stability(current_stability, trend_direction, momentum_total),
            "forecast_confidence": forecast_confidence(current_stability, trend_direction, momentum_total),
            "rationale": build_rationale(current_stability, trend_direction, momentum_total),
        })

    return {"generated_at": stability_result["generated_at"], "forecasts": forecasts}


def main() -> None:
    print(json.dumps(build_stability_forecast(), default=str))


if __name__ == "__main__":
    main()
