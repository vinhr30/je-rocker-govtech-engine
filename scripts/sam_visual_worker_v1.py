import argparse
import hashlib
import importlib
import json
import logging
import os
import re
from pathlib import Path
import socket
import sys
import subprocess
import time
from uuid import uuid4
from datetime import date, timedelta
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
LOGGER = logging.getLogger("sam_visual_worker")
NEVADA_OPEN_BIDS_URL = "https://nevadaepro.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true"
STATE_DOM_CAPTURE_URLS = {
    "AZ": "https://app.az.gov/page.aspx/en/rfp/request_browse_public",
    "CA": "https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx",
    "TX": "https://www.txsmartbuy.gov/esbd",
    "FL": "https://vendor.myfloridamarketplace.com/search/bids",
    "VA": "https://mvendor.cgieva.com/Vendor/public/AllOpportunities.jsp",
    "NY": "https://www.nyscr.ny.gov/Ads/Search?Skip=0&Top=25&Status=Open&DateFilter=All&Sort=-DateIssued",
    "CO": "https://prd.co.cgiadvantage.com/PRDVSS1X1/Advantage4",
    "ID": "https://purchasing.idaho.gov/open-and-future-solicitations/",
    "MT": "https://bids.sciquest.com/apps/Router/PublicEvent?CustomerOrg=StateOfMontana",
    "NM": "https://spd.gsd.state.nm.us/WebPortal/Modules/Procurement/Public/ProcurementsWebView.aspx",
    "OR": "https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true",
    "UT": "https://utah.bonfirehub.com/portal/?tab=openOpportunities",
    "WA": "https://pr-webs-vendor.des.wa.gov/BidCalendar.aspx",
    "WY": "https://www.publicpurchase.com/gems/wyominggsd,wy/buyer/public/publicInfo",
    "AK": "https://iris-vss.alaska.gov/",
    "HI": "https://hands.ehawaii.gov/hands/opportunities",
}
STATE_DOM_SOURCES = {
    "AZ": "arizona", "CA": "california", "TX": "texas", "FL": "florida",
    "VA": "virginia", "NY": "new_york", "CO": "colorado", "ID": "idaho",
    "MT": "montana", "NM": "new_mexico", "OR": "oregon", "UT": "utah",
    "WA": "washington", "WY": "wyoming", "AK": "alaska", "HI": "hawaii",
}
STATE_DOM_PATHS = {
    "arizona": "/page.aspx/en/rfp/request_browse_public",
    "california": "/pages/Events-BS3/event-search.aspx",
    "texas": "/esbd",
    "florida": "/search/bids",
    "virginia": "/Vendor/public/AllOpportunities.jsp",
    "new_york": "/Ads/Search",
    "colorado": "/PRDVSS1X1/Advantage4",
    "idaho": "/open-and-future-solicitations/",
    "montana": "/apps/Router/PublicEvent",
    "new_mexico": "/WebPortal/Modules/Procurement/Public/ProcurementsWebView.aspx",
    "oregon": "/bso/view/search/external/advancedSearchBid.xhtml",
    "utah": "/portal/",
    "washington": "/BidCalendar.aspx",
    "wyoming": "/gems/wyominggsd,wy/buyer/public/publicInfo",
    "alaska": "/",
    "hawaii": "/hands/opportunities",
}
SOURCES = {
    "sam.gov": None,
    "purchasing.nv.gov": "nevada",
    "nevadaepro.com": "nevada_open_bids",
    "az.gov": "arizona",
    "caleprocure.ca.gov": "california",
    "txsmartbuy.gov": "texas",
    "myflorida.com": "florida",
    "myfloridamarketplace.com": "florida",
    "myfloridamarketplace.my.site.com": "florida",
    "cgieva.com": "virginia",
    "eva.virginia.gov": "virginia",
    "nyscr.ny.gov": "new_york",
    "prd.co.cgiadvantage.com": "colorado",
    "purchasing.idaho.gov": "idaho",
    "bids.sciquest.com": "montana",
    "spd.gsd.state.nm.us": "new_mexico",
    "oregonbuys.gov": "oregon",
    "utah.bonfirehub.com": "utah",
    "pr-webs-vendor.des.wa.gov": "washington",
    "publicpurchase.com": "wyoming",
    "iris-vss.alaska.gov": "alaska",
    "hands.ehawaii.gov": "hawaii",
}


def source_for(url):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Only supported public HTTPS procurement URLs are accepted")
    for domain, source in SOURCES.items():
        if host == domain or host.endswith("." + domain):
            return source
    raise ValueError("Unsupported procurement hostname")


def extract_details(source, html, url):
    if source is None or source in ("nevada", "nevada_open_bids"):
        return {}
    module = importlib.import_module(f"ingestion.states.{source}.details")
    if source == "virginia":
        return module.extract_detail_fields(html, fallback={"url": url})
    if source == "new_york":
        return module.extract_detail_metadata(html, url)
    return module.extract_details_from_html(html, url)


def state_workflow_capture_task(task):
    if task.get("state") != "NV":
        return None
    if not task.get("id"):
        raise ValueError("Nevada state workflow requires a job id")
    return {"id": task["id"], "type": "capture", "url": NEVADA_OPEN_BIDS_URL,
            "max_pages": 1, "state": "NV"}


def state_dom_capture_task(task):
    state = task.get("state")
    if state not in STATE_DOM_CAPTURE_URLS:
        raise ValueError("State DOM capture requires a configured state code")
    if not task.get("id"):
        raise ValueError("State DOM capture requires a job id")
    max_pages = task.get("max_pages", 3)
    if isinstance(max_pages, bool) or not isinstance(max_pages, int) or not 1 <= max_pages <= 10:
        raise ValueError("State DOM snapshot page limit must be an integer between 1 and 10")
    return {"id": task["id"], "type": "capture", "url": STATE_DOM_CAPTURE_URLS[state],
            "max_pages": max_pages, "state": state}


