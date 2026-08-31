from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_TX.db"
BASE_URL = "https://www.txsmartbuy.gov/esbd"
MAX_PAGES = 2500


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


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def absolute_url(base_url: str, href: str | None) -> str:
    if not href:
        return ""
    return urljoin(base_url, href)


def _extract_listing_rows(soup: Any) -> list[Any]:
    if soup is None:
        return []

    matches = soup.select("div.esbd-result-row")
    if matches:
        return matches

    candidates: list[Any] = []
    for selector in [
        "div.esbd-result-row",
        "article",
        "tr",
        "li",
        "div.result-item",
        ".result-item",
        ".solicitation-item",
    ]:
        candidates.extend(soup.select(selector))

    uniq: list[Any] = []
    seen: set[str] = set()
    for row in candidates:
        if row is None:
            continue
        key = row.get("id") or row.get("data-id") or clean_text(row.get_text(" ", strip=True))[:160]
        if not key:
            continue
        if key in seen:
            continue
        seen.add(key)
        uniq.append(row)
    return uniq


def _extract_detail_url(row: Any, base_url: str) -> str:
    title_link = row.select_one("div.esbd-result-title a[href]")
    if title_link is not None:
        href = title_link.get("href")
        if href:
            return absolute_url(base_url, href)

    for link in row.select("a[href]"):
        href = link.get("href")
        if href and ("/esbd/" in href or "/esbd" in href):
            return absolute_url(base_url, href)
    return ""


def row_to_listing(row: Any, base_url: str) -> dict | None:
    if row is None:
        return None
    try:
        detail_url = _extract_detail_url(row, base_url)
        if not detail_url:
            return None

        title_anchor = row.select_one("div.esbd-result-title a[href]")
        event_name = clean_text(title_anchor.get_text(" ", strip=True)) if title_anchor else ""
        if not event_name:
            event_name = clean_text(row.get_text(" ", strip=True)[:250])

        event_id = ""
        href = title_anchor.get("href") if title_anchor else ""
        if href:
            match = re.search(r"/esbd/([^/?#]+)", href, flags=re.I)
            if match:
                event_id = match.group(1)

        department = ""
        type_value = ""
        start_date_raw = ""
        end_date_raw = ""
        for p in row.select("p"):
            text = clean_text(p.get_text(" ", strip=True))
            if not text:
                continue
            if text.lower().startswith("solicitation id:"):
                event_id = clean_text(text.split(":", 1)[1]) if ":" in text else event_id
            elif text.lower().startswith("due date:"):
                end_date_raw = clean_text(text.split(":", 1)[1])
            elif text.lower().startswith("posting date:"):
                start_date_raw = clean_text(text.split(":", 1)[1])
            elif "agency" in text.lower() and "member number" in text.lower():
                department = clean_text(text.split(":", 1)[1]) if ":" in text else text

        if not event_id:
            match = re.search(r"Solicitation ID:\s*([^<]+)", row.decode_contents("utf-8", "ignore"), flags=re.I)
            if match:
                event_id = clean_text(match.group(1))

        if not event_id:
            event_id = re.sub(r"\s+", " ", event_name)[:120]

        return {
            "event_id": str(event_id),
            "event_name": event_name,
            "department": department,
            "type": type_value,
            "start_date_raw": start_date_raw,
            "end_date_raw": end_date_raw,
            "detail_url": detail_url,
            "scraped_at": datetime.now(timezone.utc).isoformat(),
            "raw_html": str(row),
        }
    except Exception:
        return None


def fetch_listing_pages(base_url: str = BASE_URL, max_pages: int = MAX_PAGES, reset: bool = False) -> list[dict]:
    conn = db_connect()
    if reset:
        conn.execute("DELETE FROM raw_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_listings'")
        conn.commit()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            event_name TEXT,
            department TEXT,
            type TEXT,
            start_date_raw TEXT,
            end_date_raw TEXT,
            detail_url TEXT,
            raw_html TEXT,
            scraped_at TEXT
        )
        """
    )
    conn.commit()

    records: list[dict] = []
    seen_urls: set[str] = set()

    for page_number in range(1, max_pages + 1):
        page_url = base_url if page_number == 1 else f"{base_url}?page={page_number}"
        try:
            html = read_html(page_url)
        except Exception:
            break

        if BeautifulSoup is None:
            break

        soup = BeautifulSoup(html, "html.parser")
        rows = _extract_listing_rows(soup)
        if not rows:
            break

        for row in rows:
            listing = row_to_listing(row, page_url)
            if listing is None:
                continue
            if not listing["detail_url"]:
                continue
            if listing["detail_url"] in seen_urls:
                continue
            seen_urls.add(listing["detail_url"])
            existing = conn.execute(
                "SELECT 1 FROM raw_listings WHERE detail_url = ? OR event_id = ? LIMIT 1",
                (listing["detail_url"], listing["event_id"]),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO raw_listings (
                        event_id,
                        event_name,
                        department,
                        type,
                        start_date_raw,
                        end_date_raw,
                        detail_url,
                        raw_html,
                        scraped_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        listing.get("event_id") or "",
                        listing.get("event_name") or "",
                        listing.get("department") or "",
                        listing.get("type") or "",
                        listing.get("start_date_raw") or "",
                        listing.get("end_date_raw") or "",
                        listing.get("detail_url") or "",
                        listing.get("raw_html") or "",
                        listing.get("scraped_at") or "",
                    ),
                )
                conn.commit()
            records.append(listing)

        if not rows:
            break

        # Stop once the page source clearly has no further results or the result list shrinks.
        if page_number >= 2 and len(rows) < 2:
            break

    conn.close()
    return records


scrape_listings = fetch_listing_pages


if __name__ == "__main__":
    fetch_listing_pages()
