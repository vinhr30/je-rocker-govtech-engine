#!/usr/bin/env python3
"""Async Playwright scraper that extracts clean raw text from company career pages."""

import argparse
import asyncio
import json
from pathlib import Path
import re
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

NAV_TIMEOUT_MS = 30_000
SETTLE_MS = 2_000
MAX_CONCURRENCY = 4
SCROLL_PASSES = 4
SCROLL_WAIT_MS = 1_500
EIGHTFOLD_PAGE_SIZE = 100
EIGHTFOLD_API_DOMAINS = {
    "lockheedmartin.eightfold.ai": "lockheedmartin.com",
    "jobs.northropgrumman.com": "ngc.com",
}
WORKDAY_PAGE_SIZE = 20
PHENOM_PAGE_SIZE = 100
RADANCY_HOSTS = {"boeing.com", "jobs.boeing.com"}
PHENOM_HOSTS = {"careers.rtx.com", "jobs.baesystems.com"}
RADANCY_HOSTS.update({
    "careers.fedex.com",
    "www.jobs-ups.com",
    "careers.hcahealthcare.com",
    "careers.unitedhealthgroup.com",
})
WORKDAY_PROXY_PATHS = {
    "jobs.jbhunt.com": "/wday/cxs/jbhunt/JB_Hunt/jobs",
    "careers.jbhunt.com": "/wday/cxs/jbhunt/JB_Hunt/jobs",
    "mycareer.verizon.com": "/wday/cxs/verizon/Verizon/jobs",
}
SUCCESSFACTORS_FEEDS = {
    "jobs.nexteraenergy.com": "/search/",
    "up.jobs": "/search/",
}
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "db" / "careers_raw.json"
CAREER_ARCHITECTURES = {
    "careers.rtx.com": "phenom",
    "www.gd.com": "corporate_html",
    "www.gdit.com": "workday_html",
    "jobs.boeing.com": "radancy",
    "boeing.com": "radancy",
    "jobs.baesystems.com": "phenom",
    "careers.boozallen.com": "corporate_html",
    "careers.leidos.com": "corporate_html",
    "careers.fedex.com": "radancy",
    "www.jobs-ups.com": "radancy",
    "jobs.jbhunt.com": "workday",
    "careers.hcahealthcare.com": "radancy",
    "careers.unitedhealthgroup.com": "radancy",
    "jobs.cvshealth.com": "workday",
    "jobs.nexteraenergy.com": "successfactors",
    "mycareer.verizon.com": "workday",
    "up.jobs": "successfactors",
    "gdit.wd5.myworkdayjobs.com": "workday",
    "cvshealth.wd1.myworkdayjobs.com": "workday",
}
CORPORATE_DOMAINS = {
    "raytheon.com": "RTX Corporation",
    "rtx.com": "RTX Corporation",
    "generaldynamics.com": "General Dynamics",
    "gdit.com": "General Dynamics Information Technology",
    "boeing.com": "The Boeing Company",
    "baesystems.com": "BAE Systems",
    "boozallen.com": "Booz Allen Hamilton",
    "leidos.com": "Leidos",
}

STRIP_SELECTORS = [
    "script", "style", "noscript", "template", "svg", "iframe", "link", "meta",
    "nav", "aside", "form[role='search']",
    # Keep <header>/<footer> inside job cards; they often hold the title.
    "header:not(main header, article header, section header, li header)",
    "footer:not(main footer, article footer, section footer, li footer)",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[aria-hidden='true']", "[id*='cookie' i]", "[class*='cookie' i]",
]

EXTRACT_JS = """
(selectors) => {
    const root = document.body.cloneNode(true);
    for (const sel of selectors) {
        root.querySelectorAll(sel).forEach(el => el.remove());
    }
    document.body.appendChild(root);
    root.style.display = 'block';
    const text = root.innerText || root.textContent || '';
    root.remove();
    return text;
}
"""


def clean_text(text: str) -> str:
    lines = (re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.splitlines())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def read_target_urls(path: str) -> list[str]:
    """Read target URLs without reducing paths, queries, or fragments."""
    with open(path, encoding="utf-8", newline="") as fh:
        urls = []
        for line in fh:
            url = line.rstrip("\r\n")
            if not url.strip() or url.lstrip().startswith("#"):
                continue
            urls.append(url)
        return urls