def prepare_sam_search(page):
    from playwright.sync_api import expect

    LOGGER.info("Preparing SAM search: wildcard, 100 results; no date filter applied")
    keyword = page.locator("input#newSimpleSearch, input#search-keyword, input[type='search']").first
    keyword.fill("*", timeout=15000)
    page.locator("button[aria-label='New Search'], button.usa-search-submit, button[aria-label='Search']").first.click()
    page_size = page.locator("select#bottomPagination-select, select#show-results-per-page, select[aria-label='Results per page']").first
    page_size.select_option(label="100")
    expect(page_size.locator("option:checked")).to_have_text("100")
    current_page = page.locator("input#bottomPagination-currentPage")
    next_page = page.locator("button#bottomPagination-nextPage, button[aria-label='Next page'], li.next a").first
    expect(next_page).to_be_visible()
    if not next_page.is_enabled() or next_page.get_attribute("aria-disabled") == "true":
        LOGGER.info("SAM results fit on one page; skipping pagination hydration")
        return
    if not current_page.count():
        raise RuntimeError("Cannot verify SAM pagination: current-page control is missing")
    expect(current_page).to_have_value("1")
    next_page.click()
    expect(current_page).to_have_value("2", timeout=15000)
    page.locator("button#bottomPagination-previousPage, button[aria-label='Previous page'], li.prev a").first.click()
    expect(current_page).to_have_value("1", timeout=15000)
    LOGGER.info("SAM search preparation complete; returned to page 1")


def extract_dom_records(page):
    page.locator("app-opportunity-result").first.wait_for(state="visible", timeout=30000)
    records = page.locator("app-opportunity-result").evaluate_all("""cards => cards.map(card => {
        const clean = value => (value || '').replace(/\\s+/g, ' ').trim();
        const link = card.querySelector('h3 a[href*="/opp/"]');
        const notice = Array.from(card.querySelectorAll('h3')).map(node => clean(node.textContent)).find(text => /^Notice ID:/i.test(text));
        const fields = {};
        card.querySelectorAll('.sds-field').forEach(field => {
            const name = clean(field.querySelector('.sds-field__name')?.textContent);
            const value = clean(field.querySelector('.sds-field__value')?.textContent);
            if (name) fields[name] = value || null;
        });
        return {
            solicitation_number: notice ? notice.replace(/^Notice ID:\\s*/i, '') || null : null,
            title: clean(link?.textContent) || null,
            closing_date: fields['Current Date Offers Due'] || null,
            primary_agency: fields['Department/Ind.Agency'] || null,
            opportunity_url: link ? link.href : null
        };
    })""")
    if not records:
        raise RuntimeError("No SAM opportunity cards found; refusing an empty DOM baseline")
    LOGGER.info("DOM extraction found %s opportunity cards", len(records))
    return records


def extract_nevada_records(page):
    links = page.locator('main .GeneralDetail .RichText a[href*="/statewide-contracts/"]')
    links.first.wait_for(state="visible", timeout=20000)
    candidates = links.evaluate_all("""links => links.map(link => ({
        title: (link.textContent || '').replace(/\\s+/g, ' ').trim(),
        opportunity_url: link.href
    }))""")
    records = []
    seen = set()
    for candidate in candidates:
        address = candidate["opportunity_url"]
        parsed = urlparse(address)
        if (not candidate["title"] or address in seen or parsed.scheme != "https"
                or parsed.hostname not in ("purchasing.nv.gov", "www.purchasing.nv.gov")
                or not parsed.path.startswith("/statewide-contracts/")
                or parsed.path.rstrip("/") == "/statewide-contracts"):
            continue
        seen.add(address)
        records.append({"solicitation_number": None, "title": candidate["title"],
                        "closing_date": None, "primary_agency": "State of Nevada Purchasing Division",
                        "opportunity_url": address, "record_kind": "contract_category"})
    if not records:
        raise RuntimeError("No Nevada contract categories found; review portal markup")
    return records


def extract_nevada_open_bids(page):
    rows = page.locator('table tbody tr[data-ri]:has(a[href*="bidDetail.sda"])')
    rows.first.wait_for(state="visible", timeout=20000)
    candidates = rows.evaluate_all("""rows => rows.map(row => {
        const clean = value => (value || '').replace(/\\s+/g, ' ').trim();
        const fields = {};
        row.querySelectorAll('td').forEach(cell => {
            const label = clean(cell.querySelector('.ui-column-title')?.textContent);
            const copy = cell.cloneNode(true);
            copy.querySelectorAll('.ui-column-title').forEach(node => node.remove());
            if (label && !fields[label]) fields[label] = clean(copy.textContent) || null;
        });
        const link = row.querySelector('a[href*="bidDetail.sda"]');
        return {solicitation_number: clean(link?.textContent) || null,
            title: fields['Description'] || null,
            primary_agency: fields['Organization Name'] || null,
            closing_date: null,
            bid_opening_date: fields['Bid Opening Date'] || null,
            portal_status: fields['Status'] || null,
            opportunity_url: link?.href || null,
            record_kind: 'open_bid_listing'};
    })""")
    records = []
    seen = set()
    for record in candidates:
        address = record["opportunity_url"]
        parsed = urlparse(address or "")
        if (not record["solicitation_number"] or not record["title"]
                or parsed.scheme != "https"
                or parsed.hostname not in ("nevadaepro.com", "www.nevadaepro.com")
                or parsed.path != "/bso/external/bidDetail.sda"):
            raise ValueError("NEVADAePro bid row has missing fields or an unsupported detail URL")
        if address not in seen:
            seen.add(address)
            records.append(record)
    if not records:
        raise RuntimeError("No NEVADAePro bid records found")
    return records


