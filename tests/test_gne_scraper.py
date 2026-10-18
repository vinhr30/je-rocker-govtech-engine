import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

from core.pipeline import gne_pipeline
from engines.grant_neural.scraper import scraper, store
from engines.grant_neural.scraper.normalize import normalize_article_to_signal


RAW_ARTICLE = {
    "source": "VA Press Releases",
    "title": "VA awards $1.17 billion in grants to fight Veteran homelessness",
    "url": "https://news.va.gov/press-room/va-awards-1-17-billion-in-grants-to-fight-veteran-homelessness/",
    "date": "2026-09-14T10:00:00",
    "body": "VA announced $1.17 billion in grants to organizations helping Veterans.",
}


@pytest.mark.parametrize("date_value", ["Sep 21, 2026", "09/21/2026", "2026/09/21", "20260921", "2026-09-21T12:30:00Z"])
def test_normalize_new_date_formats_and_preserve_text(date_value: str) -> None:
    raw_text = "  exact source text\nwith spacing  "
    signal = normalize_article_to_signal(RAW_ARTICLE | {
        "source": "AP News",
        "canonical_url": "https://apnews.com/article/canonical",
        "url": "https://redirect.invalid",
        "date": date_value,
        "body": raw_text,
    })
    assert signal["source"] == "AP News"
    assert signal["published_date"] == "2026-09-21"
    assert signal["url"] == "https://apnews.com/article/canonical"
    assert signal["raw_text"] == raw_text


def test_normalize_rejects_unrecognized_date() -> None:
    signal = normalize_article_to_signal(RAW_ARTICLE | {"date": "—"})
    assert signal["published_date"] == ""


@pytest.mark.parametrize("function_name,source,domain", [
    ("fetch_military_com", "Military.com", "military.com"),
    ("fetch_ap_news", "AP News", "apnews.com"),
    ("fetch_reuters", "Reuters", "reuters.com"),
])
def test_news_fetch_functions(monkeypatch, function_name: str, source: str, domain: str) -> None:
    calls = []
    helper_name = "_fetch_indexed_latest" if function_name == "fetch_military_com" else "_fetch_indexed_rendered_latest"
    monkeypatch.setattr(scraper, helper_name, lambda actual_source, actual_domain: calls.append((actual_source, actual_domain)) or RAW_ARTICLE | {"source": actual_source})
    article = getattr(scraper, function_name)()
    assert article["source"] == source
    assert calls == [(source, domain)]


@pytest.mark.parametrize("function_name,base_name,source", [
    ("fetch_va_press", "fetch_va_news", "VA Press Releases"),
    ("fetch_hud_press", "fetch_hud_news", "HUD Press Releases"),
    ("fetch_hhs_press", "fetch_hhs_news", "HHS Press Releases"),
])
def test_official_press_fetch_functions(monkeypatch, function_name: str, base_name: str, source: str) -> None:
    monkeypatch.setattr(scraper, base_name, lambda: dict(RAW_ARTICLE))
    article = getattr(scraper, function_name)()
    assert article["source"] == source
    assert article["title"] == RAW_ARTICLE["title"]


def test_fetch_grants_gov_database_fallback(monkeypatch) -> None:
    monkeypatch.setattr(scraper, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(HTTPError("url", 404, "missing", {}, None)))
    monkeypatch.setattr(scraper, "_database_articles", lambda *args, **kwargs: [{
        "source": "Grants.gov",
        "title": "Federal grant", "url": "https://simpler.grants.gov/opportunity/1", "date": "2026-09-20",
        "body": "Opportunity number: HHS-1\nAgency: HHS\nFull grant summary", "agency": "HHS", "opportunity_number": "HHS-1",
    }])
    article = scraper.fetch_grants_gov()[0]
    assert article["source"] == "Grants.gov"
    assert article["opportunity_number"] == "HHS-1"
    assert "Agency: HHS" in article["body"]


