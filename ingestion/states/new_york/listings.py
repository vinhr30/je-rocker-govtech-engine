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
DB_PATH = ROOT_DIR / "data" / "opportunities_NY.db"
BASE_URL = "https://www.nyscr.ny.gov/"
SEARCH_URL_TEMPLATE = "https://www.nyscr.ny.gov/Ads/Search?Skip={skip}&Top=25&Status=Open&DateFilter=All&Sort=-DateIssued"


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
    request = Request(url, headers=browser_headers())
    with urlopen(request, timeout=timeout) as response:
        content = response.read()
    return content.decode("utf-8", errors="ignore")


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def absolute_url(base_url: str, href: str | None) -> str:
    if not href:
        return ""
    return urljoin(base_url, href)


def extract_field_value(text: str, labels: list[str]) -> str:
    text = clean_text(text)
    if not text:
        return ""
    for label in labels:
        pattern = rf"{re.escape(label)}\s*[:\-]\s*(.*?)(?=\s*(?:CR#|Company:|Agency:|Division:|Issue date:|Ad end date:|Due date:|Location:|Category:|Ad type:|Title:|Log in|$))"
        match = re.search(pattern, text, flags=re.I | re.S)
        if match:
            value = clean_text(match.group(1))
            if value:
                return value
    return ""


def row_to_listing(title_node, base_url: str) -> dict | None:
    if title_node is None:
        return None

    title = clean_text(title_node.get("title") or title_node.get_text(" ", strip=True))
    title = re.sub(r"^\s*Full Title\s*:\s*", "", title, flags=re.I)
    if not title:
        return None

    block = None
    for ancestor in title_node.parents:
        if ancestor is None:
            continue
        text = clean_text(ancestor.get_text(" ", strip=True))
        if re.search(r"CR#\s*[:\-]", text, flags=re.I):
            block = ancestor
            break
    if block is None:
        return None
    block_text = clean_text(block.get_text(" ", strip=True))
    if not re.search(r"CR#\s*[:\-]", block_text, flags=re.I):
        return None

    cr_match = re.search(r"CR#\s*[:\-]\s*([^\s]+)", block_text, flags=re.I)
    cr_number = clean_text(cr_match.group(1)) if cr_match else ""
    agency = extract_field_value(block_text, ["Agency", "Company"])
    issue_date_raw = extract_field_value(block_text, ["Issue date"])
    due_date_raw = extract_field_value(block_text, ["Due date", "Ad end date"])
    location = extract_field_value(block_text, ["Location"])
    category = extract_field_value(block_text, ["Category"])
    ad_type = extract_field_value(block_text, ["Ad type"])

    detail_anchor = block.select_one("a[href]")
    if detail_anchor and detail_anchor.get("href") and "/Account/Login" not in detail_anchor.get("href", ""):
        detail_url = absolute_url(base_url, detail_anchor.get("href"))
    else:
        detail_url = f"{base_url.rstrip('/')}#cr-{cr_number}"

    if not cr_number:
        return None

    return {
        "cr_number": cr_number,
        "title": title,
        "agency": agency,
        "category": category,
        "ad_type": ad_type,
        "issue_date_raw": issue_date_raw,
        "due_date_raw": due_date_raw,
        "location": location,
        "detail_url": detail_url,
        "raw_html": str(block),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def extract_listing_rows(html: str, base_url: str = BASE_URL) -> list[dict]:
    if BeautifulSoup is None:
        return []

    soup = BeautifulSoup(html, "html.parser")
    rows: list[dict] = []
    seen_keys: set[tuple[str, str, str]] = set()

    for title_node in soup.select('div[title*="Full Title:"]'):
        listing = row_to_listing(title_node, base_url)
        if listing is None:
            continue
        key = (clean_text(listing.get("cr_number")), clean_text(listing.get("title")), clean_text(listing.get("detail_url")))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        rows.append(listing)

    return rows


def fetch_listing_pages(base_url: str = BASE_URL, max_pages: int = 2000, reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cr_number TEXT,
            title TEXT,
            agency TEXT,
            category TEXT,
            ad_type TEXT,
            issue_date_raw TEXT,
            due_date_raw TEXT,
            location TEXT,
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
        skip = (page_number - 1) * 25
        url = SEARCH_URL_TEMPLATE.format(skip=skip)
        try:
            html = read_html(url)
        except Exception:
            break

        page_rows = extract_listing_rows(html, base_url)
        if not page_rows:
            break

        for row in page_rows:
            detail_url = clean_text(row.get("detail_url"))
            if detail_url in seen_detail_urls:
                continue
            seen_detail_urls.add(detail_url)

            record = {
                "cr_number": clean_text(row.get("cr_number")),
                "title": clean_text(row.get("title")),
                "agency": clean_text(row.get("agency")),
                "category": clean_text(row.get("category")),
                "ad_type": clean_text(row.get("ad_type")),
                "issue_date_raw": clean_text(row.get("issue_date_raw")),
                "due_date_raw": clean_text(row.get("due_date_raw")),
                "location": clean_text(row.get("location")),
                "detail_url": detail_url,
                "raw_html": row.get("raw_html") or json.dumps(row, ensure_ascii=False),
                "scraped_at": row.get("scraped_at") or datetime.now(timezone.utc).isoformat(),
            }

            conn.execute(
                """
                INSERT INTO raw_listings (
                    cr_number,
                    title,
                    agency,
                    category,
                    ad_type,
                    issue_date_raw,
                    due_date_raw,
                    location,
                    detail_url,
                    raw_html,
                    scraped_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["cr_number"],
                    record["title"],
                    record["agency"],
                    record["category"],
                    record["ad_type"],
                    record["issue_date_raw"],
                    record["due_date_raw"],
                    record["location"],
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
    print(f"NY raw_listings={len(rows)}")