def normalize_florida_dom_candidates(candidates, source_url):
    module = importlib.import_module("ingestion.states.florida.listings")
    records = []
    for candidate in candidates:
        number = re.sub(r"\s+", " ", str(candidate.get("number") or "")).strip()
        title = re.sub(r"\s+", " ", str(candidate.get("title") or "")).strip()
        if not number and not title:
            continue
        digits = re.sub(r"\D", "", number)
        detail_href = candidate.get("detail_href")
        can_view = bool(candidate.get("can_view"))
        if detail_href:
            detail_url = urljoin(source_url, detail_href)
        elif digits and can_view:
            detail_url = urljoin(source_url.rstrip("/") + "/", f"detail/{digits}")
        else:
            detail_url = ""
        parsed = urlparse(detail_url)
        if detail_url and (parsed.scheme != "https" or parsed.hostname != "vendor.myfloridamarketplace.com"):
            detail_url = ""
        native_record = module.row_to_listing(detail_url, title) if detail_url else None
        records.append({
            **(native_record or {}),
            "event_id": number or None,
            "event_name": title or None,
            "department": candidate.get("organization") or None,
            "agency_advertisement_number": candidate.get("agency_advertisement_number") or None,
            "version": candidate.get("version") or None,
            "type": candidate.get("ad_type") or None,
            "start_date_raw": candidate.get("start_date") or None,
            "end_date_raw": candidate.get("end_date") or None,
            "status": candidate.get("status") or None,
            "portal_status": candidate.get("status") or None,
            "detail_url": detail_url or None,
            "solicitation_number": number or None,
            "title": title or None,
            "primary_agency": candidate.get("organization") or None,
            "closing_date": candidate.get("end_date") or None,
            "opportunity_url": detail_url or None,
        })
    return records


def extract_florida_dom_records(page):
    rows = page.locator('[role="grid"] tr.mat-row[role="row"]')
    rows.first.wait_for(state="visible", timeout=30000)
    candidates = rows.evaluate_all("""rows => rows.map(row => {
        const clean = value => (value || '').replace(/\\s+/g, ' ').trim();
        const value = name => {
            const cell = row.querySelector(`td.mat-column-${name}`);
            return cell ? clean(cell.innerText || cell.textContent) : '';
        };
        const numberCell = row.querySelector('td.mat-column-adNumber');
        const view = numberCell && numberCell.querySelector('a[title^="View"]');
        return {
            title: value('title'), number: value('adNumber'),
            agency_advertisement_number: value('agencyAdvertisementNumber'),
            version: value('sequence'), organization: value('agency'),
            ad_type: value('type'), start_date: value('openDate'),
            end_date: value('closeDate'), status: value('status'),
            detail_href: view ? view.getAttribute('href') : null,
            can_view: Boolean(view && view.getAttribute('aria-disabled') !== 'true')
        };
    })""")
    records = normalize_florida_dom_candidates(candidates, page.url)
    if not records:
        raise RuntimeError("Florida search returned no visible opportunity rows")
    return records


def prepare_state_dom_page(page, source):
    if source == "florida":
        today = date.today()
        start_date = today.strftime("%m/%d/%Y")
        end_date = (today + timedelta(days=90)).strftime("%m/%d/%Y")
        page.get_by_label("Start Date").fill(start_date, timeout=20000)
        page.get_by_label("End Date").fill(end_date, timeout=20000)
        page.get_by_role("button", name="Search").click()
        page.locator(r"text=/\d+ result\(s\) found/i").wait_for(timeout=45000)
        page.locator('[role="grid"] tr.mat-row[role="row"]').first.wait_for(state="visible", timeout=30000)
    elif source == "california":
        page.get_by_text("Loading...", exact=True).wait_for(state="hidden", timeout=60000)
        page.locator("tr[data-if-label='tblBodyTr']:visible, tr[id^='trRESP_']:visible").first.wait_for(state="visible", timeout=30000)
    elif source == "arizona":
        page.locator('tr:has(td[data-iv-role="cell"]):visible').first.wait_for(state="visible", timeout=30000)
    elif source == "texas":
        page.locator("div.esbd-result-row:visible").first.wait_for(state="visible", timeout=30000)
    elif source == "virginia":
        page.locator("div.card.text-center:visible").first.wait_for(state="visible", timeout=30000)
    elif source == "new_york":
        page.locator('div[title*="Full Title:"]:visible').first.wait_for(state="visible", timeout=30000)
    elif source == "alaska":
        published = page.get_by_role("button", name="Click to show View Published Solicitations")
        if published.count() and not page.locator('table[data-qa="tableGrid"]').count():
            published.click()
        page.locator('table[data-qa="tableGrid"] tr[role="row"]').nth(1).wait_for(state="visible", timeout=30000)
    elif source == "colorado":
        select_page_size_100(page)
        page.locator('[data-qa-id*="grid1.pagination.recordInfo"]').wait_for(state="visible", timeout=30000)
    elif source == "hawaii":
        page.locator("table tr:visible, [role='row']:visible").first.wait_for(state="visible", timeout=30000)
    elif source in ("idaho", "montana", "new_mexico", "oregon", "utah", "washington", "wyoming"):
        page.locator("table tr:visible").nth(1).wait_for(state="visible", timeout=30000)


