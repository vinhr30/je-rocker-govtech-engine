"""JE ROCKER alignment mapping for GNE modernization forecasts."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.modernization.cycle import predict_modernization_cycle
from engines.grant_neural.semantics.extractor import (
    extract_homelessness_cues,
    extract_mental_health_cues,
    extract_modernization_cues,
    extract_partner_cues,
    extract_veteran_cues,
)


def map_alignment_to_jrocker(forecast_obj: dict[str, Any]) -> list[str]:
    """Map modernization evidence to JE ROCKER intelligence engines."""
    text = str(forecast_obj.get("raw_text") or "")
    modernization = bool(extract_modernization_cues(text)) or (forecast_obj.get("cycle") or {}).get("cycle_type") == "modernization"
    alignments: list[str] = []

    if modernization and extract_veteran_cues(text):
        alignments.append("veteran_stability")
    if modernization and extract_homelessness_cues(text):
        alignments.append("housing_stability")
    if modernization and extract_mental_health_cues(text):
        alignments.append("behavioral_health")
    if extract_partner_cues(text):
        alignments.append("ecosystem")
    if predict_modernization_cycle(forecast_obj)["type"] == "modernization":
        alignments.append("modernization_intelligence")
    return alignments
