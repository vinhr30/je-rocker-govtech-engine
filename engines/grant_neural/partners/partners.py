"""Partner ecosystem orchestration for Grant Neural Engine modernization records."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from engines.grant_neural.partners.alignment import map_alignment_to_jrocker
from engines.grant_neural.partners.density import calculate_density
from engines.grant_neural.partners.extractor import extract_partners
from engines.grant_neural.partners.relevance import score_partner_relevance


def run_partners(modernization_obj: dict[str, Any]) -> dict[str, Any]:
    """Produce the stable partner ecosystem schema for one modernization object."""
    partners = extract_partners(modernization_obj)
    return {
        "title": modernization_obj["title"],
        "source": modernization_obj["source"],
        "published_date": modernization_obj["published_date"],
        "partners": partners,
        "ecosystem_density": calculate_density(modernization_obj, partners),
        "relevance": score_partner_relevance(modernization_obj, partners),
        "alignment": map_alignment_to_jrocker(modernization_obj, partners),
        "raw_text": modernization_obj["raw_text"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