def normalize_state_dom_record(source, record):
    fields = {
        "arizona": ("solicitation_id", "title", "agency", "due_date_raw", "detail_url"),
        "california": ("event_id", "event_name", "department", "end_date_raw", "detail_url"),
        "texas": ("event_id", "event_name", "department", "end_date_raw", "detail_url"),
        "virginia": ("solicitation_number", "title", "agency", "closing_date_raw", "detail_url"),
        "new_york": ("cr_number", "title", "agency", "due_date_raw", "detail_url"),
    }
    id_field, title_field, agency_field, date_field, url_field = fields[source]
    closing_date = record.get(date_field)
    if source == "virginia" and closing_date:
        match = re.search(r"(\d{1,2}/\d{1,2}/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))", closing_date, re.I)
        closing_date = match.group(1) if match else None
    portal_status = record.get("status") or record.get("portal_status")
    raw_html = record.get("raw_html") or ""
    if not portal_status and source == "california":
        match = re.search(r"<td\b[^>]*data-if-label=['\"]tdStatus['\"][^>]*>(.*?)</td>", raw_html, re.I | re.S)
        if match:
            portal_status = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", match.group(1))).strip()
    elif not portal_status and source == "texas":
        match = re.search(r"<strong>\s*Status:\s*</strong>\s*([^<]+)", raw_html, re.I)
        if match:
            portal_status = match.group(1).strip()
    return {**record,
            "solicitation_number": record.get(id_field) or None,
            "title": record.get(title_field) or None,
            "primary_agency": record.get(agency_field) or None,
            "closing_date": closing_date or None,
            "portal_status": portal_status or None,
            "opportunity_url": record.get(url_field) or None}


def extract_state_portal_dom_records(page, source):
    if source == "florida":
        return extract_florida_dom_records(page)
    if source == "colorado":
        return extract_colorado_dom_records(page)
    if source in ("colorado", "idaho", "montana", "new_mexico", "oregon", "utah", "washington", "wyoming", "alaska", "hawaii"):
        return extract_registry_table_records(page, source)
    from bs4 import BeautifulSoup
    module = importlib.import_module(f"ingestion.states.{source}.listings")
    html = page.content()
    soup = BeautifulSoup(html, "html.parser")
    if source == "arizona":
        rows = soup.select('tr:has(td[data-iv-role="cell"])')
        records = [module.row_to_listing(row, page.url, 1) for row in rows]
    elif source in ("california", "texas"):
        rows = module._extract_listing_rows(soup)
        records = [module.row_to_listing(row, page.url) for row in rows]
    elif source == "virginia":
        records = module._extract_rows_from_html(html)
    elif source == "new_york":
        records = module.extract_listing_rows(html, page.url)
    return [normalize_state_dom_record(source, record) for record in records if record]


def extract_registry_table_records(page, source):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(page.content(), "html.parser")
    selectors = {
        "idaho": "table",
        "montana": "table",
        "new_mexico": "table.rgMasterTable",
        "oregon": "table tbody tr[data-ri]",
        "utah": "table#DataTables_Table_0",
        "washington": "table#DataGrid1",
        "wyoming": "table.tabHome",
        "alaska": 'table[data-qa="tableGrid"]',
        "hawaii": "table.table-opportunity",
    }
    if source == "oregon":
        table_rows = soup.select(selectors[source])
        tables = []
    else:
        tables = soup.select(selectors[source])
        if source in ("idaho", "montana"):
            tables = [table for table in tables if len(table.select("tbody tr")) > 1]
    table_rows = [row for table in tables for row in table.select("tr") if row.find("td")]
    if source == "oregon":
        return extract_oregon_records(table_rows, page.url)
    records = []
    for row in table_rows:
        cells = [re.sub(r"\s+", " ", cell.get_text(" ", strip=True)).strip() for cell in row.select("td")]
        if len(cells) < 2 or not any(cells) or "thead" in [parent.name for parent in row.parents]:
            continue
        table = row.find_parent("table")
        headers = [re.sub(r"\s+", " ", cell.get_text(" ", strip=True)).strip().lower()
                   for cell in (table.select("thead tr th") or table.select("tr th")[:len(cells)])]
        if source == "washington":
            headers = ["solicitation close date / amendment date", "title/description", "contact"]
        if not headers:
            headers = [""] * len(cells)
        values = dict(zip(headers, cells))
        title = next((value for key, value in values.items() if any(label in key for label in ("title", "project", "opportunity", "description", "name")) and value), cells[0])
        identifier = next((value for key, value in values.items() if any(label in key for label in ("solicitation #", "solicitation number", "procurement id", "ref. #", "ref#", "bid #", "number", "event id")) and value), None)
        if not identifier:
            match = re.search(r"\b(?:RFP|IFB|RFQ|ITB|RFQQ|AD|S)-?\s*#?\s*[A-Z0-9][A-Z0-9-]{3,}\b", title, re.I)
            identifier = match.group(0) if match else None
        agency = next((value for key, value in values.items() if any(label in key for label in ("agency", "department", "organization", "buyer")) and value), None)
        status = next((value for key, value in values.items() if "status" in key and value), None)
        closing_date = next((value for key, value in values.items() if any(label in key for label in ("due date", "close date", "closing date", "end date", "bid opening")) and value), None)
        if source == "alaska":
            headers = [cell.get("data-qa", "").lower() for cell in row.select("td")]
            if len(cells) > 1:
                title = next((value for value in cells if len(value) > 15), cells[0])
            identifier = next((value for value in cells if re.search(r"\b(?:ITB|RFP|RFQ)-[A-Z0-9-]+", value, re.I)), None)
            closing_date = next((value for value in cells if re.search(r"\d{1,2}/\d{1,2}/\d{4}", value)), None)
            status = next((value for value in cells if value.lower() in ("open", "amended", "closed")), None)
        links = row.select("a[href]")
        href = next((link.get("href") for link in links if link.get("href") and not link["href"].startswith("javascript:")), None)
        valid_url = None
        if href:
            parsed = urlparse(urljoin(page.url, href))
            host = (parsed.hostname or "").lower()
            allowed_hosts = {
                "idaho": ("purchasing.idaho.gov", "ipro.idaho.gov"),
                "montana": ("bids.sciquest.com", "app01.jaggaer.com"),
                "new_mexico": ("spd.gsd.state.nm.us",),
                "oregon": ("oregonbuys.gov",),
                "utah": ("utah.bonfirehub.com",),
                "washington": ("pr-webs-vendor.des.wa.gov",),
                "wyoming": ("publicpurchase.com",),
                "alaska": ("iris-vss.alaska.gov",),
                "hawaii": ("hands.ehawaii.gov",),
            }[source]
            if parsed.scheme == "https" and any(host == allowed or host.endswith("." + allowed) for allowed in allowed_hosts):
                valid_url = urljoin(page.url, href)
        records.append({
            "solicitation_number": identifier,
            "title": title or None,
            "primary_agency": agency,
            "closing_date": closing_date,
            "opportunity_url": valid_url,
            "portal_status": status,
            "raw_fields": cells,
            "record_kind": "procurement_listing",
        })
    return records


