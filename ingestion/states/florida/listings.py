from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_FL.db"
BASE_URLS = [
    "https://vendor.myfloridamarketplace.com/",
    "https://www.dms.myflorida.com/business_operations/state_purchasing/office_of_supplier_development_osd/vendor_resources/current_bid_opportunities",
]
KEYWORDS = ("bid", "solicitation", "opportunity", "rfp", "rfq", "ifb", "itb", "award")


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
    request = Request(url, headers=browser_headers())
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="ignore")


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_url(value: str, base_url: str = "") -> str:
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return urljoin(base_url or "https://vendor.myfloridamarketplace.com/", value)


def candidate_url(url: str) -> bool:
    lower = url.lower()
    if not lower.startswith("http"):
        return False
    if any(token in lower for token in (".pdf", ".jpg", ".png", ".svg", ".css", ".js")):
        return False
    if any(token in lower for token in ("/assets/", "/_next/", "/fonts/", "/favicon")):
        return False
    return any(token in lower for token in KEYWORDS)


def build_search_payload(end_date: str | None = None, days_back: int = 90) -> dict:
    end_dt = datetime.strptime(end_date, "%m/%d/%Y") if end_date else datetime.now(timezone.utc).date()
    start_dt = end_dt - timedelta(days=days_back)
    end_value = end_dt.strftime("%m/%d/%Y")
    start_value = start_dt.strftime("%m/%d/%Y")
    return {
        "page": 0,
        "pageSize": 25,
        "sortBy": "adDate",
        "direction": "DESC",
        "criteria": {
            "startDate": start_value,
            "endDate": end_value,
            "status": "OPEN",
        },
    }


def parse_mfmp_records(payload) -> list[dict]:
    records: list[dict] = []
    if payload is None:
        return records

    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("results") or payload.get("items") or payload.get("data") or payload.get("advertisements") or []
        if isinstance(items, dict):
            items = list(items.values())
    else:
        items = []

    for item in items:
        if not isinstance(item, dict):
            continue

        detail_url = clean_text(item.get("url") or item.get("detail_url") or item.get("href") or item.get("link") or "")
        if not detail_url:
            detail_url = clean_text(item.get("detailUrl") or item.get("id") or "")
            if detail_url and not detail_url.startswith("http"):
                detail_url = f"https://vendor.myfloridamarketplace.com/search/bids/{detail_url}"
        if not detail_url:
            continue
        if any(token in detail_url.lower() for token in ("/assets/", "/_next/", "/fonts/", "/favicon")):
            continue
        if not candidate_url(detail_url):
            continue

        title = clean_text(item.get("title") or item.get("event_name") or item.get("name") or item.get("adTitle") or item.get("announcement"))
        event_id = clean_text(item.get("adNumber") or item.get("event_id") or item.get("id") or item.get("adId") or parse_event_id(detail_url))
        department = clean_text(item.get("agency") or item.get("department") or item.get("organization") or item.get("owner"))
        kind = clean_text(item.get("adType") or item.get("type") or item.get("bid_type") or "")
        start_date_raw = clean_text(item.get("postedDate") or item.get("publishedDate") or item.get("issueDate") or item.get("start_date_raw") or item.get("start_date") or "")
        end_date_raw = clean_text(item.get("deadline") or item.get("dueDate") or item.get("endDate") or item.get("closeDate") or item.get("end_date_raw") or item.get("end_date") or "")

        records.append(
            {
                "event_id": event_id,
                "event_name": title or event_id,
                "department": department or "Florida Department of Management Services",
                "type": kind,
                "start_date_raw": start_date_raw,
                "end_date_raw": end_date_raw,
                "detail_url": detail_url,
                "scraped_at": datetime.now(timezone.utc).isoformat(),
                "raw_html": json.dumps(item, ensure_ascii=False),
            }
        )

    return records


def extract_candidate_links(html: str, base_url: str) -> list[str]:
    urls: list[str] = []
    if not html:
        return urls

    seen: set[str] = set()
    for match in re.finditer(r'href=["\']([^"\']+)["\']', html, flags=re.I):
        href = clean_text(match.group(1))
        if not href or href.startswith("mailto:"):
            continue
        url = normalize_url(href, base_url)
        if not url or url in seen:
            continue
        if candidate_url(url):
            seen.add(url)
            urls.append(url)

    if BeautifulSoup is not None:
        try:
            soup = BeautifulSoup(html, "html.parser")
            for anchor in soup.select("a[href]"):
                href = anchor.get("href")
                if not href:
                    continue
                url = normalize_url(href, base_url)
                if not url or url in seen:
                    continue
                text = clean_text(anchor.get_text(" ", strip=True)).lower()
                if text and any(token in text for token in KEYWORDS):
                    seen.add(url)
                    urls.append(url)
        except Exception:
            pass

    return urls


