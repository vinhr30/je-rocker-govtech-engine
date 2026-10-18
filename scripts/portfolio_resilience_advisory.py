from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_resilience_forecast import build_resilience_forecast
except ImportError:
    from portfolio_resilience_forecast import build_resilience_forecast


def advisory_level(current_level: str, forecast_level: str, confidence: int) -> str:
    if forecast_level == "Low":
        return "High"
    if confidence < 40:
        return "High"
    if confidence < 70:
        return "Medium"
    return "Low"


def advisory_actions(level: str, current_level: str, forecast_level: str) -> list[str]:
    if level == "High":
        return [
            "Review resilience drivers across stability, momentum, and volatility.",
            "Prepare a resilience mitigation plan for the next cycle.",
            "Schedule an internal review within 48 hours.",
            "Notify the client if resilience is projected to degrade.",
        ]
    if level == "Medium":
        return [
            "Monitor resilience indicators in the next cycle.",
            "Prepare light-touch notes for potential resilience shifts.",
            "Re-evaluate resilience after the next ingestion window.",
        ]
    return [
        "Maintain current posture.",
        "Reconfirm resilience after the next cycle.",
        "No immediate action required.",
    ]


def advisory_rationale(current_level: str, forecast_level: str, forecast_score: int, confidence: int) -> str:
    return (
        f"Current resilience: {current_level}. "
        f"Forecast resilience: {forecast_level}. "
        f"Projected score: {forecast_score}. "
        f"Confidence: {confidence}%. "
        "Advisory level derived from resilience projection and confidence strength."
    )


def build_resilience_advisory() -> dict[str, Any]:
    forecast_result = build_resilience_forecast()
    advisories = []
    for forecast in forecast_result["forecasts"]:
        level = advisory_level(
            forecast["current_resilience_level"],
            forecast["forecast_resilience_level"],
            forecast["forecast_confidence"],
        )
        advisories.append({
            "clientId": forecast["clientId"],
            "clientName": forecast["clientName"],
            "current_resilience_level": forecast["current_resilience_level"],
            "forecast_resilience_level": forecast["forecast_resilience_level"],
            "forecast_resilience_score": forecast["forecast_resilience_score"],
            "forecast_confidence": forecast["forecast_confidence"],
            "advisory_level": level,
            "advisory_actions": advisory_actions(
                level,
                forecast["current_resilience_level"],
                forecast["forecast_resilience_level"],
            ),
            "advisory_rationale": advisory_rationale(
                forecast["current_resilience_level"],
                forecast["forecast_resilience_level"],
                forecast["forecast_resilience_score"],
                forecast["forecast_confidence"],
            ),
        })
    return {"generated_at": forecast_result["generated_at"], "advisory": advisories}


def main() -> None:
    print(json.dumps(build_resilience_advisory(), default=str))


if __name__ == "__main__":
    main()