async def scroll_to_load(page) -> None:
    """Scroll a few times so infinite-scroll and lazy-loaded job cards render before extraction."""
    viewport = page.viewport_size or {"width": 1366, "height": 900}
    for _ in range(SCROLL_PASSES):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        # Wheel events also reach boards that scroll inside an inner panel instead of the window.
        await page.mouse.move(viewport["width"] / 2, viewport["height"] / 2)
        await page.mouse.wheel(0, viewport["height"] * 3)
        await page.wait_for_timeout(SCROLL_WAIT_MS)


def build_result(
    url: str,
    raw_text: str = "",
    error: str | None = None,
    raw_format: str | None = None,
    architecture: str | None = None,
) -> dict:
    result = {
        "source_url": url,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "raw_text": raw_text,
        "status": "error" if error else "ok",
        "error": error,
    }
    if raw_format:
        result["raw_format"] = raw_format
    if architecture:
        result["career_architecture"] = architecture
    return result


def eightfold_domain(url: str) -> str | None:
    host = (urlsplit(url).hostname or "").lower()
    return EIGHTFOLD_API_DOMAINS.get(host)


def workday_endpoint(url: str) -> str | None:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    path_parts = [part for part in parsed.path.split("/") if part]
    if host in WORKDAY_PROXY_PATHS:
        return f"{parsed.scheme}://{parsed.netloc}{WORKDAY_PROXY_PATHS[host]}"
    if not re.fullmatch(r"[^.]+\.wd\d+\.myworkdayjobs\.com", host) or not path_parts:
        return None
    tenant, site = host.split(".wd", 1)[0], path_parts[-1]
    return f"{parsed.scheme}://{parsed.netloc}/wday/cxs/{tenant}/{site}/jobs"


def career_architecture(url: str) -> str:
    """Return the known public career architecture for deterministic downstream parsing."""
    host = (urlsplit(url).hostname or "").lower()
    return CAREER_ARCHITECTURES.get(host, "playwright_html")


