"""Relevance and confidence scoring for GNE classifications."""

from __future__ import annotations

import math
from typing import Any


HIGH_IMPORTANCE_AGENCIES = {
    "Department of Veterans Affairs",
    "Department of Housing and Urban Development",
    "Department of Health and Human Services",
    "VA",
    "HUD",
    "HHS",
}

CUE_FIELDS = (
    "modernization_cues",
    "veteran_cues",
    "homelessness_cues",
    "mental_health_cues",
    "partner_cues",
)


def _items(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _funding_points(amount: Any) -> int:
    try:
        numeric = max(float(amount or 0), 0)
    except (TypeError, ValueError):
        return 0
    if numeric <= 0:
        return 0
    return min(30, round(5 + 5 * math.log10(max(numeric / 1_000_000, 1))))


def score_relevance(semantic_obj: dict[str, Any]) -> int:
    """Score grant-signal relevance on a deterministic 0-100 scale."""
    funding = _funding_points(semantic_obj.get("funding_amount"))
    populations = min(20, len(_items(semantic_obj.get("target_population"))) * 5)
    programs = min(20, len(_items(semantic_obj.get("program_types"))) * 4)
    modernization = min(10, len(_items(semantic_obj.get("modernization_cues"))) * 2)
    agency = 15 if semantic_obj.get("agency") in HIGH_IMPORTANCE_AGENCIES else 7 if semantic_obj.get("agency") else 0
    geography = {"national": 5, "regional": 3, "local": 1}.get(str(semantic_obj.get("geography") or "").casefold(), 3)
    return max(0, min(100, funding + populations + programs + modernization + agency + geography))


def calculate_confidence(semantic_obj: dict[str, Any]) -> float:
    """Calculate extraction confidence from cue coverage and field clarity."""
    cue_count = sum(len(_items(semantic_obj.get(field))) for field in CUE_FIELDS)
    cue_clarity = min(cue_count / 8, 1.0)
    funding_clarity = 1.0 if _funding_points(semantic_obj.get("funding_amount")) else 0.0
    agency_clarity = 1.0 if semantic_obj.get("agency") else 0.0
    program_clarity = min(len(_items(semantic_obj.get("program_types"))) / 3, 1.0)
    confidence = 0.35 * cue_clarity + 0.25 * funding_clarity + 0.20 * agency_clarity + 0.20 * program_clarity
    return round(max(0.0, min(1.0, confidence)), 4)
