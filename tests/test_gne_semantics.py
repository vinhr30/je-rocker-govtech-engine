from core.pipeline.gne_pipeline import run_semantic_extractor
from core.state import gne_state
from engines.grant_neural.semantics.extractor import (
    extract_funding_amount,
    extract_program_types,
    extract_target_population,
    run_semantic_extraction,
)


VA_TEXT = """
The Department of Veterans Affairs announced a record high $1.17 billion in
 grants to help Veterans who are homeless or at risk of becoming homeless.
Grantees will provide case management, prevent the imminent loss of a home,
and rapidly re-house Veterans and their families. The program also funds
transitional housing through organizations across the country.
"""

VA_SIGNAL = {
    "source": "VA News",
    "title": "VA awards $1.17 billion in grants to fight Veteran homelessness",
    "published_date": "2026-09-14",
    "raw_text": VA_TEXT,
}

REQUIRED_FIELDS = {
    "source",
    "title",
    "published_date",
    "funding_amount",
    "agency",
    "target_population",
    "program_types",
    "geography",
    "modernization_cues",
    "veteran_cues",
    "homelessness_cues",
    "mental_health_cues",
    "partner_cues",
    "raw_text",
    "created_at",
}


def test_extract_funding_amount() -> None:
    assert extract_funding_amount(VA_TEXT) == 1_170_000_000


def test_extract_target_population() -> None:
    populations = extract_target_population(VA_TEXT)
    assert all(value in populations for value in ["veterans", "homeless", "at-risk"])


def test_extract_program_types() -> None:
    program_types = extract_program_types(VA_TEXT)
    assert all(value in program_types for value in ["case management", "rapid re-housing", "eviction prevention"])


def test_semantic_object_schema() -> None:
    semantic = run_semantic_extraction(VA_SIGNAL)
    assert set(semantic) == REQUIRED_FIELDS
    assert semantic["source"] == VA_SIGNAL["source"]
    assert semantic["raw_text"] == VA_SIGNAL["raw_text"]


def test_pipeline_semantic_extraction(monkeypatch) -> None:
    raw_signals = [VA_SIGNAL, VA_SIGNAL | {"title": "Second grant signal"}]
    monkeypatch.setattr(gne_state, "grant_signals", raw_signals)
    monkeypatch.setattr(gne_state, "gne_semantics", [])

    semantics = run_semantic_extractor()

    assert len(semantics) == len(raw_signals)
    assert semantics is gne_state.gne_semantics
    assert [item["title"] for item in semantics] == [item["title"] for item in raw_signals]
