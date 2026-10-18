import hashlib
import importlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PORTALS = {
    "AZ": {"module": "arizona", "url": "https://app.az.gov/page.aspx/en/rfp/request_browse_public", "ready": "#body_x_grid_grd tr[data-id]"},
    "CA": {"module": "california", "url": "https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx", "ready": "tr[id^='trRESP_'], tr[data-if-label^='tblBodyTr']"},
    "TX": {"module": "texas", "url": "https://www.txsmartbuy.gov/esbd", "ready": "table tr:has(td)"},
    "FL": {"module": "florida", "url": "https://vendor.myfloridamarketplace.com/", "ready": "a[href*='notice'], a[href*='solicitation'], a[href*='bid']"},
    "VA": {"module": "virginia", "url": "https://mvendor.cgieva.com/Vendor/public/AllOpportunities.jsp", "ready": "table tr:has(td), .card"},
    "NY": {"module": "new_york", "url": "https://www.nyscr.ny.gov/", "ready": "div[title*='Full Title:']"},
}


def listing_records(state, html, url, page_number):
    module = importlib.import_module(f"ingestion.states.{PORTALS[state]['module']}.listings")
    soup = BeautifulSoup(html, "html.parser")
    if state == "NY":
        return module.extract_listing_rows(html, url)
    if state == "VA":
        return module._extract_rows_from_html(html)
    if state == "FL":
        return [record for address in module.extract_candidate_links(html, url)
                if (record := module.row_to_listing(address))]
    if state == "AZ":
        return [record for row in soup.select("#body_x_grid_grd tr[data-id]")
                if (record := module.row_to_listing(row, url, page_number))]
    return [record for row in module._extract_listing_rows(soup)
            if (record := module.row_to_listing(row, url))]


def save_evidence(page, directory, name, records):
    image = directory / f"{name}.png"
    sidecar = directory / f"{name}.json"
    page.screenshot(path=str(image), full_page=True, timeout=30000)
    sidecar.write_text(json.dumps(records, indent=2), encoding="utf-8")
    (directory / f"{name}.html").write_text(page.content(), encoding="utf-8")
    return {"snapshot_path": str(image), "dom_path": str(sidecar),
            "snapshot_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
            "dom_sha256": hashlib.sha256(sidecar.read_bytes()).hexdigest(), "url": page.url}


def challenge(page):
    text = page.locator("body").inner_text(timeout=10000).lower()
    return any(marker in text for marker in ("verify you are human", "browser check", "security check", "access denied", "captcha"))


def run_browser_workflow(context, state, output_dir, max_pages=1, max_details=10):
    if state not in PORTALS or type(max_pages) is not int or not 1 <= max_pages <= 10:
        raise ValueError("Supported state and 1-10 discovery pages required")
    if type(max_details) is not int or not 1 <= max_details <= 100:
        raise ValueError("Detail limit must be 1-100")
    output_dir.mkdir(parents=True, exist_ok=False)
    config = PORTALS[state]
    page = context.new_page()
    records, evidence, issues = [], [], []
    seen = set()
    keep_open = False
    try:
        page.goto(config["url"], wait_until="domcontentloaded", timeout=45000)
        for number in range(1, max_pages + 1):
            if challenge(page):
                keep_open = True
                issues.append("manual_browser_verification_required")
                evidence.append(save_evidence(page, output_dir, f"listing_{number}", []))
                break
            try:
                page.locator(config["ready"]).first.wait_for(state="visible", timeout=20000)
            except Exception:
                keep_open = True
                issues.append("listing_controls_not_ready_requires_manual_review")
                evidence.append(save_evidence(page, output_dir, f"listing_{number}", []))
                break
            rows = listing_records(state, page.content(), page.url, number)
            evidence.append(save_evidence(page, output_dir, f"listing_{number}", rows))
            for record in rows:
                address = record.get("detail_url")
                if address and address not in seen:
                    seen.add(address)
                    records.append(record)
            if not rows:
                issues.append("no_listing_records_parsed")
                break
            if number < max_pages:
                next_button = page.get_by_role("button", name=re.compile(r"^(next|next page|>)$", re.I)).or_(
                    page.get_by_role("link", name=re.compile(r"^(next|next page|>)$", re.I))).first
                if not next_button.count() or not next_button.is_visible() or not next_button.is_enabled():
                    issues.append("pagination_end_or_adapter_requires_configuration")
                    break
                before = page.locator(config["ready"]).all_text_contents()
                next_button.click()
                page.wait_for_function("({selector, previous}) => JSON.stringify(Array.from(document.querySelectorAll(selector), node => node.innerText)) !== JSON.stringify(previous)",
                                       arg={"selector": config["ready"], "previous": before}, timeout=20000)
        details = importlib.import_module(f"ingestion.states.{config['module']}.details")
        hydrated = 0
        for index, record in enumerate(records[:max_details], 1):
            address = record["detail_url"]
            if urlparse(address).scheme not in ("http", "https"):
                issues.append("unsupported_detail_url")
                continue
            try:
                page.goto(address, wait_until="domcontentloaded", timeout=45000)
                page.locator("body").wait_for(state="visible")
                if challenge(page):
                    keep_open = True
                    issues.append("manual_detail_verification_required")
                    evidence.append(save_evidence(page, output_dir, f"detail_{index}", []))
                    break
                if state == "VA":
                    extracted = details.extract_detail_fields(page.content(), fallback=record)
                elif state == "NY":
                    extracted = details.extract_detail_metadata(page.content(), page.url)
                else:
                    extracted = details.extract_details_from_html(page.content(), page.url)
                record["browser_details"] = extracted
                evidence.append(save_evidence(page, output_dir, f"detail_{index}", extracted))
                hydrated += 1
            except Exception as error:
                issues.append(f"detail_{index}: {type(error).__name__}: {error}")
        report = {"state": state, "extraction_method": "state_workflow", "transport": "persistent_chrome_dom_snapshot",
                  "structured_data": records[:max_details], "discovered_records": len(records),
                  "selected_records": min(len(records), max_details), "hydrated_records": hydrated,
                  "evidence": evidence, "quality_issues": issues, "review_required": True,
                  "status": "requires_manual_review" if issues or not records else "captured_for_review",
                  "requested_max_pages": max_pages, "max_details": max_details,
                  "browser_tab_left_open": keep_open}
        (output_dir / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        return report
    finally:
        if not keep_open:
            page.close()