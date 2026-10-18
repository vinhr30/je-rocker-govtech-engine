from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.forecast_engine import (
    exponential_smoothing,
    forecast_grants,
    forecast_modernization,
    forecast_pipeline,
    moving_average,
)


class ForecastEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.database = Path(self.tmp.name) / "forecast.db"
        conn = sqlite3.connect(self.database)
        conn.executescript("""
            CREATE TABLE forecast_pipeline_timeseries (
                id INTEGER PRIMARY KEY, bucket_date TEXT, stableNaics TEXT,
                stablePsc TEXT, stableAgency TEXT, opportunity_count INTEGER, match_count INTEGER
            );
            CREATE TABLE forecast_grants_timeseries (
                id INTEGER PRIMARY KEY, bucket_date TEXT, stableGrantCategory TEXT,
                stableAgency TEXT, grant_count INTEGER, match_count INTEGER
            );
            CREATE TABLE forecast_modernization_timeseries (
                id INTEGER PRIMARY KEY, bucket_date TEXT, stableModernization TEXT,
                stableCapabilityZone TEXT, opportunity_count INTEGER, match_count INTEGER
            );
        """)
        conn.executemany(
            "INSERT INTO forecast_pipeline_timeseries (bucket_date, stableNaics, stablePsc, stableAgency, opportunity_count, match_count) VALUES (?, ?, ?, ?, ?, ?)",
            [
                ("2026-01-01", "541611", "R499", "Department of Defense", 10, 1),
                ("2026-01-03", "541611", "R499", "Department of Defense", 4, 1),
                ("2026-01-01", "561720", "S201", "GSA", 2, 0),
            ],
        )
        conn.executemany(
            "INSERT INTO forecast_grants_timeseries (bucket_date, stableGrantCategory, stableAgency, grant_count, match_count) VALUES (?, ?, ?, ?, ?)",
            [
                ("2026-01-01", "SBIR", "NSF", 2, 0),
                ("2026-01-02", "SBIR", "NSF", 4, 0),
            ],
        )
        conn.executemany(
            "INSERT INTO forecast_modernization_timeseries (bucket_date, stableModernization, stableCapabilityZone, opportunity_count, match_count) VALUES (?, ?, ?, ?, ?)",
            [
                ("2026-01-01", "Cloud", "Technical", 6, 0),
                ("2026-01-02", "Cloud", "Technical", 2, 0),
            ],
        )
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_moving_average(self) -> None:
        self.assertEqual(moving_average([1, 2, 3, 4], 2), [1.0, 1.5, 2.5, 3.5])
        with self.assertRaises(ValueError):
            moving_average([1], 0)

    def test_exponential_smoothing(self) -> None:
        self.assertEqual(exponential_smoothing([10, 20, 30], 0.3), [10.0, 13.0, 18.1])
        self.assertEqual(exponential_smoothing([], 0.3), [])
        with self.assertRaises(ValueError):
            exponential_smoothing([1], 0)

    def test_pipeline_zero_fills_missing_calendar_days(self) -> None:
        rows = forecast_pipeline(database_path=self.database)
        dod = next(row for row in rows if row["stableAgency"] == "Department of Defense")
        self.assertEqual(dod["last_7_day_avg"], round(14 / 3, 4))
        self.assertEqual(dod["last_30_day_avg"], round(14 / 3, 4))
        self.assertEqual(dod["projected_30_day_opportunity_count"], round((14 / 3) * 30, 4))

    def test_grants_forecast_returns_plain_json_ready_rows(self) -> None:
        rows = forecast_grants(database_path=self.database)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["stableGrantCategory"], "SBIR")
        self.assertEqual(rows[0]["last_7_day_avg"], 3.0)
        self.assertEqual(rows[0]["projected_30_day_grant_count"], 90.0)

    def test_modernization_forecast_returns_expected_metrics(self) -> None:
        rows = forecast_modernization(database_path=self.database)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["stableModernization"], "Cloud")
        self.assertEqual(rows[0]["stableCapabilityZone"], "Technical")
        self.assertEqual(rows[0]["smoothed_trend"], 4.8)


if __name__ == "__main__":
    unittest.main()
