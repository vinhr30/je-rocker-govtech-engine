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
DB_PATH = ROOT_DIR / "data" / "opportunities_AZ.db"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def clean_text(value: str | None) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def ensure_columns(conn: sqlite3.Connection, table_name: str, columns: list[str]) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}
    for column_sql in columns:
        name = column_sql.split()[0]
        if name not in existing:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}")


def parse_date(value: str | None) -> str:
    if value is None:
        return ""
    text = clean_text(value)
    if not text:
        return ""

    for candidate in (text, text.replace("T", " ")):
        if date_parser is not None:
            try:
                return date_parser.parse(candidate, fuzzy=True).strftime("%Y-%m-%d")
            except Exception:
                pass
        for fmt in (
            "%m/%d/%Y %I:%M:%S %p",
            "%m/%d/%Y %H:%M:%S",
            "%m/%d/%Y",
            "%m/%d/%y",
            "%Y-%m-%d",
            "%b %d, %Y",
            "%B %d, %Y",
            "%m-%d-%Y",
        ):
            try:
                return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    return text


def normalize_email(value: str | None) -> str:
    text = clean_text(value)
    if not text:
        return ""
    match = re.search(r"\S+@\S+", text)
    if not match:
        return ""
    return match.group(0).strip().lower()


def normalize_phone(value: str | None) -> str:
    text = clean_text(value)
    if not text:
        return ""
    digits = re.sub(r"\D", "", text)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if not digits:
        return ""
    return text


def normalize_name(value: str | None) -> str:
    text = clean_text(value)
    if not text:
        return ""
    fragments = [part.strip() for part in re.split(r"\s+", text) if part.strip()]
    cleaned = []
    for fragment in fragments:
        if len(fragment) <= 1:
            cleaned.append(fragment.upper() if fragment.isalpha() else fragment)
        else:
            cleaned.append(fragment.title())
    return " ".join(cleaned)[:200]


def parse_json_list(value: str | None) -> list[str]:
    if value in (None, ""):
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = []
    if isinstance(parsed, list):
        items = []
        for item in parsed:
            text = clean_text(str(item))
            if text:
                items.append(text)
        return items
    if isinstance(parsed, str):
        return [clean_text(parsed)] if clean_text(parsed) else []
    return []


def normalize_json_array(value: str | None, *, base_url: str | None = None) -> str:
    items = []
    if value in (None, ""):
        return "[]"
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = []
    if isinstance(parsed, list):
        candidates = parsed
    elif isinstance(parsed, str):
        candidates = [{"url": parsed, "filename": ""}]
    else:
        candidates = []

    for candidate in candidates:
        if isinstance(candidate, dict):
            url = clean_text(candidate.get("url") or candidate.get("href") or "")
            filename = clean_text(candidate.get("filename") or candidate.get("name") or "")
        elif isinstance(candidate, str):
            url = clean_text(candidate)
            filename = ""
        else:
            continue
        if not url:
            continue
        if not url.startswith(("http://", "https://")) and base_url:
            url = urljoin(base_url, url)
        if not filename:
            filename = urlparse(url).path.split("/")[-1] or "attachment"
        items.append({"url": url, "filename": filename})
    deduped: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for entry in items:
        key = (entry.get("url", ""), entry.get("filename", ""))
        if key not in seen:
            deduped.append(entry)
            seen.add(key)
    return json.dumps(deduped, ensure_ascii=False)


def normalize_commodity_codes(value: str | None) -> str:
    items = []
    if value in (None, ""):
        return "[]"
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            items = parsed
        else:
            parsed = []
    except (TypeError, ValueError):
        parsed = []
    if not parsed:
        text = clean_text(value)
        if text:
            items = [part.strip() for part in re.split(r"[,\n]+", text) if part.strip()]
    clean_items: list[str] = []
    for item in items:
        text = clean_text(str(item))
        if text and text not in clean_items:
            clean_items.append(text)
    return json.dumps(clean_items, ensure_ascii=False)


def normalize_addenda(value: str | None) -> str:
    if value in (None, ""):
        return "[]"
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = []
    if not isinstance(parsed, list):
        parsed = []
    normalized: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        title = clean_text(item.get("title") or item.get("name") or "")
        date_value = clean_text(item.get("date") or item.get("posted_date") or "")
        entry = {"title": title, "date": parse_date(date_value) if date_value else None}
        if entry["title"]:
            normalized.append(entry)
    return json.dumps(normalized, ensure_ascii=False)


def normalize_metadata(value: str | None) -> str:
    if value in (None, ""):
        parsed = {}
    else:
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    additional_dates = parsed.get("additional_dates") or []
    normalized_dates = []
    for item in additional_dates:
        date_value = parse_date(item)
        if date_value:
            normalized_dates.append(date_value)
    parsed["additional_dates"] = normalized_dates
    parsed["posted_date"] = parse_date(parsed.get("posted_date")) or parsed.get("posted_date")
    parsed["due_date"] = parse_date(parsed.get("due_date")) or parsed.get("due_date")
    return json.dumps(parsed, ensure_ascii=False)


