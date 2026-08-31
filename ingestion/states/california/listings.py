from __future__ import annotations

import sqlite3
import re
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
DB_PATH = ROOT_DIR / "data" / "opportunities_CA.db"
BASE_URL = "https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def browser_headers() -> dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Referer": "https://caleprocure.ca.gov/pages/",
    }


def read_html(url: str, timeout: int = 30) -> str:
    request = Request(url, headers=browser_headers())
    with urlopen(request, timeout=timeout) as response:
        content = response.read()
    return content.decode("utf-8", errors="ignore")


def browser_render_html(url: str, timeout: int = 60) -> str:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:  # pragma: no cover
        return ""

    headers = browser_headers()
    browser = None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=headers["User-Agent"],
                viewport={"width": 1440, "height": 1200},
                locale="en-US",
                timezone_id="America/Los_Angeles",
            )
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            try:
                page.wait_for_selector("tr[id^='trRESP_'], tr[data-if-label^='tblBodyTr']", timeout=30000)
            except Exception:
                pass
            page.wait_for_timeout(1500)
            return page.content()
    except Exception:  # pragma: no cover
        return ""
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def absolute_url(base_url: str, href: str | None) -> str:
    if not href:
        return ""
    return urljoin(base_url, href)


def row_to_listing(row: Any, base_url: str) -> dict | None:
    if row is None:
        return None
    try:
        cells = row.find_all("td")
        if len(cells) < 2:
            return None

        event_id = ""
        event_name = ""
        department = ""
        event_type = ""
        start_date_raw = ""
        end_date_raw = ""

        for cell in cells:
            label = clean_text(cell.get("data-if-label") or cell.get("data-if-content") or "")
            text = clean_text(cell.get_text(" ", strip=True))
            if not text and label.startswith("td"):
                continue
            if label == "tdEventId":
                event_id = text
            elif label == "tdEventName":
                event_name = text
            elif label == "tdDepName":
                department = text
            elif label == "tdEventType":
                event_type = text
            elif label == "tdStartDate":
                start_date_raw = text
            elif label == "tdEndDate":
                end_date_raw = text

        if not event_id:
            for cell in cells:
                text = clean_text(cell.get_text(" ", strip=True))
                if text and re.fullmatch(r"\d+[A-Za-z0-9-]*", text):
                    event_id = text
                    break

        if not event_id:
            event_id = clean_text(row.get("data-id") or row.get("id") or "")
            if event_id and event_id.startswith("trRESP_"):
                event_id = ""

        if not event_id:
            return None

        if not event_name:
            event_name = clean_text(cells[1].get_text(" ", strip=True)) if len(cells) >= 2 else ""
        if not department and len(cells) >= 3:
            department = clean_text(cells[2].get_text(" ", strip=True))
        if not end_date_raw and len(cells) >= 4:
            end_date_raw = clean_text(cells[3].get_text(" ", strip=True))

        detail_anchor = row.select_one("a[href*='event-details.aspx']")
        if detail_anchor is None:
            detail_anchor = row.select_one("a[href*='event-details']")
        href = detail_anchor.get("href") if detail_anchor else ""
        detail_url = absolute_url(base_url, href)

        if not detail_url and event_id:
            event_id_digits = re.sub(r"\D+", "", event_id)
            if event_id_digits:
                detail_url = "https://caleprocure.ca.gov/pages/ps-relay.aspx?nlxTarget=AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL&Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=" + event_id.split("-")[0] if "-" in event_id else "https://caleprocure.ca.gov/pages/ps-relay.aspx?nlxTarget=AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL&Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=&AUC_ID=" + event_id_digits
                if "-" in event_id:
                    business_unit, auc_id = event_id.split("-", 1)
                    detail_url = (
                        "https://caleprocure.ca.gov/pages/ps-relay.aspx?nlxTarget=AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL&"
                        "Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=" + business_unit + "&AUC_ID=" + auc_id
                    )
                else:
                    detail_url = (
                        "https://caleprocure.ca.gov/pages/ps-relay.aspx?nlxTarget=AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL&"
                        "Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=&AUC_ID=" + event_id_digits
                    )

        if not detail_url:
            return None

        return {
            "event_id": str(event_id),
            "event_name": event_name,
            "department": department,
            "type": event_type,
            "start_date_raw": start_date_raw,
            "end_date_raw": end_date_raw,
            "detail_url": detail_url,
            "scraped_at": datetime.now(timezone.utc).isoformat(),
            "raw_html": str(row),
        }
    except Exception:
        return None


def _extract_listing_rows(soup: Any) -> list[Any]:
    if soup is None:
        return []

    table = soup.select_one("table#eventSearchResults")
    rows: list[Any] = []

    if table is not None:
        rows.extend(table.select("tr[data-if-label='tblBodyTr']"))
        rows.extend(table.select("tr[id^='trRESP_']"))
        rows.extend(table.select("tr[data-id]"))

    rows.extend(soup.select("tr[data-if-label='tblBodyTr']"))
    rows.extend(soup.select("tr[id^='trRESP_']"))
    rows.extend(soup.select("tr[data-id]"))

    for tag in soup.select("[role='row']"):
        if tag.name == "tr" or tag.name == "div":
            rows.append(tag)

    unique_rows: list[Any] = []
    seen: set[str] = set()
    for row in rows:
        if row is None:
            continue
        marker = (
            row.get("id")
            or row.get("data-if-label")
            or row.get("data-id")
            or clean_text(row.get_text(" ", strip=True))[:120]
        )
        if not marker:
            continue
        if marker in seen:
            continue
        seen.add(marker)
        unique_rows.append(row)
    return unique_rows


def fetch_listing_pages() -> list[dict]:
    conn = db_connect()
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

    html = read_html(BASE_URL)
    if BeautifulSoup is None:
        conn.close()
        return []

    soup = BeautifulSoup(html, "html.parser")
    rows = _extract_listing_rows(soup)
    if not rows:
        rendered_html = browser_render_html(BASE_URL)
        if rendered_html:
            soup = BeautifulSoup(rendered_html, "html.parser")
            rows = _extract_listing_rows(soup)

    records: list[dict] = []
    for row in rows:
        listing = row_to_listing(row, BASE_URL)
        if listing is None:
            continue
        if not listing["detail_url"]:
            continue
        existing = conn.execute(
            "SELECT 1 FROM raw_listings WHERE detail_url = ? OR event_id = ? LIMIT 1",
            (listing["detail_url"], listing.get("event_id") or ""),
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

    conn.close()
    return records


if __name__ == "__main__":
    fetch_listing_pages()
