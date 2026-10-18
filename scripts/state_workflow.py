import argparse
import importlib
import inspect
import json
import hashlib
from pathlib import Path
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
STATES = {"AZ": "arizona", "CA": "california", "TX": "texas",
          "FL": "florida", "VA": "virginia", "NY": "new_york"}


class BrowserFallback:
    def __init__(self, state, listings, output_dir, max_pages):
        self.state = state
        self.listings = listings
        self.output_dir = output_dir
        self.max_pages = max_pages
        self.listing_reads = 0
        self.evidence = []
        self.issues = []
        self.cache = {}
        self.blocked_urls = {}

    def read(self, url, timeout=30):
        from playwright.sync_api import sync_playwright
        from bs4 import BeautifulSoup

        if url in self.cache:
            return self.cache[url]
        if url in self.blocked_urls:
            raise RuntimeError(self.blocked_urls[url])
        base_url = getattr(self.listings, "BASE_URL", None)
        if base_url is None:
            base_url = getattr(self.listings, "BASE_URLS", [""])[0]
        listing = url.split("?")[0] == base_url.split("?")[0]
        if listing and self.listing_reads >= self.max_pages:
            return ""
        if listing:
            self.listing_reads += 1
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=10000)
            if not browser.contexts:
                raise RuntimeError("Open Miller's debugging Chrome profile first")
            page = browser.contexts[0].new_page()
            keep_open = False
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                deadline = time.monotonic() + min(timeout, 30)
                while True:
                    body = page.locator("body").inner_text(timeout=10000)
                    if any(marker in body.lower() for marker in ("verify you are human", "browser check", "security check", "captcha", "access denied")):
                        keep_open = True
                        self.issues.append("manual_browser_verification_required: " + url)
                        break
                    html = page.content()
                    if listing:
                        if self.state == "AZ":
                            ready = bool(BeautifulSoup(html, "html.parser").select("#body_x_grid_grd tr[data-id]"))
                        elif self.state == "VA":
                            ready = bool(self.listings._extract_rows_from_html(html))
                        else:
                            soup = BeautifulSoup(html, "html.parser")
                            ready = any(record and record.get("detail_url") for row in self.listings._extract_listing_rows(soup)
                                        if (record := self.listings.row_to_listing(row, page.url)))
                    else:
                        ready = len(body.strip()) > 200 and not any(marker in body.lower() for marker in ("searching...", "waiting for results"))
                    if ready:
                        break
                    if time.monotonic() >= deadline:
                        keep_open = True
                        self.issues.append("rendered_results_unavailable: " + url)
                        break
                    page.wait_for_timeout(250)
                html = page.content()
                name = hashlib.sha256(url.encode()).hexdigest()
                image = self.output_dir / (name + ".png")
                page.screenshot(path=str(image), full_page=True, timeout=30000)
                (self.output_dir / (name + ".html")).write_text(html, encoding="utf-8")
                self.evidence.append({"url": page.url, "snapshot_path": str(image),
                                      "snapshot_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                                      "purpose": "supplementary_browser_evidence",
                                      "browser_tab_left_open": keep_open})
                if keep_open:
                    self.blocked_urls[url] = self.issues[-1]
                    raise RuntimeError(self.issues[-1])
                self.cache[url] = html
                return html
            finally:
                if not keep_open:
                    page.close()


def run_workflow(state, output_dir, max_pages=1, max_details=10):
    if state not in STATES:
        raise ValueError("Unsupported state")
    if type(max_pages) is not int or not 1 <= max_pages <= 10:
        raise ValueError("State discovery limit must be between 1 and 10 pages")
    if type(max_details) is not int or not 1 <= max_details <= 100:
        raise ValueError("State detail limit must be between 1 and 100 records")
    modules = {name: importlib.import_module(f"ingestion.states.{STATES[state]}.{name}")
               for name in ("listings", "details", "normalize")}
    if any(getattr(module, "BeautifulSoup", True) is None for module in modules.values()):
        raise RuntimeError("BeautifulSoup is required for state workflows")
    output_dir.mkdir(parents=True, exist_ok=False)
    database = output_dir / f"opportunities_{state}.db"
    for module in modules.values():
        module.DB_PATH = database
    discovery = modules["listings"].fetch_listing_pages
    parameters = inspect.signature(discovery).parameters
    options = {}
    if "max_pages" in parameters:
        options["max_pages"] = max_pages
    if "allow_partial" in parameters:
        options["allow_partial"] = True
    fallback = BrowserFallback(state, modules["listings"], output_dir, max_pages)
    if state == "AZ":
        modules["listings"].sync_playwright = None
        modules["listings"].read_html = fallback.read
    try:
        discovery(**options)
    except Exception as error:
        if not fallback.issues:
            raise
        fallback.issues.append(f"browser_discovery: {error}")
    with sqlite3.connect(database) as connection:
        initial_count = connection.execute("SELECT COUNT(*) FROM raw_listings").fetchone()[0]
    if not initial_count and state in ("CA", "VA"):
        modules["listings"].read_html = fallback.read
        if hasattr(modules["listings"], "browser_render_html"):
            modules["listings"].browser_render_html = fallback.read
        try:
            discovery(**options)
        except Exception as error:
            fallback.issues.append(f"browser_discovery: {error}")
    with sqlite3.connect(database) as connection:
        discovered = connection.execute("SELECT COUNT(*) FROM raw_listings").fetchone()[0]
        connection.execute("DELETE FROM raw_listings WHERE id NOT IN (SELECT id FROM raw_listings ORDER BY id LIMIT ?)", (max_details,))
    modules["details"].hydrate_details()
    with sqlite3.connect(database) as connection:
        initial_details = connection.execute("SELECT COUNT(*) FROM raw_details").fetchone()[0]
    if discovered and not initial_details and state in ("AZ", "CA", "VA"):
        modules["details"].read_html = fallback.read
        modules["details"].hydrate_details()
    modules["normalize"].normalize_records()
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        records = [dict(row) for row in connection.execute("SELECT * FROM normalized_listings ORDER BY id")]
        hydrated = connection.execute("SELECT COUNT(*) FROM raw_details").fetchone()[0]
        selected_rows = [dict(row) for row in connection.execute("SELECT * FROM raw_listings ORDER BY id")]
    (output_dir / "parsed_records.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    for row in selected_rows:
        address = row.get("detail_url")
        if not address or address in fallback.cache:
            continue
        try:
            fallback.read(address)
        except Exception as error:
            fallback.issues.append(f"supplementary_evidence: {error}")
    report = {"state": state, "extraction_method": "state_workflow",
              "workflow": "original_state_pipeline_with_targeted_browser_fallback",
              "browser_evidence": fallback.evidence, "quality_issues": fallback.issues,
              "database_path": str(database), "discovered_records": discovered,
              "selected_records": min(discovered, max_details), "hydrated_records": hydrated,
              "structured_data": records, "review_required": True,
              "requested_max_pages": max_pages, "max_details": max_details,
              "discovery_page_limit_supported": "max_pages" in parameters or state == "AZ",
              "status": ("no_records_requires_review" if not records else
                         "partial_hydration_requires_review" if hydrated < min(discovered, max_details) else
                         "evidence_requires_review" if fallback.issues else "completed_for_review")}
    (output_dir / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Isolated six-state discovery, hydration and normalization")
    parser.add_argument("--state", choices=list(STATES), required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--max-details", type=int, default=10)
    args = parser.parse_args()
    report = run_workflow(args.state, args.output_dir, args.max_pages, args.max_details)
    print(json.dumps({key: value for key, value in report.items() if key != "structured_data"}))