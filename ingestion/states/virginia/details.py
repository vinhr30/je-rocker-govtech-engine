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
DB_PATH = ROOT_DIR / "data" / "opportunities_VA.db"


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
        "Upgrade-Insecure-Requests": "1",
    }


def read_html(url: str, timeout: int = 30) -> str:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            page = browser.new_page(
                viewport={"width": 1440, "height": 1200},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            )
            response = page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            if response is not None and response.status >= 400:
                html = ""
            else:
                page.wait_for_timeout(2500)
                html = page.content()
            browser.close()
            if html and ("rfp_id_lot" in html or "Submit" in html or "Please verify reCAPTCHA" in html or "IVDetails" in html or "Virginia Business Opportunities" in html):
                return html
    except Exception:
        html = ""

    request = Request(url, headers=browser_headers())
    try:
        with urlopen(request, timeout=timeout) as response:
            content = response.read()
        html = content.decode("utf-8", errors="ignore")
    except Exception:
        html = ""

    return html


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def extract_text_from_html(html: str) -> str:
    if not html or BeautifulSoup is None:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    return clean_text(soup.get_text(" ", strip=True))


def extract_contact_fields(text: str) -> dict:
    name = ""
    email = ""
    phone = ""

    email_match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, flags=re.I)
    phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)

    name_match = re.search(r"(?:Contact(?:\s+Name)?|Name)\s*[:\-]\s*([A-Z][A-Za-z' .,-]+)", text, flags=re.I)
    if name_match:
        name = name_match.group(1).strip()

    if email_match:
        email = email_match.group(0).lower()
    if phone_match:
        phone = phone_match.group(0).strip()

    return {
        "contact_name": name,
        "contact_email": email,
        "contact_phone": phone,
    }


def extract_attachments(soup: BeautifulSoup, base_url: str) -> list[dict]:
    attachments: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for anchor in soup.select("a[href]"):
        href = anchor.get("href") or ""
        url = href.lower()
        if ".pdf" not in url:
            continue
        pdf_url = urljoin(base_url, href)
        filename = clean_text(anchor.get_text(" ", strip=True)) or pdf_url.rsplit("/", 1)[-1]
        key = (pdf_url, filename)
        if key in seen:
            continue
        seen.add(key)
        attachments.append({"url": pdf_url, "filename": filename})
    return attachments


def extract_label_value(text: str, labels: list[str]) -> str:
    for label in labels:
        match = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n\r]+)", text, flags=re.I)
        if match:
            return clean_text(match.group(1))
    return ""


def extract_detail_fields(html: str, fallback: dict | None = None) -> dict:
    fallback = fallback or {}
    details: dict[str, str] = {
        "full_description": "",
        "contact_name": "",
        "contact_email": "",
        "contact_phone": "",
        "agency": clean_text(fallback.get("agency")),
        "opening_date_raw": clean_text(fallback.get("opening_date_raw")),
        "closing_date_raw": clean_text(fallback.get("closing_date_raw")),
        "commodity_codes": "",
    }

    if not html or BeautifulSoup is None:
        return details

    soup = BeautifulSoup(html, "html.parser")
    text = extract_text_from_html(html)

    for label in ["Agency", "Department", "Buyer", "Organization"]:
        value = extract_label_value(text, [label])
        if value:
            details["agency"] = value
            break

    if not details["agency"]:
        candidate = soup.select_one("table td")
        if candidate:
            details["agency"] = clean_text(candidate.get_text(" ", strip=True))

    for label in ["Opening Date", "Open Date", "Posted Date", "Issue Date"]:
        value = extract_label_value(text, [label])
        if value:
            details["opening_date_raw"] = value
            break

    for label in ["Closing Date", "Due Date", "Deadline", "Response Date", "Close Date", "Bid Due"]:
        value = extract_label_value(text, [label])
        if value:
            details["closing_date_raw"] = value
            break

    for label in ["Contact Name", "Buyer Name", "Name"]:
        value = extract_label_value(text, [label])
        if value:
            details["contact_name"] = value
            break

    for label in ["Contact Email", "Email", "E-mail"]:
        value = extract_label_value(text, [label])
        if value:
            details["contact_email"] = value
            break

    for label in ["Contact Phone", "Phone", "Telephone"]:
        value = extract_label_value(text, [label])
        if value:
            details["contact_phone"] = value
            break

    email_match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, flags=re.I)
    if not details["contact_email"] and email_match:
        details["contact_email"] = email_match.group(0).lower()

    phone_match = re.search(r"(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}", text)
    if not details["contact_phone"] and phone_match:
        details["contact_phone"] = phone_match.group(0).strip()

    for selector in ["div.description-container", "div.description", "#description", "#longdescription", "p", "td"]:
        node = soup.select_one(selector)
        if node is not None:
            candidate = clean_text(node.get_text(" ", strip=True))
            if candidate and not candidate.lower().startswith("please verify recaptcha") and not candidate.lower().startswith("virginia business opportunities"):
                details["full_description"] = candidate
                break

    if not details["full_description"]:
        description_text = text
        description_text = re.sub(r"(?i)Please verify reCAPTCHA to continue:.*", "", description_text)
        description_text = re.sub(r"(?i)Virginia Business Opportunities", "", description_text)
        description_text = re.sub(r"\s+", " ", description_text).strip()
        if description_text:
            details["full_description"] = description_text

    if not details["full_description"]:
        details["full_description"] = clean_text(fallback.get("full_description"))

    for node in soup.select("table tr"):
        cells = [clean_text(c.get_text(" ", strip=True)) for c in node.select("th, td")]
        if len(cells) < 2:
            continue
        key = cells[0].lower()
        value = cells[1]
        if key.startswith("agency"):
            details["agency"] = value
        if key.startswith("opening date"):
            details["opening_date_raw"] = value
        if key.startswith("closing date"):
            details["closing_date_raw"] = value
        if key.startswith("contact name"):
            details["contact_name"] = value
        if key.startswith("contact email"):
            details["contact_email"] = value
        if key.startswith("contact phone"):
            details["contact_phone"] = value

    # Use fallback only when the live detail page does not provide real data.
    if not details["agency"]:
        details["agency"] = clean_text(fallback.get("agency"))
    if not details["opening_date_raw"]:
        details["opening_date_raw"] = clean_text(fallback.get("opening_date_raw"))
    if not details["closing_date_raw"]:
        details["closing_date_raw"] = clean_text(fallback.get("closing_date_raw"))

    return details


