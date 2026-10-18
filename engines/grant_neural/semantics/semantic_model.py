"""Semantic object construction for the Grant Neural Engine."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def build_semantic_object(raw_signal: dict[str, Any], extracted_fields: dict[str, Any]) -> dict[str, Any]:
    """Build a semantic record using the stable GNE schema."""
    return {
        "source": raw_signal["source"],
        "title": raw_signal["title"],
        "published_date": raw_signal["published_date"],
        "funding_amount": extracted_fields.get("funding_amount"),
        "agency": extracted_fields.get("agency"),
        "target_population": extracted_fields.get("target_population", []),
        "program_types": extracted_fields.get("program_types", []),
        "geography": extracted_fields.get("geography", "national"),
        "modernization_cues": extracted_fields.get("modernization_cues", []),
        "veteran_cues": extracted_fields.get("veteran_cues", []),
        "homelessness_cues": extracted_fields.get("homelessness_cues", []),
        "mental_health_cues": extracted_fields.get("mental_health_cues", []),
        "partner_cues": extracted_fields.get("partner_cues", []),
        "raw_text": raw_signal["raw_text"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
