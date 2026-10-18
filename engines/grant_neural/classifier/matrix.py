"""Classification matrix construction for Grant Neural Engine output."""

from __future__ import annotations


MATRIX_CATEGORIES = ("veteran", "homelessness", "modernization", "mental_health", "partner", "funding")


def build_matrix(categories: list[str], relevance: int, confidence: float) -> dict[str, float]:
    """Build six normalized category weights from category presence and score strength."""
    active = set(categories)
    strength = max(0.0, min(1.0, ((float(relevance) / 100.0) + float(confidence)) / 2.0))
    return {
        category: round(strength, 4) if category in active else 0.0
        for category in MATRIX_CATEGORIES
    }