def normalize_detail_text(raw: str) -> str:
    if not raw:
        return ""
    cleaned = re.sub(r"\s+", " ", raw)
    return cleaned.strip()


def hydrate_details(reset: bool = False) -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            solicitation_number TEXT,
            detail_url TEXT,
            full_description TEXT,
            contact_name TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            agency TEXT,
            opening_date_raw TEXT,
            closing_date_raw TEXT,
            commodity_codes TEXT,
            attachments_raw TEXT,
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
        "SELECT solicitation_number, detail_url, title, agency, closing_date_raw FROM raw_listings ORDER BY id"
    ).fetchall()
    records: list[dict] = []

    for row in rows:
        detail_url = row["detail_url"] or ""
        if not detail_url:
            continue

        try:
            html = read_html(detail_url)
        except Exception:
            html = ""

        if BeautifulSoup is not None:
            soup = BeautifulSoup(html, "html.parser")
            detail_fields = extract_detail_fields(html, fallback={
                "agency": clean_text(row["agency"]),
                "opening_date_raw": "",
                "closing_date_raw": clean_text(row["closing_date_raw"]),
                "full_description": "",
            })
            contact = {
                "contact_name": detail_fields.get("contact_name", ""),
                "contact_email": detail_fields.get("contact_email", ""),
                "contact_phone": detail_fields.get("contact_phone", ""),
            }
            description = detail_fields.get("full_description", "")
            attachments = extract_attachments(soup, detail_url)
            agency = detail_fields.get("agency") or clean_text(row["agency"]) or ""
            opening_date_raw = detail_fields.get("opening_date_raw") or ""
            closing_date_raw = detail_fields.get("closing_date_raw") or clean_text(row["closing_date_raw"]) or ""
            commodity_codes = detail_fields.get("commodity_codes", "")
            commodity_match = re.search(r"(?:Commodity\s*Codes?|Commodity\s*Code|NAICS|PSC)\s*[:\-]\s*([^\n\r]+)", html, flags=re.I)
            if commodity_match and not commodity_codes:
                commodity_codes = commodity_match.group(1)
        else:
            soup = None
            detail_fields = {
                "full_description": "",
                "contact_name": "",
                "contact_email": "",
                "contact_phone": "",
                "agency": clean_text(row["agency"]),
                "opening_date_raw": "",
                "closing_date_raw": clean_text(row["closing_date_raw"]),
                "commodity_codes": "",
            }
            contact = {"contact_name": "", "contact_email": "", "contact_phone": ""}
            description = ""
            attachments = []
            agency = clean_text(row["agency"]) or ""
            opening_date_raw = ""
            closing_date_raw = clean_text(row["closing_date_raw"]) or ""
            commodity_codes = ""

        payload = {
            "solicitation_number": row["solicitation_number"],
            "detail_url": detail_url,
            "full_description": normalize_detail_text(description),
            "contact_name": clean_text(contact.get("contact_name")),
            "contact_email": clean_text(contact.get("contact_email")),
            "contact_phone": clean_text(contact.get("contact_phone")),
            "agency": agency,
            "opening_date_raw": opening_date_raw,
            "closing_date_raw": closing_date_raw,
            "commodity_codes": commodity_codes,
            "attachments_raw": json.dumps(attachments, ensure_ascii=False),
            "scraped_at": datetime.now(timezone.utc).isoformat(),
        }

        conn.execute(
            """
            INSERT INTO raw_details (
                solicitation_number,
                detail_url,
                full_description,
                contact_name,
                contact_email,
                contact_phone,
                agency,
                opening_date_raw,
                closing_date_raw,
                commodity_codes,
                attachments_raw,
                scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["solicitation_number"],
                payload["detail_url"],
                payload["full_description"],
                payload["contact_name"],
                payload["contact_email"],
                payload["contact_phone"],
                payload["agency"],
                payload["opening_date_raw"],
                payload["closing_date_raw"],
                payload["commodity_codes"],
                payload["attachments_raw"],
                payload["scraped_at"],
            ),
        )
        conn.commit()
        records.append(payload)

    conn.close()
    return records


if __name__ == "__main__":
    rows = hydrate_details(reset=True)
    print(f"VA raw_details={len(rows)}")
