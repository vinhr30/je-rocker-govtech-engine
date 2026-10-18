"""Forecast orchestration for Grant Neural Engine classifications."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from engines.grant_neural.forecast.cycle import predict_cycle
from engines.grant_neural.forecast.probability import calculate_probability
from engines.grant_neural.forecast.smoothing import smooth_forecast
from engines.grant_neural.forecast.timeline import map_timeline
from engines.grant_neural.forecast.volatility import detect_volatility


def run_forecast(classification_obj: dict[str, Any]) -> dict[str, Any]:
    """Produce a bounded forecast for one GNE classification object."""
    forecast = {
        "title": classification_obj["title"],
        "source": classification_obj["source"],
        "published_date": classification_obj["published_date"],
        "cycle": predict_cycle(classification_obj),
        "probability": calculate_probability(classification_obj),
        "timeline": map_timeline(classification_obj),
        "volatility": detect_volatility(classification_obj),
        "raw_text": classification_obj["raw_text"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    return smooth_forecast(forecast)
