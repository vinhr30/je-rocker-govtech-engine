from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    from dateutil import parser as date_parser
except ImportError:  # pragma: no cover
    date_parser = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_FL.db"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_date(value: str | None) -> str | None:
    if value is None:
        return None
    text = clean_text(value)
    if not text:
        return None
    if date_parser is not None:
        try:
            return date_parser.parse(text, fuzzy=True).strftime("%Y-%m-%d")
        except Exception:
            pass
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
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
    digits = re.sub(r"\D", "", match.group(0))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return match.group(0).strip()
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"


def normalize_attachments(value: str | None, *, base_url: str | None = None) -> list[dict]:
    if value in (None, ""):
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = []
    items: list[dict] = []
    if isinstance(parsed, list):
        candidates = parsed
    else:
        candidates = []

    for candidate in candidates:
        if isinstance(candidate, dict):
            url = clean_text(candidate.get("url") or candidate.get("href") or "")
            filename = clean_text(candidate.get("filename") or candidate.get("name") or "Attachment")
        elif isinstance(candidate, str):
            url = clean_text(candidate)
            filename = "Attachment"
        else:
            continue
        if not url:
            continue
        if not url.startswith(("http://", "https://")) and base_url:
            url = urljoin(base_url, url)
        if not filename:
            filename = urlparse(url).path.split("/")[-1] or "Attachment"
        items.append({"url": url, "filename": filename})

    deduped: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        key = (item.get("url", ""), item.get("filename", ""))
        if key not in seen:
            deduped.append(item)
            seen.add(key)
    return deduped


def normalize_records(reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS normalized_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            title TEXT,
            department TEXT,
            event_type TEXT,
            start_date TEXT,
            end_date TEXT,
            description TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            bid_type TEXT,
            location TEXT,
            commodity_codes TEXT,
            attachments TEXT,
            url TEXT,
            state TEXT,
            normalized_at TEXT
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_fl_normalized_url ON normalized_listings(url)")
    conn.commit()

    if reset:
        conn.execute("DELETE FROM normalized_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'normalized_listings'")
        conn.commit()

    rows = conn.execute(
        """
        SELECT l.event_id, l.event_name, l.department, l.type, l.start_date_raw, l.end_date_raw, l.detail_url,
               d.description_raw, d.contact_name, d.contact_email, d.contact_phone,
               d.bid_type, d.location, d.commodity_codes_raw, d.attachments_raw
        FROM raw_listings l
        LEFT JOIN raw_details d ON d.detail_url = l.detail_url
        ORDER BY l.id
        """
    ).fetchall()

    records: list[dict] = []
    seen_urls: set[str] = set()
    for row in rows:
        detail_url = row["detail_url"] or ""
        if not detail_url or detail_url in seen_urls:
            continue
        seen_urls.add(detail_url)

        payload = {
            "event_id": row["event_id"],
            "title": clean_text(row["event_name"]),
            "department": clean_text(row["department"]),
            "event_type": clean_text(row["type"]),
            "start_date": normalize_date(row["start_date_raw"]),
            "end_date": normalize_date(row["end_date_raw"]),
            "description": clean_text(row["description_raw"]),
            "contact_name": normalize_name(row["contact_name"]),
            "contact_email": normalize_email(row["contact_email"]),
            "contact_phone": normalize_phone(row["contact_phone"]),
            "bid_type": clean_text(row["bid_type"]),
            "location": clean_text(row["location"]),
            "commodity_codes": json.dumps([], ensure_ascii=False),
            "attachments": json.dumps(normalize_attachments(row["attachments_raw"], base_url=detail_url), ensure_ascii=False),
            "url": detail_url,
            "state": "Florida",
            "normalized_at": datetime.now(timezone.utc).isoformat(),
        }

        conn.execute(
            """
            INSERT INTO normalized_listings (
                event_id,
                title,
                department,
                event_type,
                start_date,
                end_date,
                description,
                contact_name,
                contact_email,
                contact_phone,
                bid_type,
                location,
                commodity_codes,
                attachments,
                url,
                state,
                normalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["event_id"],
                payload["title"],
                payload["department"],
                payload["event_type"],
                payload["start_date"],
                payload["end_date"],
                payload["description"],
                payload["contact_name"],
                payload["contact_email"],
                payload["contact_phone"],
                payload["bid_type"],
                payload["location"],
                payload["commodity_codes"],
                payload["attachments"],
                payload["url"],
                payload["state"],
                payload["normalized_at"],
            ),
        )
        records.append(payload)

    conn.commit()
    conn.close()
    return records
