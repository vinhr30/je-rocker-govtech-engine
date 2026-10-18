#!/usr/bin/env python3
"""Link hygiene for state opportunity databases: flag listings whose source URLs are dead.

Runs on Mac Miller (it makes outbound HTTP requests). Run after the weekly state refresh,
because the state normalizers rebuild normalized_listings and reset the flags.
"""

from __future__ import annotations

import argparse
import asyncio
import html
import logging
import random
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = DASHBOARD_ROOT / "data"
TABLE = "normalized_listings"
# First match wins; AZ/NY use due_date, CA/TX/FL end_date, VA closing_date.
DEADLINE_COLUMNS = ("due_date", "end_date", "closing_date")
ISO_DATE = re.compile(r"^\s*(\d{4})-(\d{1,2})-(\d{1,2})")
US_DATE = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\b")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

TRACKING_PARAMS = {
    "gclid", "gbraid", "wbraid", "dclid", "fbclid", "msclkid", "yclid", "igshid",
    "mc_cid", "mc_eid", "_ga", "_gl", "_hsenc", "_hsmi", "mkt_tok", "ref_src", "trk",
}
GENERIC_SEGMENT = re.compile(
    r"^(index|default|home|homepage|main|welcome|portal|login|signin|sign-in|logon|sso|"
    r"error|errors|404|notfound|not-found|pagenotfound|session-expired|timeout)(\.[a-z]+)?$",
    re.IGNORECASE,
)

CHALLENGE = re.compile(r"browser_check|captcha|challenge|cf-chl|access[-_]denied|bot[-_]?check", re.IGNORECASE)
TITLE = re.compile(rb"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
TITLE_READ_LIMIT = 256 * 1024

HOST_ANOMALY_MIN_URLS = 5
HOST_ANOMALY_RATIO = 0.5
# Share of a soft-404 host's listings matching its "not found" page above which the host is unverifiable.
UNVERIFIABLE_RATIO = 0.8

STATUS_COLUMN = "url_status"
DETAIL_COLUMNS = {"link_status": "TEXT", "link_http_status": "INTEGER", "link_checked_at": "TEXT"}
WRITE_BATCH = 500

log = logging.getLogger("link_hygiene")


@dataclass
class CheckResult:
    url: str
    verdict: str  # active | expired | unknown
    reason: str
    http_status: int | None = None
    final_url: str | None = None


def parse_deadline(raw: str | None) -> date | None:
    """Parse the leading date of a deadline field; text like 'continuously accepted' returns None."""
    if not raw:
        return None
    try:
        if m := ISO_DATE.match(raw):
            return date(int(m[1]), int(m[2]), int(m[3]))
        if m := US_DATE.match(raw):
            year = int(m[3]) + (2000 if len(m[3]) == 2 else 0)
            return date(year, int(m[1]), int(m[2]))
    except ValueError:
        pass
    return None


def normalize_url(raw: str) -> str | None:
    raw = (raw or "").strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return None
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    ]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", urlencode(query), ""))


def is_generic_landing(original: str, final: str) -> bool:
    """True if a redirect dropped the user on a portal root, index, login, or error page."""
    src, dst = urlsplit(original), urlsplit(final)
    dst_path = dst.path.rstrip("/")
    if not dst_path:
        return True
    segments = [s for s in dst_path.split("/") if s]
    if segments and GENERIC_SEGMENT.match(segments[-1]):
        return True
    src_path = src.path.rstrip("/")
    # Bounced up to a parent listing/index page, e.g. /bids/123 -> /bids.
    return src_path != dst_path and src_path.startswith(dst_path + "/") and not dst.query


def classify_response(url: str, resp: httpx.Response) -> CheckResult:
    code, final = resp.status_code, str(resp.url)
    if 200 <= code < 300:
        final_parts = urlsplit(final)
        if CHALLENGE.search(f"{final_parts.path}?{final_parts.query}"):
            return CheckResult(url, "unknown", "bot_challenge", code, final)
        if resp.history and is_generic_landing(url, final):
            return CheckResult(url, "expired", "redirect_to_portal", code, final)
        return CheckResult(url, "active", "ok", code, final)
    if code in (404, 410):
        return CheckResult(url, "expired", f"http_{code}", code, final)
    if code >= 500:
        return CheckResult(url, "expired", "http_5xx", code, final)
    if code in (401, 403, 407, 429):
        return CheckResult(url, "unknown", "blocked", code, final)
    return CheckResult(url, "unknown", f"http_{code}", code, final)


