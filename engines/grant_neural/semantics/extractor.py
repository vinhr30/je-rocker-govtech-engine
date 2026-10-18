"""Deterministic semantic extraction for Grant Neural Engine signals."""

from __future__ import annotations

import re
from typing import Any

from engines.grant_neural.semantics.patterns import (
    AGENCY_PATTERNS,
    FUNDING_PATTERN,
    GEOGRAPHY_PATTERNS,
    HOMELESSNESS_CUE_PATTERNS,
    MENTAL_HEALTH_CUE_PATTERNS,
    MODERNIZATION_CUE_PATTERNS,
    PARTNER_CUE_PATTERNS,
    PROGRAM_TYPE_PATTERNS,
    TARGET_POPULATION_PATTERNS,
    VETERAN_CUE_PATTERNS,
)
from engines.grant_neural.semantics.semantic_model import build_semantic_object


def _extract_labels(text: str, patterns: dict[str, tuple[str, ...]]) -> list[str]:
    return [
        label
        for label, expressions in patterns.items()
        if any(re.search(expression, text, re.IGNORECASE) for expression in expressions)
    ]


def extract_funding_amount(text: str) -> int | None:
    amounts = []
    for match in FUNDING_PATTERN.finditer(text or ""):
        value = float(match.group(1))
        multiplier = 1_000_000 if match.group(2).lower() == "million" else 1_000_000_000
        amounts.append(round(value * multiplier))
    return max(amounts) if amounts else None


def extract_agency(text: str) -> str | None:
    for agency, patterns in AGENCY_PATTERNS.items():
        if any(pattern.search(text or "") for pattern in patterns):
            return agency
    return None


def extract_target_population(text: str) -> list[str]:
    return _extract_labels(text or "", TARGET_POPULATION_PATTERNS)


def extract_program_types(text: str) -> list[str]:
    return _extract_labels(text or "", PROGRAM_TYPE_PATTERNS)


def extract_geography(text: str) -> str:
    matches = _extract_labels(text or "", GEOGRAPHY_PATTERNS)
    return matches[0] if matches else "national"


def extract_modernization_cues(text: str) -> list[str]:
    return _extract_labels(text or "", MODERNIZATION_CUE_PATTERNS)


def extract_veteran_cues(text: str) -> list[str]:
    return _extract_labels(text or "", VETERAN_CUE_PATTERNS)


def extract_homelessness_cues(text: str) -> list[str]:
    return _extract_labels(text or "", HOMELESSNESS_CUE_PATTERNS)


def extract_mental_health_cues(text: str) -> list[str]:
    return _extract_labels(text or "", MENTAL_HEALTH_CUE_PATTERNS)


def extract_partner_cues(text: str) -> list[str]:
    return _extract_labels(text or "", PARTNER_CUE_PATTERNS)


def run_semantic_extraction(raw_signal: dict[str, Any]) -> dict[str, Any]:
    """Extract all supported semantic fields from one normalized raw signal."""
    text = str(raw_signal["raw_text"] or "")
    extracted_fields = {
        "funding_amount": extract_funding_amount(text),
        "agency": extract_agency(text),
        "target_population": extract_target_population(text),
        "program_types": extract_program_types(text),
        "geography": extract_geography(text),
        "modernization_cues": extract_modernization_cues(text),
        "veteran_cues": extract_veteran_cues(text),
        "homelessness_cues": extract_homelessness_cues(text),
        "mental_health_cues": extract_mental_health_cues(text),
        "partner_cues": extract_partner_cues(text),
    }
    return build_semantic_object(raw_signal, extracted_fields)
