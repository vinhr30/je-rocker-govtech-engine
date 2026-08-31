from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_CA.db"


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


def extract_label_value(table, label_text: str) -> str:
    if table is None:
        return ""
    try:
        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            key = clean_text(cells[0].get_text(" ", strip=True)).lower()
            val = clean_text(cells[1].get_text(" ", strip=True))
            if label_text.lower() in key:
                return val
    except Exception:
        pass
    return ""


def normalize_date(value: str | None) -> str | None:
    if value is None:
        return None
    text = clean_text(value)
    if not text:
        return None
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    try:
        from dateutil import parser as date_parser
        return date_parser.parse(text, fuzzy=True).strftime("%Y-%m-%d")
    except Exception:
        return text


def normalize_name(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    return " ".join(part.title() for part in text.split())


def normalize_email(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"\S+@\S+", text)
    return match.group(0).lower() if match else None


def normalize_phone(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)
    if not match:
        return None
    cleaned = re.sub(r"\D", "", match.group(0))
    if len(cleaned) == 11 and cleaned.startswith("1"):
        cleaned = cleaned[1:]
    if len(cleaned) != 10:
        return match.group(0).strip()
    return f"({cleaned[:3]}) {cleaned[3:6]}-{cleaned[6:]}"


def extract_contact_info(soup: BeautifulSoup) -> dict:
    data = {"contact_name": None, "contact_email": None, "contact_phone": None}
    try:
        for selector in ["#contactInfo", "#contact-information", ".contact-info", "#contactSection", ".contact-section"]:
            node = soup.select_one(selector)
            if node is None:
                continue
            text = clean_text(node.get_text(" ", strip=True))
            if text:
                name_match = re.search(r"(?:Contact|Name)\s*[:\-]?\s*([A-Z][A-Za-z' .-]+)", text, flags=re.I)
                if name_match:
                    data["contact_name"] = normalize_name(name_match.group(1))
                email_match = re.search(r"\S+@\S+", text)
                if email_match:
                    data["contact_email"] = normalize_email(email_match.group(0))
                phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)
                if phone_match:
                    data["contact_phone"] = normalize_phone(phone_match.group(0))
                break
    except Exception:
        pass
    return data


def extract_attachment_entries(soup: BeautifulSoup, base_url: str) -> list[dict]:
    entries: list[dict] = []
    try:
        for button in soup.select("button#viewEventPackage, a[href*='.pdf'], a[href*='download']"):
            href = button.get("href") or ""
            onclick = button.get("onclick") or ""
            if not href and onclick:
                match = re.search(r"window\.open\(['\"]([^'\"]+)['\"]", onclick, flags=re.I)
                if match:
                    href = match.group(1)
            if not href:
                continue
            url = urljoin(base_url, href)
            filename = "Event Package"
            if url.lower().endswith(".pdf"):
                filename = "Event Package.pdf"
            entries.append({"url": url, "filename": filename})
    except Exception:
        return []
    return entries


def extract_commodity_codes(soup: BeautifulSoup) -> list[str]:
    values: list[str] = []
    try:
        selectors = ["#unspsc", "#commodityCodes", "#commodity-code", "#commodityCodesSection", ".commodity-codes", ".unspsc"]
        for selector in selectors:
            node = soup.select_one(selector)
            if node is None:
                continue
            text = clean_text(node.get_text(" ", strip=True))
            if text:
                parts = re.split(r"[,;\n]+", text)
                for part in parts:
                    item = clean_text(part)
                    if item and item not in values:
                        values.append(item)
                if values:
                    return values
    except Exception:
        return []
    return values


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
    for selector in ["#eventDescription", "#event-description", ".event-description", ".description"]:
        try:
            node = soup.select_one(selector)
            if node:
                description = clean_text(node.get_text(" ", strip=True))
                break
        except Exception:
            continue
    if not description:
        description = clean_text(soup.get_text(" ", strip=True)[:4000])

    contact_info = extract_contact_info(soup)

    try:
        table = soup.select_one("table")
        bid_type = extract_label_value(table, "Bid Type")
        start_date_raw = extract_label_value(table, "Start Date") or extract_label_value(table, "Event Start")
        end_date_raw = extract_label_value(table, "End Date") or extract_label_value(table, "Event End")
        location = extract_label_value(table, "Location") or extract_label_value(table, "Address")
    except Exception:
        bid_type = None
        start_date_raw = None
        end_date_raw = None
        location = None

    commodity_values = extract_commodity_codes(soup)
    commodity_codes_raw = json.dumps(commodity_values, ensure_ascii=False) if commodity_values else None

    attachments = extract_attachment_entries(soup, detail_url)
    attachments_raw = json.dumps(attachments, ensure_ascii=False) if attachments else None

    return {
        "description_raw": description or None,
        "contact_name": contact_info.get("contact_name") or None,
        "contact_email": contact_info.get("contact_email") or None,
        "contact_phone": contact_info.get("contact_phone") or None,
        "bid_type": bid_type or None,
        "start_date_raw": start_date_raw or None,
        "end_date_raw": end_date_raw or None,
        "location": location or None,
        "commodity_codes_raw": commodity_codes_raw,
        "attachments_raw": attachments_raw,
    }


def hydrate_details() -> list[dict]:
    conn = db_connect()
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
