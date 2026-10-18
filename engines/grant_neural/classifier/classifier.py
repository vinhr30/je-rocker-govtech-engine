"""Classification orchestration for Grant Neural Engine semantic objects."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from engines.grant_neural.classifier.caps import apply_caps
from engines.grant_neural.classifier.categories import assign_categories
from engines.grant_neural.classifier.matrix import build_matrix
from engines.grant_neural.classifier.relevance import calculate_confidence, score_relevance


def run_classification(semantic_obj: dict[str, Any]) -> dict[str, Any]:
    """Classify one semantic object and return the stable GNE classification schema."""
    categories = assign_categories(semantic_obj)
    relevance = score_relevance(semantic_obj)
    confidence = calculate_confidence(semantic_obj)
    classification = {
        "title": semantic_obj["title"],
        "source": semantic_obj["source"],
        "published_date": semantic_obj["published_date"],
        "categories": categories,
        "relevance": relevance,
        "confidence": confidence,
        "matrix": build_matrix(categories, relevance, confidence),
        "raw_text": semantic_obj["raw_text"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    return apply_caps(classification)
