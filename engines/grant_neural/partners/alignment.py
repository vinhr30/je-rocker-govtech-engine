"""JE ROCKER client alignment for partner ecosystem records."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.semantics.extractor import (
    extract_homelessness_cues,
    extract_mental_health_cues,
    extract_modernization_cues,
    extract_veteran_cues,
)


def map_alignment_to_jrocker(modernization_obj: dict[str, Any], partners: list[str]) -> list[str]:
    """Map partner evidence to stable JE ROCKER client profile identifiers."""
    text = str(modernization_obj.get("raw_text") or "")
    existing_alignment = set(modernization_obj.get("alignment") or [])
    alignments: list[str] = []

    if extract_veteran_cues(text) or "veteran_stability" in existing_alignment:
        alignments.append("veteran_stability_clients")
    if extract_homelessness_cues(text) or "housing_stability" in existing_alignment:
        alignments.append("housing_stability_clients")
    if extract_mental_health_cues(text) or "behavioral_health" in existing_alignment:
        alignments.append("behavioral_health_clients")
    if extract_modernization_cues(text) or "modernization_intelligence" in existing_alignment:
        alignments.append("modernization_intelligence_clients")
    if partners or "ecosystem" in existing_alignment:
        alignments.append("ecosystem_engine_clients")
    return alignments
