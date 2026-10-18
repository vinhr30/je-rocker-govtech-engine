"""Funding probability calculation for Grant Neural Engine forecasts."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.semantics.extractor import extract_agency, extract_program_types


HIGH_IMPORTANCE_AGENCIES = {
    "Department of Veterans Affairs",
    "Department of Housing and Urban Development",
    "Department of Health and Human Services",
}


def calculate_probability(classification_obj: dict[str, Any]) -> float:
    """Calculate normalized funding probability from classification evidence."""
    categories = set(classification_obj.get("categories") or [])
    matrix = dict(classification_obj.get("matrix") or {})
    raw_text = str(classification_obj.get("raw_text") or "")
    relevance = max(0.0, min(1.0, float(classification_obj.get("relevance", 0) or 0) / 100.0))
    confidence = max(0.0, min(1.0, float(classification_obj.get("confidence", 0) or 0)))
    agency = extract_agency(raw_text)
    program_density = min(len(extract_program_types(raw_text)) / 4.0, 1.0)
    cue_density = min(sum(float(matrix.get(key, 0) or 0) for key in matrix) / 3.0, 1.0)

    probability = (
        0.25 * (1.0 if "funding" in categories else 0.0)
        + 0.25 * relevance
        + 0.15 * (1.0 if agency in HIGH_IMPORTANCE_AGENCIES else 0.5 if agency else 0.0)
        + 0.15 * program_density
        + 0.10 * cue_density
        + 0.10 * confidence
    )
    return round(max(0.0, min(1.0, probability)), 4)
