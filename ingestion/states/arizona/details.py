from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from dateutil import parser as date_parser
except ImportError:  # pragma: no cover
    date_parser = None

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_AZ.db"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def read_html(url: str, timeout: int = 30) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=timeout) as response:
        html = response.read()
    return html.decode("utf-8", errors="ignore")


def clean_text(value: str | None) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def safe_select_text(soup: BeautifulSoup, selectors: str | list[str]) -> str:
    candidates = [selectors] if isinstance(selectors, str) else selectors
    for selector in candidates:
        try:
            node = soup.select_one(selector)
        except Exception:
            continue
        if node is not None:
            return clean_text(node.get_text(" ", strip=True))
    return ""


def extract_contact_fields(raw_text: str | None) -> dict:
    text = clean_text(raw_text)
    if not text:
        return {"contact_name": None, "contact_email": None, "contact_phone": None}

    name = None
    match = re.search(r"(?:Name|Contact(?: Name)?|Primary Contact|Contact Person)\s*[:\-]?\s*([A-Z][A-Za-zÀ-ÿ'.,\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'.,\-]+){0,5})\s*(?:Email|E-mail)?\s*:", text, flags=re.I)
    if match:
        name = match.group(1).strip()
    else:
        match = re.search(r"([A-Z][A-Za-zÀ-ÿ'.,\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'.,\-]+){0,5})\s*Email\s*:", text, flags=re.I)
        if match:
            name = match.group(1).strip()

    email_match = re.search(r"\S+@\S+", text)
    email = email_match.group(0) if email_match else None

    phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)
    phone = phone_match.group(0) if phone_match else None

    return {
        "contact_name": name,
        "contact_email": email,
        "contact_phone": phone,
    }


def extract_dates_from_text(value: str | None) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    pattern = re.compile(
        r"\b(?:\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4})\b",
        flags=re.I,
    )
    matches = pattern.findall(text)
    ordered: list[str] = []
    for match in matches:
        if match not in ordered:
            ordered.append(match)
    return ordered


def normalize_date_value(value: str | None) -> str | None:
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
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%b %d, %Y", "%B %d, %Y", "%m-%d-%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text


def extract_attachment_entries(soup: BeautifulSoup, detail_url: str) -> list[dict]:
    entries: list[dict] = []
    try:
        for anchor in soup.select("div#solicitationDocuments a[href], #solicitationDocuments a[href]"):
            href = anchor.get("href")
            if not href:
                continue
            url = urljoin(detail_url, href)
            filename = clean_text(anchor.get_text(" ", strip=True)) or urlparse(url).path.split("/")[-1] or "attachment"
            entry = {"url": url, "filename": filename}
            if entry not in entries:
                entries.append(entry)
    except Exception:
        return []
    return entries


def extract_commodity_codes(raw_text: str | None) -> list[str]:
    text = clean_text(raw_text)
    if not text:
        return []
    chunks = re.split(r"[,\n]+", text)
    items: list[str] = []
    for chunk in chunks:
        value = clean_text(chunk)
        if value:
            if value not in items:
                items.append(value)
    return items


def extract_addenda_entries(soup: BeautifulSoup) -> list[dict]:
    entries: list[dict] = []
    try:
        selector_targets = ["div#addenda li", "div#addenda > div", "div#addenda > p", "div#addenda > span", "#addenda li", "#addenda > div"]
        for node in soup.select(", ".join(selector_targets)):
            text = clean_text(node.get_text(" ", strip=True))
            if not text:
                continue
            title = text
            date_match = re.search(r"(?:\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4})", text, flags=re.I)
            item_date = date_match.group(0) if date_match else None
            entries.append({"title": title, "date": item_date})
    except Exception:
        return []
    return entries


def is_browser_check_page(html: str | None) -> bool:
    if not html:
        return False
    text = clean_text(html).lower()
    challenge_markers = (
        "browser check",
        "verify you are human",
        "this browser is checking",
        "please verify you are a human",
        "continue to buyer arizona",
        "security check",
        "captcha",
        "challenge",
    )
    return any(marker in text for marker in challenge_markers)


