"""Normalize raw news articles into Grant Neural Engine signals."""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any


def _source_type(article: dict[str, Any]) -> str:
    explicit = str(article.get("source_type") or "").strip().lower()
    if explicit in {"federal", "state", "local", "innovation", "procurement"}:
        return explicit
    source = str(article.get("source") or "").casefold()
    if "state portal" in source:
        return "state"
    if source in {"local counties", "local cities", "regional planning organizations"}:
        return "local"
    if "sbir" in source or "sttr" in source or "baa" in source or "arpa" in source:
        return "innovation"
    if source == "sam.gov":
        return "procurement"
    return "federal"


def _normalize_date(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            for date_format in ("%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y", "%Y/%m/%d", "%Y%m%d"):
                try:
                    return datetime.strptime(raw, date_format).date().isoformat()
                except ValueError:
                    continue
            match = __import__("re").search(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b", raw)
            return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}" if match else ""
    return parsed.date().isoformat()


def normalize_article_to_signal(article: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw scraper article to the unified grant signal schema."""
    return {
        "source": str(article.get("source") or "").strip(),
        "title": str(article.get("title") or "").strip(),
        "url": str(article.get("canonical_url") or article.get("url") or "").strip(),
        "published_date": _normalize_date(article.get("published_date") or article.get("date")),
        "source_type": _source_type(article),
        "funding_amount": article.get("funding_amount"),
        "agency": article.get("agency"),
        "target_population": [],
        "program_types": [],
        "geography": "national",
        "raw_text": str(article.get("raw_text") if article.get("raw_text") is not None else article.get("body") or ""),
        "categories": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
        **{
            key: article[key]
            for key in ("opportunity_number", "category", "eligibility", "close_date", "response_date", "notice_type", "phase", "state")
            if article.get(key) not in (None, "")
        },
    }