def phenom_target(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in PHENOM_HOSTS


def radancy_target(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in RADANCY_HOSTS


def successfactors_target(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in SUCCESSFACTORS_FEEDS


class EightfoldAPIEngine:
    def fetch_all(self, url: str, domain: str) -> list[dict]:
        positions = []
        start = 0
        while True:
            endpoint = f"https://{urlsplit(url).netloc}/api/pcsx/search"
            payload = {"domain": domain, "query": "", "location": "", "start": start}
            request = Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "JE-Rocker/1.0"},
                method="POST",
            )
            with urlopen(request, timeout=NAV_TIMEOUT_MS / 1000) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
            page_positions = response_payload.get("data", {}).get("positions", [])
            if not page_positions:
                break
            positions.extend(page_positions)
            start += EIGHTFOLD_PAGE_SIZE
        return positions

    def fetch(self, url: str, domain: str) -> dict:
        return build_result(url, json.dumps({"positions": self.fetch_all(url, domain)}, ensure_ascii=False, indent=2), raw_format="eightfold_api")


async def scrape_eightfold_target(url: str, domain: str, semaphore: asyncio.Semaphore) -> dict:
    async with semaphore:
        try:
            return await asyncio.to_thread(EightfoldAPIEngine().fetch, url, domain)
        except HTTPError as exc:
            return build_result(url, error=f"HTTP {exc.code}")
        except (URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            return build_result(url, error=f"Eightfold API error: {exc}")


class WorkdayAPIEngine:
    def fetch_all(self, url: str, endpoint: str) -> list[dict]:
        postings = []
        offset = 0
        while True:
            payload = {"appliedFacets": {}, "limit": WORKDAY_PAGE_SIZE, "offset": offset, "searchText": ""}
            request = Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers={
                "Accept": "application/json", "Content-Type": "application/json",
                "Referer": url, "User-Agent": "JE-Rocker/1.0",
            }, method="POST")
            with urlopen(request, timeout=NAV_TIMEOUT_MS / 1000) as response:
                page = json.loads(response.read().decode("utf-8"))
            page_postings = page.get("jobPostings", []) if isinstance(page, dict) else []
            if not isinstance(page_postings, list) or not page_postings:
                break
            postings.extend(page_postings)
            offset += WORKDAY_PAGE_SIZE
        return postings

    def fetch(self, url: str, endpoint: str) -> dict:
        return build_result(url, json.dumps({"jobPostings": self.fetch_all(url, endpoint)}, ensure_ascii=False, indent=2), raw_format="workday_api", architecture="workday")


async def scrape_workday_target(url: str, endpoint: str, semaphore: asyncio.Semaphore) -> dict:
    async with semaphore:
        try:
            return await asyncio.to_thread(WorkdayAPIEngine().fetch, url, endpoint)
        except HTTPError as exc:
            return build_result(url, error=f"HTTP {exc.code}", architecture="workday")
        except (URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            return build_result(url, error=f"Workday API error: {exc}", architecture="workday")


class SuccessFactorsAPIEngine:
    page_size = 25

    def feed_endpoint(self, url: str) -> str:
        parsed = urlsplit(url)
        return f"{parsed.scheme}://{parsed.netloc}{SUCCESSFACTORS_FEEDS[parsed.hostname.lower()]}"

    @staticmethod
    def payload_array(text: str) -> list:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return []
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("d", "results", "jobs", "jobPostings", "data"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
                if isinstance(value, dict) and isinstance(value.get("results"), list):
                    return value["results"]
        return []

    def fetch_all(self, url: str) -> list[dict]:
        postings = []
        start_row = 0
        endpoint = self.feed_endpoint(url)
        while True:
            query = urlencode({"q": "", "locationsearch": "", "startRow": start_row})
            request = Request(
                f"{endpoint}?{query}",
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "Referer": url,
                    "User-Agent": "JE-Rocker/1.0",
                },
            )
            with urlopen(request, timeout=NAV_TIMEOUT_MS / 1000) as response:
                page = response.read().decode("utf-8")
            page_postings = self.payload_array(page)
            if not page_postings:
                break
            postings.extend(page_postings)
            start_row += self.page_size
        return postings

    def fetch(self, url: str) -> dict:
        return build_result(
            url,
            json.dumps({"jobs": self.fetch_all(url)}, ensure_ascii=False, indent=2),
            raw_format="successfactors_api",
            architecture="successfactors",
        )


async def scrape_successfactors_target(url: str, semaphore: asyncio.Semaphore) -> dict:
    async with semaphore:
        try:
            return await asyncio.to_thread(SuccessFactorsAPIEngine().fetch, url)
        except HTTPError as exc:
            return build_result(url, error=f"HTTP {exc.code}", architecture="successfactors")
        except (URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            return build_result(url, error=f"SuccessFactors API error: {exc}", architecture="successfactors")


async def scrape_phenom_target(url: str, semaphore: asyncio.Semaphore) -> dict:
    async with semaphore:
        try:
            return await asyncio.to_thread(PhenomAPIEngine().fetch, url)
        except HTTPError as exc:
            return build_result(url, error=f"HTTP {exc.code}", architecture="phenom")
        except (URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            return build_result(url, error=f"Phenom API error: {exc}", architecture="phenom")


class PhenomAPIEngine:
    def fetch_all(self, url: str) -> list[dict]:
        parsed = urlsplit(url)
        endpoint = f"{parsed.scheme}://{parsed.netloc}/opportunities-embed/api/jobs"
        jobs = []
        offset = 0
        while True:
            payload = {"from": offset, "size": PHENOM_PAGE_SIZE, "keywords": "", "location": [], "coreorvetted": "both"}
            request = Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers={
                "Accept": "application/json", "Content-Type": "application/json",
                "Origin": f"{parsed.scheme}://{parsed.netloc}", "Referer": url,
                "User-Agent": "JE-Rocker/1.0",
            }, method="POST")
            with urlopen(request, timeout=NAV_TIMEOUT_MS / 1000) as response:
                payload = json.loads(response.read().decode("utf-8"))
            page_jobs = payload.get("jobs") or payload.get("results") or payload.get("data") or []
            if isinstance(page_jobs, dict):
                page_jobs = page_jobs.get("jobs") or page_jobs.get("results") or page_jobs.get("content") or []
            if not isinstance(page_jobs, list) or not page_jobs:
                break
            jobs.extend(page_jobs)
            offset += PHENOM_PAGE_SIZE
        return jobs

    def fetch(self, url: str) -> dict:
        return build_result(url, json.dumps({"jobs": self.fetch_all(url)}, ensure_ascii=False, indent=2), raw_format="phenom_api", architecture="phenom")


def radancy_page_url(url: str, page_number: int) -> str:
    parsed = urlsplit(url)
    query = [(key, value) for key, value in [part.split("=", 1) if "=" in part else (part, "") for part in parsed.query.split("&") if part] if key != "p"]
    query.append(("p", str(page_number)))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def radancy_total_pages(footer_text: str) -> int:
    matches = re.findall(r"(?:of|/|page\s+)\s*(\d+)\b", footer_text, re.IGNORECASE)
    return max((int(value) for value in matches), default=1)


class RadancyAPIEngine:
    async def fetch(self, context, url: str) -> dict:
        page = await context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            await page.wait_for_timeout(SETTLE_MS)
            footer_text = await page.locator("footer").all_inner_texts()
            total_pages = radancy_total_pages("\n".join(footer_text))
            pages = []
            for page_number in range(1, total_pages + 1):
                target = radancy_page_url(url, page_number)
                response = await page.request.get(target, timeout=NAV_TIMEOUT_MS)
                pages.append(clean_text(await response.text()))
            return build_result(url, "\n\n".join(pages), raw_format="radancy_html", architecture="radancy")
        except (PlaywrightTimeoutError, PlaywrightError) as exc:
            return build_result(url, error=f"Radancy error: {exc}", architecture="radancy")
        finally:
            await page.close()


async def scrape_radancy_target(context, url: str, semaphore: asyncio.Semaphore) -> dict:
    async with semaphore:
        return await RadancyAPIEngine().fetch(context, url)


async def scrape_page(context, url: str, semaphore: asyncio.Semaphore) -> dict:
    async with semaphore:
        page = await context.new_page()
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            if response is not None and response.status >= 400:
                return build_result(url, error=f"HTTP {response.status}")
            try:
                await page.wait_for_load_state("networkidle", timeout=NAV_TIMEOUT_MS // 2)
            except PlaywrightTimeoutError:
                pass  # JS-heavy boards often never go idle; use what has rendered.
            await page.wait_for_timeout(SETTLE_MS)
            await scroll_to_load(page)
            raw = await page.evaluate(EXTRACT_JS, STRIP_SELECTORS)
            return build_result(url, clean_text(raw), architecture=career_architecture(url))
        except PlaywrightTimeoutError:
            return build_result(url, error=f"Timeout after {NAV_TIMEOUT_MS} ms")
        except PlaywrightError as exc:
            return build_result(url, error=f"Connection/browser error: {exc.message.splitlines()[0]}")
        finally:
            await page.close()


async def scrape_career_pages(urls: list[str]) -> list[dict]:
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    api_targets = [(url, eightfold_domain(url)) for url in urls if eightfold_domain(url)]
    workday_targets = [(url, workday_endpoint(url)) for url in urls if workday_endpoint(url)]
    phenom_urls = [url for url in urls if phenom_target(url)]
    radancy_urls = [url for url in urls if radancy_target(url)]
    successfactors_urls = [url for url in urls if successfactors_target(url)]
    browser_urls = [url for url in urls if not eightfold_domain(url) and not workday_endpoint(url) and not phenom_target(url) and not radancy_target(url) and not successfactors_target(url)]
    api_tasks = [scrape_eightfold_target(url, domain, semaphore) for url, domain in api_targets]
    api_tasks += [scrape_workday_target(url, endpoint, semaphore) for url, endpoint in workday_targets]
    api_tasks += [scrape_phenom_target(url, semaphore) for url in phenom_urls]
    api_tasks += [scrape_successfactors_target(url, semaphore) for url in successfactors_urls]
    if not browser_urls and not radancy_urls:
        return await asyncio.gather(*api_tasks)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            viewport={"width": 1366, "height": 900},
        )
        try:
            browser_tasks = [scrape_page(context, url, semaphore) for url in browser_urls]
            radancy_tasks = [scrape_radancy_target(context, url, semaphore) for url in radancy_urls]
            return await asyncio.gather(*(api_tasks + browser_tasks + radancy_tasks))
        finally:
            await context.close()
            await browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape raw text from company career pages.")
    parser.add_argument("urls", nargs="*", help="Career page URLs")
    parser.add_argument("-f", "--file", help="File with one URL per line")
    parser.add_argument("-o", "--output", default=str(DEFAULT_OUTPUT), help="Write JSON results to this path")
    args = parser.parse_args()

    urls = list(args.urls)
    if args.file:
        urls += read_target_urls(args.file)
    urls = [u for u in dict.fromkeys(urls) if u.startswith(("http://", "https://"))]
    if not urls:
        parser.error("provide at least one http(s) URL")

    results = asyncio.run(scrape_career_pages(urls))
    payload = json.dumps(results, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
        print(f"Wrote {len(results)} results to {args.output}", file=sys.stderr)
    else:
        print(payload)
    return 0 if any(r["status"] == "ok" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
