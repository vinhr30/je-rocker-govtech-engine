from __future__ import annotations

from ingestion.states.california.details import hydrate_details
from ingestion.states.california.listings import fetch_listing_pages
from ingestion.states.california.normalize import normalize_records


def main() -> None:
    fetch_listing_pages()
    hydrate_details()
    normalize_records()

    import sqlite3
    from pathlib import Path

    db_path = Path(__file__).resolve().parents[3] / "data" / "opportunities_CA.db"
    conn = sqlite3.connect(db_path)
    counts = {
        "raw_listings": conn.execute("SELECT COUNT(*) FROM raw_listings").fetchone()[0],
        "raw_details": conn.execute("SELECT COUNT(*) FROM raw_details").fetchone()[0],
        "normalized_listings": conn.execute("SELECT COUNT(*) FROM normalized_listings").fetchone()[0],
    }
    conn.close()
    print(counts)


if __name__ == "__main__":
    main()
