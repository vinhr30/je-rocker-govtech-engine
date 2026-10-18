"""Partner entity extraction for Grant Neural Engine modernization records."""

from __future__ import annotations

import re
from typing import Any


GENERIC_PARTNER_PATTERNS = {
    "Community Partners": r"\bcommunity partners?\b",
    "Modernization Vendors": r"\b(?:modernization|technology|digital) vendors?\b",
    "Health Plans": r"\bhealth plans?\b",
    "Nonprofit Organizations": r"\bnon[ -]?profits?(?: organizations?)?\b",
    "Service Providers": r"\b(?:service|health care|healthcare) providers?\b|\bproviders?\b",
    "Partner Organizations": r"\bpartner organizations?\b",
}

NAMED_ORGANIZATION_PATTERN = re.compile(
    r"\b((?:[A-Z][A-Za-z&'’-]*\s+){1,7}(?:Foundation|Association|Alliance|Coalition|Council|Network|Center|Centre|Institute|Corporation|Company|Inc\.?|LLC|Health Plan|Hospital|University))\b"
)


def _normalize_name(value: str) -> str:
    normalized = " ".join(value.strip(" ,.;:()[]").split())
    return re.sub(r"^(?:The|A|An)\s+", "", normalized)


def extract_partners(modernization_obj: dict[str, Any]) -> list[str]:
    """Extract and normalize named organizations and partner classes from raw text."""
    text = str(modernization_obj.get("raw_text") or "")
    partners: list[str] = []

    for match in NAMED_ORGANIZATION_PATTERN.finditer(text):
        name = _normalize_name(match.group(1))
        if name and name not in partners:
            partners.append(name)

    for name, expression in GENERIC_PARTNER_PATTERNS.items():
        if re.search(expression, text, re.IGNORECASE) and name not in partners:
            partners.append(name)

    if re.search(r"\borganizations?\b", text, re.IGNORECASE) and not partners:
        partners.append("Organizations")
    return partners
