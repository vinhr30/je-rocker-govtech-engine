import os
import time
import json
import logging
import datetime
from typing import List, Dict, Tuple
from urllib.parse import urljoin
import re

from playwright.sync_api import sync_playwright
from drift_suppression import apply_drift_suppression, log_drift_events

# ---------------------------------------------------------
# Config
# ---------------------------------------------------------

REMOTE_DEBUGGING_PORT = 9222

BASE_OUTPUT_DIR = "/Volumes/Data Drive/Govtech/JE ROCKER/ingestion/opportunities"
LOG_FILE = "/Volumes/Data Drive/Govtech/JE ROCKER/utils/logs/scraper.log"

URLS_PASS1_FILE = "urls_pass1.txt"
FAILED_PASS1_FILE = "failed_urls_pass1.txt"
FAILED_PASS2_FILE = "failed_urls_pass2.txt"
FAILED_PASS3_FILE = "failed_urls_pass3.txt"

MAX_PAGES_PER_BATCH = 3000
RESULTS_PER_PAGE = 100  # you set this manually in the UI

# ---------------------------------------------------------
# NAICS dictionary (same as yesterday style)
# ---------------------------------------------------------

NAICS_DICT = {
    "541511": "Custom Computer Programming Services",
    "541512": "Computer Systems Design Services",
    "541513": "Computer Facilities Management Services",
    "541519": "Other Computer Related Services",
    "518210": "Data Processing, Hosting, and Related Services",
    "519190": "All Other Information Services",
    # ... extend as needed, same pattern as yesterday
}


def normalize_naics(naics_code: str) -> Dict[str, str]:
    code = naics_code.strip()
    desc = NAICS_DICT.get(code, "Unknown NAICS")
    return {"naics_code": code, "naics_description": desc}


# ---------------------------------------------------------
# Logging setup
# ---------------------------------------------------------

os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

logging.info("=== SAM Unified Scraper v3 (URL + detail + NAICS) start ===")


# ---------------------------------------------------------
# Date-stamped output folder
# ---------------------------------------------------------

def get_output_dir() -> str:
    today_str = datetime.datetime.now().strftime("%Y-%m-%d")
    run_dir = os.path.join(BASE_OUTPUT_DIR, today_str)
    os.makedirs(run_dir, exist_ok=True)
    logging.info(f"Output directory: {run_dir}")
    return run_dir


# ---------------------------------------------------------
# Playwright CDP attach
# ---------------------------------------------------------

def attach_to_chrome():
    logging.info("Attaching to existing Chrome via CDP")
    playwright = sync_playwright().start()
    browser = playwright.chromium.connect_over_cdp(f"http://localhost:{REMOTE_DEBUGGING_PORT}")
    context = browser.contexts[0]
    page = context.pages[0]
    logging.info("Successfully attached to Chrome")
    return playwright, browser, context, page


# ---------------------------------------------------------
# URL harvesting (100 per page, 3000-page batches)
# ---------------------------------------------------------

