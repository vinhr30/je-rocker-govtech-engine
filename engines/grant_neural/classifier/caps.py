"""Invariant caps for Grant Neural Engine classifications."""

from __future__ import annotations

from typing import Any


def _clamp(value: Any, lower: float, upper: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = lower
    return max(lower, min(upper, numeric))


def apply_caps(classification_obj: dict[str, Any]) -> dict[str, Any]:
    """Clamp classifier values and guarantee at least one semantic category."""
    capped = dict(classification_obj)
    categories = list(capped.get("categories") or [])
    if not categories:
        categories = ["general"]
    capped["categories"] = categories
    capped["relevance"] = int(round(_clamp(capped.get("relevance", 0), 0, 100)))
    capped["confidence"] = round(_clamp(capped.get("confidence", 0), 0.0, 1.0), 4)
    capped["matrix"] = {
        key: round(_clamp(value, 0.0, 1.0), 4)
        for key, value in dict(capped.get("matrix") or {}).items()
    }
    return capped