def select_page_size_100(page):
    if source_for(page.url) == "colorado":
        record_info = page.locator('[data-qa-id*="grid1.pagination.recordInfo"]')
        published_button = page.locator('button[data-qa-id*="solicitations.listBulletLink"]')
        if not record_info.count() or not record_info.is_visible():
            published_button.wait_for(state="visible", timeout=30000)
            published_button.click(timeout=30000)
        record_info.wait_for(state="visible", timeout=30000)
        page_size = page.locator('button[data-qa-id*="pagination.100Records"]')
        page_size.wait_for(state="visible", timeout=20000)
        if page_size.get_attribute("aria-current") != "page":
            page_size.click()
            page.wait_for_function("""() => {
                const button = document.querySelector('button[data-qa-id*="pagination.100Records"]');
                const count = document.querySelector('[data-qa-id*="pagination.recordInfo"]');
                return button?.getAttribute('aria-current') === 'page' && count?.innerText.trim();
            }""", timeout=30000)
        return True
    selects = page.locator("select")
    for index in range(selects.count()):
        select = selects.nth(index)
        options = select.locator("option").evaluate_all("options => options.map(option => ({text: option.textContent.trim(), value: option.value}))")
        option = next((item for item in options if item["text"].strip() == "100" or item["value"].strip() == "100"), None)
        if option:
            if select.input_value() == option["value"]:
                return True
            before = page.locator("body").inner_text()
            select.select_option(value=option["value"])
            page.wait_for_function("previous => document.body && document.body.innerText !== previous",
                                   arg=before, timeout=20000)
            return True
    return False


def extract_colorado_dom_records(page):
    rows = page.locator('table[data-qa-id*="grid1.table"] tr[role="row"]:visible')
    rows.first.wait_for(state="visible", timeout=20000)
    candidates = rows.evaluate_all("""rows => rows.map(row => {
        const text = selector => {
            const node = row.querySelector(selector);
            return node ? (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        };
        return {
            title: text('[data-qa-id$=".DOC_DSCR"]'),
            agency: text('[data-qa-id$=".DeptBuyr.DEPT_NM"]'),
            buyer: text('[data-qa-id$=".DeptBuyr.BUYR_NM"]'),
            solicitation_number: text('[data-qa-id$=".solNumTypCat.DOC_REF"]'),
            solicitation_type: text('[data-qa-id$=".solNumTypCat.DOC_CD_CONCAT"]'),
            category: text('[data-qa-id$=".solNumTypCat.SO_CAT_CD"]'),
            closing_date: text('[data-qa-id$=".closeDateTimeSta.SO_CLSNG_DT_TM.readOnlyDate"]'),
            portal_status: text('[data-qa-id$=".closeDateTimeSta.SO_STA"]')
        };
    })""")
    records = []
    for record in candidates:
        if not record["solicitation_number"] and not record["title"]:
            continue
        records.append({**record, "primary_agency": record["agency"] or None,
                        "opportunity_url": None, "record_kind": "published_solicitation"})
    if not records:
        raise RuntimeError("Colorado Published Solicitations grid had no readable rows")
    return records


PAGINATION_ROOTS = "nav,[role='navigation'],[class*='pagination'],[class*='paginator'],[data-qa*='pagination'],[data-qa*='paginator']"


def portal_pagination_info(page):
    return page.locator(PAGINATION_ROOTS).evaluate_all("""roots => {
        const visible = element => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const candidates = roots.filter(visible).map((root, index) => {
            const controls = Array.from(root.querySelectorAll('button,a,[role="button"]')).filter(visible);
            const numbers = controls.map(control => {
                const text = (control.innerText || control.textContent || '').trim();
                return /^\\d+$/.test(text) ? Number(text) : null;
            }).filter(value => value !== null);
            const current = controls.find(control => control.getAttribute('aria-current') === 'page' ||
                /active|current|selected/i.test(control.className || ''));
            const currentText = current && (current.innerText || current.textContent || '').trim();
            const currentPage = /^\\d+$/.test(currentText || '') ? Number(currentText) : null;
            const hasNext = controls.some(control => /next/i.test([
                control.getAttribute('aria-label'), control.title, control.innerText, control.textContent
            ].join(' ')));
            return {index, totalPages: numbers.length ? Math.max(...numbers) : null, currentPage, hasNext,
                    score: numbers.length + (hasNext ? 2 : 0)};
        }).filter(candidate => candidate.score > 0).sort((left, right) => right.score - left.score);
        return candidates[0] || null;
    }""")


