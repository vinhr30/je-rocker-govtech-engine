"""Partner relevance scoring for Grant Neural Engine modernization records."""

from __future__ import annotations

import math
from typing import Any

from engines.grant_neural.partners.alignment import map_alignment_to_jrocker
from engines.grant_neural.semantics.extractor import extract_agency, extract_funding_amount, extract_partner_cues


HIGH_IMPORTANCE_AGENCIES = {
    "Department of Veterans Affairs",
    "Department of Housing and Urban Development",
    "Department of Health and Human Services",
}


def _funding_probability_proxy(text: str) -> float:
    amount = extract_funding_amount(text) or 0
    if amount <= 0:
        return 0.0
    return min(1.0, 0.2 + 0.2 * math.log10(max(amount / 1_000_000, 1)))


def score_partner_relevance(modernization_obj: dict[str, Any], partners: list[str]) -> int:
    """Score partner ecosystem relevance on a bounded 0-100 scale."""
    text = str(modernization_obj.get("raw_text") or "")
    modernization = max(0.0, min(100.0, float(modernization_obj.get("relevance", 0) or 0)))
    partner_cues = extract_partner_cues(text)
    agency = extract_agency(text)
    alignments = map_alignment_to_jrocker(modernization_obj, partners)

    score = (
        0.35 * modernization
        + 20 * min(len(partner_cues) / 3.0, 1.0)
        + 15 * _funding_probability_proxy(text)
        + (15 if agency in HIGH_IMPORTANCE_AGENCIES else 7 if agency else 0)
        + 15 * min(len(alignments) / 5.0, 1.0)
    )
    return int(round(max(0.0, min(100.0, score))))