def extract_urls_from_page(page) -> List[str]:
    """Extract result URLs from the current search results page.

    This implementation tries several likely selectors and falls back
    to any anchor whose href contains an opportunities path. Relative
    URLs are resolved against the current page URL.
    """

    urls: List[str] = []

    # Candidate selectors (adjust or reorder if your SAM.gov markup differs)
    # Tight selectors targeting the SAM.gov result title anchor
    candidate_selectors = [
        "a.usa-link.ng-star-inserted[href^='/workspace/contract/opp/']",
        "a.usa-link[href^='/workspace/contract/opp/']",
    ]

    for sel in candidate_selectors:
        try:
            elems = page.query_selector_all(sel)
        except Exception:
            elems = []

        if not elems:
            continue

        for el in elems:
            href = el.get_attribute("href")
            if not href:
                continue

            # Resolve relative URLs to absolute
            full = href if href.startswith("http") else urljoin(page.url, href)

            # Basic sanity: must point to an opportunity view and contain expected path
            if "/workspace/contract/opp/" not in full:
                continue
            if "/view" not in full:
                # some links may omit /view; still accept but prefer /view
                pass

            # Filter out tiny or numeric-only link texts like "(1)"
            try:
                txt = el.inner_text().strip()
            except Exception:
                txt = ""
            if len(txt) < 5:
                continue
            if re.match(r"^\(\d+\)$", txt):
                continue

            urls.append(full)

        if urls:
            # If we found URLs with this selector, stop trying others
            break

    # Final fallback: scan anchors for anything that looks like a sam.gov link
    if not urls:
        for el in page.query_selector_all("a"):
            href = el.get_attribute("href")
            if not href:
                continue
            full = href if href.startswith("http") else urljoin(page.url, href)
            if "sam.gov" in full and "/opportunity" in full:
                urls.append(full)

    # Deduplicate while preserving order
    seen = set()
    deduped: List[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            deduped.append(u)

    logging.info(f"Extracted {len(deduped)} URLs from current page using selectors")
    return deduped


def go_to_next_page(page) -> bool:
    next_btn = page.query_selector("button[aria-label='Next']")
    if not next_btn:
        logging.info("No next button found; stopping pagination")
        return False

    disabled = next_btn.get_attribute("disabled")
    if disabled:
        logging.info("Next button disabled; last page reached")
        return False

    next_btn.click()
    time.sleep(3)
    logging.info("Moved to next page")
    return True


def harvest_urls(page, run_dir: str) -> List[str]:
    all_urls: List[str] = []
    page_index = 1
    batch_count = 0

    urls_file_path = os.path.join(run_dir, URLS_PASS1_FILE)

    logging.info("Starting URL harvesting phase")

    while True:
        logging.info(f"Harvesting URLs from page {page_index}")
        page_urls = extract_urls_from_page(page)
        all_urls.extend(page_urls)

        batch_count += 1

        if batch_count >= MAX_PAGES_PER_BATCH:
            logging.info(
                f"Reached {MAX_PAGES_PER_BATCH} pages in this batch. "
                f"Total URLs so far: {len(all_urls)}"
            )
            # Write intermediate URLs to disk
            with open(urls_file_path, "w", encoding="utf-8") as f:
                for u in all_urls:
                    f.write(u + "\n")
            logging.info(f"URLs written to {urls_file_path}")

            input("Batch limit reached. Press Enter in Terminal 2 to continue to next 3000 pages...")

            batch_count = 0  # reset batch counter

        if not go_to_next_page(page):
            break

        page_index += 1

    # Final write
    with open(urls_file_path, "w", encoding="utf-8") as f:
        for u in all_urls:
            f.write(u + "\n")

    logging.info(f"URL harvesting complete. Total URLs: {len(all_urls)}")
    logging.info(f"Final URLs written to {urls_file_path}")

    return all_urls


# ---------------------------------------------------------
# Detail scraping (per URL, selectors, NAICS normalization)
# ---------------------------------------------------------

def extract_detail_from_page(page, url: str) -> Dict:
    """
    Extract all relevant fields from the detail page using selectors and inner_text().
    This mirrors the behavior of your v3: text-based extraction, not JSON parsing.
    """

    logging.info(f"Extracting detail from: {url}")

    def safe_text(selector: str) -> str:
        el = page.query_selector(selector)
        return el.inner_text().strip() if el else ""

    # These selectors are placeholders; they match the idea of your v3,
    # which used text extraction from the visible page.
    title = safe_text("h1")
    notice_id = safe_text("span[data-testid='notice-id']")
    agency = safe_text("span[data-testid='agency']")
    office = safe_text("span[data-testid='office']")
    naics_raw = safe_text("span[data-testid='naics-code']")
    psc = safe_text("span[data-testid='psc-code']")
    set_aside = safe_text("span[data-testid='set-aside']")
    description = safe_text("div[data-testid='description']")
    place_of_performance = safe_text("div[data-testid='place-of-performance']")
    contact = safe_text("div[data-testid='contact-info']")
    posted_date = safe_text("span[data-testid='posted-date']")
    response_date = safe_text("span[data-testid='response-date']")

    naics_info = normalize_naics(naics_raw)

    record = {
        "url": url,
        "title": title,
        "notice_id": notice_id,
        "agency": agency,
        "office": office,
        "naics_code": naics_info["naics_code"],
        "naics_description": naics_info["naics_description"],
        "psc_code": psc,
        "set_aside": set_aside,
        "description": description,
        "place_of_performance": place_of_performance,
        "contact_info": contact,
        "posted_date": posted_date,
        "response_date": response_date,
    }

    stable = apply_drift_suppression({
        "naics": record["naics_code"],
        "psc": record["psc_code"],
        "agency": record["agency"],
        "grantCategory": record["set_aside"],
    })
    log_drift_events(stable["driftEvents"])
    final_opportunity = {
        **record,
        "stableNaics": stable["stableNaics"],
        "stablePsc": stable["stablePsc"],
        "stableAgency": stable["stableAgency"],
        "stableModernization": stable["stableModernization"],
        "stableGrantCategory": stable["stableGrantCategory"],
        "stableCapabilityZone": stable["stableCapabilityZone"],
    }

    logging.info(f"Extracted record for {url}: {record['notice_id']} / {record['title']}")
    return final_opportunity


def upsert_record(record: Dict):
    """
    Stub for upsert into Opportunities DB.
    In your real v3, this called your ingestion/upsert pipeline.
    Here we just log; you can wire this into your DB layer.
    """
    # Example: call your DB function here
    # opportunities_upsert(record)
    logging.info(f"Upserted record: {record.get('notice_id', '')} / {record.get('title', '')}")


def scrape_detail_urls(
    page,
    urls: List[str],
    run_dir: str,
    pass_label: str,
    failed_file_name: str,
) -> Tuple[int, List[str]]:
    failed_urls: List[str] = []
    count = 0

    failed_path = os.path.join(run_dir, failed_file_name)

    logging.info(f"Starting detail scraping {pass_label}. URLs: {len(urls)}")

    for url in urls:
        try:
            logging.info(f"[{pass_label}] Navigating to {url}")
            page.goto(url, wait_until="load")
            time.sleep(2)

            record = extract_detail_from_page(page, url)
            upsert_record(record)
            count += 1

        except Exception as e:
            logging.error(f"[{pass_label}] Failed to scrape {url}: {e}")
            failed_urls.append(url)

    if failed_urls:
        with open(failed_path, "w", encoding="utf-8") as f:
            for u in failed_urls:
                f.write(u + "\n")
        logging.info(f"[{pass_label}] Failed URLs written to {failed_path}")
    else:
        logging.info(f"[{pass_label}] No failed URLs")

    logging.info(f"[{pass_label}] Detail scraping complete. Success: {count}, Failed: {len(failed_urls)}")

    return count, failed_urls


# ---------------------------------------------------------
# Main orchestration (minimal debug version)
# ---------------------------------------------------------

def main():
    print(">>> MAIN() STARTED")
    run_dir = get_output_dir()
    print(f">>> OUTPUT DIR: {run_dir}")

    playwright, browser, context, page = attach_to_chrome()
    print(">>> ATTACHED TO CHROME")

    urls = harvest_urls(page, run_dir)
    print(f">>> HARVESTED {len(urls)} URLS")

    pass1_count, failed_pass1 = scrape_detail_urls(
        page,
        urls,
        run_dir,
        pass_label="Pass 1",
        failed_file_name=FAILED_PASS1_FILE,
    )
    print(f">>> PASS 1 DONE: {pass1_count} success, {len(failed_pass1)} failed")


# ---------------------------------------------------------
# Entry point
# ---------------------------------------------------------

if __name__ == "__main__":
    print(">>> FILE EXECUTED, CALLING MAIN()")
    main()
