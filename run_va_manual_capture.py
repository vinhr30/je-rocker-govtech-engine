from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from ingestion.states.virginia.listings import DB_PATH, _extract_cards_from_html
from ingestion.states.virginia.normalize import normalize_records


VA_PAGE_MARKER = "mvendor.cgieva.com/Vendor/public/AllOpportunities.jsp"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
        pages = [
            page
            for context in browser.contexts
            for page in context.pages
            if VA_PAGE_MARKER in page.url
        ]
        if not pages:
            raise RuntimeError("No manually prepared VA page found. Open VA, click Open, scroll to the bottom, then rerun.")

        rows = _extract_cards_from_html(pages[-1].content())
        if not rows:
            raise RuntimeError("No VA listings found on the prepared page.")

        connection = sqlite3.connect(DB_PATH)
        connection.execute("DELETE FROM raw_listings")
        connection.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_listings'")
        connection.executemany(
            """
            INSERT INTO raw_listings (
                solicitation_number, title, agency, closing_date_raw, status,
                detail_url, raw_html, scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row.get("solicitation_number", ""),
                    row.get("title", ""),
                    row.get("agency", ""),
                    row.get("closing_date_raw", ""),
                    row.get("status", ""),
                    row.get("detail_url", ""),
                    json.dumps(row, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
                )
                for row in rows
            ],
        )
        connection.commit()
        connection.close()

    normalized = normalize_records(reset=True)
    print(f"Captured {len(rows)} VA listings and normalized {len(normalized)} without reopening detail pages.")


if __name__ == "__main__":
    main()from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from ingestion.states.virginia.listings import DB_PATH, _extract_cards_from_html
from ingestion.states.virginia.normalize import normalize_records


VA_PAGE_MARKER = "mvendor.cgieva.com/Vendor/public/AllOpportunities.jsp"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
        pages = [
            page
            for context in browser.contexts
            for page in context.pages
            if VA_PAGE_MARKER in page.url
        ]
        if not pages:
            raise RuntimeError(
                "No manually prepared VA page found. Open VA, click Open, scroll to the bottom, then rerun."
            )

        rows = _extract_cards_from_html(pages[-1].content())
        if not rows:
            raise RuntimeError("No VA listings found on the prepared page.")

        connection = sqlite3.connect(DB_PATH)
        connection.execute("DELETE FROM raw_listings")
        connection.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_listings'")
        connection.executemany(
            """
            INSERT INTO raw_listings (
                solicitation_number, title, agency, closing_date_raw, status,
                detail_url, raw_html, scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row.get("solicitation_number", ""),
                    row.get("title", ""),
                    row.get("agency", ""),
                    row.get("closing_date_raw", ""),
                    row.get("status", ""),
                    row.get("detail_url", ""),
                    json.dumps(row, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
                )
                for row in rows
            ],
        )
        connection.commit()
        connection.close()

    normalized = normalize_records(reset=True)
    print(f"Captured {len(rows)} VA listings and normalized {len(normalized)} without reopening detail pages.")


if __name__ == "__main__":
    main()