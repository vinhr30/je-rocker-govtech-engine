"""Modernization orchestration for Grant Neural Engine forecasts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from engines.grant_neural.modernization.alignment import map_alignment_to_jrocker
from engines.grant_neural.modernization.cycle import predict_modernization_cycle
from engines.grant_neural.modernization.density import calculate_density
from engines.grant_neural.modernization.relevance import score_modernization_relevance


def run_modernization(forecast_obj: dict[str, Any]) -> dict[str, Any]:
    """Produce the stable modernization schema for one GNE forecast."""
    return {
        "title": forecast_obj["title"],
        "source": forecast_obj["source"],
        "published_date": forecast_obj["published_date"],
        "density": calculate_density(forecast_obj),
        "cycle": predict_modernization_cycle(forecast_obj),
        "relevance": score_modernization_relevance(forecast_obj),
        "alignment": map_alignment_to_jrocker(forecast_obj),
        "raw_text": forecast_obj["raw_text"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
