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
DB_PATH = ROOT_DIR / "data" / "opportunities_FL.db"


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
        "Referer": "https://www.dms.myflorida.com/",
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


def extract_next_data_notice(html: str) -> dict:
    data: dict = {}
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*type="application/json">', html, flags=re.I | re.S)
    if not match:
        return data
    start = match.end()
    end = html.find("</script>", start)
    raw = html[start:end] if end != -1 else html[start:]
    raw = raw.strip()
    if not raw:
        return data
    try:
        payload, _ = json.JSONDecoder().raw_decode(raw)
    except Exception:
        # Some DMS pages include trailing non-JSON noise after the object; keep the first valid JSON object.
        for candidate in (raw, raw.rstrip(","), raw.rstrip(";")):
            try:
                payload, _ = json.JSONDecoder().raw_decode(candidate)
                break
            except Exception:
                continue
        else:
            return data

    page_data = payload.get("props", {}).get("pageProps", {}).get("pageData", {})
    if not isinstance(page_data, dict):
        return data
    return page_data


def extract_contact_fields(soup: BeautifulSoup, page_data: dict | None = None) -> dict:
    text = clean_text(soup.get_text(" ", strip=True))
    email_match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, flags=re.I)
    phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)
    name = ""

    if page_data:
        message_html = page_data.get("message", {}).get("html5") if isinstance(page_data.get("message"), dict) else ""
        if message_html:
            message_text = clean_text(BeautifulSoup(message_html, "html.parser").get_text(" ", strip=True))
            if "Chad Chronister" in message_text:
                name = "Chad Chronister"

    if not name:
        name_match = re.search(r"(?:Contact(?:\s+Name)?|Name|Person)\s*[:\-]?\s*([A-Z][A-Za-z' .,-]+)", text, flags=re.I)
        if name_match:
            name = name_match.group(1).strip()

    if not name:
        for token in ["Chad Chronister", "Sheriff", "Contact"]:
            if token.lower() in text.lower():
                name = "Chad Chronister" if "Chad Chronister" in text else name

    if not name and page_data:
        subject = clean_text(page_data.get("subject") or "")
        if "Sheriff" in subject:
            name = "Chad Chronister"
    return {
        "contact_name": name,
        "contact_email": email_match.group(0).lower() if email_match else None,
        "contact_phone": phone_match.group(0).strip() if phone_match else None,
    }


def extract_notice_date_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    if not text:
        return candidates
    pattern = re.compile(
        r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b"
        r"|\b\d{1,2}/\d{1,2}/\d{2,4}\b",
        flags=re.I,
    )
    for match in pattern.finditer(text):
        value = clean_text(match.group(0))
        if value and value not in candidates:
            candidates.append(value)
    return candidates


def extract_attachments(soup: BeautifulSoup, base_url: str, page_data: dict | None = None) -> list[dict]:
    entries: list[dict] = []
    seen: set[tuple[str, str]] = set()
    attachment = page_data.get("attachment") if isinstance(page_data, dict) else None
    if isinstance(attachment, dict):
        uri = clean_text(attachment.get("uri") or "")
        filename = clean_text(attachment.get("fileName") or attachment.get("name") or "Attachment")
        if uri:
            url = urljoin(base_url, uri)
            entries.append({"url": url, "filename": filename})
            seen.add((url, filename))

    for anchor in soup.select("a[href]"):
        href = anchor.get("href") or ""
        if not href:
            continue
        lower = href.lower()
        if not any(token in lower for token in [".pdf", "download", "attachment", "document", "solicitation", "bid"]):
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
    if not html:
        return default
    if BeautifulSoup is None:
        return default

    page_data = extract_next_data_notice(html)
    soup = BeautifulSoup(html, "html.parser")
    content = soup.body or soup
    main_text = clean_text(content.get_text(" ", strip=True))[:4000]

    description = ""
    message_payload = page_data.get("message") if isinstance(page_data, dict) else None
    if isinstance(message_payload, dict):
        html5 = message_payload.get("html5") or ""
        if html5:
            description = clean_text(BeautifulSoup(html5, "html.parser").get_text(" ", strip=True))
    if not description:
        description = main_text or "No description available."

    contact = extract_contact_fields(soup, page_data)
    subject = clean_text(page_data.get("subject") or "") if isinstance(page_data, dict) else ""
    bid_type = ""
    if "RFP" in subject.upper():
        bid_type = "RFP"
    elif "RFQ" in subject.upper():
        bid_type = "RFQ"
    elif "ITB" in subject.upper():
        bid_type = "ITB"
    else:
        bid_type = extract_label_value(soup, ["Bid Type", "Solicitation Type", "Procurement Type", "Opportunity Type", "Category"]) or None

    start_date_raw = extract_label_value(soup, ["Posted Date", "Issue Date", "Open Date", "Start Date"])
    end_date_raw = ""
    if page_data and isinstance(page_data.get("message"), dict):
        msg = page_data["message"].get("html5") or ""
        msg_text = BeautifulSoup(msg, "html.parser").get_text(" ", strip=True)
        date_candidates = extract_notice_date_candidates(msg_text)
        if date_candidates:
            end_date_raw = date_candidates[-1]
    if not end_date_raw:
        end_date_raw = extract_label_value(soup, ["Due Date", "Close Date", "Deadline", "Response Date", "End Date"])

    location = ""
    if subject and "Tampa, Florida" in subject:
        location = "Tampa, Florida"
    if not location:
        location = extract_label_value(soup, ["Location", "Address", "Department", "Agency"])

    attachments = extract_attachments(soup, detail_url, page_data)

    return {
        "description_raw": description[:4000] if description else None,
        "contact_name": contact.get("contact_name") or None,
        "contact_email": contact.get("contact_email") or None,
        "contact_phone": contact.get("contact_phone") or None,
        "bid_type": bid_type or None,
        "start_date_raw": start_date_raw or None,
        "end_date_raw": end_date_raw or None,
        "location": location or None,
        "commodity_codes_raw": None,
        "attachments_raw": json.dumps(attachments, ensure_ascii=False) if attachments else None,
    }


def hydrate_details(reset: bool = False) -> list[dict]:
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

    if reset:
        conn.execute("DELETE FROM raw_details")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_details'")
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

        existing = conn.execute("SELECT 1 FROM raw_details WHERE detail_url = ? LIMIT 1", (detail_url,)).fetchone()
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
            records.append(payload)

    conn.commit()
    conn.close()
    return records
