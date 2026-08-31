from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_VA.db"
BASE_URL = "https://mvendor.cgieva.com/Vendor/public/AllOpportunities.jsp"
ALLOWED_STATUSES = {"Open", "Bids Opened", "Contact Buyer"}
SKIP_STATUSES = {"Awarded", "Closed", "Intent Posted", "No Award", "Cancelled"}


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def browser_headers() -> dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }


def read_html(url: str, timeout: int = 30) -> str:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            page = browser.new_page(
                viewport={"width": 1440, "height": 1200},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            )

            response = page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            if response is not None and response.status >= 400:
                html = ""
            else:
                page.wait_for_timeout(3000)
                html = page.content()
            browser.close()
            if html and ("div.card.text-center" in html or "statustext" in html or "Virginia Business Opportunities" in html):
                return html
    except Exception:
        html = ""

    request = Request(url, headers=browser_headers())
    try:
        with urlopen(request, timeout=timeout) as response:
            content = response.read()
        html = content.decode("utf-8", errors="ignore")
    except Exception:
        html = ""

    return html


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _status_is_allowed(status: str | None) -> bool:
    value = clean_text(status).strip()
    if not value:
        return False
    return value in ALLOWED_STATUSES


def _status_is_skipped(status: str | None) -> bool:
    value = clean_text(status).strip()
    return value in SKIP_STATUSES


def _normalize_url(value: str | None, base_url: str = BASE_URL) -> str:
    if not value:
        return ""
    href = clean_text(value)
    if href.startswith("http://") or href.startswith("https://"):
        return href
    return urljoin(base_url, href)


def _build_detail_url(solicitation_number: str | None) -> str:
    text = clean_text(solicitation_number)
    if not text:
        return ""
    match = re.search(r"(\d+)(?:-(\d+))?", text)
    if not match:
        return ""
    lot_id = match.group(1)
    round_id = match.group(2) or "0"
    return f"https://mvendor.cgieva.com/Vendor/public/IVDetailsV2.jsp?rfp_id_lot={lot_id}&rfp_id_round={round_id}"


def _extract_status(raw: str | None) -> str:
    text = clean_text(raw)
    if not text:
        return ""
    for candidate in ["Open", "Bids Opened", "Contact Buyer", "Awarded", "Closed", "Intent Posted", "No Award", "Cancelled"]:
        if candidate.lower() in text.lower():
            return candidate
    return text


def _extract_cards_from_html(html: str) -> list[dict]:
    if BeautifulSoup is None:
        return []

    soup = BeautifulSoup(html, "html.parser")
    cards: list[dict] = []
    for card in soup.select("div.card.text-center"):
        title_node = card.select_one("h5.card-title") or card.select_one("h5") or card.select_one(".card-header h5")
        title = clean_text(title_node.get_text(" ", strip=True)) if title_node is not None else ""

        solicitation_node = card.select_one("h6.card-title") or card.select_one("h6")
        solicitation_number = clean_text(solicitation_node.get_text(" ", strip=True)) if solicitation_node is not None else ""

        status_node = card.select_one(".statustext") or card.select_one("span.statustext")
        status = clean_text(status_node.get_text(" ", strip=True)) if status_node is not None else ""
        if not status:
            status = _extract_status(clean_text(card.get_text(" ", strip=True)))

        agency_candidates = [
            clean_text(node.get_text(" ", strip=True))
            for node in card.select("p.card-text.text-muted")
        ]
        agency = next((value for value in agency_candidates if value and not value.startswith("Closing On:") and not value.startswith("Time Left:")), "")
        if not agency:
            agency = clean_text(card.select_one("p.card-text") or card.select_one("p"))

        full_text = clean_text(card.get_text(" ", strip=True))
        closing_match = re.search(r"Closing On:\s*([^\n]+)", full_text, flags=re.I)
        closing_date_raw = clean_text(closing_match.group(1)) if closing_match else ""

        detail_url = _build_detail_url(solicitation_number)
        if not detail_url:
            continue

        cards.append(
            {
                "solicitation_number": solicitation_number,
                "title": title,
                "agency": agency,
                "closing_date_raw": closing_date_raw,
                "status": status or "Open",
                "detail_url": detail_url,
                "raw_text": full_text,
            }
        )

    return cards


def _extract_rows_from_html(html: str) -> list[dict]:
    if BeautifulSoup is None:
        return []

    rows = _extract_cards_from_html(html)
    if rows:
        return rows

    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for table in soup.select("table"):
        for row in table.select("tr"):
            values = []
            for cell in row.select("td"):
                values.append(clean_text(cell.get_text(" ", strip=True)))
            if len(values) < 4:
                continue
            solicitation_number = values[0]
            title = values[1] if len(values) > 1 else ""
            agency = values[2] if len(values) > 2 else ""
            closing_date_raw = values[3] if len(values) > 3 else ""
            status = _extract_status(values[4] if len(values) > 4 else "")
            detail_url = _build_detail_url(solicitation_number)
            if not detail_url:
                continue
            rows.append(
                {
                    "solicitation_number": solicitation_number,
                    "title": title,
                    "agency": agency,
                    "closing_date_raw": closing_date_raw,
                    "status": status,
                    "detail_url": detail_url,
                }
            )
    return rows


def fetch_listing_pages(base_url: str = BASE_URL, max_pages: int = 999, reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            solicitation_number TEXT,
            title TEXT,
            agency TEXT,
            closing_date_raw TEXT,
            status TEXT,
            detail_url TEXT,
            raw_html TEXT,
            scraped_at TEXT
        )
        """
    )
    conn.commit()

    if reset:
        conn.execute("DELETE FROM raw_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_listings'")
        conn.commit()

    records: list[dict] = []
    seen_detail_urls: set[str] = set()

    for page_number in range(1, max_pages + 1):
        url = f"{base_url}?page={page_number}"
        try:
            html = read_html(url)
        except Exception:
            break

        page_rows = _extract_rows_from_html(html)
        if not page_rows:
            break

        filtered_rows = []
        for row in page_rows:
            detail_url = clean_text(row.get("detail_url"))
            if not detail_url:
                continue
            if detail_url in seen_detail_urls:
                continue
            seen_detail_urls.add(detail_url)
            filtered_rows.append(row)

        if not filtered_rows:
            break

        for row in filtered_rows:
            record = {
                "solicitation_number": clean_text(row.get("solicitation_number")),
                "title": clean_text(row.get("title")),
                "agency": clean_text(row.get("agency")),
                "closing_date_raw": clean_text(row.get("closing_date_raw")),
                "status": clean_text(row.get("status")),
                "detail_url": clean_text(row.get("detail_url")),
                "raw_html": json.dumps(row, ensure_ascii=False),
                "scraped_at": datetime.now(timezone.utc).isoformat(),
            }

            existing = conn.execute(
                "SELECT 1 FROM raw_listings WHERE detail_url = ? OR solicitation_number = ? LIMIT 1",
                (record["detail_url"], record["solicitation_number"]),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO raw_listings (
                        solicitation_number,
                        title,
                        agency,
                        closing_date_raw,
                        status,
                        detail_url,
                        raw_html,
                        scraped_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record["solicitation_number"],
                        record["title"],
                        record["agency"],
                        record["closing_date_raw"],
                        record["status"],
                        record["detail_url"],
                        record["raw_html"],
                        record["scraped_at"],
                    ),
                )
                conn.commit()
            records.append(record)

    conn.close()
    return records


if __name__ == "__main__":
    rows = fetch_listing_pages(reset=True)
    print(f"VA raw_listings={len(rows)}")
