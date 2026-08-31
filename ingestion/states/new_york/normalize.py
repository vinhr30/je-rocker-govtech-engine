from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

try:
    from dateutil import parser as date_parser
except ImportError:  # pragma: no cover
    date_parser = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_NY.db"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_name(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    return " ".join(part.title() for part in text.split())


def normalize_email(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, flags=re.I)
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


def normalize_date(value: str | None) -> str | None:
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


def normalize_categories(value: str | None) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    items = re.split(r"[,;/]+", text)
    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        cleaned = clean_text(item)
        if not cleaned:
            continue
        candidate = cleaned.strip("-")
        if not candidate:
            continue
        key = candidate.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(candidate)
    return normalized


def normalize_attachments(value: str | None, base_url: str | None = None) -> list[dict]:
    if value in (None, ""):
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = []

    if not isinstance(parsed, list):
        return []

    items: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in parsed:
        if not isinstance(item, dict):
            continue
        url = clean_text(item.get("url") or item.get("href") or "")
        filename = clean_text(item.get("filename") or item.get("name") or "Attachment")
        if not url:
            continue
        if not url.startswith(("http://", "https://")) and base_url:
            url = f"{base_url.rstrip('/')}/{url.lstrip('/')}"
        if not filename:
            filename = url.rsplit("/", 1)[-1] or "Attachment"
        key = (url, filename)
        if key in seen:
            continue
        seen.add(key)
        items.append({"url": url, "filename": filename})
    return items


def normalize_records(reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS normalized_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cr_number TEXT,
            title TEXT,
            agency TEXT,
            category TEXT,
            ad_type TEXT,
            issue_date TEXT,
            due_date TEXT,
            location TEXT,
            full_description TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            attachments TEXT,
            state TEXT,
            normalized_at TEXT
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_ny_normalized_url ON normalized_listings(cr_number)")
    conn.commit()

    if reset:
        conn.execute("DELETE FROM normalized_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'normalized_listings'")
        conn.commit()

    rows = conn.execute(
        """
        SELECT l.cr_number, l.title, l.agency, l.category, l.ad_type,
               l.issue_date_raw, l.due_date_raw, l.location,
               d.full_description, d.contact_name, d.contact_email, d.contact_phone,
               d.attachments_raw, d.detail_url
        FROM raw_listings l
        LEFT JOIN raw_details d ON d.detail_url = l.detail_url
        ORDER BY l.id
        """
    ).fetchall()

    records: list[dict] = []
    seen_cr_numbers: set[str] = set()

    for row in rows:
        cr_number = clean_text(row["cr_number"])
        if not cr_number or cr_number in seen_cr_numbers:
            continue
        seen_cr_numbers.add(cr_number)

        record = {
            "cr_number": cr_number,
            "title": clean_text(row["title"]),
            "agency": clean_text(row["agency"]),
            "category": ", ".join(normalize_categories(row["category"])),
            "ad_type": clean_text(row["ad_type"]),
            "issue_date": normalize_date(row["issue_date_raw"]),
            "due_date": normalize_date(row["due_date_raw"]),
            "location": clean_text(row["location"]),
            "full_description": clean_text(row["full_description"]),
            "contact_name": normalize_name(row["contact_name"]),
            "contact_email": normalize_email(row["contact_email"]),
            "contact_phone": normalize_phone(row["contact_phone"]),
            "attachments": json.dumps(normalize_attachments(row["attachments_raw"], base_url=row["detail_url"]), ensure_ascii=False),
            "state": "NY",
            "normalized_at": datetime.now(timezone.utc).isoformat(),
        }

        conn.execute(
            """
            INSERT INTO normalized_listings (
                cr_number,
                title,
                agency,
                category,
                ad_type,
                issue_date,
                due_date,
                location,
                full_description,
                contact_name,
                contact_email,
                contact_phone,
                attachments,
                state,
                normalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record["cr_number"],
                record["title"],
                record["agency"],
                record["category"],
                record["ad_type"],
                record["issue_date"],
                record["due_date"],
                record["location"],
                record["full_description"],
                record["contact_name"],
                record["contact_email"],
                record["contact_phone"],
                record["attachments"],
                record["state"],
                record["normalized_at"],
            ),
        )
        conn.commit()
        records.append(record)

    conn.close()
    return records


if __name__ == "__main__":
    rows = normalize_records(reset=True)
    print(f"NY normalized_listings={len(rows)}")
