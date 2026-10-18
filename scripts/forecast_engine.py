from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
FORECAST_DB = DASHBOARD_ROOT / "data" / "forecast.db"


def moving_average(series: Iterable[float], window: int) -> list[float]:
    if window <= 0:
        raise ValueError("window must be positive")
    values = [float(value) for value in series]
    averages: list[float] = []
    for index in range(len(values)):
        start = max(0, index - window + 1)
        averages.append(sum(values[start:index + 1]) / (index - start + 1))
    return averages


def exponential_smoothing(series: Iterable[float], alpha: float) -> list[float]:
    if not 0 < alpha <= 1:
        raise ValueError("alpha must be greater than 0 and at most 1")
    values = [float(value) for value in series]
    if not values:
        return []
    smoothed = [values[0]]
    for value in values[1:]:
        smoothed.append(alpha * value + (1 - alpha) * smoothed[-1])
    return smoothed


def calendar_series(rows: list[tuple[str, int]]) -> list[float]:
    if not rows:
        return []
    counts = {date.fromisoformat(bucket): int(count or 0) for bucket, count in rows}
    current = min(counts)
    end = max(counts)
    values: list[float] = []
    while current <= end:
        values.append(float(counts.get(current, 0)))
        current += timedelta(days=1)
    return values


def classify_regime(last7: float, last30: float, trend: float) -> str:
    if last7 > last30 * 1.15:
        return "Uptrend"
    if last7 < last30 * 0.85:
        return "Downtrend"
    if abs(last7 - last30) / max(last30, 1) > 0.20:
        return "Volatile"
    return "Stable"


def confidence_band(series: Iterable[float]) -> str:
    length = len(list(series))
    if length < 10:
        return "Low"
    if length < 30:
        return "Medium"
    return "High"


def metric_row(series: list[float], horizon_days: int, projected_key: str) -> dict[str, Any]:
    if horizon_days <= 0:
        raise ValueError("horizon_days must be positive")
    last_7 = sum(series[-7:]) / min(7, len(series)) if series else 0.0
    last_30 = sum(series[-30:]) / min(30, len(series)) if series else 0.0
    trend = exponential_smoothing(series, 0.3)[-1] if series else 0.0
    return {
        "last_7_day_avg": round(last_7, 4),
        "last_30_day_avg": round(last_30, 4),
        "smoothed_trend": round(trend, 4),
        projected_key: round(last_7 * horizon_days, 4),
        "regime": classify_regime(last_7, last_30, trend),
        "confidence": confidence_band(series),
    }


def grouped_series(
    table: str,
    dimension_columns: tuple[str, ...],
    count_column: str,
    database_path: Path = FORECAST_DB,
) -> dict[tuple[Any, ...], list[float]]:
    if not database_path.exists():
        return {}
    conn = sqlite3.connect(database_path)
    try:
        columns = ", ".join(("bucket_date", *dimension_columns, count_column))
        rows = conn.execute(f"SELECT {columns} FROM {table} ORDER BY bucket_date ASC, id ASC").fetchall()
    finally:
        conn.close()

    grouped: dict[tuple[Any, ...], list[tuple[str, int]]] = defaultdict(list)
    for row in rows:
        bucket_date, *dimensions, count = row
        grouped[tuple(dimensions)].append((bucket_date, count))
    return {dimensions: calendar_series(rows) for dimensions, rows in grouped.items()}


def forecast_pipeline(horizon_days: int = 30, database_path: Path = FORECAST_DB) -> list[dict[str, Any]]:
    groups = grouped_series(
        "forecast_pipeline_timeseries",
        ("stableNaics", "stablePsc", "stableAgency"),
        "opportunity_count",
        database_path,
    )
    rows = []
    for (naics, psc, agency), series in groups.items():
        rows.append({
            "stableNaics": naics,
            "stablePsc": psc,
            "stableAgency": agency,
            **metric_row(series, horizon_days, "projected_30_day_opportunity_count"),
        })
    return sorted(rows, key=lambda row: row["projected_30_day_opportunity_count"], reverse=True)


def forecast_grants(horizon_days: int = 30, database_path: Path = FORECAST_DB) -> list[dict[str, Any]]:
    groups = grouped_series(
        "forecast_grants_timeseries",
        ("stableGrantCategory", "stableAgency"),
        "grant_count",
        database_path,
    )
    rows = []
    for (category, agency), series in groups.items():
        rows.append({
            "stableGrantCategory": category,
            "stableAgency": agency,
            **metric_row(series, horizon_days, "projected_30_day_grant_count"),
        })
    return sorted(rows, key=lambda row: row["projected_30_day_grant_count"], reverse=True)


def forecast_modernization(horizon_days: int = 30, database_path: Path = FORECAST_DB) -> list[dict[str, Any]]:
    groups = grouped_series(
        "forecast_modernization_timeseries",
        ("stableModernization", "stableCapabilityZone"),
        "opportunity_count",
        database_path,
    )
    rows = []
    for (modernization, capability), series in groups.items():
        rows.append({
            "stableModernization": modernization,
            "stableCapabilityZone": capability,
            **metric_row(series, horizon_days, "projected_30_day_opportunity_count"),
        })
    return sorted(rows, key=lambda row: row["projected_30_day_opportunity_count"], reverse=True)


FORECAST_FUNCTIONS = {
    "pipeline": forecast_pipeline,
    "grants": forecast_grants,
    "modernization": forecast_modernization,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Return a baseline short-horizon forecast from aggregate time series.")
    parser.add_argument("kind", choices=FORECAST_FUNCTIONS)
    parser.add_argument("--horizon-days", type=int, default=30)
    args = parser.parse_args()
    print(json.dumps({"items": FORECAST_FUNCTIONS[args.kind](args.horizon_days)}, default=str))


if __name__ == "__main__":
    main()