def extract_dms_notice_links(html: str, base_url: str) -> list[str]:
    if not html:
        return []

    urls: list[str] = []
    seen: set[str] = set()
    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        for anchor in soup.select("a[href]"):
            href = anchor.get("href") or ""
            if not href or href.startswith("mailto:"):
                continue
            url = normalize_url(href, base_url)
            if not url or url in seen:
                continue
            if "/current_bid_opportunities/" in url.lower() and not any(token in url.lower() for token in ("?page=", "/search", "/privacy", "/terms", "/accessibility")):
                seen.add(url)
                urls.append(url)
    return urls


def extract_dms_detail_url(html: str, base_url: str) -> str:
    if not html:
        return ""

    try:
        data = json.JSONDecoder().raw_decode(html.strip())
    except Exception:
        data = None

    if data is None:
        match = re.search(r'<script id="__NEXT_DATA__"[^>]*type="application/json">(.*?)</script>', html, flags=re.I | re.S)
        if match:
            raw = match.group(1).strip()
            try:
                payload, _ = json.JSONDecoder().raw_decode(raw)
            except Exception:
                payload = None
            if payload is not None:
                data = payload

    if isinstance(data, dict):
        page_data = data.get("props", {}).get("pageProps", {}).get("pageData", {})
        if isinstance(page_data, dict):
            link = page_data.get("link")
            if isinstance(link, dict):
                detail = clean_text(link.get("link") or "")
                if detail:
                    return normalize_url(detail, base_url)

    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        for anchor in soup.select("a[href]"):
            href = anchor.get("href") or ""
            if not href or href.startswith("mailto:"):
                continue
            text = clean_text(anchor.get_text(" ", strip=True)).lower()
            if "click here for details" in text or "details" in text:
                return normalize_url(href, base_url)

    return ""


def collect_dms_notice_pages(base_url: str, max_pages: int = 67) -> list[str]:
    collected: list[str] = []
    seen: set[str] = set()

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1600, "height": 1200})
            for page_number in range(1, max_pages + 1):
                page_url = base_url if page_number == 1 else f"{base_url}?page={page_number}"
                page.goto(page_url, wait_until="networkidle", timeout=60000)
                page.wait_for_selector('a[href*="/current_bid_opportunities/"]', timeout=60000)
                row_links = page.locator('table a[href*="/current_bid_opportunities/"]')
                count = row_links.count()
                for index in range(count):
                    href = row_links.nth(index).get_attribute("href")
                    if not href:
                        continue
                    url = normalize_url(href, base_url)
                    if not url or url in seen:
                        continue
                    if any(token in url.lower() for token in ("?page=", "/search", "/privacy", "/terms", "/accessibility")):
                        continue
                    seen.add(url)
                    collected.append(url)
                if count == 0:
                    break
                if page_number >= max_pages:
                    break
            browser.close()
    except Exception:
        pass

    if collected:
        return collected

    for page_number in range(1, max_pages + 1):
        page_url = base_url if page_number == 1 else f"{base_url}?page={page_number}"
        try:
            html = read_html(page_url)
        except Exception:
            break
        page_links = extract_dms_notice_links(html, base_url)
        if not page_links:
            break
        for link in page_links:
            if link not in seen:
                seen.add(link)
                collected.append(link)
    return collected


def parse_event_id(detail_url: str) -> str:
    parsed = urlparse(detail_url)
    last = parsed.path.rstrip("/").split("/")[-1]
    if last:
        return last
    match = re.search(r"[A-Za-z0-9-]+", detail_url)
    return match.group(0) if match else "FL-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def row_to_listing(detail_url: str, title_text: str = "") -> dict | None:
    if not detail_url:
        return None
    event_id = parse_event_id(detail_url)
    title = clean_text(title_text) or event_id.replace("-", " ")
    return {
        "event_id": event_id,
        "event_name": title,
        "department": "Florida Department of Management Services",
        "type": "",
        "start_date_raw": "",
        "end_date_raw": "",
        "detail_url": detail_url,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "raw_html": "",
    }