def test_fetch_grants_gov_paginates_full_api(monkeypatch) -> None:
    payloads = [
        {"data": [{
            "title": f"Grant {index}", "opportunity_id": str(index), "opportunity_number": f"NOFO-{index}",
            "posted_date": "2026-09-21", "summary": "Full summary", "agency_name": "NIH",
            "category": "Discretionary", "estimated_funding": 1_000_000,
            "applicant_types": "Nonprofits", "close_date": "2026-12-01",
        } for index in range(100)]},
        {"data": [{
            "title": "Grant 100", "opportunity_id": "100", "opportunity_number": "NOFO-100",
            "posted_date": "2026-09-20", "summary": "Second page", "agency_name": "NSF",
        }]},
    ]

    class Response:
        def __init__(self, payload):
            self.payload = payload
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self):
            return json.dumps(self.payload).encode()

    monkeypatch.setattr(scraper, "urlopen", lambda *args, **kwargs: Response(payloads.pop(0)))
    articles = scraper.fetch_grants_gov()
    assert len(articles) == 101
    assert articles[0]["opportunity_number"] == "NOFO-0"
    assert articles[0]["funding_amount"] == 1_000_000
    assert articles[0]["eligibility"] == "Nonprofits"
    assert articles[0]["close_date"] == "2026-12-01"


def test_fetch_sam_gov_api_and_html_fallback(monkeypatch) -> None:
    monkeypatch.setenv("SAM_API_KEY", "key")
    monkeypatch.setattr(scraper, "_sam_api_articles", lambda key: [RAW_ARTICLE | {"source": "SAM.gov", "notice_type": "Solicitation"}])
    assert scraper.fetch_sam_gov()[0]["notice_type"] == "Solicitation"

    monkeypatch.setattr(scraper, "_sam_api_articles", lambda key: (_ for _ in ()).throw(HTTPError("url", 403, "blocked", {}, None)))
    monkeypatch.setattr(scraper, "_sam_html_fallback", lambda: RAW_ARTICLE | {"source": "SAM.gov", "notice_type": "Public notice"})
    assert scraper.fetch_sam_gov()[0]["notice_type"] == "Public notice"


@pytest.mark.parametrize("function_name,source", [
    ("fetch_nsf", "NSF"), ("fetch_doe", "DOE"), ("fetch_dot", "DOT"),
    ("fetch_dhs", "DHS"), ("fetch_usda", "USDA"), ("fetch_treasury", "Treasury"),
    ("fetch_sba", "SBA"), ("fetch_nih", "NIH"), ("fetch_cdc", "CDC"),
    ("fetch_doj", "DOJ"), ("fetch_dol", "DOL"),
    ("fetch_commerce_eda", "Commerce/EDA"), ("fetch_epa", "EPA"),
])
def test_federal_agency_fetch_functions(monkeypatch, function_name: str, source: str) -> None:
    calls = []
    monkeypatch.setattr(scraper, "_fetch_federal_agency", lambda actual_source, terms: calls.append((actual_source, terms)) or [RAW_ARTICLE | {"source": actual_source, "source_type": "federal"}])
    articles = getattr(scraper, function_name)()
    assert articles[0]["source"] == source
    assert calls[0][0] == source


@pytest.mark.parametrize("function_name,source", [
    ("fetch_sbir_sttr_dod", "DoD SBIR/STTR"),
    ("fetch_sbir_sttr_nasa", "NASA SBIR/STTR"),
    ("fetch_sbir_sttr_nih", "NIH SBIR/STTR"),
    ("fetch_sbir_sttr_nsf", "NSF SBIR/STTR"),
    ("fetch_sbir_sttr_doe", "DOE SBIR/STTR"),
])
def test_sbir_fetch_functions(monkeypatch, function_name: str, source: str) -> None:
    monkeypatch.setattr(scraper, "_fetch_sbir_agency", lambda actual_source, terms: [RAW_ARTICLE | {"source": actual_source, "source_type": "innovation", "phase": "II"}])
    article = getattr(scraper, function_name)()[0]
    assert article["source"] == source
    assert article["phase"] == "II"