def classify_exception(url: str, exc: Exception) -> CheckResult:
    text = str(exc).lower()
    if isinstance(exc, httpx.TimeoutException):
        return CheckResult(url, "expired", "timeout")
    if isinstance(exc, httpx.ConnectError):
        if "certificate" in text or "ssl" in text:
            return CheckResult(url, "unknown", "tls_error")
        if any(s in text for s in ("nodename nor servname", "name or service not known", "getaddrinfo", "name resolution")):
            return CheckResult(url, "expired", "dns_failure")
        return CheckResult(url, "expired", "connect_error")
    if isinstance(exc, httpx.TooManyRedirects):
        return CheckResult(url, "unknown", "redirect_loop")
    return CheckResult(url, "unknown", f"transport_error:{type(exc).__name__}")


async def read_title(resp: httpx.Response) -> str:
    buf = b""
    async for chunk in resp.aiter_bytes():
        buf += chunk
        match = TITLE.search(buf)
        if match or len(buf) >= TITLE_READ_LIMIT:
            break
    else:
        match = TITLE.search(buf)
    raw = match.group(1).decode(resp.encoding or "utf-8", "replace") if match else ""
    return " ".join(html.unescape(raw).split()).lower()


async def request_once(client: httpx.AsyncClient, url: str, not_found_title: str | None = None) -> CheckResult:
    """not_found_title is set for soft-404 hosts; pages with that title count as expired."""
    if not_found_title is None:
        try:
            resp = await client.head(url)
            result = classify_response(url, resp)
            if result.verdict == "active":
                return result
        except httpx.TooManyRedirects as exc:
            return classify_exception(url, exc)
        except httpx.TransportError:
            pass  # Some servers drop HEAD; confirm with GET below.
    try:
        async with client.stream("GET", url) as resp:
            result = classify_response(url, resp)
            if not_found_title is not None and result.verdict == "active":
                if await read_title(resp) == not_found_title:
                    result.verdict, result.reason = "expired", "soft_404"
            return result
    except httpx.HTTPError as exc:
        return classify_exception(url, exc)


def make_probe_url(sample: str) -> str:
    """Turn a real listing URL into one that points at a listing that can't exist."""
    parts = urlsplit(sample)
    junk = f"9{random.randrange(10**9, 10**10)}"
    query = parse_qsl(parts.query, keep_blank_values=True)
    id_like = [i for i, (_, v) in enumerate(query) if re.search(r"\d", v)]
    if id_like:
        i = id_like[-1]
        query[i] = (query[i][0], junk)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))
    path = parts.path.rstrip("/") or ""
    return urlunsplit((parts.scheme, parts.netloc, f"{path}-zz{junk}", parts.query, ""))


async def fetch_title(client: httpx.AsyncClient, url: str) -> tuple[CheckResult, str]:
    async with client.stream("GET", url) as resp:
        result = classify_response(url, resp)
        return result, (await read_title(resp) if result.verdict == "active" else "")


async def probe_host(client: httpx.AsyncClient, host: str, samples: list[str]) -> tuple[str, str, str]:
    """Returns (host, mode, not_found_title): mode is 'trusted', 'soft404', or 'unverifiable'."""
    probe = make_probe_url(samples[0])
    try:
        fake, fake_title = await fetch_title(client, probe)
        if fake.reason == "bot_challenge":
            log.warning("Probe %s: bot challenge page; can't verify links without a browser", host)
            return host, "unverifiable", ""
        if fake.verdict != "active":
            log.info("Probe %s: fake listing -> %s; HTTP status codes are trusted", host, fake.reason)
            return host, "trusted", ""
        if not fake_title:
            log.warning("Probe %s: missing listings return 200 with no page title; "
                        "can't verify links without a browser", host)
            return host, "unverifiable", ""
        for sample in samples:
            real, real_title = await fetch_title(client, sample)
            if real.verdict == "active" and real_title != fake_title:
                log.info("Probe %s: soft 404; missing listings show title=%r", host, fake_title)
                return host, "soft404", fake_title
    except httpx.HTTPError as exc:
        log.warning("Probe %s failed (%s); HTTP status codes are trusted", host, classify_exception(probe, exc).reason)
        return host, "trusted", ""
    log.warning("Probe %s: real and fake listings return the same page (title=%r); "
                "can't verify links without a browser", host, fake_title)
    return host, "unverifiable", ""