def portal_result_signature(page):
    return page.evaluate("""() => {
        const visible = element => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const selectors = 'table tbody tr,[role="grid"] [role="row"],[role="table"] [role="row"],app-opportunity-result,.mat-row,[data-qa="tableGrid"] tr';
        const rows = Array.from(document.querySelectorAll(selectors)).filter(visible)
            .filter(row => !row.querySelector('th') && (row.innerText || row.textContent || '').trim());
        return rows.slice(0, 4).map(row => (row.innerText || row.textContent || '').replace(/\\s+/g, ' ').trim()).join('\\n');
    }""")


def advance_portal_page(page, expected_page):
    info = portal_pagination_info(page)
    if not info:
        return False
    container = page.locator(PAGINATION_ROOTS).nth(info["index"])
    next_selectors = (
        "button[aria-label*='next' i], a[aria-label*='next' i], [role='button'][aria-label*='next' i], "
        "button[title*='next' i], a[title*='next' i], button[id*='next' i], a[id*='next' i]"
    )
    next_control = container.locator(next_selectors).first
    if next_control.count() and next_control.is_visible() and next_control.is_enabled() \
            and next_control.get_attribute("aria-disabled") != "true":
        control = next_control
    else:
        control = container.get_by_role("button", name=str(expected_page), exact=True).first
        if not control.count():
            control = container.get_by_role("link", name=str(expected_page), exact=True).first
        if not control.count() or not control.is_visible() or not control.is_enabled():
            return False
    before = portal_result_signature(page)
    if not before:
        return False
    control.click()
    page.wait_for_function("""previous => {
        const visible = element => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const selectors = 'table tbody tr,[role="grid"] [role="row"],[role="table"] [role="row"],app-opportunity-result,.mat-row,[data-qa="tableGrid"] tr';
        const rows = Array.from(document.querySelectorAll(selectors)).filter(visible)
            .filter(row => !row.querySelector('th') && (row.innerText || row.textContent || '').trim());
        const current = rows.slice(0, 4).map(row => (row.innerText || row.textContent || '').replace(/\\s+/g, ' ').trim()).join('\\n');
        return current && current !== previous && !/loading search results/i.test(document.body.innerText);
    }""", arg=before, timeout=30000)
    return True


def extract_oregon_records(rows, base_url):
    from bs4 import BeautifulSoup
    records = []
    for row in rows:
        fields = {}
        for cell in row.select("td"):
            label_node = cell.select_one(".ui-column-title")
            if not label_node:
                continue
            label = re.sub(r"\s+", " ", label_node.get_text(" ", strip=True)).strip().lower()
            clone = BeautifulSoup(str(cell), "html.parser")
            for marker in clone.select(".ui-column-title"):
                marker.decompose()
            value = re.sub(r"\s+", " ", clone.get_text(" ", strip=True)).strip()
            fields[label] = value
        solicitation_id = fields.get("bid solicitation #")
        title = fields.get("description")
        if not title and not solicitation_id:
            continue
        anchor = row.select_one('a[href*="bidDetail.sda"]')
        detail_url = urljoin(base_url, anchor.get("href")) if anchor else None
        records.append({"solicitation_number": solicitation_id or None, "title": title or None,
                        "primary_agency": fields.get("organization name"), "closing_date": None,
                        "bid_opening_date": fields.get("bid opening date"), "opportunity_url": detail_url,
                        "portal_status": fields.get("status"), "raw_fields": fields,
                        "record_kind": "open_bid_listing"})
    return records


def state_dom_quality_issues(records, source=None):
    issues = [{"issue": "detail_hydration_not_performed"}]
    if source != "colorado":
        issues.insert(0, {"issue": "displayed_page_only_no_pagination"})
    if not records:
        return issues + [{"issue": "no_public_bid_records_on_configured_portal"}]
    if source == "colorado":
        issues.append({"issue": "public_grid_does_not_expose_detail_urls"})
    seen_urls = set()
    non_open_statuses = {"closed", "withdrawn", "awarded", "cancelled", "canceled", "no award"}
    allowed_detail_hosts = {
        "colorado": ("prd.co.cgiadvantage.com",),
        "arizona": ("app.az.gov",),
        "california": ("caleprocure.ca.gov",),
        "texas": ("txsmartbuy.gov",),
        "florida": ("vendor.myfloridamarketplace.com",),
        "virginia": ("cgieva.com",),
        "new_york": ("nyscr.ny.gov",),
        "idaho": ("purchasing.idaho.gov", "ipro.idaho.gov"),
        "montana": ("bids.sciquest.com", "app01.jaggaer.com"),
        "new_mexico": ("spd.gsd.state.nm.us",),
        "oregon": ("oregonbuys.gov",),
        "utah": ("utah.bonfirehub.com",),
        "washington": ("pr-webs-vendor.des.wa.gov",),
        "wyoming": ("publicpurchase.com",),
        "alaska": ("iris-vss.alaska.gov",),
        "hawaii": ("hands.ehawaii.gov",),
    }
    for position, record in enumerate(records):
        required_fields = ("solicitation_number", "title") if source == "colorado" else (
            "solicitation_number", "title", "opportunity_url")
        for field in required_fields:
            if not record.get(field):
                issues.append({"row": position, "field": field, "issue": "not_present_in_dom"})
        address = record.get("opportunity_url")
        if address:
            parsed = urlparse(address)
            host = (parsed.hostname or "").lower()
            hosts = allowed_detail_hosts.get(source, ())
            if parsed.scheme != "https" or parsed.username or parsed.password or not any(host == allowed or host.endswith("." + allowed) for allowed in hosts):
                issues.append({"row": position, "field": "opportunity_url", "issue": "unsupported_detail_host"})
            if address in seen_urls:
                issues.append({"row": position, "field": "opportunity_url", "issue": "duplicate"})
            seen_urls.add(address)
        status = str(record.get("portal_status") or record.get("status") or "").strip().lower()
        if status in non_open_statuses:
            issues.append({"row": position, "field": "portal_status", "issue": "not_open"})
    return issues


