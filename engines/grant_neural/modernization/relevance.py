"""Modernization relevance scoring for Grant Neural Engine forecasts."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.modernization.density import calculate_density
from engines.grant_neural.semantics.extractor import (
    extract_agency,
    extract_modernization_cues,
    extract_program_types,
)


HIGH_IMPORTANCE_AGENCIES = {
    "Department of Veterans Affairs",
    "Department of Housing and Urban Development",
    "Department of Health and Human Services",
}

MODERNIZATION_PROGRAM_TERMS = {"case management", "workflow", "automation"}


def score_modernization_relevance(forecast_obj: dict[str, Any]) -> int:
    """Score modernization relevance on a bounded 0-100 scale."""
    raw_text = str(forecast_obj.get("raw_text") or "")
    density_points = 40 * calculate_density(forecast_obj)
    probability_points = 20 * max(0.0, min(1.0, float(forecast_obj.get("probability", 0) or 0)))
    cues = extract_modernization_cues(raw_text)
    cue_points = 15 * min(len(cues) / 4.0, 1.0)
    agency = extract_agency(raw_text)
    agency_points = 15 if agency in HIGH_IMPORTANCE_AGENCIES else 7 if agency else 0
    programs = set(extract_program_types(raw_text))
    aligned_terms = programs.intersection(MODERNIZATION_PROGRAM_TERMS)
    lower_text = raw_text.casefold()
    aligned_terms.update(term for term in ("workflow", "automation") if term in lower_text)
    program_points = 10 * min(len(aligned_terms) / len(MODERNIZATION_PROGRAM_TERMS), 1.0)
    return int(round(max(0.0, min(100.0, density_points + probability_points + cue_points + agency_points + program_points))))
