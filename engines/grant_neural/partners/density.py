"""Partner ecosystem density for Grant Neural Engine modernization records."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.semantics.extractor import extract_partner_cues


def calculate_density(modernization_obj: dict[str, Any], partners: list[str]) -> float:
    """Calculate normalized density from entities, partner cues, and modernization relevance."""
    text = str(modernization_obj.get("raw_text") or "")
    entity_weight = 0.50 * min(len(set(partners)) / 5.0, 1.0)
    cue_weight = 0.25 * min(len(extract_partner_cues(text)) / 3.0, 1.0)
    relevance = max(0.0, min(100.0, float(modernization_obj.get("relevance", 0) or 0)))
    relevance_weight = 0.25 * (relevance / 100.0)
    return round(max(0.0, min(1.0, entity_weight + cue_weight + relevance_weight)), 4)