@pytest.mark.parametrize("function_name,source", [
    ("fetch_darpa_baa", "DARPA BAA"), ("fetch_arpa_h_baa", "ARPA-H BAA"),
    ("fetch_arpa_e_baa", "ARPA-E BAA"), ("fetch_dhs_st_baa", "DHS S&T BAA"),
    ("fetch_dod_labs_baa", "DoD Labs BAA"),
])
def test_baa_fetch_functions(monkeypatch, function_name: str, source: str) -> None:
    monkeypatch.setattr(scraper, "_fetch_baa", lambda actual_source, terms: [RAW_ARTICLE | {"source": actual_source, "source_type": "innovation"}])
    assert getattr(scraper, function_name)()[0]["source"] == source


def test_wave3_new_york_state_fetch(monkeypatch) -> None:
    monkeypatch.setattr(scraper, "_fetch_state_database", lambda code, source: RAW_ARTICLE | {"source": source, "state": code})
    article = scraper.fetch_state_ny()
    assert article["source"] == "New York State Portal"
    assert article["state"] == "NY"


@pytest.mark.parametrize("function_name,source,domain", [
    ("fetch_state_wa", "Washington State Portal", "wa.gov"),
    ("fetch_state_co", "Colorado State Portal", "co.gov"),
    ("fetch_state_il", "Illinois State Portal", "illinois.gov"),
    ("fetch_state_ga", "Georgia State Portal", "georgia.gov"),
    ("fetch_state_nc", "North Carolina State Portal", "nc.gov"),
    ("fetch_state_pa", "Pennsylvania State Portal", "pa.gov"),
    ("fetch_state_oh", "Ohio State Portal", "ohio.gov"),
    ("fetch_state_mi", "Michigan State Portal", "michigan.gov"),
    ("fetch_state_ma", "Massachusetts State Portal", "mass.gov"),
    ("fetch_local_counties", "Local Counties", "naco.org"),
    ("fetch_local_cities", "Local Cities", "nlc.org"),
    ("fetch_regional_planning_orgs", "Regional Planning Organizations", "narc.org"),
])
def test_indexed_state_and_local_functions(monkeypatch, function_name: str, source: str, domain: str) -> None:
    calls = []
    monkeypatch.setattr(scraper, "_fetch_official_indexed", lambda actual_source, actual_domain, source_type: calls.append((actual_source, actual_domain, source_type)) or RAW_ARTICLE | {"source": actual_source, "source_type": source_type})
    article = getattr(scraper, function_name)()
    expected_type = "local" if source.startswith("Local") or source.startswith("Regional") else "state"
    assert article["source"] == source
    assert calls == [(source, domain, expected_type)]


@pytest.mark.parametrize("source,expected", [
    ("NIH", "federal"), ("California State Portal", "state"),
    ("Local Counties", "local"), ("NASA SBIR/STTR", "innovation"),
    ("SAM.gov", "procurement"),
])
def test_normalize_source_types(source: str, expected: str) -> None:
    signal = normalize_article_to_signal(RAW_ARTICLE | {"source": source})
    assert signal["source_type"] == expected


def test_normalize_preserves_full_notice_metadata() -> None:
    signal = normalize_article_to_signal(RAW_ARTICLE | {
        "source": "SAM.gov", "notice_type": "BAA", "agency": "DARPA",
        "opportunity_number": "DARPA-1", "response_date": "2026-12-01",
        "close_date": "2026-12-01", "category": "Research", "eligibility": "Small business",
        "funding_amount": 5_000_000,
    })
    assert signal["source_type"] == "procurement"
    assert signal["notice_type"] == "BAA"
    assert signal["agency"] == "DARPA"
    assert signal["opportunity_number"] == "DARPA-1"
    assert signal["response_date"] == "2026-12-01"
    assert signal["funding_amount"] == 5_000_000


