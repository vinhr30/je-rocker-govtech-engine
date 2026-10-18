"""Category assignment for Grant Neural Engine semantic objects."""

from __future__ import annotations

from typing import Any


CATEGORY_CUES = (
    ("veteran", "veteran_cues"),
    ("homelessness", "homelessness_cues"),
    ("modernization", "modernization_cues"),
    ("mental_health", "mental_health_cues"),
    ("partner", "partner_cues"),
)

STATE_SOURCE_MARKERS = ("state portal", "state of ", "state government", "state news", "commonwealth", "county", "city of")


def _has_positive_funding(value: Any) -> bool:
    try:
        return float(value or 0) > 0
    except (TypeError, ValueError):
        return False


def assign_categories(semantic_obj: dict[str, Any]) -> list[str]:
    """Assign stable classifier categories from extracted semantic fields."""
    categories = [category for category, field in CATEGORY_CUES if semantic_obj.get(field)]
    if _has_positive_funding(semantic_obj.get("funding_amount")):
        categories.append("funding")

    source = str(semantic_obj.get("source") or "").casefold()
    categories.append("state" if any(marker in source for marker in STATE_SOURCE_MARKERS) else "federal")
    return categories
