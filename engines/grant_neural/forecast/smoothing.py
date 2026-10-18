"""Probability smoothing for Grant Neural Engine forecasts."""

from __future__ import annotations

from typing import Any


MAX_PROBABILITY_BY_VOLATILITY = {"low": 1.0, "medium": 0.92, "high": 0.85}
MAX_CHANGE_BY_VOLATILITY = {"low": 0.40, "medium": 0.25, "high": 0.15}


def _clamp(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = 0.0
    return max(0.0, min(1.0, numeric))


def smooth_forecast(forecast_obj: dict[str, Any]) -> dict[str, Any]:
    """Clamp probability and damp abrupt changes when prior probability is available."""
    smoothed = dict(forecast_obj)
    volatility = str(smoothed.get("volatility") or "medium")
    probability = min(_clamp(smoothed.get("probability", 0)), MAX_PROBABILITY_BY_VOLATILITY.get(volatility, 0.92))

    if smoothed.get("previous_probability") is not None:
        previous = _clamp(smoothed["previous_probability"])
        max_change = MAX_CHANGE_BY_VOLATILITY.get(volatility, 0.25)
        probability = max(previous - max_change, min(previous + max_change, probability))

    smoothed["probability"] = round(_clamp(probability), 4)
    smoothed.pop("previous_probability", None)
    return smoothed
