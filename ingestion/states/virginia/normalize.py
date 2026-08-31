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
DB_PATH = ROOT_DIR / "data" / "opportunities_VA.db"


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
    match = re.search(r"\S+@\S+", text, flags=re.I)
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


def _normalize_commodity_codes(value: str | None) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    tokens = re.split(r"[,;/]+", text)
    cleaned = []
    for token in tokens:
        item = clean_text(token).replace("-", "")
        if not item:
            continue
        item = re.sub(r"[^A-Za-z0-9]", "", item)
        if item:
            cleaned.append(item)
    seen: set[str] = set()
    output: list[str] = []
    for item in cleaned:
        if item.upper() in seen:
            continue
        seen.add(item.upper())
        output.append(item.upper())
    return output


def normalize_attachments(value: str | None, base_url: str | None = None) -> list[dict]:
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
        parsed_name = filename or urlparse(url).path.rsplit("/", 1)[-1] or "Attachment"
        items.append({"url": url, "filename": parsed_name})

    deduped: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        key = (item.get("url", ""), item.get("filename", ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def normalize_records(reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS normalized_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            solicitation_number TEXT,
            title TEXT,
            agency TEXT,
            opening_date TEXT,
            closing_date TEXT,
            description TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            commodity_codes TEXT,
            attachments TEXT,
            url TEXT,
            state TEXT,
            normalized_at TEXT
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_va_normalized_url ON normalized_listings(url)")
    conn.commit()

    if reset:
        conn.execute("DELETE FROM normalized_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'normalized_listings'")
        conn.commit()

    rows = conn.execute(
        """
        SELECT l.solicitation_number, l.title, l.agency, l.closing_date_raw, l.detail_url,
               d.full_description, d.contact_name, d.contact_email, d.contact_phone,
               d.opening_date_raw, d.closing_date_raw AS detail_closing_date, d.commodity_codes, d.attachments_raw
        FROM raw_listings l
        LEFT JOIN raw_details d ON d.detail_url = l.detail_url
        ORDER BY l.id
        """
    ).fetchall()

    records: list[dict] = []
    seen_urls: set[str] = set()
    for row in rows:
        url = clean_text(row["detail_url"])
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)

        description = clean_text(row["full_description"])
        contact_name = normalize_name(row["contact_name"])
        contact_email = normalize_email(row["contact_email"])
        contact_phone = normalize_phone(row["contact_phone"])
        opening_date = normalize_date(row["opening_date_raw"])
        closing_date = normalize_date(row["detail_closing_date"]) or normalize_date(row["closing_date_raw"])
        commodity_codes = json.dumps(_normalize_commodity_codes(row["commodity_codes"]), ensure_ascii=False)
        attachments = json.dumps(normalize_attachments(row["attachments_raw"], base_url=url), ensure_ascii=False)

        payload = {
            "solicitation_number": clean_text(row["solicitation_number"]),
            "title": clean_text(row["title"]),
            "agency": clean_text(row["agency"]),
            "opening_date": opening_date,
            "closing_date": closing_date,
            "description": description,
            "contact_name": contact_name,
            "contact_email": contact_email,
            "contact_phone": contact_phone,
            "commodity_codes": commodity_codes,
            "attachments": attachments,
            "url": url,
            "state": "VA",
            "normalized_at": datetime.now(timezone.utc).isoformat(),
        }

        conn.execute(
            """
            INSERT INTO normalized_listings (
                solicitation_number,
                title,
                agency,
                opening_date,
                closing_date,
                description,
                contact_name,
                contact_email,
                contact_phone,
                commodity_codes,
                attachments,
                url,
                state,
                normalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["solicitation_number"],
                payload["title"],
                payload["agency"],
                payload["opening_date"],
                payload["closing_date"],
                payload["description"],
                payload["contact_name"],
                payload["contact_email"],
                payload["contact_phone"],
                payload["commodity_codes"],
                payload["attachments"],
                payload["url"],
                payload["state"],
                payload["normalized_at"],
            ),
        )
        conn.commit()
        records.append(payload)

    conn.close()
    return records


if __name__ == "__main__":
    rows = normalize_records(reset=True)
    print(f"VA normalized_listings={len(rows)}")
