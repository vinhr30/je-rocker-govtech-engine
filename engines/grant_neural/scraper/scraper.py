"""Fetch grant-related article signals from configured public news feeds."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Final
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote_plus, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree


USER_AGENT: Final = "Mozilla/5.0 (compatible; JE-ROCKER-GNE/0.1; +grant signal research)"
TIMEOUT_SECONDS: Final = 20
REPOSITORY_ROOT: Final = Path(__file__).resolve().parents[3]

SOURCE_FEEDS: Final = {
    "VA News": "https://news.va.gov/feed/",
}

SOURCE_LISTINGS: Final = {
    "HUD News": ("https://www.hud.gov/news", r"^/news/hud-no-"),
}

GRANT_TERMS: Final = re.compile(r"\b(grants?|funding|funds?|investment|financial assistance)\b", re.IGNORECASE)
FUNDED_AWARD: Final = re.compile(r"\bawards?\b.*(?:\$|\b(?:million|billion)\b)", re.IGNORECASE)


class _ArticleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._ignored_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "nav", "footer", "form", "svg"}:
            self._ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "nav", "footer", "form", "svg"} and self._ignored_depth:
            self._ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if not self._ignored_depth and text:
            self.parts.append(text)


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href = ""
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self._href = dict(attrs).get("href") or ""
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href:
            title = " ".join("".join(self._parts).split())
            if title:
                self.links.append((self._href, unescape(title)))
            self._href = ""
            self._parts = []


def _request_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/html"})
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")


def _request_json(url: str) -> Any:
    return json.loads(_request_text(url))


def _element_text(element: ElementTree.Element | None) -> str:
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


def _find_text(element: ElementTree.Element, names: tuple[str, ...]) -> str:
    for child in element.iter():
        local_name = child.tag.rsplit("}", 1)[-1].lower()
        if local_name in names:
            value = _element_text(child)
            if value:
                return value
    return ""


def _article_body(url: str) -> str:
    parser = _ArticleTextParser()
    parser.feed(_request_text(url))
    return "\n".join(parser.parts)


def _is_grant_related(title: str) -> bool:
    return bool(GRANT_TERMS.search(title) or FUNDED_AWARD.search(title))


def _published_date(url: str, body: str) -> str:
    url_match = re.search(r"/(\d{4}-\d{2}-\d{2})/", url)
    if url_match:
        return url_match.group(1)
    date_match = re.search(
        r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+"
        r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+"
        r"(\d{1,2}),\s+(\d{4})\b",
        body,
    )
    if not date_match:
        date_match = re.search(
            r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+"
            r"(\d{1,2}),\s+(\d{4})\b",
            body,
        )
    if not date_match:
        return ""
    month = (
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ).index(date_match.group(1)) + 1
    return f"{date_match.group(3)}-{month:02d}-{int(date_match.group(2)):02d}"


def _fetch_listing_latest(source: str) -> dict[str, str]:
    listing_url, link_pattern = SOURCE_LISTINGS[source]
    parser = _LinkParser()
    parser.feed(_request_text(listing_url))
    for href, title in parser.links:
        if re.match(link_pattern, urlparse(href).path) and _is_grant_related(title):
            url = urljoin(listing_url, href)
            body = _article_body(url)
            return {
                "source": source,
                "title": title,
                "url": url,
                "date": _published_date(url, body),
                "body": body,
            }
    raise ValueError(f"No articles found on {source} listing")


def _fetch_indexed_latest(source: str, publisher_domain: str) -> dict[str, str]:
    query = quote_plus(f"site:{publisher_domain} grant funding award")
    root = ElementTree.fromstring(_request_text(f"https://www.bing.com/news/search?q={query}&format=rss"))
    for entry in root.findall(".//item"):
        title = _find_text(entry, ("title",))
        indexed_url = _find_text(entry, ("link",))
        target_url = parse_qs(urlparse(indexed_url).query).get("url", [indexed_url])[0]
        if publisher_domain not in urlparse(target_url).netloc or not _is_grant_related(title):
            continue
        body = _article_body(target_url)
        return {
            "source": source,
            "title": re.sub(r"\s+-\s+Stars and Stripes$", "", title).strip(),
            "url": target_url,
            "date": _find_text(entry, ("pubdate", "published", "date")) or _published_date(target_url, body),
            "body": body,
        }
    raise ValueError(f"No grant-related articles found for {source}")


def _raw_article(source: str, title: Any, url: Any, date_value: Any, body: Any, **metadata: Any) -> dict[str, Any]:
    article = {
        "source": source,
        "title": str(title or "").strip(),
        "url": str(url or "").strip(),
        "date": str(date_value or "").strip(),
        "body": str(body or ""),
    }
    article.update({key: value for key, value in metadata.items() if value not in (None, "")})
    if not article["title"] or not article["url"] or not article["date"] or not article["body"]:
        raise ValueError(f"Incomplete article returned by {source}")
    return article


def _latest_database_row(database_path: Any, table: str, columns: dict[str, tuple[str, ...]], grant_related: bool = False) -> dict[str, Any]:
    path = REPOSITORY_ROOT / database_path
    if not path.exists():
        raise ValueError(f"Fallback database unavailable: {path}")
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        available = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        selected = {}
        for output_name, candidates in columns.items():
            available_candidates = [candidate for candidate in candidates if candidate in available]
            if output_name == "date":
                selected[output_name] = next((
                    candidate for candidate in available_candidates
                    if connection.execute(
                        f"SELECT 1 FROM {table} WHERE {candidate} GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]*' LIMIT 1"
                    ).fetchone()
                ), available_candidates[0] if available_candidates else None)
            else:
                selected[output_name] = available_candidates[0] if available_candidates else None
        required = ("title", "url", "date", "body")
        if any(not selected.get(name) for name in required):
            raise ValueError(f"{table} does not contain the required normalized fields")
        select_sql = ", ".join(f"{column} AS {name}" for name, column in selected.items() if column)
        date_column = selected["date"]
        rows = connection.execute(
            f"SELECT {select_sql} FROM {table} WHERE COALESCE(title, '') <> '' AND COALESCE({selected['url']}, '') <> '' "
            f"AND {date_column} GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]*' "
            f"ORDER BY {date_column} DESC, rowid DESC LIMIT 500"
        ).fetchall()
        row = next((candidate for candidate in rows if not grant_related or _is_grant_related(f"{candidate['title']} {candidate['body']}")), None)
        if row is None:
            raise ValueError(f"No normalized records found in {path.name}")
        return dict(row)
    finally:
        connection.close()


def _fetch_state_database(state_code: str, source: str) -> dict[str, Any]:
    row = _latest_database_row(
        f"data/opportunities_{state_code}.db",
        "normalized_listings",
        {
            "title": ("title", "event_name"),
            "url": ("url", "detail_url"),
            "date": ("posted_date", "start_date", "opening_date", "normalized_at"),
            "body": ("description", "raw_text", "metadata_json"),
            "agency": ("agency", "department"),
            "notice_type": ("category", "event_type", "bid_type"),
        },
        grant_related=True,
    )
    body_parts = [
        f"Title: {row['title']}",
        f"Agency: {row.get('agency') or 'Not listed'}",
        f"Notice type: {row.get('notice_type') or 'Not listed'}",
        f"Posted date: {row['date']}",
        f"Description: {str(row.get('body') or '').strip() or 'No additional description published.'}",
    ]
    body = "\n".join(body_parts)
    return _raw_article(source, row["title"], row["url"], row["date"], body, agency=row.get("agency"), state=state_code)


def _database_articles(
    database_path: str,
    table: str,
    source: str,
    where_sql: str = "1 = 1",
    params: tuple[Any, ...] = (),
    limit: int | None = None,
    source_type: str = "federal",
) -> list[dict[str, Any]]:
    path = REPOSITORY_ROOT / database_path
    if not path.exists():
        raise ValueError(f"Normalized source unavailable: {path}")
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        available = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        order_column = next((name for name in ("posted_date", "issue_date", "normalized_at", "created_at") if name in available), "rowid")
        limit_sql = f" LIMIT {int(limit)}" if limit else ""
        rows = connection.execute(
            f"SELECT * FROM {table} WHERE {where_sql} ORDER BY {order_column} DESC{limit_sql}",
            params,
        ).fetchall()
    finally:
        connection.close()

    articles = []
    for record in rows:
        row = dict(record)
        title = row.get("title") or row.get("event_name")
        url = row.get("url") or row.get("official_url") or row.get("sbir_topic_url")
        posted = row.get("posted_date") or row.get("normalized_at") or row.get("created_at")
        body = row.get("description") or row.get("abstract") or ""
        agency = row.get("agency") or row.get("department")
        identifier = row.get("opportunity_number") or row.get("solicitation_number") or row.get("topic_number") or row.get("external_id")
        category = row.get("category") or row.get("opportunity_category")
        close_date = row.get("close_date") or row.get("end_date") or row.get("closing_date")
        eligibility = row.get("applicant_types") or row.get("eligibility")
        phase = row.get("phase")
        if not phase:
            phase_match = re.search(r"\bPhase\s+(III|IIB|II|I)\b", str(title or ""), re.IGNORECASE)
            phase = phase_match.group(1).upper() if phase_match else None
        full_text = "\n".join(filter(None, [
            f"Agency: {agency}" if agency else "",
            f"Opportunity number: {identifier}" if identifier else "",
            f"Category: {category}" if category else "",
            f"Phase: {phase}" if phase else "",
            f"Close date: {close_date}" if close_date else "",
            f"Eligibility: {eligibility}" if eligibility else "",
            str(body).strip() or "No additional description published.",
        ]))
        try:
            articles.append(_raw_article(
                source, title, url, posted, full_text,
                agency=agency, opportunity_number=identifier, category=category,
                close_date=close_date, eligibility=eligibility, phase=phase,
                source_type=source_type,
                funding_amount=row.get("estimated_funding") or row.get("funding_max"),
            ))
        except ValueError:
            continue
    if not articles:
        raise ValueError(f"No dated normalized records found for {source}")
    return articles


def _fetch_federal_agency(source: str, agency_terms: tuple[str, ...]) -> list[dict[str, Any]]:
    clauses = " OR ".join("lower(agency) LIKE ?" for _ in agency_terms)
    params = tuple(f"%{term.casefold()}%" for term in agency_terms)
    return _database_articles(
        "grant_scraper/data/grants.db", "grants_normalized", source,
        f"({clauses}) AND COALESCE(posted_date, '') GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]*'",
        params, source_type="federal",
    )


def _fetch_sbir_agency(source: str, agency_terms: tuple[str, ...]) -> list[dict[str, Any]]:
    clauses = " OR ".join("lower(s.agency) LIKE ?" for _ in agency_terms)
    params = tuple(f"%{term.casefold()}%" for term in agency_terms)
    path = REPOSITORY_ROOT / "sbir_scraper/data/sbir.db"
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT s.title, s.agency, s.solicitation_number, s.topic_number, s.phase, s.created_at, "
            "COALESCE(s.official_url, s.sbir_topic_url) AS url, d.abstract, d.deliverables, d.funding_max "
            "FROM sbir_topic_sources s LEFT JOIN sbir_topic_details d ON d.sbir_topic_id = s.id "
            f"WHERE {clauses} ORDER BY s.created_at DESC",
            params,
        ).fetchall()
    finally:
        connection.close()
    articles = []
    for record in rows:
        row = dict(record)
        body = "\n".join(filter(None, [
            f"Agency: {row.get('agency')}", f"Phase: {row.get('phase')}",
            f"Solicitation: {row.get('solicitation_number')}", f"Topic: {row.get('topic_number')}",
            row.get("abstract"), row.get("deliverables"),
        ]))
        try:
            articles.append(_raw_article(
                source, row.get("title"), row.get("url"), row.get("created_at"), body,
                agency=row.get("agency"), phase=row.get("phase"), close_date=None,
                source_type="innovation", funding_amount=row.get("funding_max"),
            ))
        except ValueError:
            continue
    if articles:
        return articles
    return _database_articles(
        "grant_scraper/data/grants.db", "grants_normalized", source,
        "category = 'sbir' AND (" + " OR ".join("lower(agency) LIKE ?" for _ in agency_terms) + ")",
        params, source_type="innovation",
    )


def _fetch_baa(source: str, agency_terms: tuple[str, ...]) -> list[dict[str, Any]]:
    agency_clause = " OR ".join("lower(agency) LIKE ?" for _ in agency_terms)
    params = tuple(f"%{term.casefold()}%" for term in agency_terms)
    return _database_articles(
        "grant_scraper/data/grants.db", "grants_normalized", source,
        f"({agency_clause}) AND (lower(title) LIKE '%broad agency%' OR lower(title) LIKE '%baa%' OR lower(description) LIKE '%broad agency announcement%')",
        params, source_type="innovation",
    )


def _fetch_official_indexed(source: str, domain: str, source_type: str) -> dict[str, Any]:
    article = _fetch_indexed_rendered_latest(source, domain)
    return {**article, "source_type": source_type}


def _fetch_rendered_listing_latest(source: str, listing_url: str, link_pattern: str) -> dict[str, str]:
    rendered_listing = _request_text("https://r.jina.ai/" + listing_url)
    links = re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", rendered_listing)
    for title, url in links:
        if re.match(link_pattern, urlparse(url).path) and _is_grant_related(title):
            body = _request_text("https://r.jina.ai/" + url)
            published = _published_date(url, body)
            if not published:
                continue
            return {
                "source": source,
                "title": unescape(title).strip(),
                "url": url,
                "date": published,
                "body": body,
            }
    raise ValueError(f"No grant-related articles found on {source} listing")


def _fetch_indexed_rendered_latest(source: str, publisher_domain: str) -> dict[str, str]:
    query = quote_plus(f"site:{publisher_domain} grant funding modernization homelessness")
    root = ElementTree.fromstring(_request_text(f"https://www.bing.com/news/search?q={query}&format=rss"))
    for entry in root.findall(".//item"):
        title = _find_text(entry, ("title",))
        indexed_url = _find_text(entry, ("link",))
        target_url = parse_qs(urlparse(indexed_url).query).get("url", [indexed_url])[0]
        if publisher_domain not in urlparse(target_url).netloc or not _is_grant_related(title):
            continue
        body = _request_text("https://r.jina.ai/" + target_url)
        return _raw_article(source, re.sub(r"\s+-\s+[^-]+$", "", title), target_url, _find_text(entry, ("pubdate", "published", "date")), body)
    raise ValueError(f"No grant-related articles found for {source}")


def _fetch_latest(source: str) -> dict[str, str]:
    root = ElementTree.fromstring(_request_text(SOURCE_FEEDS[source]))
    entries = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1].lower() in {"item", "entry"}]
    if not entries:
        raise ValueError(f"No articles found in {source} feed")

    entry = next((candidate for candidate in entries if _is_grant_related(_find_text(candidate, ("title",)))), None)
    if entry is None:
        raise ValueError(f"No grant-related articles found in {source} feed")
    title = _find_text(entry, ("title",))
    published_date = _find_text(entry, ("pubdate", "published", "updated", "date"))
    url = _find_text(entry, ("link", "guid"))
    if not url:
        for child in entry.iter():
            if child.tag.rsplit("}", 1)[-1].lower() == "link" and child.attrib.get("href"):
                url = child.attrib["href"]
                break
    if not title or not url:
        raise ValueError(f"Article metadata incomplete in {source} feed")

    return {
        "source": source,
        "title": title,
        "url": url,
        "date": published_date,
        "body": _article_body(url),
    }


def fetch_va_news() -> dict[str, str]:
    endpoint = "https://news.va.gov/wp-json/wp/v2/news-releases?search=grant&orderby=date&order=desc&per_page=1"
    records = json.loads(_request_text(endpoint))
    if not records:
        raise ValueError("No grant-related articles found in VA News API")
    record = records[0]
    parser = _ArticleTextParser()
    parser.feed(record.get("content", {}).get("rendered", ""))
    return {
        "source": "VA News",
        "title": unescape(record.get("title", {}).get("rendered", "")).strip(),
        "url": str(record.get("link") or "").strip(),
        "date": str(record.get("date") or "").strip(),
        "body": "\n".join(parser.parts),
    }


def fetch_hud_news() -> dict[str, str]:
    return _fetch_listing_latest("HUD News")


def fetch_hhs_news() -> dict[str, str]:
    return _fetch_rendered_listing_latest(
        "HHS News",
        "https://www.hhs.gov/press-room/index.html",
        r"^/press-room/.+\.html$",
    )


def fetch_stars_and_stripes() -> dict[str, str]:
    return _fetch_indexed_latest("Stars and Stripes", "stripes.com")


def fetch_military_com() -> dict[str, str]:
    return _fetch_indexed_latest("Military.com", "military.com")


def fetch_ap_news() -> dict[str, str]:
    return _fetch_indexed_rendered_latest("AP News", "apnews.com")


def fetch_reuters() -> dict[str, str]:
    return _fetch_indexed_rendered_latest("Reuters", "reuters.com")


def fetch_va_press() -> dict[str, Any]:
    article = fetch_va_news()
    return {**article, "source": "VA Press Releases"}


def fetch_hud_press() -> dict[str, Any]:
    article = fetch_hud_news()
    return {**article, "source": "HUD Press Releases"}


def fetch_hhs_press() -> dict[str, Any]:
    article = fetch_hhs_news()
    return {**article, "source": "HHS Press Releases"}


def fetch_grants_gov() -> list[dict[str, Any]]:
    api_url = "https://api.simpler.grants.gov/v1/opportunities/search"
    try:
        page_size = 100
        page_offset = 1
        api_articles = []
        while True:
            request = Request(
                api_url,
                data=json.dumps({"pagination": {"page_offset": page_offset, "page_size": page_size}, "sort_order": [{"order_by": "posted_date", "sort_direction": "descending"}]}).encode("utf-8"),
                headers={"User-Agent": USER_AGENT, "Content-Type": "application/json", "Accept": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
            items = payload.get("data") or payload.get("opportunities") or payload.get("items") or []
            if isinstance(items, dict):
                items = items.get("opportunities") or items.get("items") or []
            if not items:
                break
            for item in items:
                opportunity_id = item.get("opportunity_id") or item.get("id") or item.get("opportunity_number")
                url = item.get("url") or f"https://simpler.grants.gov/opportunity/{opportunity_id}"
                body = item.get("summary") or item.get("description") or item.get("description_plain")
                agency = item.get("agency_name") or item.get("agency")
                try:
                    api_articles.append(_raw_article(
                        "Grants.gov", item.get("title"), url, item.get("posted_date"), body,
                        opportunity_number=item.get("opportunity_number"), agency=agency,
                        category=item.get("category") or item.get("opportunity_category"),
                        funding_amount=item.get("estimated_funding") or item.get("award_ceiling"),
                        eligibility=item.get("applicant_types") or item.get("eligibility"),
                        close_date=item.get("close_date"), source_type="federal",
                    ))
                except ValueError:
                    continue
            if len(items) < page_size:
                break
            page_offset += 1
        if api_articles:
            return api_articles
    except (HTTPError, OSError, ValueError, json.JSONDecodeError):
        pass

    return _database_articles(
        "grant_scraper/data/grants.db", "grants_normalized", "Grants.gov",
        "category = 'grants_gov' AND COALESCE(posted_date, '') GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]*'",
        source_type="federal",
    )


def _sam_api_articles(api_key: str) -> list[dict[str, Any]]:
    from datetime import date, timedelta

    today = date.today()
    query = urlencode({
        "api_key": api_key,
        "postedFrom": (today - timedelta(days=30)).strftime("%m/%d/%Y"),
        "postedTo": today.strftime("%m/%d/%Y"),
        "limit": int(os.environ.get("SAM_LIMIT", "1000")),
    })
    payload = _request_json("https://api.sam.gov/opportunities/v2/search?" + query)
    items = payload.get("opportunitiesData") or payload.get("data") or payload.get("opportunities") or []
    if not items:
        raise ValueError("SAM.gov API returned no notices")
    articles = []
    for item in items:
        notice_id = item.get("noticeId") or item.get("solicitationNumber")
        agency = item.get("fullParentPathName") or item.get("department") or item.get("organizationName")
        notice_type = item.get("type") or item.get("noticeType")
        description = item.get("description") or item.get("additionalInfoLink") or ""
        response_date = item.get("responseDeadLine") or item.get("responseDate")
        body = f"Notice type: {notice_type or 'Not listed'}\nAgency: {agency or 'Not listed'}\nResponse date: {response_date or 'Not listed'}\n{description}"
        url = item.get("uiLink") or f"https://sam.gov/opp/{notice_id}/view"
        try:
            articles.append(_raw_article("SAM.gov", item.get("title"), url, item.get("postedDate") or item.get("posted_date"), body, notice_type=notice_type, agency=agency, response_date=response_date, source_type="procurement"))
        except ValueError:
            continue
    if not articles:
        raise ValueError("SAM.gov API returned no complete notices")
    return articles


def _sam_html_fallback() -> dict[str, Any]:
    listing_url = "https://sam.gov/search/?index=opp"
    body = _request_text("https://r.jina.ai/" + listing_url)
    links = re.findall(r"\[([^\]]+)\]\((https?://(?:www\.)?sam\.gov/[^)]+)\)", body)
    for title, url in links:
        if _is_grant_related(title) or "/opp/" in url or "/contract/opp/" in url:
            article_body = _request_text("https://r.jina.ai/" + url)
            published = _published_date(url, article_body)
            if published:
                return _raw_article("SAM.gov", title, url, published, article_body, notice_type="Public notice")
    raise ValueError("SAM.gov API unavailable and HTML fallback returned no dated notices")


def fetch_sam_gov() -> list[dict[str, Any]]:
    api_key = os.environ.get("SAM_API_KEY", "").strip()
    if api_key:
        try:
            return _sam_api_articles(api_key)
        except HTTPError as error:
            if error.code not in {403, 404}:
                raise
    return [_sam_html_fallback()]


def fetch_state_az() -> dict[str, Any]:
    try:
        return _fetch_state_database("AZ", "Arizona State Portal")
    except ValueError:
        return _fetch_rendered_listing_latest(
            "Arizona State Portal",
            "https://ospb.az.gov/grants-resources",
            r"^/(?:grants?|funding|sites/default/files)/",
        )


def fetch_state_ca() -> dict[str, Any]:
    return _fetch_state_database("CA", "California State Portal")


def fetch_state_fl() -> dict[str, Any]:
    return _fetch_state_database("FL", "Florida State Portal")


def fetch_state_va() -> dict[str, Any]:
    return _fetch_state_database("VA", "Virginia State Portal")


def fetch_state_tx() -> dict[str, Any]:
    return _fetch_state_database("TX", "Texas State Portal")


def fetch_nsf() -> list[dict[str, Any]]:
    return _fetch_federal_agency("NSF", ("national science foundation",))


def fetch_doe() -> list[dict[str, Any]]:
    return _fetch_federal_agency("DOE", ("department of energy", "office of science"))


def fetch_dot() -> list[dict[str, Any]]:
    return _fetch_federal_agency("DOT", ("department of transportation", "federal transit", "federal highway", "federal railroad"))


def fetch_dhs() -> list[dict[str, Any]]:
    return _fetch_federal_agency("DHS", ("department of homeland security", "fema"))


def fetch_usda() -> list[dict[str, Any]]:
    return _fetch_federal_agency("USDA", ("department of agriculture", "rural utilities", "rural business", "national institute of food"))


def fetch_treasury() -> list[dict[str, Any]]:
    return _fetch_federal_agency("Treasury", ("treasury",))


def fetch_sba() -> list[dict[str, Any]]:
    return _fetch_federal_agency("SBA", ("small business administration",))


def fetch_nih() -> list[dict[str, Any]]:
    return _fetch_federal_agency("NIH", ("national institutes of health",))


def fetch_cdc() -> list[dict[str, Any]]:
    return _fetch_federal_agency("CDC", ("centers for disease control",))


def fetch_doj() -> list[dict[str, Any]]:
    return _fetch_federal_agency("DOJ", ("bureau of justice", "department of justice", "office on violence"))


def fetch_dol() -> list[dict[str, Any]]:
    return _fetch_federal_agency("DOL", ("department of labor", "employment and training"))


def fetch_commerce_eda() -> list[dict[str, Any]]:
    return _fetch_federal_agency("Commerce/EDA", ("department of commerce", "economic development administration", "national telecommunications"))


def fetch_epa() -> list[dict[str, Any]]:
    return _fetch_federal_agency("EPA", ("environmental protection agency",))


def fetch_sbir_sttr_dod() -> list[dict[str, Any]]:
    return _fetch_sbir_agency("DoD SBIR/STTR", ("dod", "army", "navy", "usaf", "osd", "dtra", "darpa"))


def fetch_sbir_sttr_nasa() -> list[dict[str, Any]]:
    return _fetch_sbir_agency("NASA SBIR/STTR", ("nasa",))


def fetch_sbir_sttr_nih() -> list[dict[str, Any]]:
    return _fetch_sbir_agency("NIH SBIR/STTR", ("nih", "national institutes of health"))


def fetch_sbir_sttr_nsf() -> list[dict[str, Any]]:
    return _fetch_sbir_agency("NSF SBIR/STTR", ("nsf", "national science foundation"))


def fetch_sbir_sttr_doe() -> list[dict[str, Any]]:
    return _fetch_sbir_agency("DOE SBIR/STTR", ("doe", "department of energy"))


def fetch_darpa_baa() -> list[dict[str, Any]]:
    return _fetch_baa("DARPA BAA", ("darpa",))


def fetch_arpa_h_baa() -> list[dict[str, Any]]:
    return _fetch_baa("ARPA-H BAA", ("arpa-h", "advanced research projects agency for health"))


def fetch_arpa_e_baa() -> list[dict[str, Any]]:
    return _fetch_baa("ARPA-E BAA", ("arpa-e", "advanced research projects agency energy"))


def fetch_dhs_st_baa() -> list[dict[str, Any]]:
    return _fetch_baa("DHS S&T BAA", ("department of homeland security",))


def fetch_dod_labs_baa() -> list[dict[str, Any]]:
    return _fetch_baa("DoD Labs BAA", ("air force", "army", "naval", "defense"))


def fetch_state_ny() -> dict[str, Any]:
    path = REPOSITORY_ROOT / "data/opportunities_NY.db"
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT * FROM normalized_listings WHERE issue_date GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]*' ORDER BY issue_date DESC LIMIT 500"
        ).fetchall()
    finally:
        connection.close()
    row = next((dict(record) for record in rows if _is_grant_related(f"{record['title']} {record['full_description']}")), None)
    if row is None:
        raise ValueError("No dated grant-related New York records found")
    url = f"https://www.nyscr.ny.gov/#cr-{row['cr_number']}"
    body = "\n".join(filter(None, [
        f"Agency: {row.get('agency')}", f"Category: {row.get('category')}",
        f"Ad type: {row.get('ad_type')}", f"Due date: {row.get('due_date')}",
        row.get("full_description"),
    ]))
    return _raw_article("New York State Portal", row["title"], url, row["issue_date"], body, agency=row.get("agency"), state="NY", source_type="state")


def fetch_state_wa() -> dict[str, Any]:
    return _fetch_official_indexed("Washington State Portal", "wa.gov", "state")


def fetch_state_co() -> dict[str, Any]:
    return _fetch_official_indexed("Colorado State Portal", "co.gov", "state")


def fetch_state_il() -> dict[str, Any]:
    return _fetch_official_indexed("Illinois State Portal", "illinois.gov", "state")


def fetch_state_ga() -> dict[str, Any]:
    return _fetch_official_indexed("Georgia State Portal", "georgia.gov", "state")


def fetch_state_nc() -> dict[str, Any]:
    return _fetch_official_indexed("North Carolina State Portal", "nc.gov", "state")


def fetch_state_pa() -> dict[str, Any]:
    return _fetch_official_indexed("Pennsylvania State Portal", "pa.gov", "state")


def fetch_state_oh() -> dict[str, Any]:
    return _fetch_official_indexed("Ohio State Portal", "ohio.gov", "state")


def fetch_state_mi() -> dict[str, Any]:
    return _fetch_official_indexed("Michigan State Portal", "michigan.gov", "state")


def fetch_state_ma() -> dict[str, Any]:
    return _fetch_official_indexed("Massachusetts State Portal", "mass.gov", "state")


def fetch_local_counties() -> dict[str, Any]:
    return _fetch_official_indexed("Local Counties", "naco.org", "local")


def fetch_local_cities() -> dict[str, Any]:
    return _fetch_official_indexed("Local Cities", "nlc.org", "local")


def fetch_regional_planning_orgs() -> dict[str, Any]:
    return _fetch_official_indexed("Regional Planning Organizations", "narc.org", "local")
