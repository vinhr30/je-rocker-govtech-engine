from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_stability_forecast import build_stability_forecast
except ImportError:
    from portfolio_stability_forecast import build_stability_forecast


def advisory_level(current: str, forecast: str, confidence: int) -> str:
    if forecast in ["Unstable", "Highly Unstable"]:
        return "High"
    if confidence < 40:
        return "High"
    if confidence < 70:
        return "Medium"
    return "Low"


def advisory_actions(level: str, current: str, forecast: str) -> list[str]:
    if level == "High":
        return [
            "Review volatility sources across regime, confidence, volume, and risk.",
            "Prepare a stability mitigation plan for the next cycle.",
            "Schedule an internal review within 48 hours.",
            "Notify the client if forecast stability is degrading.",
        ]
    if level == "Medium":
        return [
            "Monitor volatility indicators in the next cycle.",
            "Prepare light-touch notes for potential stability shifts.",
            "Re-evaluate stability after the next ingestion window.",
        ]
    return [
        "Maintain current posture.",
        "Reconfirm stability after the next cycle.",
        "No immediate action required.",
    ]


def advisory_rationale(current: str, forecast: str, confidence: int) -> str:
    return (
        f"Current stability: {current}. "
        f"Forecast stability: {forecast}. "
        f"Confidence: {confidence}%. "
        "Advisory level derived from stability projection and confidence strength."
    )


def build_stability_advisory() -> dict[str, Any]:
    forecast_result = build_stability_forecast()
    advisories = []
    for forecast in forecast_result["forecasts"]:
        level = advisory_level(
            forecast["current_stability"],
            forecast["forecast_stability"],
            forecast["forecast_confidence"],
        )
        advisories.append({
            "clientId": forecast["clientId"],
            "clientName": forecast["clientName"],
            "current_stability": forecast["current_stability"],
            "forecast_stability": forecast["forecast_stability"],
            "forecast_confidence": forecast["forecast_confidence"],
            "advisory_level": level,
            "advisory_actions": advisory_actions(
                level,
                forecast["current_stability"],
                forecast["forecast_stability"],
            ),
            "advisory_rationale": advisory_rationale(
                forecast["current_stability"],
                forecast["forecast_stability"],
                forecast["forecast_confidence"],
            ),
        })
    return {"generated_at": forecast_result["generated_at"], "advisory": advisories}


def main() -> None:
    print(json.dumps(build_stability_advisory(), default=str))


if __name__ == "__main__":
    main()
