"""Serialize the complete in-memory GNE pipeline state for the dashboard API."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from core.pipeline.gne_pipeline import (
    run_classifier,
    run_forecast,
    run_modernization,
    run_partners,
    run_scraper,
    run_semantic_extractor,
)
from core.state import gne_state


def build_snapshot() -> dict[str, list[dict]]:
    run_semantic_extractor()
    run_classifier()
    run_forecast()
    run_modernization()
    run_partners()
    return {
        "gne_signals": gne_state.grant_signals,
        "gne_semantics": gne_state.gne_semantics,
        "gne_classifications": gne_state.gne_classifications,
        "gne_forecasts": gne_state.gne_forecasts,
        "gne_modernization": gne_state.gne_modernization,
        "gne_partners": gne_state.gne_partners,
    }


def run_full_pipeline() -> dict[str, list[dict]]:
    """Run every GNE stage once and return the resulting idempotent state snapshot."""
    run_scraper()
    return build_snapshot()


if __name__ == "__main__":
    snapshot = run_full_pipeline() if "--run-full" in sys.argv[1:] else build_snapshot()
    print(json.dumps(snapshot, ensure_ascii=True))
