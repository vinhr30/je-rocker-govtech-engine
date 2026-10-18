"""Cycle prediction for Grant Neural Engine classifications."""

from __future__ import annotations

import calendar
from datetime import date
from typing import Any

from engines.grant_neural.semantics.extractor import extract_funding_amount


HIGH_FUNDING_THRESHOLD = 500_000_000


def _parse_date(value: Any) -> date:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError) as error:
        raise ValueError("published_date must be a valid YYYY-MM-DD date") from error


def add_months(anchor: date, months: int) -> date:
    """Add calendar months while preserving the nearest valid day."""
    month_index = anchor.month - 1 + months
    year = anchor.year + month_index // 12
    month = month_index % 12 + 1
    day = min(anchor.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def predict_cycle(classification_obj: dict[str, Any]) -> dict[str, str]:
    """Predict a funding cycle anchored to the classification publication date."""
    anchor = _parse_date(classification_obj["published_date"])
    categories = set(classification_obj.get("categories") or [])
    matrix = classification_obj.get("matrix") or {}
    funding_amount = extract_funding_amount(str(classification_obj.get("raw_text") or "")) or 0

    if funding_amount > HIGH_FUNDING_THRESHOLD and "federal" in categories:
        cycle_type = "annual"
        cycle_end = add_months(anchor, 12)
    elif "modernization" in categories or float(matrix.get("modernization", 0) or 0) > 0:
        cycle_type = "modernization"
        cycle_end = add_months(anchor, 36)
    elif categories.intersection({"homelessness", "veteran"}):
        cycle_type = "seasonal"
        cycle_end = add_months(anchor, 6)
    else:
        cycle_type = "annual"
        cycle_end = add_months(anchor, 12)

    return {
        "cycle_type": cycle_type,
        "cycle_start": anchor.isoformat(),
        "cycle_end": cycle_end.isoformat(),
    }
