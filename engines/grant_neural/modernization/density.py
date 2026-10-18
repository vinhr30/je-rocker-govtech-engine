"""Modernization density calculation for Grant Neural Engine forecasts."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.semantics.extractor import extract_modernization_cues


def calculate_density(forecast_obj: dict[str, Any]) -> float:
    """Calculate normalized modernization density from cues, category, and cycle."""
    cues = extract_modernization_cues(str(forecast_obj.get("raw_text") or ""))
    categories = set(forecast_obj.get("categories") or [])
    matrix = dict(forecast_obj.get("matrix") or {})
    cycle_type = str((forecast_obj.get("cycle") or {}).get("cycle_type") or "")

    cue_weight = 0.50 * min(len(cues) / 4.0, 1.0)
    category_present = "modernization" in categories or float(matrix.get("modernization", 0) or 0) > 0 or bool(cues)
    category_weight = 0.25 if category_present else 0.0
    cycle_weight = 0.25 if cycle_type == "modernization" else 0.0
    return round(max(0.0, min(1.0, cue_weight + category_weight + cycle_weight)), 4)
