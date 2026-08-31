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
DB_PATH = ROOT_DIR / "data" / "opportunities_NY.db"


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
    }


def read_html(url: str, timeout: int = 30) -> str:
    request = Request(url, headers=browser_headers())
    with urlopen(request, timeout=timeout) as response:
        content = response.read()
    return content.decode("utf-8", errors="ignore")


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


def extract_detail_metadata(html: str, detail_url: str) -> dict:
    details = {
        "full_description": "",
        "contact_name": "",
        "contact_email": "",
        "contact_phone": "",
        "agency": "",
        "issue_date_raw": "",
        "due_date_raw": "",
        "category": "",
        "ad_type": "",
        "location": "",
        "attachments_raw": "[]",
    }
    if not html or BeautifulSoup is None:
        return details

    soup = BeautifulSoup(html, "html.parser")
    text = clean_text(soup.get_text(" ", strip=True))

    for label in ["Agency", "Agency Name", "Department"]:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            details["agency"] = clean_text(match.group(1))
            break

    for label in ["Issue Date", "Posted Date", "Open Date"]:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            details["issue_date_raw"] = clean_text(match.group(1))
            break

    for label in ["Due Date", "Submission Date", "Response Date", "Deadline"]:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            details["due_date_raw"] = clean_text(match.group(1))
            break

    for label in ["Category", "Commodity", "Classification"]:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            details["category"] = clean_text(match.group(1))
            break

    for label in ["Ad Type", "Type"]:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            details["ad_type"] = clean_text(match.group(1))
            break

    for label in ["Location", "City", "Office Location"]:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            details["location"] = clean_text(match.group(1))
            break

    contact_name_match = re.search(r"(?:Contact(?:\s+Name)?|Name)\s*[:\-]\s*([A-Z][A-Za-z' .,-]+)", text, flags=re.I)
    if contact_name_match:
        details["contact_name"] = normalize_name(contact_name_match.group(1)) or ""

    email_match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, flags=re.I)
    if email_match:
        details["contact_email"] = normalize_email(email_match.group(0)) or ""

    phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)
    if phone_match:
        details["contact_phone"] = normalize_phone(phone_match.group(0)) or ""

    for selector in ["#mainContent", "#content", "#description", ".description", "main", "article"]:
        node = soup.select_one(selector)
        if node:
            candidate = clean_text(node.get_text(" ", strip=True))
            if candidate:
                details["full_description"] = candidate
                break

    if not details["full_description"]:
        details["full_description"] = text[:5000]

    attachments = []
    for anchor in soup.select("a[href]"):
        href = (anchor.get("href") or "").strip()
        if not href.lower().endswith(".pdf"):
            continue
        pdf_url = urljoin(detail_url, href)
        filename = clean_text(anchor.get_text(" ", strip=True)) or pdf_url.rsplit("/", 1)[-1]
        attachments.append({"url": pdf_url, "filename": filename})

    deduped: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in attachments:
        key = (item.get("url", ""), item.get("filename", ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    details["attachments_raw"] = json.dumps(deduped, ensure_ascii=False)
    return details


def hydrate_details(reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cr_number TEXT,
            detail_url TEXT,
            full_description TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            agency TEXT,
            issue_date_raw TEXT,
            due_date_raw TEXT,
            category TEXT,
            ad_type TEXT,
            location TEXT,
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
        "SELECT cr_number, title, agency, category, ad_type, issue_date_raw, due_date_raw, location, detail_url, raw_html FROM raw_listings ORDER BY id"
    ).fetchall()

    records: list[dict] = []
    seen_urls: set[str] = set()

    for row in rows:
        detail_url = clean_text(row["detail_url"])
        if not detail_url:
            detail_url = f"https://www.nyscr.ny.gov/Ads/Search?type=opportunity#cr-{clean_text(row['cr_number'])}"
        if detail_url in seen_urls:
            continue
        seen_urls.add(detail_url)

        payload = {
            "full_description": clean_text(row["title"]),
            "contact_name": "",
            "contact_email": "",
            "contact_phone": "",
            "agency": clean_text(row["agency"]),
            "issue_date_raw": clean_text(row["issue_date_raw"]),
            "due_date_raw": clean_text(row["due_date_raw"]),
            "category": clean_text(row["category"]),
            "ad_type": clean_text(row["ad_type"]),
            "location": clean_text(row["location"]),
            "attachments_raw": "[]",
        }
        payload["cr_number"] = clean_text(row["cr_number"])
        payload["detail_url"] = detail_url
        payload["raw_html"] = row["raw_html"] or ""
        payload["scraped_at"] = datetime.now(timezone.utc).isoformat()

        conn.execute(
            """
            INSERT INTO raw_details (
                cr_number,
                detail_url,
                full_description,
                contact_name,
                contact_email,
                contact_phone,
                agency,
                issue_date_raw,
                due_date_raw,
                category,
                ad_type,
                location,
                attachments_raw,
                raw_html,
                scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["cr_number"],
                payload["detail_url"],
                payload["full_description"],
                payload["contact_name"],
                payload["contact_email"],
                payload["contact_phone"],
                payload["agency"],
                payload["issue_date_raw"],
                payload["due_date_raw"],
                payload["category"],
                payload["ad_type"],
                payload["location"],
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
    rows = hydrate_details(reset=True)
    print(f"NY raw_details={len(rows)}")
