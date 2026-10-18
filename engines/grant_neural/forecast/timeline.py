"""Timeline mapping for Grant Neural Engine forecasts."""

from __future__ import annotations

from datetime import date
from typing import Any

from engines.grant_neural.forecast.cycle import add_months, predict_cycle


def _quarter(month: int) -> str:
    return f"Q{((month - 1) // 3) + 1}"


def map_timeline(classification_obj: dict[str, Any]) -> dict[str, str]:
    """Map a classification into a forecast window and expected release quarter."""
    cycle = predict_cycle(classification_obj)
    start = date.fromisoformat(cycle["cycle_start"])
    offsets = {"annual": (9, 12), "modernization": (18, 36), "seasonal": (3, 6)}
    start_offset, end_offset = offsets[cycle["cycle_type"]]
    forecast_start = add_months(start, start_offset)
    forecast_end = add_months(start, end_offset)
    return {
        "forecast_window_start": forecast_start.isoformat(),
        "forecast_window_end": forecast_end.isoformat(),
        "expected_release_quarter": f"{forecast_start.year}-{_quarter(forecast_start.month)}",
    }
