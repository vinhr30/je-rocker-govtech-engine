from __future__ import annotations

import sqlite3
from pathlib import Path

from drift_suppression import apply_drift_suppression

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_ROOT = Path("/Volumes/Data Drive/Govtech/JE ROCKER")
OPPORTUNITIES_DB = PIPELINE_ROOT / "db" / "opportunities.db"
MATCHES_DB = PIPELINE_ROOT / "db" / "matches.db"
GRANTS_DB = DASHBOARD_ROOT / "grant_scraper" / "data" / "grants.db"
FORECAST_DB = DASHBOARD_ROOT / "data" / "forecast.db"


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS forecast_pipeline_timeseries (
            id INTEGER PRIMARY KEY,
            bucket_date TEXT NOT NULL,
            stableNaics TEXT,
            stablePsc TEXT,
            stableAgency TEXT,
            opportunity_count INTEGER NOT NULL,
            match_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS forecast_grants_timeseries (
            id INTEGER PRIMARY KEY,
            bucket_date TEXT NOT NULL,
            stableGrantCategory TEXT,
            stableAgency TEXT,
            grant_count INTEGER NOT NULL,
            match_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS forecast_modernization_timeseries (
            id INTEGER PRIMARY KEY,
            bucket_date TEXT NOT NULL,
            stableModernization TEXT,
            stableCapabilityZone TEXT,
            opportunity_count INTEGER NOT NULL,
            match_count INTEGER NOT NULL
        );
    """)


def has_table(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone() is not None


def has_columns(conn: sqlite3.Connection, table: str, columns: set[str]) -> bool:
    available = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    return columns.issubset(available)


def date_bucket(column: str, fallback: str | None = None) -> str:
    valid_source = f"CASE WHEN date({column}) IS NOT NULL THEN date({column}) END"
    if not fallback:
        return valid_source
    valid_fallback = f"CASE WHEN date({fallback}) IS NOT NULL THEN date({fallback}) END"
    return f"COALESCE({valid_source}, {valid_fallback})"


def rebuild_forecast_timeseries(
    opportunities_db: Path = OPPORTUNITIES_DB,
    matches_db: Path = MATCHES_DB,
    grants_db: Path = GRANTS_DB,
    forecast_db: Path = FORECAST_DB,
) -> dict[str, int]:
    forecast_db.parent.mkdir(parents=True, exist_ok=True)
    target = sqlite3.connect(forecast_db)
    opportunities = sqlite3.connect(opportunities_db)
    matches = sqlite3.connect(matches_db)
    grants = sqlite3.connect(grants_db)

    try:
        ensure_schema(target)
        target.execute("DELETE FROM forecast_pipeline_timeseries")
        target.execute("DELETE FROM forecast_grants_timeseries")
        target.execute("DELETE FROM forecast_modernization_timeseries")

        if has_table(opportunities, "opportunities") and has_columns(
            opportunities,
            "opportunities",
            {"stableNaics", "stablePsc", "stableAgency", "stableModernization", "stableGrantCategory", "stableCapabilityZone"},
        ):
            pipeline_opportunity_rows = opportunities.execute(f"""
                SELECT
                    {date_bucket('posted_date', 'scraped_at')} AS bucket_date,
                    stableNaics,
                    stablePsc,
                    stableAgency,
                    COUNT(*) AS opportunity_count
                FROM opportunities
                WHERE {date_bucket('posted_date', 'scraped_at')} IS NOT NULL
                GROUP BY bucket_date, stableNaics, stablePsc, stableAgency
            """).fetchall()
            modernization_opportunity_rows = opportunities.execute(f"""
                SELECT
                    {date_bucket('posted_date', 'scraped_at')} AS bucket_date,
                    stableModernization,
                    stableCapabilityZone,
                    COUNT(*) AS opportunity_count
                FROM opportunities
                WHERE {date_bucket('posted_date', 'scraped_at')} IS NOT NULL
                GROUP BY bucket_date, stableModernization, stableCapabilityZone
            """).fetchall()
        else:
            pipeline_opportunity_rows = []
            modernization_opportunity_rows = []

        match_counts: dict[tuple[str | None, str | None, str | None], int] = {}
        grant_match_counts: dict[tuple[str | None, str | None], int] = {}
        modernization_match_counts: dict[tuple[str | None, str | None, str | None], int] = {}
        for table in ("matches", "matches_low_confidence"):
            if not has_table(matches, table) or not has_columns(
                matches,
                table,
                {"stableNaics", "stablePsc", "stableAgency", "stableModernization", "stableGrantCategory", "stableCapabilityZone", "timestamp"},
            ):
                continue
            for row in matches.execute(f"""
                SELECT {date_bucket('timestamp')} AS bucket_date, stableNaics, stablePsc,
                       stableAgency, stableModernization, stableGrantCategory, stableCapabilityZone,
                       COUNT(*) AS match_count
                FROM {table}
                WHERE {date_bucket('timestamp')} IS NOT NULL
                GROUP BY bucket_date, stableNaics, stablePsc, stableAgency,
                         stableModernization, stableGrantCategory, stableCapabilityZone
            """):
                bucket, naics, psc, agency, modernization, grant_category, capability, count = row
                match_counts[(bucket, naics, psc)] = match_counts.get((bucket, naics, psc), 0) + count
                grant_match_counts[(bucket, grant_category, agency)] = grant_match_counts.get((bucket, grant_category, agency), 0) + count
                modernization_match_counts[(bucket, modernization, capability)] = modernization_match_counts.get((bucket, modernization, capability), 0) + count

        pipeline_rows: list[tuple] = []
        grants_rows: list[tuple] = []
        modernization_rows: list[tuple] = []
        for bucket, naics, psc, agency, count in pipeline_opportunity_rows:
            pipeline_rows.append((bucket, naics, psc, agency, count, match_counts.get((bucket, naics, psc), 0)))
        for bucket, modernization, capability, count in modernization_opportunity_rows:
            modernization_rows.append((bucket, modernization, capability, count, modernization_match_counts.get((bucket, modernization, capability), 0)))

        if has_table(grants, "grants_normalized"):
            columns = {row[1] for row in grants.execute("PRAGMA table_info(grants_normalized)")}
            if {"normalized_at", "opportunity_category", "agency"}.issubset(columns):
                grant_counts: dict[tuple[str, str | None, str | None], int] = {}
                for bucket, category, agency in grants.execute(f"""
                    SELECT {date_bucket('normalized_at')} AS bucket_date, opportunity_category, agency
                    FROM grants_normalized
                    WHERE {date_bucket('normalized_at')} IS NOT NULL
                """):
                    stable_category = apply_drift_suppression({"grantCategory": category})["stableGrantCategory"]
                    key = (bucket, stable_category, agency)
                    grant_counts[key] = grant_counts.get(key, 0) + 1
                for (bucket, category, agency), count in grant_counts.items():
                    grants_rows.append((bucket, category, agency, count, grant_match_counts.get((bucket, category, agency), 0)))

        target.executemany(
            "INSERT INTO forecast_pipeline_timeseries (bucket_date, stableNaics, stablePsc, stableAgency, opportunity_count, match_count) VALUES (?, ?, ?, ?, ?, ?)",
            pipeline_rows,
        )
        target.executemany(
            "INSERT INTO forecast_grants_timeseries (bucket_date, stableGrantCategory, stableAgency, grant_count, match_count) VALUES (?, ?, ?, ?, ?)",
            grants_rows,
        )
        target.executemany(
            "INSERT INTO forecast_modernization_timeseries (bucket_date, stableModernization, stableCapabilityZone, opportunity_count, match_count) VALUES (?, ?, ?, ?, ?)",
            modernization_rows,
        )
        target.commit()

        return {
            "pipeline": len(pipeline_rows),
            "grants": len(grants_rows),
            "modernization": len(modernization_rows),
        }
    finally:
        opportunities.close()
        matches.close()
        grants.close()
        target.close()


if __name__ == "__main__":
    counts = rebuild_forecast_timeseries()
    print(f"forecast_pipeline_timeseries: {counts['pipeline']} rows")
    print(f"forecast_grants_timeseries: {counts['grants']} rows")
    print(f"forecast_modernization_timeseries: {counts['modernization']} rows")
