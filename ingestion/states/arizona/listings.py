from __future__ import annotations

import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover
    sync_playwright = None

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_AZ.db"
BASE_URL = "https://app.az.gov/page.aspx/en/rfp/request_browse_public"
MAX_PAGES = 500
BROWSER_CONTEXTS = (
    {
        "viewport": {"width": 1440, "height": 1200},
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "locale": "en-US",
    },
    {
        "viewport": {"width": 1366, "height": 768},
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "locale": "en-US",
    },
    {
        "viewport": {"width": 1440, "height": 1200},
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "locale": "en-US",
    },
)


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_columns(conn: sqlite3.Connection, table_name: str, columns: list[str]) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}
    for column_sql in columns:
        name = column_sql.split()[0]
        if name not in existing:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}")


def read_html(url: str, timeout: int = 30) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=timeout) as response:
        html = response.read()
    return html.decode("utf-8", errors="ignore")


def clean_text(value: str | None) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", value).strip()


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


def should_retry_browser_check(html: str | None, attempt: int, max_attempts: int = 3) -> bool:
    return is_browser_check_page(html) and attempt < max_attempts


def row_to_listing(tr, page_url: str, page_number: int) -> dict | None:
    if BeautifulSoup is None:
        return None

    cells = [cell for cell in tr.find_all("td", attrs={"data-iv-role": "cell"})]
    if not cells and tr.find_all("td"):
        cells = tr.find_all("td")
    if len(cells) < 6:
        return None

    detail_anchor = tr.select_one("a[href*='/bpm/process_manage_extranet/']")
    if not detail_anchor:
        return None

    href = detail_anchor.get("href")
    if not href:
        return None

    detail_url = urljoin(page_url, href)

    cell_texts = [clean_text(cell.get_text(" ", strip=True)) for cell in cells]
    solicitation_id = next((value for value in cell_texts if re.fullmatch(r"[A-Za-z]+\d+", value)), "")
    title = ""
    if len(cell_texts) >= 3:
        title = cell_texts[2]
    if not title:
        title = clean_text(detail_anchor.get_text(" ", strip=True).replace("Edit ", "", 1))

    agency = cell_texts[5] if len(cell_texts) >= 6 else ""
    category = cell_texts[4] if len(cell_texts) >= 5 else ""
    status = ""
    for value in cell_texts:
        if re.search(r"open for bidding|cancelled|rfx awarded|closed|awarded|rejected|draft", value, flags=re.I):
            status = value
            break
    if not status and len(cell_texts) >= 6:
        status = cell_texts[5]
    posted_date_raw = cell_texts[3] if len(cell_texts) >= 4 else ""
    due_date_raw = cell_texts[11] if len(cell_texts) >= 12 else (cell_texts[6] if len(cell_texts) >= 7 else "")

    if not solicitation_id:
        match = re.search(r"process_manage_extranet/(\d+)", detail_url, flags=re.I)
        if match:
            solicitation_id = match.group(1)

    if not title:
        title = clean_text(detail_anchor.get_text(" ", strip=True))

    return {
        "solicitation_id": solicitation_id,
        "title": title,
        "agency": agency,
        "category": category,
        "status": status,
        "posted_date_raw": posted_date_raw,
        "due_date_raw": due_date_raw,
        "detail_url": detail_url,
        "page_number": page_number,
        "raw_html": str(tr),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def extract_next_page_index(html: str) -> tuple[int, int] | None:
    pattern = re.search(r"GoToPageOfGrid\(\s*(\d+)\s*,\s*(\d+)\s*\)", html or "")
    if pattern:
        return int(pattern.group(1)), int(pattern.group(2))

    for button in re.finditer(r"<button[^>]*aria-label=\"[Nn]ext page\"[^>]*data-page-index=\"(\d+)\"[^>]*>", html or ""):
        try:
            return 0, int(button.group(1))
        except ValueError:
            pass

    return None


def next_page_url_from_soup(soup: BeautifulSoup, current_url: str) -> str | None:
    for link in soup.select("a[href]"):
        href = link.get("href")
        if not href:
            continue
        text = clean_text(link.get_text(" ", strip=True)).lower()
        if "next" in text or "page" in text:
            if text.startswith("page") or text.startswith("next"):
                return urljoin(current_url, href)
    return None


def insert_listing_record(conn: sqlite3.Connection, listing: dict) -> None:
    conn.execute(
        """
        INSERT INTO raw_listings (
            solicitation_id,
            title,
            agency,
            category,
            status,
            posted_date_raw,
            due_date_raw,
            detail_url,
            page_number,
            raw_html,
            scraped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            listing.get("solicitation_id") or "",
            listing.get("title") or "",
            listing.get("agency") or "",
            listing.get("category") or "",
            listing.get("status") or "",
            listing.get("posted_date_raw") or "",
            listing.get("due_date_raw") or "",
            listing.get("detail_url") or "",
            listing.get("page_number") or 0,
            listing.get("raw_html") or "",
            listing.get("scraped_at") or "",
        ),
    )
    conn.commit()


def fetch_listing_pages(
    base_url: str = BASE_URL,
    db_path: str | Path | None = None,
    reset: bool = False,
    allow_partial: bool = True,
) -> list[dict]:
    db_target = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(str(db_target))
    if reset:
        conn.execute("DELETE FROM raw_listings")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'raw_listings'")
        conn.commit()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            solicitation_id TEXT,
            title TEXT,
            agency TEXT,
            category TEXT,
            status TEXT,
            posted_date_raw TEXT,
            due_date_raw TEXT,
            detail_url TEXT,
            page_number INTEGER,
            raw_html TEXT,
            scraped_at TEXT
        )
        """
    )
    conn.commit()
    ensure_columns(conn, "raw_listings", ["status TEXT"])
    conn.commit()

    current_url = base_url
    current_page = 1
    results: list[dict] = []
    seen_urls: set[str] = set()

    def handle_browser_check(html: str | None, attempt: int, *, return_partial: bool) -> bool:
        if not is_browser_check_page(html):
            return False
        if should_retry_browser_check(html, attempt):
            print(f"[AZ listings] browser challenge detected on attempt {attempt}; retrying with a fresh context after a brief backoff.")
            return False
        if return_partial:
            print("[AZ listings] browser challenge detected; keeping partial Arizona results and stopping gracefully.")
            return True
        print("[AZ listings] browser challenge detected; stopping crawl after retry budget is exhausted.")
        return True

    if sync_playwright is not None:
        max_context_attempts = 3
        for attempt in range(1, max_context_attempts + 1):
            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    context = browser.new_context(**BROWSER_CONTEXTS[(attempt - 1) % len(BROWSER_CONTEXTS)])
                    page = context.new_page()
                    page.add_init_script("Object.defineProperty(window.navigator, 'webdriver', { get: () => undefined });")
                    try:
                        page.goto(base_url, wait_until="domcontentloaded", timeout=120000)
                        page.wait_for_timeout(1500)
                        page.wait_for_selector("#body_x_grid_grd", timeout=30000)
                    except Exception:
                        html = page.content()
                        if handle_browser_check(html, attempt, return_partial=allow_partial):
                            context.close(); browser.close(); conn.close(); return results
                        if is_browser_check_page(html) and attempt < max_context_attempts:
                            context.close(); browser.close(); time.sleep(1.5 * attempt); continue
                        raise

                    for page_number in range(1, MAX_PAGES + 1):
                        html = page.content()
                        if handle_browser_check(html, attempt, return_partial=allow_partial):
                            context.close(); browser.close(); conn.close(); return results
                        soup = BeautifulSoup(html, "html.parser")
                        grid = soup.select_one("#body_x_grid_grd")
                        rows = grid.select("tr[data-id]") if grid else []
                        if not rows:
                            break

                        for tr in rows:
                            listing = row_to_listing(tr, current_url, page_number)
                            if listing is None:
                                continue
                            if listing["detail_url"] in seen_urls:
                                continue
                            seen_urls.add(listing["detail_url"])
                            existing = conn.execute(
                                "SELECT 1 FROM raw_listings WHERE detail_url = ? LIMIT 1",
                                (listing["detail_url"],),
                            ).fetchone()
                            if existing is None:
                                insert_listing_record(conn, listing)
                                results.append(listing)

                        next_button = page.locator("button[aria-label='Next page'], #body_x_grid_gridPagerBtnNextPage")
                        if next_button.count() == 0:
                            break
                        if next_button.evaluate("el => el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'"):
                            break
                        try:
                            next_button.click()
                        except Exception:
                            page.locator("button:has-text('2')").first.click()
                        page.wait_for_timeout(2000)
                        try:
                            page.wait_for_selector("#body_x_grid_grd", timeout=60000)
                        except Exception:
                            html_after = page.content()
                            if handle_browser_check(html_after, attempt, return_partial=allow_partial):
                                context.close(); browser.close(); conn.close(); return results
                            if is_browser_check_page(html_after) and attempt < max_context_attempts:
                                context.close(); browser.close(); time.sleep(1.5 * attempt); break
                            raise

                    context.close(); browser.close(); conn.close(); return results
            except Exception:
                if allow_partial and results:
                    print("[AZ listings] challenge or page-load issue encountered; returning partial Arizona results.")
                    conn.close(); return results
                if attempt < max_context_attempts:
                    time.sleep(1.5 * attempt)
                    continue
                raise

    browser_attempt = 0
    while True:
        browser_attempt += 1
        html = read_html(current_url)
        if BeautifulSoup is None:
            break
        if handle_browser_check(html, browser_attempt, return_partial=allow_partial):
            break
        if is_browser_check_page(html) and should_retry_browser_check(html, browser_attempt):
            time.sleep(1.5 * browser_attempt)
            continue

        soup = BeautifulSoup(html, "html.parser")
        grid = soup.select_one("#body_x_grid_grd")
        rows = grid.select("tr[data-id]") if grid else []
        if not rows:
            break

        for tr in rows:
            listing = row_to_listing(tr, current_url, current_page)
            if listing is None:
                continue
            if listing["detail_url"] in seen_urls:
                continue
            seen_urls.add(listing["detail_url"])
            existing = conn.execute(
                "SELECT 1 FROM raw_listings WHERE detail_url = ? LIMIT 1",
                (listing["detail_url"],),
            ).fetchone()
            if existing is None:
                insert_listing_record(conn, listing)
                results.append(listing)

        next_page = next_page_url_from_soup(soup, current_url)
        if not next_page:
            next_page_index = extract_next_page_index(html)
            if next_page_index is None:
                break
            if next_page_index[1] <= current_page:
                break
            current_url = base_url
            current_page = next_page_index[1]
            time.sleep(1)
            continue

        current_url = next_page
        current_page += 1
        time.sleep(1)

    conn.close()
    return results


scrape_listings = fetch_listing_pages

if __name__ == "__main__":
    fetch_listing_pages()
