from __future__ import annotations

from ingestion.states.arizona.listings import fetch_listing_pages
from ingestion.states.arizona.normalize import normalize_records


def main() -> None:
    listing_results = fetch_listing_pages(reset=True, allow_partial=True)
    listing_count = len(listing_results)
    print(f"[AZ ingest] listing rows gathered: {listing_count}")

    normalized_rows = normalize_records(reset=True)
    print(f"[AZ ingest] normalized rows: {len(normalized_rows)}")

    import sqlite3
    from pathlib import Path

    db_path = Path(__file__).resolve().parents[3] / "data" / "opportunities_AZ.db"
    conn = sqlite3.connect(db_path)
    counts = {
        "raw_listings": conn.execute("SELECT COUNT(*) FROM raw_listings").fetchone()[0],
        "raw_details": conn.execute("SELECT COUNT(*) FROM raw_details").fetchone()[0] if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raw_details'").fetchone() else 0,
        "normalized_listings": conn.execute("SELECT COUNT(*) FROM normalized_listings").fetchone()[0],
    }
    conn.close()

    if listing_count:
        print(f"[AZ ingest] success: partial ingest completed with {listing_count} listing records captured and {counts['normalized_listings']} normalized records.")
    else:
        print(f"[AZ ingest] completed: {counts}")
    print(counts)


if __name__ == "__main__":
    main()
