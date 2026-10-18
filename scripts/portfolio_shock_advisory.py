from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_shock import build_portfolio_shock
    from .portfolio_shock_forecast import build_shock_forecast
except ImportError:
    from portfolio_shock import build_portfolio_shock
    from portfolio_shock_forecast import build_shock_forecast


def advisory_level(forecast_risk: str, confidence: int, latest_shock: dict[str, Any] | None) -> str:
    if forecast_risk == "None" and (not latest_shock or not latest_shock.get("shock_detected")):
        return "None"
    if forecast_risk == "High":
        return "High"
    if confidence < 40 and latest_shock and latest_shock.get("shock_detected"):
        return "High"
    if forecast_risk == "Medium" or confidence < 70:
        return "Medium"
    return "Low"


def advisory_actions(level: str, latest_shock: dict[str, Any] | None) -> list[str]:
    if level == "High":
        actions = [
            "Initiate immediate shock review across regime, confidence, volume, risk, stability, and resilience.",
            "Prepare a mitigation plan for the next cycle.",
            "Schedule an internal review within 24-48 hours.",
            "Notify the client of elevated shock risk and potential impacts.",
        ]
        if latest_shock and latest_shock.get("shock_detected"):
            actions.insert(1, f"Investigate latest {latest_shock['shock_type']} shock event and its root causes.")
        return actions
    if level == "Medium":
        actions = [
            "Monitor shock indicators in the next cycle.",
            "Capture notes on any emerging discontinuities.",
            "Re-evaluate shock risk after the next ingestion window.",
        ]
        if latest_shock and latest_shock.get("shock_detected"):
            actions.insert(1, f"Log and track the latest {latest_shock['shock_type']} shock for follow-up.")
        return actions
    if level == "Low":
        return [
            "Maintain current posture.",
            "Confirm shock status remains low after the next cycle.",
            "No immediate intervention required.",
        ]
    return [
        "No shock-related action required.",
        "Continue standard monitoring.",
    ]


def advisory_rationale(forecast_risk: str, confidence: int, latest_shock: dict[str, Any] | None) -> str:
    if latest_shock and latest_shock.get("shock_detected"):
        shock_description = f"Latest shock type: {latest_shock['shock_type']}, severity: {latest_shock['shock_severity']}."
    else:
        shock_description = "No recent shock detected."
    return (
        f"{shock_description} "
        f"Forecast shock risk: {forecast_risk}. "
        f"Confidence: {confidence}%. "
        "Advisory level derived from forecast risk, confidence, and recent shock history."
    )


def build_shock_advisory() -> dict[str, Any]:
    forecast_result = build_shock_forecast()
    shock_result = build_portfolio_shock()
    shocks_by_client = {shock["clientId"]: shock for shock in shock_result["shocks"]}
    entries = []

    for forecast in forecast_result["forecasts"]:
        latest_shock = shocks_by_client.get(forecast["clientId"])
        level = advisory_level(
            forecast["forecast_shock_risk"],
            forecast["forecast_confidence"],
            latest_shock,
        )
        entries.append({
            "clientId": forecast["clientId"],
            "clientName": forecast["clientName"],
            "forecast_shock_risk": forecast["forecast_shock_risk"],
            "forecast_confidence": forecast["forecast_confidence"],
            "advisory_level": level,
            "advisory_actions": advisory_actions(level, latest_shock),
            "advisory_rationale": advisory_rationale(
                forecast["forecast_shock_risk"],
                forecast["forecast_confidence"],
                latest_shock,
            ),
        })
    return {"generated_at": forecast_result["generated_at"], "advisory": entries}


def main() -> None:
    print(json.dumps(build_shock_advisory(), default=str))


if __name__ == "__main__":
    main()