def sam_total_pages(page):
    control = page.locator("input#bottomPagination-currentPage")
    label = control.get_attribute("aria-label") or ""
    match = re.search(r"\bPage\s+[\d,]+\s+of\s+([\d,]+)\b", label, re.I)
    if not match:
        raise RuntimeError(f"Cannot read SAM total page count from pagination label: {label!r}")
    return max(1, int(match.group(1).replace(",", "")))


def dom_quality(records):
    issues = []
    seen_urls = set()
    for position, record in enumerate(records):
        for field in ("solicitation_number", "title", "opportunity_url"):
            if not record.get(field):
                issues.append({"row": position, "field": field, "issue": "missing"})
        address = record.get("opportunity_url")
        if address:
            parsed = urlparse(address)
            if parsed.scheme != "https" or parsed.hostname not in ("sam.gov", "www.sam.gov") or "/opp/" not in parsed.path:
                issues.append({"row": position, "field": "opportunity_url", "issue": "invalid"})
            if address in seen_urls:
                issues.append({"row": position, "field": "opportunity_url", "issue": "duplicate"})
            seen_urls.add(address)
        for field in ("closing_date", "primary_agency"):
            if not record.get(field):
                issues.append({"row": position, "field": field, "issue": "not_present_in_dom"})
    return issues


def capture(page, task, storage):
    if not isinstance(task, dict) or not task.get("id") or not isinstance(task.get("url"), str):
        raise ValueError("Task requires an id and URL")
    source = source_for(task["url"])
    if task.get("type", "capture") != "capture":
        raise ValueError("Unsupported task type")
    max_pages = task.get("max_pages", task.get("pages", 3))
    if isinstance(max_pages, bool) or not isinstance(max_pages, int) or not 1 <= max_pages <= 100:
        raise ValueError("Capture page limit must be an integer between 1 and 100")
    started = time.monotonic()
    response = page.goto(task["url"], wait_until="domcontentloaded", timeout=30000)
    source_for(page.url)
    if response and response.status >= 400:
        raise RuntimeError(f"Portal returned HTTP {response.status}")
    page.locator("body").wait_for(state="visible", timeout=15000)
    html = page.content()
    if any(marker in html.lower() for marker in ("verify you are human", "g-recaptcha", "cf-chl-")):
        raise RuntimeError("Portal requires manual browser verification; no bypass attempted")
    parsed_url = urlparse(page.url)
    sam_search = source is None and parsed_url.path.rstrip("/") == "/search"
    nevada_directory = source == "nevada"
    nevada_open_bids = source == "nevada_open_bids"
    state_dom_capture = source in STATE_DOM_PATHS and parsed_url.path == STATE_DOM_PATHS[source]
    if nevada_open_bids and (parsed_url.path != "/bso/view/search/external/advancedSearchBid.xhtml"
                              or "openBids=true" not in parsed_url.query.split("&")):
        raise ValueError("Use https://nevadaepro.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true")
    if nevada_directory and parsed_url.path.rstrip("/").lower() not in ("/contracts", "/statewide-contracts"):
        raise ValueError("Nevada adapter currently supports only the statewide contracts directory")
    if state_dom_capture:
        prepare_state_dom_page(page, source)
    total_pages = 1
    if sam_search:
        prepare_sam_search(page)
        total_pages = sam_total_pages(page)
        LOGGER.info("SAM reports %s pages; capturing at most %s", total_pages, max_pages)
    elif state_dom_capture:
        pagination = portal_pagination_info(page)
        total_pages = pagination["totalPages"] if pagination and pagination.get("totalPages") else max_pages
    storage.mkdir(parents=True, exist_ok=True)
    stem = hashlib.sha256(str(task["id"]).encode()).hexdigest()
    payloads = []
    for page_number in range(1, min(max_pages, total_pages) + 1):
        source_for(page.url)
        html = page.content()
        if any(marker in html.lower() for marker in ("verify you are human", "g-recaptcha", "cf-chl-")):
            raise RuntimeError("Portal requires manual browser verification during pagination")
        snapshot = storage / f"opp_{stem}_page_{page_number}.png"
        dom_records = (extract_dom_records(page) if sam_search else
                   extract_nevada_records(page) if nevada_directory else
                   extract_nevada_open_bids(page) if nevada_open_bids else
                   extract_state_portal_dom_records(page, source) if state_dom_capture else None)
        quality_issues = ([{"issue": "contract_categories_not_active_solicitations"}]
                  if nevada_directory else
                  [{"issue": "displayed_page_only_no_pagination"},
                   {"issue": "bid_opening_date_is_not_a_verified_closing_deadline"}]
                  if nevada_open_bids else state_dom_quality_issues(dom_records, source)
                  if state_dom_capture else dom_quality(dom_records) if dom_records is not None else [])
        page.screenshot(path=str(snapshot), full_page=True, timeout=30000)
        dom_path = snapshot.with_suffix(".json")
        if dom_records is not None:
            dom_path.write_text(json.dumps(dom_records, indent=2), encoding="utf-8")
        payloads.append({"id": task["id"], "url": page.url, "source": source or "sam",
                         "state": "NV" if nevada_directory or nevada_open_bids else next((code for code, state_source in STATE_DOM_SOURCES.items() if state_source == source), None) if state_dom_capture else None,
                         "record_kind": "contract_category" if nevada_directory else "open_bid_listing" if nevada_open_bids else "opportunity",
                         "page_number": page_number, "total_pages": total_pages,
                         "requested_max_pages": max_pages,
                         "snapshot_path": str(snapshot), "snapshot_host": socket.gethostname(),
                         "snapshot_sha256": hashlib.sha256(snapshot.read_bytes()).hexdigest(),
                         "dom_path": str(dom_path) if dom_records is not None else None,
                         "dom_sha256": hashlib.sha256(dom_path.read_bytes()).hexdigest() if dom_records is not None else None,
                         "dom_record_count": len(dom_records) if dom_records is not None else None,
                         "extraction_method": "dom" if dom_records is not None else "state_parser",
                         "structured_data": dom_records,
                         "quality_issues": quality_issues,
                         "review_required": bool(quality_issues) if dom_records is not None else True,
                         "details": {} if state_dom_capture else extract_details(source, html, task["url"]),
                         "elapsed_seconds": round(time.monotonic() - started, 3),
                         "timestamp": time.time(), "asset_transport": "worker_local_file"})
        LOGGER.info("Captured page %s of %s", page_number, total_pages)
        if state_dom_capture and page_number < min(max_pages, total_pages):
            if not advance_portal_page(page, page_number + 1):
                total_pages = page_number
                break
        elif not state_dom_capture and page_number < min(max_pages, total_pages):
            from playwright.sync_api import expect
            next_button = page.locator("button#bottomPagination-nextPage, button[aria-label='Next page'], a.usa-pagination__next-page, li.next a").first
            if not next_button.is_enabled() or next_button.get_attribute("aria-disabled") == "true":
                LOGGER.info("Reached final available page after %s captures", page_number)
                break
            previous_first_card = page.locator("app-opportunity-result").first.inner_text()
            next_button.click()
            expect(page.locator("input#bottomPagination-currentPage")).to_have_value(str(page_number + 1), timeout=15000)
            expect(page.locator("app-opportunity-result").first).not_to_have_text(previous_first_card, timeout=30000, use_inner_text=True)
    for payload in payloads:
        payload["captured_pages"] = len(payloads)
        if state_dom_capture and len(payloads) < total_pages:
            payload["total_pages"] = len(payloads)
    return payloads