def extract_details_from_html(html: str, detail_url: str) -> dict:
    empty = {
        "summary_raw": None,
        "description_raw": None,
        "contact_raw": None,
        "contact_name": None,
        "contact_email": None,
        "contact_phone": None,
        "dates_raw": None,
        "posted_date": None,
        "due_date": None,
        "metadata_json": None,
        "attachments_raw": None,
        "commodity_codes_raw": None,
        "addenda_raw": None,
    }
    if BeautifulSoup is None:
        return empty
    if is_browser_check_page(html):
        return empty

    soup = BeautifulSoup(html, "html.parser")
    content = soup.select_one("#mainContentDiv") or soup.select_one("#body_x_plhMain") or soup.body
    main_text = ""
    if content is not None:
        try:
            for tag in content.select("script, style, noscript"):
                tag.decompose()
            main_text = clean_text(content.get_text(" ", strip=True))
        except Exception:
            main_text = ""

    contact_block = safe_select_text(soup, ["div#contactInfo", "#contactInfo", "div.contact-info", "#contactInfo", "div#generalInfo"])
    if not contact_block:
        contact_block = main_text[:2000]
    contact_fields = extract_contact_fields(contact_block)

    dates_block = safe_select_text(soup, ["div#dates", "#dates"])
    date_values = extract_dates_from_text(dates_block) if dates_block else extract_dates_from_text(main_text)
    posted_date = normalize_date_value(date_values[0]) if date_values else None
    due_date = normalize_date_value(date_values[-1]) if date_values else None
    extra_dates = [normalize_date_value(value) for value in date_values[1:-1]] if len(date_values) > 2 else []
    metadata_dict = {
        "raw_dates": date_values,
        "additional_dates": [value for value in extra_dates if value],
        "posted_date": posted_date,
        "due_date": due_date,
    }
    metadata_json = json.dumps(metadata_dict, ensure_ascii=False) if metadata_dict else None

    attachments = []
    try:
        attachments = extract_attachment_entries(soup, detail_url)
    except Exception:
        attachments = []
    attachments_raw = json.dumps(attachments, ensure_ascii=False) if attachments else None

    commodity_text = safe_select_text(soup, ["div#commodityCodes", "#commodityCodes", "div.commodity-codes"])
    commodity_values = extract_commodity_codes(commodity_text)
    commodity_codes_raw = json.dumps(commodity_values, ensure_ascii=False) if commodity_values else None

    addenda_entries: list[dict] = []
    try:
        addenda_entries = extract_addenda_entries(soup)
    except Exception:
        addenda_entries = []
    addenda_raw = json.dumps(addenda_entries, ensure_ascii=False) if addenda_entries else None

    return {
        "summary_raw": main_text[:4000] if main_text else None,
        "description_raw": main_text or None,
        "contact_raw": contact_block or main_text[:2000] or None,
        "contact_name": contact_fields.get("contact_name") or None,
        "contact_email": contact_fields.get("contact_email") or None,
        "contact_phone": contact_fields.get("contact_phone") or None,
        "dates_raw": dates_block or main_text[:2000] or None,
        "posted_date": posted_date,
        "due_date": due_date,
        "metadata_json": metadata_json,
        "attachments_raw": attachments_raw,
        "commodity_codes_raw": commodity_codes_raw,
        "addenda_raw": addenda_raw,
    }


def ensure_columns(conn: sqlite3.Connection, table_name: str, columns: list[str]) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}
    for column_sql in columns:
        name = column_sql.split()[0]
        if name not in existing:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}")


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
            solicitation_id TEXT,
            detail_url TEXT,
            summary_raw TEXT,
            description_raw TEXT,
            contact_raw TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            dates_raw TEXT,
            posted_date TEXT,
            due_date TEXT,
            metadata_json TEXT,
            attachments_raw TEXT,
            commodity_codes_raw TEXT,
            addenda_raw TEXT,
            raw_html TEXT,
            scraped_at TEXT
        )
        """
    )
    conn.commit()
    ensure_columns(
        conn,
        "raw_details",
        [
            "contact_name TEXT",
            "contact_email TEXT",
            "contact_phone TEXT",
            "posted_date TEXT",
            "due_date TEXT",
            "metadata_json TEXT",
        ],
    )
    conn.commit()

    rows = conn.execute(
        "SELECT solicitation_id, detail_url FROM raw_listings WHERE detail_url IS NOT NULL AND detail_url != '' ORDER BY id"
    ).fetchall()

    records: list[dict] = []
    for row in rows:
        solicitation_id = row["solicitation_id"]
        detail_url = row["detail_url"]
        try:
            html = read_html(detail_url)
        except Exception:
            continue

        extracted = extract_details_from_html(html, detail_url)
        if extracted["description_raw"] is None and extracted["summary_raw"] is None and not extracted["contact_raw"]:
            continue

        payload = {
            "solicitation_id": solicitation_id,
            "detail_url": detail_url,
            "summary_raw": extracted["summary_raw"],
            "description_raw": extracted["description_raw"],
            "contact_raw": extracted["contact_raw"],
            "contact_name": extracted["contact_name"],
            "contact_email": extracted["contact_email"],
            "contact_phone": extracted["contact_phone"],
            "dates_raw": extracted["dates_raw"],
            "posted_date": extracted["posted_date"],
            "due_date": extracted["due_date"],
            "metadata_json": extracted["metadata_json"],
            "attachments_raw": extracted["attachments_raw"],
            "commodity_codes_raw": extracted["commodity_codes_raw"],
            "addenda_raw": extracted["addenda_raw"],
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
                    solicitation_id,
                    detail_url,
                    summary_raw,
                    description_raw,
                    contact_raw,
                    contact_name,
                    contact_email,
                    contact_phone,
                    dates_raw,
                    posted_date,
                    due_date,
                    metadata_json,
                    attachments_raw,
                    commodity_codes_raw,
                    addenda_raw,
                    raw_html,
                    scraped_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["solicitation_id"],
                    payload["detail_url"],
                    payload["summary_raw"],
                    payload["description_raw"],
                    payload["contact_raw"],
                    payload["contact_name"],
                    payload["contact_email"],
                    payload["contact_phone"],
                    payload["dates_raw"],
                    payload["posted_date"],
                    payload["due_date"],
                    payload["metadata_json"],
                    payload["attachments_raw"],
                    payload["commodity_codes_raw"],
                    payload["addenda_raw"],
                    payload["raw_html"],
                    payload["scraped_at"],
                ),
            )
            conn.commit()
        records.append(payload)

    conn.close()
    return records


fetch_and_store_details = hydrate_details

if __name__ == "__main__":
    hydrate_details()