def normalize_contact(value: str | None) -> tuple[str, str, str]:
    text = clean_text(value)
    if not text:
        return "", "", ""
    email = normalize_email(value)
    phone = normalize_phone(re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text).group(0) if re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text) else "")
    name = ""
    match = re.search(r"(?:Name|Contact(?: Name)?|Primary Contact|Contact Person)\s*[:\-]?\s*([A-Z][A-Za-zÀ-ÿ'.,\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'.,\-]+){0,5})\s*(?:Email|E-mail)?\s*:", text, flags=re.I)
    if match:
        name = normalize_name(match.group(1))
    else:
        email_match = re.search(r"([A-Z][A-Za-zÀ-ÿ'.,\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'.,\-]+){0,5})\s*Email\s*:", text, flags=re.I)
        if email_match:
            name = normalize_name(email_match.group(1))
    return name, email, phone


def dedupe_normalized_records(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        DELETE FROM normalized_listings
        WHERE url IS NOT NULL AND url != ''
          AND rowid NOT IN (
              SELECT MIN(rowid)
              FROM normalized_listings
              WHERE url IS NOT NULL AND url != ''
              GROUP BY url
          )
        """
    )
    conn.commit()


def remove_expired_records(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, due_date FROM normalized_listings WHERE due_date IS NOT NULL AND TRIM(due_date) != ''"
    ).fetchall()
    expired_ids = []
    for row in rows:
        if is_expired_due_date(row["due_date"]):
            expired_ids.append(row["id"])
    if expired_ids:
        placeholders = ", ".join("?" for _ in expired_ids)
        conn.execute(f"DELETE FROM normalized_listings WHERE id IN ({placeholders})", expired_ids)
    conn.commit()


def is_open_for_bidding(value: str | None) -> bool:
    return bool(re.search(r"open for bidding", clean_text(value), flags=re.I))


def is_expired_due_date(value: str | None) -> bool:
    text = clean_text(value)
    if not text:
        return False
    parsed = parse_date(text)
    if not parsed or not re.match(r"^\d{4}-\d{2}-\d{2}$", str(parsed)):
        return False
    try:
        due_date = datetime.strptime(parsed, "%Y-%m-%d").date()
        return due_date <= datetime.now(timezone.utc).date()
    except ValueError:
        return False


def is_active_listing(due_date: str | None, status: str | None) -> bool:
    if is_open_for_bidding(status):
        return True
    if not due_date:
        return False
    return not is_expired_due_date(due_date)


def normalize_records(reset: bool = False) -> list[dict]:
    conn = db_connect()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS normalized_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            solicitation_id TEXT,
            title TEXT,
            agency TEXT,
            posted_date TEXT,
            due_date TEXT,
            description TEXT,
            category TEXT,
            url TEXT,
            attachments TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            commodity_codes TEXT,
            addenda TEXT,
            metadata_json TEXT,
            state TEXT,
            normalized_at TEXT
        )
        """
    )
    conn.commit()

    if reset:
        conn.execute("DELETE FROM normalized_listings")
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'"
        ).fetchone() is not None:
            conn.execute("DELETE FROM sqlite_sequence WHERE name = 'normalized_listings'")
        conn.commit()
    ensure_columns(
        conn,
        "normalized_listings",
        ["contact_phone TEXT", "metadata_json TEXT", "state TEXT"],
    )
    conn.execute("UPDATE normalized_listings SET state = 'Arizona' WHERE state IS NULL OR TRIM(state) = ''")
    conn.commit()

    if reset:
        conn.execute("DELETE FROM normalized_listings")
        conn.commit()
    else:
        dedupe_normalized_records(conn)
        remove_expired_records(conn)

    ensure_columns(
        conn,
        "raw_listings",
        ["status TEXT"],
    )
    conn.commit()

    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_normalized_listings_url ON normalized_listings(url)"
    )
    conn.commit()

    existing_urls = {
        row["url"]
        for row in conn.execute(
            "SELECT url FROM normalized_listings WHERE url IS NOT NULL AND url != ''"
        ).fetchall()
    }

    raw_details_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='raw_details'"
    ).fetchone() is not None

    if raw_details_exists:
        rows = conn.execute(
            """
            SELECT l.solicitation_id, l.title, l.agency,
                   l.status AS status, l.posted_date_raw, l.due_date_raw,
                   l.detail_url, l.category,
                   d.description_raw, d.summary_raw, d.contact_raw,
                   d.contact_name, d.contact_email, d.contact_phone,
                   d.posted_date, d.due_date, d.metadata_json,
                   d.attachments_raw, d.commodity_codes_raw, d.addenda_raw
            FROM raw_listings l
            LEFT JOIN raw_details d ON d.detail_url = l.detail_url
            ORDER BY l.id
            """
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT l.solicitation_id, l.title, l.agency,
                   l.status AS status, l.posted_date_raw, l.due_date_raw,
                   l.detail_url, l.category,
                   NULL AS description_raw, NULL AS summary_raw, NULL AS contact_raw,
                   NULL AS contact_name, NULL AS contact_email, NULL AS contact_phone,
                   NULL AS posted_date, NULL AS due_date, NULL AS metadata_json,
                   NULL AS attachments_raw, NULL AS commodity_codes_raw, NULL AS addenda_raw
            FROM raw_listings l
            ORDER BY l.id
            """
        ).fetchall()

    records: list[dict] = []
    for row in rows:
        detail_url = row["detail_url"]
        status = row["status"]
        raw_title = clean_text(row["title"] or "")
        description = clean_text(row["description_raw"] or row["summary_raw"] or raw_title)
        posted_date = parse_date(row["posted_date"] or row["posted_date_raw"])
        due_date = parse_date(row["due_date"] or row["due_date_raw"])

        if not is_active_listing(due_date, status):
            if detail_url:
                conn.execute("DELETE FROM normalized_listings WHERE url = ?", (detail_url,))
                conn.commit()
            continue

        is_new_url = detail_url not in existing_urls
        contact_name, contact_email, contact_phone = normalize_contact(row["contact_raw"] or row["contact_name"])
        if not contact_name:
            contact_name = normalize_name(row["contact_name"])
        if not contact_email:
            contact_email = normalize_email(row["contact_email"])
        if not contact_phone:
            contact_phone = normalize_phone(row["contact_phone"])

        metadata_source = {
            "status": status or "",
            "source_status": status or "",
            "posted_date_raw": row["posted_date_raw"] or row["posted_date"] or "",
            "due_date_raw": row["due_date_raw"] or row["due_date"] or "",
            "raw_title": raw_title,
            "raw_agency": clean_text(row["agency"] or ""),
            "raw_category": clean_text(row["category"] or ""),
            "detail_url": detail_url or "",
        }
        metadata_json = normalize_metadata(row["metadata_json"])
        try:
            metadata_dict = json.loads(metadata_json)
        except (TypeError, ValueError):
            metadata_dict = {}
        if not isinstance(metadata_dict, dict):
            metadata_dict = {}
        metadata_dict.update({key: value for key, value in metadata_source.items() if value not in (None, "")})
        metadata_json = json.dumps(metadata_dict, ensure_ascii=False)
        attachments = normalize_json_array(row["attachments_raw"], base_url=row["detail_url"])
        commodity_codes = normalize_commodity_codes(row["commodity_codes_raw"])
        addenda = normalize_addenda(row["addenda_raw"])

        payload = {
            "solicitation_id": row["solicitation_id"],
            "title": row["title"],
            "agency": row["agency"],
            "posted_date": posted_date,
            "due_date": due_date,
            "description": description,
            "category": row["category"],
            "url": detail_url,
            "attachments": attachments,
            "contact_name": contact_name,
            "contact_email": contact_email,
            "contact_phone": contact_phone,
            "commodity_codes": commodity_codes,
            "addenda": addenda,
            "metadata_json": metadata_json,
            "state": "Arizona",
            "normalized_at": datetime.utcnow().isoformat(),
        }

        conn.execute(
            """
            INSERT INTO normalized_listings (
                solicitation_id,
                title,
                agency,
                posted_date,
                due_date,
                description,
                category,
                url,
                attachments,
                contact_name,
                contact_email,
                contact_phone,
                commodity_codes,
                addenda,
                metadata_json,
                state,
                normalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
                solicitation_id = excluded.solicitation_id,
                title = excluded.title,
                agency = excluded.agency,
                posted_date = excluded.posted_date,
                due_date = excluded.due_date,
                description = excluded.description,
                category = excluded.category,
                attachments = excluded.attachments,
                contact_name = excluded.contact_name,
                contact_email = excluded.contact_email,
                contact_phone = excluded.contact_phone,
                commodity_codes = excluded.commodity_codes,
                addenda = excluded.addenda,
                metadata_json = excluded.metadata_json,
                state = excluded.state,
                normalized_at = excluded.normalized_at
            """,
            (
                payload["solicitation_id"],
                payload["title"],
                payload["agency"],
                payload["posted_date"],
                payload["due_date"],
                payload["description"],
                payload["category"],
                payload["url"],
                payload["attachments"],
                payload["contact_name"],
                payload["contact_email"],
                payload["contact_phone"],
                payload["commodity_codes"],
                payload["addenda"],
                payload["metadata_json"],
                payload["state"],
                payload["normalized_at"],
            ),
        )
        conn.commit()
        if is_new_url:
            records.append(payload)
        else:
            records.append(payload)
        existing_urls.add(detail_url)

    conn.close()
    return records


normalize_listing = normalize_records

if __name__ == "__main__":
    normalize_records()
