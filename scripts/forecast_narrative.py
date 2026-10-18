from __future__ import annotations

import argparse
import json
from typing import Any, Callable

try:
    from .forecast_engine import forecast_grants, forecast_modernization, forecast_pipeline
except ImportError:
    from forecast_engine import forecast_grants, forecast_modernization, forecast_pipeline


def describe_regime(regime: str) -> str:
    if regime == "Uptrend":
        return "Activity is increasing and expected to continue rising."
    if regime == "Downtrend":
        return "Activity is decreasing and may continue to fall."
    if regime == "Volatile":
        return "Activity is fluctuating sharply with no clear direction."
    return "Activity is stable with minor variation."


def describe_confidence(conf: str) -> str:
    if conf == "High":
        return "This projection is based on a long, stable history."
    if conf == "Medium":
        return "This projection is moderately reliable."
    return "This projection is based on limited recent data."


def build_narratives(
    rows: list[dict[str, Any]],
    dimensions: tuple[str, ...],
    projection_key: str,
) -> list[dict[str, Any]]:
    narratives = []
    for row in rows:
        regime = row.get("regime", "Stable")
        confidence = row.get("confidence", "Low")
        narratives.append({
            **{dimension: row.get(dimension) for dimension in dimensions},
            "regime": regime,
            "confidence": confidence,
            "summary": (
                f"{describe_regime(regime)} {describe_confidence(confidence)} "
                f"Projected 30-day volume: {row.get(projection_key, 0)}."
            ),
        })
    return narratives


def pipeline_narrative() -> list[dict[str, Any]]:
    return build_narratives(
        forecast_pipeline(),
        ("stableNaics", "stablePsc", "stableAgency"),
        "projected_30_day_opportunity_count",
    )


def grants_narrative() -> list[dict[str, Any]]:
    return build_narratives(
        forecast_grants(),
        ("stableGrantCategory", "stableAgency"),
        "projected_30_day_grant_count",
    )


def modernization_narrative() -> list[dict[str, Any]]:
    return build_narratives(
        forecast_modernization(),
        ("stableModernization", "stableCapabilityZone"),
        "projected_30_day_opportunity_count",
    )


NARRATIVE_FUNCTIONS: dict[str, Callable[[], list[dict[str, Any]]]] = {
    "pipeline": pipeline_narrative,
    "grants": grants_narrative,
    "modernization": modernization_narrative,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Return forecast narratives as JSON.")
    parser.add_argument("kind", choices=NARRATIVE_FUNCTIONS)
    args = parser.parse_args()
    print(json.dumps({"items": NARRATIVE_FUNCTIONS[args.kind]()}, default=str))


if __name__ == "__main__":
    main()
