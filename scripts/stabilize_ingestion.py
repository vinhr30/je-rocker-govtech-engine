from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path
from typing import Any

from drift_suppression import apply_drift_suppression, log_drift_events

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_ROOT = Path("/Volumes/Data Drive/Govtech/JE ROCKER")
SAM_DB = PIPELINE_ROOT / "db" / "opportunities.db"
STATE_DATABASES = sorted((DASHBOARD_ROOT / "data").glob("opportunities_*.db"))
STABLE_COLUMNS = {
    "stableNaics": "TEXT",
    "stablePsc": "TEXT",
    "stableAgency": "TEXT",
    "stableModernization": "TEXT",
    "stableGrantCategory": "TEXT",
    "stableCapabilityZone": "TEXT",
}


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def ensure_stable_columns(conn: sqlite3.Connection, table: str) -> None:
    columns = table_columns(conn, table)
    for name, column_type in STABLE_COLUMNS.items():
        if name not in columns:
            conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {column_type}')
    conn.commit()


def source_value(row: sqlite3.Row, *names: str) -> Any:
    for name in names:
        if name in row.keys() and row[name] not in (None, ""):
            return row[name]
    return None


def raw_metadata(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "naics": source_value(row, "naics", "naics_code"),
        "psc": source_value(row, "psc", "psc_code", "commodity_codes"),
        "agency": source_value(row, "agency", "department"),
        "modernization": source_value(row, "modernization"),
        "grantCategory": source_value(row, "grantCategory", "grant_category", "category", "event_type", "bid_type"),
        "capabilityZone": source_value(row, "capabilityZone", "capability_zone"),
    }


def stabilize_table(database_path: Path, table: str, key_column: str = "rowid") -> dict[str, int]:
    if not database_path.exists():
        return {"rows": 0, "events": 0}
    conn = sqlite3.connect(database_path)
    conn.row_factory = sqlite3.Row
    try:
        if table not in {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
            return {"rows": 0, "events": 0}
        ensure_stable_columns(conn, table)
        rows = conn.execute(f'SELECT rowid AS _dsm_rowid, * FROM "{table}"').fetchall()
        events = 0
        for row in rows:
            stable = apply_drift_suppression(raw_metadata(row))
            log_drift_events(stable["driftEvents"])
            events += len(stable["driftEvents"])
            conn.execute(
                f'''UPDATE "{table}" SET
                    "stableNaics" = ?, "stablePsc" = ?, "stableAgency" = ?,
                    "stableModernization" = ?, "stableGrantCategory" = ?, "stableCapabilityZone" = ?
                    WHERE rowid = ?''',
                (
                    stable["stableNaics"], stable["stablePsc"], stable["stableAgency"],
                    stable["stableModernization"], stable["stableGrantCategory"], stable["stableCapabilityZone"],
                    row["_dsm_rowid"],
                ),
            )
        conn.commit()
        return {"rows": len(rows), "events": events}
    finally:
        conn.close()


def stabilize_sam() -> dict[str, int]:
    return stabilize_table(SAM_DB, "opportunities")


def stabilize_states() -> dict[str, dict[str, int]]:
    return {path.stem: stabilize_table(path, "normalized_listings") for path in STATE_DATABASES}


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply DSM stable category columns after ingestion.")
    parser.add_argument("--states-only", action="store_true")
    parser.add_argument("--sam-only", action="store_true")
    args = parser.parse_args()
    if args.states_only and args.sam_only:
        parser.error("--states-only and --sam-only cannot be used together")
    if not args.states_only:
        sam = stabilize_sam()
        print(f"SAM: {sam['rows']} rows stabilized, {sam['events']} drift events")
    if not args.sam_only:
        for name, result in stabilize_states().items():
            print(f"{name}: {result['rows']} rows stabilized, {result['events']} drift events")


if __name__ == "__main__":
    main()
