from __future__ import annotations

import sqlite3
from pathlib import Path

from ingestion.states.new_york.details import hydrate_details
from ingestion.states.new_york.listings import fetch_listing_pages
from ingestion.states.new_york.normalize import normalize_records

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_NY.db"


def main() -> None:
    fetch_listing_pages(reset=True)
    hydrate_details(reset=True)
    normalize_records(reset=True)

    conn = sqlite3.connect(DB_PATH)
    counts = {
        "raw_listings": conn.execute("SELECT COUNT(*) FROM raw_listings").fetchone()[0],
        "raw_details": conn.execute("SELECT COUNT(*) FROM raw_details").fetchone()[0],
        "normalized_listings": conn.execute("SELECT COUNT(*) FROM normalized_listings").fetchone()[0],
    }
    conn.close()
    print(counts)


if __name__ == "__main__":
    main()