async def check_url(
    client: httpx.AsyncClient,
    url: str,
    global_sem: asyncio.Semaphore,
    host_sems: dict[str, asyncio.Semaphore],
    retries: int,
    not_found_title: str | None,
) -> CheckResult:
    host_sem = host_sems[urlsplit(url).hostname or ""]
    result = CheckResult(url, "unknown", "not_checked")
    for attempt in range(retries + 1):
        async with global_sem, host_sem:
            result = await request_once(client, url, not_found_title)
        # Retry only failures that are often transient, so a network blip doesn't expire a listing.
        if result.reason not in ("timeout", "connect_error", "http_5xx") or attempt == retries:
            return result
        await asyncio.sleep(1.5 * (attempt + 1))
    return result


def apply_host_breaker(results: dict[str, CheckResult], soft404_titles: dict[str, str]) -> None:
    """Don't expire a whole host's listings when the host is down, blocking us, or unverifiable."""
    by_host: dict[str, list[CheckResult]] = defaultdict(list)
    for r in results.values():
        by_host[urlsplit(r.url).hostname or ""].append(r)
    for host, items in by_host.items():
        soft = [r for r in items if r.reason == "soft_404"]
        mostly_soft = len(items) >= HOST_ANOMALY_MIN_URLS and len(soft) / len(items) >= UNVERIFIABLE_RATIO
        if host in soft404_titles and (not soft404_titles[host] or mostly_soft):
            log.warning(
                "Unverifiable host: %s serves the same page for %d/%d listings (JavaScript app shell); "
                "needs a browser-based check. Leaving its listings unchanged", host, len(soft), len(items),
            )
            for r in items:
                if r.verdict != "expired" or r.reason == "soft_404":
                    r.verdict, r.reason = "unknown", "unverifiable_host"
            continue
        failing = [r for r in items if r.reason in ("timeout", "connect_error", "dns_failure", "http_5xx")]
        if len(items) >= HOST_ANOMALY_MIN_URLS and len(failing) / len(items) >= HOST_ANOMALY_RATIO:
            log.warning(
                "Host anomaly: %s failed %d/%d checks (%s); leaving its listings unchanged",
                host, len(failing), len(items), dict(Counter(r.reason for r in failing)),
            )
            for r in failing:
                r.verdict, r.reason = "unknown", f"host_anomaly:{r.reason}"


def table_columns(conn: sqlite3.Connection) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({TABLE})")}