def test_wave3_registry_order() -> None:
    names = [name for name, _ in gne_pipeline.SOURCE_FETCHERS]
    assert len(names) == 50
    assert names[:13] == ["NSF", "DOE", "DOT", "DHS", "USDA", "Treasury", "SBA", "NIH", "CDC", "DOJ", "DOL", "Commerce/EDA", "EPA"]
    assert names[13:16] == ["VA Press Releases", "HUD Press Releases", "HHS Press Releases"]
    assert names[16:18] == ["Grants.gov", "SAM.gov"]
    assert names[-4:] == ["AP News", "Reuters", "Military.com", "Stars and Stripes"]


@pytest.mark.parametrize("function_name,state_code,source", [
    ("fetch_state_az", "AZ", "Arizona State Portal"),
    ("fetch_state_ca", "CA", "California State Portal"),
    ("fetch_state_fl", "FL", "Florida State Portal"),
    ("fetch_state_va", "VA", "Virginia State Portal"),
    ("fetch_state_tx", "TX", "Texas State Portal"),
])
def test_state_fetch_functions(monkeypatch, function_name: str, state_code: str, source: str) -> None:
    calls = []
    monkeypatch.setattr(scraper, "_fetch_state_database", lambda code, name: calls.append((code, name)) or RAW_ARTICLE | {"source": name, "state": code})
    article = getattr(scraper, function_name)()
    assert article["source"] == source
    assert article["state"] == state_code
    assert calls == [(state_code, source)]


def test_store_signal_deduplicates_across_sources_and_logs(tmp_path: Path, monkeypatch, caplog) -> None:
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "grant_signals.json")
    first = normalize_article_to_signal(RAW_ARTICLE)
    duplicate = normalize_article_to_signal(RAW_ARTICLE | {"source": "Reuters", "title": "  VA awards   $1.17 billion in grants to fight Veteran homelessness  "})
    with caplog.at_level("INFO"):
        assert store.store_signal(first) is True
        assert store.store_signal(duplicate) is False
    assert len(json.loads(store.STATE_PATH.read_text(encoding="utf-8"))) == 1
    assert "grant_signal_stored" in caplog.text
    assert "grant_signal_duplicate" in caplog.text


def test_store_signal_logs_error_for_invalid_record(tmp_path: Path, monkeypatch, caplog) -> None:
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "grant_signals.json")
    with caplog.at_level("ERROR"), pytest.raises(ValueError, match="title and published_date"):
        store.store_signal({"title": "Undated signal", "published_date": ""})
    assert "grant_signal_error" in caplog.text


def test_pipeline_cardinality_and_error_handling(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "grant_signals.json")
    fetchers = tuple(
        (f"Source {index}", lambda index=index: RAW_ARTICLE | {"source": f"Source {index}", "title": f"Signal {index}"})
        for index in range(13)
    ) + (("Unavailable", lambda: (_ for _ in ()).throw(RuntimeError("blocked"))),)
    monkeypatch.setattr(gne_pipeline, "SOURCE_FETCHERS", fetchers)

    result = gne_pipeline.run_scraper()

    assert result["fetched"] == 13
    assert result["stored"] == 13
    assert result["duplicates"] == 0
    assert result["errors"] == [{"source": "Unavailable", "error": "blocked"}]
    assert len(json.loads(store.STATE_PATH.read_text(encoding="utf-8"))) == 13


def test_pipeline_isolates_invalid_article(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "grant_signals.json")
    monkeypatch.setattr(gne_pipeline, "SOURCE_FETCHERS", (
        ("Undated Source", lambda: RAW_ARTICLE | {"date": ""}),
        ("Valid Source", lambda: RAW_ARTICLE | {"title": "Valid signal"}),
    ))

    result = gne_pipeline.run_scraper()

    assert result["fetched"] == 2
    assert result["stored"] == 1
    assert result["errors"] == [{"source": "Undated Source", "error": "Signal title and published_date are required"}]