def fetch_listing_pages(base_url: str = BASE_URLS[0], max_pages: int = 67, reset: bool = False, source: str = "auto") -> list[dict]:
    conn = db_connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            event_name TEXT,
            department TEXT,
            type TEXT,
            start_date_raw TEXT,
            end_date_raw TEXT,
            detail_url TEXT,
            raw_html TEXT,
            scraped_at TEXT
        )
        """
    )
    conn.commit()

    if reset:
        conn.execute("DELETE FROM raw_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_listings'")
        conn.commit()

    source = (source or "auto").lower()
    urls: list[str] = []
    seen_urls: set[str] = set()
    records: list[dict] = []
    mfmp_records_found = False

    if source in {"mfmp", "all", "auto"}:
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 1600, "height": 1200})
                page.goto("https://vendor.myfloridamarketplace.com/search/bids", wait_until="domcontentloaded", timeout=60000)
                page.get_by_label("Start Date").fill("08/15/2026")
                page.get_by_label("End Date").fill("11/13/2026")
                page.get_by_role("button", name="Search").click()
                page.locator(r'text=/\d+ result\(s\) found/i').wait_for(timeout=60000)

                rows = page.locator('div[role="grid"] [role="row"]')
                for idx in range(1, rows.count()):
                    row = rows.nth(idx)
                    links = row.locator('a[href*="/search/bids/"]')
                    if links.count() == 0:
                        continue
                    href = links.first.get_attribute("href")
                    if not href:
                        continue
                    detail_url = normalize_url(href)
                    if detail_url in seen_urls:
                        continue
                    seen_urls.add(detail_url)
                    title = clean_text(row.locator('div[role="gridcell"]').first.inner_text()) if row.locator('div[role="gridcell"]').count() else ""
                    record = row_to_listing(detail_url, title)
                    if record is not None:
                        records.append(record)
                        urls.append(detail_url)
                browser.close()
        except Exception:
            pass

        api_candidates = [
            "https://vendor.myfloridamarketplace.com/mfmp/pub/search/bids",
            "https://vendor.myfloridamarketplace.com/mfmp/pub/search/bids/count",
        ]
        search_payload = build_search_payload(end_date="11/13/2026")

        for api_url in api_candidates:
            try:
                payload = json.dumps(search_payload)
                request = Request(
                    api_url,
                    data=payload.encode("utf-8"),
                    headers={
                        **browser_headers(),
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/plain, */*",
                        "Referer": "https://vendor.myfloridamarketplace.com/search/bids",
                        "Origin": "https://vendor.myfloridamarketplace.com",
                    },
                    method="POST",
                )
                with urlopen(request, timeout=30) as response:
                    response_text = response.read().decode("utf-8", errors="ignore")
                parsed = json.loads(response_text) if response_text.strip().startswith(("[", "{")) else None
                if parsed is not None:
                    api_records = parse_mfmp_records(parsed)
                    if api_records:
                        mfmp_records_found = True
                    for record in api_records:
                        if record["detail_url"] not in urls:
                            urls.append(record["detail_url"])
                            records.append(record)
            except Exception:
                pass

        for candidate_url in [base_url, *BASE_URLS]:
            if not candidate_url or candidate_url in seen_urls:
                continue
            if source == "mfmp" and "dms.myflorida.com" in candidate_url.lower():
                continue
            seen_urls.add(candidate_url)
            try:
                html = read_html(candidate_url)
            except Exception:
                continue

            try:
                parsed = json.loads(html)
            except Exception:
                parsed = None
            if parsed is not None:
                parsed_records = parse_mfmp_records(parsed)
                if parsed_records:
                    mfmp_records_found = True
                for record in parsed_records:
                    if record["detail_url"] not in urls:
                        urls.append(record["detail_url"])
                        records.append(record)
                continue

            for url in extract_candidate_links(html, candidate_url):
                if url not in urls:
                    urls.append(url)

    if source in {"dms", "all"} or (source == "auto" and not mfmp_records_found):
        dms_base = "https://www.dms.myflorida.com/business_operations/state_purchasing/office_of_supplier_development_osd/vendor_resources/current_bid_opportunities"
        for notice_url in collect_dms_notice_pages(dms_base, max_pages=max_pages):
            title = notice_url.rsplit("/", 1)[-1].replace("_", " ")
            try:
                html = read_html(notice_url)
            except Exception:
                html = ""
            detail_url = extract_dms_detail_url(html, notice_url)
            notice_record = {
                "event_id": parse_event_id(notice_url),
                "event_name": title or parse_event_id(notice_url),
                "department": "Florida Department of Management Services",
                "type": "",
                "start_date_raw": "",
                "end_date_raw": "",
                "detail_url": notice_url,
                "raw_html": json.dumps({"notice_url": notice_url, "detail_url": detail_url}, ensure_ascii=False) if detail_url else json.dumps({"notice_url": notice_url}, ensure_ascii=False),
                "scraped_at": datetime.now(timezone.utc).isoformat(),
            }
            if notice_url not in seen_urls:
                seen_urls.add(notice_url)
                urls.append(notice_url)
                records.append(notice_record)

    for detail_url in list(urls):
        if detail_url and detail_url not in {item["detail_url"] for item in records}:
            listing = row_to_listing(detail_url)
            if listing is None:
                continue
            records.append(listing)

    deduped: list[dict] = []
    seen_keys: set[str] = set()
    for listing in records:
        key = listing.get("detail_url") or listing.get("event_id") or ""
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append(listing)
    records = deduped

    for listing in records:
        existing = conn.execute(
            "SELECT 1 FROM raw_listings WHERE detail_url = ? OR event_id = ? LIMIT 1",
            (listing["detail_url"], listing["event_id"]),
        ).fetchone()
        if existing is not None:
            continue
        conn.execute(
            """
            INSERT INTO raw_listings (
                event_id,
                event_name,
                department,
                type,
                start_date_raw,
                end_date_raw,
                detail_url,
                raw_html,
                scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                listing["event_id"],
                listing["event_name"],
                listing["department"],
                listing["type"],
                listing["start_date_raw"],
                listing["end_date_raw"],
                listing["detail_url"],
                listing["raw_html"],
                listing["scraped_at"],
            ),
        )

    conn.commit()
    conn.close()
    return records