def process_one(queue, page, storage, processing_key, timeout=5):
    raw = queue.brpoplpush("contract_queue", processing_key, timeout=timeout)
    if raw is None:
        return False
    try:
        task = json.loads(raw)
        if isinstance(task, dict) and task.get("type") == "state_dom_capture":
            payloads = capture(page, state_dom_capture_task(task), storage)
        elif isinstance(task, dict) and task.get("type") == "state_workflow":
            capture_task = state_workflow_capture_task(task)
            if capture_task:
                payloads = capture(page, capture_task, storage)
            else:
                from state_workflow import STATES
                state = task.get("state")
                if state not in STATES or not task.get("id"):
                    raise ValueError("State workflow requires an id and supported state code")
                output = storage.parent / "state-runs" / str(uuid4())
                output.parent.mkdir(parents=True, exist_ok=True)
                completed = subprocess.run(
                    [sys.executable, str(ROOT / "scripts/state_workflow.py"),
                     "--state", state, "--output-dir", str(output),
                     "--max-pages", str(task.get("max_pages", 1)),
                     "--max-details", str(task.get("max_details", 10))],
                    timeout=600, capture_output=True, text=True)
                if completed.returncode:
                    raise RuntimeError(f"State workflow failed: {completed.stderr[-2000:]}")
                report = json.loads((output / "result.json").read_text(encoding="utf-8"))
                payloads = [{**report, "id": task["id"], "processed_by": socket.gethostname(),
                             "timestamp": time.time()}]
        else:
            payloads = capture(page, task, storage)
    except Exception as error:
        payloads = [{"task_raw": raw, "error": str(error), "timestamp": time.time()}]
        destination = "contract_failed_queue"
        LOGGER.exception("Capture failed; preserving task in failed queue")
    else:
        destination = None
    with queue.pipeline(transaction=True) as transaction:
        for payload in payloads:
            target = destination or ("results_registry" if payload.get("extraction_method") in ("dom", "state_workflow") else "capture_review_queue")
            transaction.lpush(target, json.dumps(payload))
        transaction.lrem(processing_key, 1, raw)
        transaction.execute()
    return True


def main():
    parser = argparse.ArgumentParser(description="Bounded SAM search and single-page state snapshot worker; requires Chrome CDP")
    parser.add_argument("--broker-url", default=os.environ.get("BROKER_URL", "redis://127.0.0.1:16379/0"))
    parser.add_argument("--cdp-url", default="http://127.0.0.1:9222")
    parser.add_argument("--storage-dir", type=Path, default=ROOT / "storage" / "snapshots")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--check", action="store_true", help="Check Redis and CDP without consuming jobs")
    args = parser.parse_args()
    from redis import Redis
    from playwright.sync_api import sync_playwright
    queue = Redis.from_url(args.broker_url, decode_responses=True, socket_connect_timeout=3, socket_timeout=10)
    queue.ping()
    processing_key = f"contract_processing:{socket.gethostname()}"
    if queue.llen(processing_key):
        raise RuntimeError(f"Unfinished jobs in {processing_key}; inspect and explicitly requeue before starting")
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(args.cdp_url, timeout=10000)
        if not browser.contexts:
            raise RuntimeError("Chrome has no existing browser context")
        if args.check:
            print("Redis and Chrome CDP ready; no jobs consumed")
            return
        page = browser.contexts[0].new_page()
        try:
            while True:
                process_one(queue, page, args.storage_dir, processing_key)
                if args.once:
                    break
        finally:
            page.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        main()
    except KeyboardInterrupt:
        LOGGER.info("Worker stopped; any unfinished claim remains in processing queue")