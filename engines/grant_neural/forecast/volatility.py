"""Volatility detection for Grant Neural Engine forecasts."""

from __future__ import annotations

from typing import Any

from engines.grant_neural.semantics.extractor import extract_funding_amount


HIGH_FUNDING_THRESHOLD = 500_000_000


def detect_volatility(classification_obj: dict[str, Any]) -> str:
    """Return low, medium, or high volatility using capped classification evidence."""
    categories = set(classification_obj.get("categories") or [])
    matrix = dict(classification_obj.get("matrix") or {})
    funding_amount = extract_funding_amount(str(classification_obj.get("raw_text") or "")) or 0

    if funding_amount > HIGH_FUNDING_THRESHOLD:
        return "low"
    if "homelessness" in categories or float(matrix.get("homelessness", 0) or 0) >= 0.7:
        return "high"
    if "modernization" in categories or float(matrix.get("modernization", 0) or 0) > 0:
        return "medium"
    if "partner" in categories or float(matrix.get("partner", 0) or 0) > 0:
        return "low"
    return "medium"
