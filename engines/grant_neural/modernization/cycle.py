"""Modernization cycle prediction for Grant Neural Engine forecasts."""

from __future__ import annotations

from datetime import date
from typing import Any

from engines.grant_neural.forecast.cycle import add_months
from engines.grant_neural.semantics.extractor import extract_modernization_cues


MODERNIZATION_CUE_THRESHOLD = 2


def predict_modernization_cycle(forecast_obj: dict[str, Any]) -> dict[str, str]:
    """Predict a multi-year modernization cycle when forecast or cue evidence qualifies."""
    try:
        anchor = date.fromisoformat(str(forecast_obj["published_date"])[:10])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("published_date must be a valid YYYY-MM-DD date") from error

    forecast_cycle = forecast_obj.get("cycle") or {}
    cues = extract_modernization_cues(str(forecast_obj.get("raw_text") or ""))
    qualifies = forecast_cycle.get("cycle_type") == "modernization" or len(cues) >= MODERNIZATION_CUE_THRESHOLD
    end = add_months(anchor, 36) if qualifies else anchor
    return {
        "type": "modernization" if qualifies else "none",
        "start": anchor.isoformat(),
        "end": end.isoformat(),
    }