def load_candidates(db_path: Path) -> list[tuple[int, str | None, str | None]] | None:
    """Returns (rowid, url, deadline) for rows whose url_status is 'active' or NULL."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (TABLE,)).fetchone():
            log.warning("state=%s no %s table; skipping", state_of(db_path), TABLE)
            return None
        columns = table_columns(conn)
        deadline_col = next((c for c in DEADLINE_COLUMNS if c in columns), None)
        if "url" not in columns and deadline_col is None:
            log.warning("state=%s no url or deadline column; skipping", state_of(db_path))
            return None
        if "url" not in columns:
            log.warning("state=%s no url column; checking deadlines only", state_of(db_path))
        url_expr = "url" if "url" in columns else "NULL"
        deadline_expr = deadline_col or "NULL"
        status_filter = (
            f"WHERE {STATUS_COLUMN} IS NULL OR {STATUS_COLUMN} = 'active'" if STATUS_COLUMN in columns else ""
        )
        return conn.execute(f"SELECT rowid, {url_expr}, {deadline_expr} FROM {TABLE} {status_filter}").fetchall()
    finally:
        conn.close()


def write_results(db_path: Path, rows: list[tuple[int, CheckResult]], checked_at: str) -> int:
    """Apply results in one transaction (batched statements); returns active rows remaining."""
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = table_columns(conn)
        if STATUS_COLUMN not in existing:
            conn.execute(f"ALTER TABLE {TABLE} ADD COLUMN {STATUS_COLUMN} TEXT DEFAULT 'active'")
        for name, ddl in DETAIL_COLUMNS.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {TABLE} ADD COLUMN {name} {ddl}")
        params = [
            (r.verdict, f"{r.verdict}:{r.reason}", r.http_status, checked_at, rowid) for rowid, r in rows
        ]
        for start in range(0, len(params), WRITE_BATCH):
            conn.executemany(
                f"""UPDATE {TABLE} SET
                        {STATUS_COLUMN} = CASE ? WHEN 'expired' THEN 'expired'
                                                ELSE COALESCE({STATUS_COLUMN}, 'active') END,
                        link_status = ?, link_http_status = ?, link_checked_at = ?
                    WHERE rowid = ?""",
                params[start:start + WRITE_BATCH],
            )
        remaining = conn.execute(
            f"SELECT COUNT(*) FROM {TABLE} WHERE COALESCE({STATUS_COLUMN}, 'active') = 'active'"
        ).fetchone()[0]
        conn.execute("COMMIT")
        return remaining
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def state_of(db_path: Path) -> str:
    return db_path.stem.removeprefix("opportunities_")


class LinkChecker:
    """Shared by all state tasks so each host is probed once and each URL is requested once."""

    def __init__(self, client: httpx.AsyncClient, args: argparse.Namespace) -> None:
        self.client, self.args = client, args
        self.global_sem = asyncio.Semaphore(args.concurrency)
        self.host_sems: dict[str, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(args.per_host))
        self.probes: dict[str, asyncio.Future] = {}
        self.checks: dict[str, asyncio.Future] = {}

    def check(self, url: str, samples: list[str]) -> asyncio.Future:
        if url not in self.checks:
            self.checks[url] = asyncio.ensure_future(self._check(url, samples))
        return self.checks[url]

    async def _check(self, url: str, samples: list[str]) -> CheckResult:
        host = urlsplit(url).hostname or ""
        if host not in self.probes:
            self.probes[host] = asyncio.ensure_future(probe_host(self.client, host, samples))
        _, mode, title = await self.probes[host]
        if mode == "unverifiable":
            return CheckResult(url, "unknown", "unverifiable_host")
        return await check_url(self.client, url, self.global_sem, self.host_sems, self.args.retries,
                               title if mode == "soft404" else None)

    def soft404_titles(self) -> dict[str, str]:
        done = (p.result() for p in self.probes.values() if p.done() and not p.exception())
        return {host: title for host, mode, title in done if mode == "soft404"}


async def process_database(db_path: Path, checker: LinkChecker, args: argparse.Namespace,
                           today: date, checked_at: str) -> dict[str, object] | None:
    state = state_of(db_path)
    rows = await asyncio.to_thread(load_candidates, db_path)
    if rows is None:
        return None

    results_rows: list[tuple[int, CheckResult]] = []
    by_url: dict[str, list[int]] = defaultdict(list)
    invalid = 0
    for rowid, raw_url, raw_deadline in rows:
        deadline = parse_deadline(raw_deadline)
        if deadline is not None and deadline < today:
            results_rows.append((rowid, CheckResult(raw_url or "", "expired", "past_due")))
        elif raw_url and raw_url.strip():
            clean = normalize_url(raw_url)
            if clean is None:
                invalid += 1
            else:
                by_url[clean].append(rowid)
    past_due = len(results_rows)
    log.info("state=%s candidates=%d past_deadline=%d unique_urls=%d malformed_urls=%d",
             state, len(rows), past_due, len(by_url), invalid)

    samples: dict[str, list[str]] = defaultdict(list)
    for u in by_url:
        host_samples = samples[urlsplit(u).hostname or ""]
        if len(host_samples) < 3:
            host_samples.append(u)
    urls = list(by_url)
    checked = await asyncio.gather(*(checker.check(u, samples[urlsplit(u).hostname or ""]) for u in urls))
    # Copy: results are shared across states and the breaker below mutates them.
    results = {u: replace(r) for u, r in zip(urls, checked)}
    apply_host_breaker(results, checker.soft404_titles())
    for u, rowids in by_url.items():
        results_rows.extend((rowid, results[u]) for rowid in rowids)

    verdicts = Counter(r.verdict for _, r in results_rows)
    for _, r in results_rows:
        if r.verdict != "active" and args.verbose:
            log.debug("state=%s %s %s -> %s (%s)", state, r.verdict, r.url, r.final_url or "-", r.reason)

    remaining = len(rows) - verdicts["expired"]
    error = None
    if not args.dry_run and results_rows:
        try:
            remaining = await asyncio.to_thread(write_results, db_path, results_rows, checked_at)
        except sqlite3.Error as exc:
            error = str(exc)
            log.error("state=%s update failed and was rolled back: %s", state, exc)
    return {
        "state": state,
        "checked": len(results_rows),
        "expired": verdicts["expired"],
        "past_due": past_due,
        "dead_link": verdicts["expired"] - past_due,
        "unverified": verdicts["unknown"],
        "active_remaining": remaining,
        "reasons": Counter(r.reason for _, r in results_rows if r.verdict == "unknown"),
        "error": error,
    }


def print_summary(metrics: list[dict[str, object]], dry_run: bool) -> None:
    header = f"{'STATE':<6}{'CHECKED':>9}{'EXPIRED':>9}{'PAST_DUE':>10}{'DEAD_LINK':>11}{'UNVERIFIED':>12}{'ACTIVE_LEFT':>13}"
    lines = ["", header, "-" * len(header)]
    totals = Counter()
    for m in sorted(metrics, key=lambda m: m["state"]):
        lines.append(f"{m['state']:<6}{m['checked']:>9}{m['expired']:>9}{m['past_due']:>10}"
                     f"{m['dead_link']:>11}{m['unverified']:>12}{m['active_remaining']:>13}"
                     + ("  WRITE FAILED" if m["error"] else ""))
        totals.update({k: m[k] for k in ("checked", "expired", "past_due", "dead_link", "unverified", "active_remaining")})
    lines.append("-" * len(header))
    lines.append(f"{'TOTAL':<6}{totals['checked']:>9}{totals['expired']:>9}{totals['past_due']:>10}"
                 f"{totals['dead_link']:>11}{totals['unverified']:>12}{totals['active_remaining']:>13}")
    if dry_run:
        lines.append("(dry run: no changes written)")
    print("\n".join(lines), flush=True)
    unverified = sum((m["reasons"] for m in metrics), Counter())
    if unverified:
        log.warning("Unverified links left active: %s", dict(unverified.most_common()))


async def run(args: argparse.Namespace) -> int:
    wanted = {s.upper() for s in args.states or []}
    db_paths = [p for p in sorted(DATA_DIR.glob("opportunities_*.db")) if not wanted or state_of(p) in wanted]
    if not db_paths:
        log.error("No opportunities_{STATE}.db files found in %s", DATA_DIR)
        return 2
    log.info("Found %d state databases: %s", len(db_paths), ", ".join(state_of(p) for p in db_paths))

    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)
    started = time.monotonic()
    async with httpx.AsyncClient(
        headers=HEADERS, timeout=httpx.Timeout(args.timeout), follow_redirects=True,
        max_redirects=10, limits=limits,
    ) as client:
        checker = LinkChecker(client, args)
        outcomes = await asyncio.gather(
            *(process_database(p, checker, args, date.today(), checked_at) for p in db_paths),
            return_exceptions=True,
        )

    metrics, exit_code = [], 0
    for db_path, outcome in zip(db_paths, outcomes):
        if isinstance(outcome, BaseException):
            log.error("state=%s failed: %s: %s", state_of(db_path), type(outcome).__name__, outcome)
            exit_code = 1
        elif outcome is not None:
            metrics.append(outcome)
            exit_code = exit_code or (1 if outcome["error"] else 0)
    log.info("Finished in %.1fs (%d unique URLs assessed)", time.monotonic() - started, len(checker.checks))
    print_summary(metrics, args.dry_run)
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify state opportunity URLs and flag expired listings.")
    parser.add_argument("--states", nargs="*", help="State codes to check (default: all opportunities_*.db)")
    parser.add_argument("--dry-run", action="store_true", help="Check links but don't write to the databases")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--per-host", type=int, default=4, help="Max simultaneous requests per host")
    parser.add_argument("--retries", type=int, default=1, help="Retries for timeouts, connection errors and 5xx")
    parser.add_argument("-v", "--verbose", action="store_true", help="Log every expired/unverified URL")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
