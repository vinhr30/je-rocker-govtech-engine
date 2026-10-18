from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_cycle_momentum import build_cycle_momentum
    from .portfolio_resilience_forecast import build_resilience_forecast
    from .portfolio_shock import build_portfolio_shock
    from .portfolio_stability import build_portfolio_stability
    from .portfolio_stability_forecast import build_stability_forecast
except ImportError:
    from portfolio_cycle_momentum import build_cycle_momentum
    from portfolio_resilience_forecast import build_resilience_forecast
    from portfolio_shock import build_portfolio_shock
    from portfolio_stability import build_portfolio_stability
    from portfolio_stability_forecast import build_stability_forecast


def base_risk_from_shock(shock_detected: bool, shock_severity: str | None) -> str:
    if not shock_detected:
        return "Low"
    if shock_severity == "High":
        return "High"
    if shock_severity == "Medium":
        return "Medium"
    return "Low"


def adjust_risk_with_forecasts(base: str, stability_forecast: str, resilience_forecast: str) -> str:
    strong_stability = stability_forecast in ["Highly Stable", "Stable"]
    strong_resilience = resilience_forecast in ["High", "Medium"]
    if strong_stability and strong_resilience:
        if base == "High":
            return "Medium"
        if base == "Medium":
            return "Low"
        return "Low"

    weak_stability = stability_forecast in ["Unstable", "Highly Unstable"]
    weak_resilience = resilience_forecast == "Low"
    if weak_stability or weak_resilience:
        if base == "Low":
            return "Medium"
        if base == "Medium":
            return "High"
        return "High"
    return base


def forecast_confidence(stability_confidence: int, resilience_confidence: int, momentum_total: int, volatility: int) -> int:
    confidence = int((stability_confidence + resilience_confidence) / 2)
    confidence += min(15, int(momentum_total * (15 / 24)))
    if volatility == 0:
        confidence += 10
    elif volatility == 1:
        confidence += 5
    elif volatility == 2:
        confidence -= 10
    elif volatility == 3:
        confidence -= 20
    else:
        confidence -= 25
    return max(0, min(100, confidence))


def build_rationale(shock: dict[str, Any] | None, risk: str, confidence: int) -> str:
    if not shock or not shock.get("shock_detected"):
        shock_description = "No recent shock detected."
    else:
        shock_description = f"Latest shock type: {shock['shock_type']}, severity: {shock['shock_severity']}."
    return (
        f"{shock_description} "
        f"Forecast shock risk: {risk}. "
        f"Confidence: {confidence}%. "
        "Derived from shock history, stability/resilience forecasts, momentum, and volatility."
    )


def build_shock_forecast() -> dict[str, Any]:
    shock_result = build_portfolio_shock()
    stability_forecast_result = build_stability_forecast()
    resilience_forecast_result = build_resilience_forecast()
    stability_result = build_portfolio_stability()
    momentum_result = build_cycle_momentum()
    shocks_by_client = {shock["clientId"]: shock for shock in shock_result["shocks"]}
    stability_forecasts_by_client = {forecast["clientId"]: forecast for forecast in stability_forecast_result["forecasts"]}
    resilience_forecasts_by_client = {forecast["clientId"]: forecast for forecast in resilience_forecast_result["forecasts"]}
    momentum_by_client = {entry["clientId"]: entry for entry in momentum_result["momentum"]}
    entries = []

    for stability in stability_result["stability"]:
        client_id = stability["clientId"]
        stability_forecast = stability_forecasts_by_client.get(client_id)
        resilience_forecast = resilience_forecasts_by_client.get(client_id)
        momentum = momentum_by_client.get(client_id)
        if not stability_forecast or not resilience_forecast or not momentum:
            continue
        momentum_total = (
            momentum["momentum_regime"]
            + momentum["momentum_confidence"]
            + momentum["momentum_volume"]
            + momentum["momentum_risk"]
        )
        shock = shocks_by_client.get(client_id)
        base_risk = base_risk_from_shock(
            bool(shock and shock.get("shock_detected")),
            shock.get("shock_severity") if shock else None,
        )
        risk = adjust_risk_with_forecasts(
            base_risk,
            stability_forecast["forecast_stability"],
            resilience_forecast["forecast_resilience_level"],
        )
        confidence = forecast_confidence(
            stability_forecast["forecast_confidence"],
            resilience_forecast["forecast_confidence"],
            momentum_total,
            stability["total_volatility"],
        )
        entries.append({
            "clientId": client_id,
            "clientName": stability["clientName"],
            "forecast_shock_risk": risk,
            "forecast_confidence": confidence,
            "rationale": build_rationale(shock, risk, confidence),
        })

    return {"generated_at": shock_result["generated_at"], "forecasts": entries}


def main() -> None:
    print(json.dumps(build_shock_forecast(), default=str))


if __name__ == "__main__":
    main()
