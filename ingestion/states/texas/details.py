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
DB_PATH = ROOT_DIR / "data" / "opportunities_TX.db"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def browser_headers() -> dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://www.txsmartbuy.gov/",
    }


def read_html(url: str, timeout: int = 30) -> str:
    request = Request(url, headers=browser_headers())
    with urlopen(request, timeout=timeout) as response:
        content = response.read()
    return content.decode("utf-8", errors="ignore")


def extract_label_value(soup: BeautifulSoup, label_texts: list[str]) -> str:
    text = soup.get_text(" ", strip=True)
    for label in label_texts:
        match = re.search(rf"{re.escape(label)}\s*[:\-]?\s*([^\n\r]+)", text, flags=re.I)
        if match:
            return clean_text(match.group(1))
    return ""


def extract_contact_info(soup: BeautifulSoup) -> dict:
    data = {"contact_name": None, "contact_email": None, "contact_phone": None}
    full_text = clean_text(soup.get_text(" ", strip=True))
    try:
        name_match = re.search(r"(?:Contact(?:\s+Name)?|Name)\s*[:\-]?\s*([A-Z][A-Za-z' .,-]+)", full_text, flags=re.I)
        if name_match:
            data["contact_name"] = name_match.group(1).strip()
        email_match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", full_text, flags=re.I)
        if email_match:
            data["contact_email"] = email_match.group(0).lower()
        phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", full_text)
        if phone_match:
            data["contact_phone"] = phone_match.group(0).strip()
    except Exception:
        pass
    return data


def extract_attachments(soup: BeautifulSoup, base_url: str) -> list[dict]:
    entries: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for anchor in soup.select("a[href]"):
        href = anchor.get("href") or ""
        if not href:
            continue
        lower = href.lower()
        if not any(token in lower for token in [".pdf", "download", "attachment", "document", "bid", "solicitation"]):
            continue
        url = urljoin(base_url, href)
        filename = clean_text(anchor.get_text(" ", strip=True)) or "Attachment"
        key = (url, filename)
        if key in seen:
            continue
        seen.add(key)
        entries.append({"url": url, "filename": filename})
    return entries


def extract_details_from_html(html: str, detail_url: str) -> dict:
    default = {
        "description_raw": None,
        "contact_name": None,
        "contact_email": None,
        "contact_phone": None,
        "bid_type": None,
        "start_date_raw": None,
        "end_date_raw": None,
        "location": None,
        "commodity_codes_raw": None,
        "attachments_raw": None,
    }
    if BeautifulSoup is None:
        return default

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return default

    description = None
    for selector in [".description", ".details", ".content", "#main-container", "main"]:
        node = soup.select_one(selector)
        if node:
            candidate = clean_text(node.get_text(" ", strip=True))
            if candidate:
                description = candidate[:4000]
                break
    if not description:
        description = clean_text(soup.get_text(" ", strip=True)[:4000])

    contact_info = extract_contact_info(soup)
    bid_type = extract_label_value(soup, ["Bid Type", "Solicitation Type", "Procurement Type", "Opportunity Type"])
    start_date_raw = extract_label_value(soup, ["Posted Date", "Issue Date", "Start Date", "Open Date"])
    end_date_raw = extract_label_value(soup, ["Due Date", "Close Date", "Deadline", "Response Date", "End Date"])
    location = extract_label_value(soup, ["Location", "Address", "Department", "Agency"])
    attachments = extract_attachments(soup, detail_url)

    return {
        "description_raw": description or None,
        "contact_name": contact_info.get("contact_name") or None,
        "contact_email": contact_info.get("contact_email") or None,
        "contact_phone": contact_info.get("contact_phone") or None,
        "bid_type": bid_type or None,
        "start_date_raw": start_date_raw or None,
        "end_date_raw": end_date_raw or None,
        "location": location or None,
        "commodity_codes_raw": None,
        "attachments_raw": json.dumps(attachments, ensure_ascii=False) if attachments else None,
    }


def hydrate_details(reset: bool = False) -> list[dict]:
    conn = db_connect()
    if reset:
        conn.execute("DELETE FROM raw_details")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_details'")
        conn.commit()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            detail_url TEXT,
            description_raw TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            bid_type TEXT,
            start_date_raw TEXT,
            end_date_raw TEXT,
            location TEXT,
            commodity_codes_raw TEXT,
            attachments_raw TEXT,
            raw_html TEXT,
            scraped_at TEXT
        )
        """
    )
    conn.commit()

    rows = conn.execute(
        "SELECT event_id, detail_url FROM raw_listings WHERE detail_url IS NOT NULL AND detail_url != '' ORDER BY id"
    ).fetchall()

    records: list[dict] = []
    for row in rows:
        detail_url = row["detail_url"]
        event_id = row["event_id"]
        try:
            html = read_html(detail_url)
            extracted = extract_details_from_html(html, detail_url)
        except Exception:
            continue

        payload = {
            "event_id": event_id,
            "detail_url": detail_url,
            "description_raw": extracted.get("description_raw"),
            "contact_name": extracted.get("contact_name"),
            "contact_email": extracted.get("contact_email"),
            "contact_phone": extracted.get("contact_phone"),
            "bid_type": extracted.get("bid_type"),
            "start_date_raw": extracted.get("start_date_raw"),
            "end_date_raw": extracted.get("end_date_raw"),
            "location": extracted.get("location"),
            "commodity_codes_raw": extracted.get("commodity_codes_raw"),
            "attachments_raw": extracted.get("attachments_raw"),
            "raw_html": html,
            "scraped_at": datetime.now(timezone.utc).isoformat(),
        }

        existing = conn.execute(
            "SELECT 1 FROM raw_details WHERE detail_url = ? LIMIT 1",
            (detail_url,),
        ).fetchone()
        if existing is None:
            conn.execute(
                """
                INSERT INTO raw_details (
                    event_id,
                    detail_url,
                    description_raw,
                    contact_name,
                    contact_email,
                    contact_phone,
                    bid_type,
                    start_date_raw,
                    end_date_raw,
                    location,
                    commodity_codes_raw,
                    attachments_raw,
                    raw_html,
                    scraped_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["event_id"],
                    payload["detail_url"],
                    payload["description_raw"],
                    payload["contact_name"],
                    payload["contact_email"],
                    payload["contact_phone"],
                    payload["bid_type"],
                    payload["start_date_raw"],
                    payload["end_date_raw"],
                    payload["location"],
                    payload["commodity_codes_raw"],
                    payload["attachments_raw"],
                    payload["raw_html"],
                    payload["scraped_at"],
                ),
            )
            conn.commit()
        records.append(payload)

    conn.close()
    return records


if __name__ == "__main__":
    hydrate_details()
