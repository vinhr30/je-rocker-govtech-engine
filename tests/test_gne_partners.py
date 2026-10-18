from core.pipeline.gne_pipeline import run_partners as run_partners_pipeline
from core.state import gne_state
from engines.grant_neural.partners.alignment import map_alignment_to_jrocker
from engines.grant_neural.partners.density import calculate_density
from engines.grant_neural.partners.extractor import extract_partners
from engines.grant_neural.partners.partners import run_partners
from engines.grant_neural.partners.relevance import score_partner_relevance


MODERNIZATION_OBJECT = {
    "title": "Modernized veteran housing partner network",
    "source": "HHS News",
    "published_date": "2026-09-18",
    "density": 0.9,
    "cycle": {"type": "modernization", "start": "2026-09-18", "end": "2029-09-18"},
    "relevance": 78,
    "alignment": [
        "veteran_stability",
        "housing_stability",
        "behavioral_health",
        "ecosystem",
        "modernization_intelligence",
    ],
    "raw_text": """
        The Veterans Housing Alliance and Community Health Plan will work with
        community partners, nonprofit organizations, technology vendors, and
        service providers. The Department of Veterans Affairs awarded $20
        million for digital workflow automation supporting homeless veterans
        and behavioral health services.
    """,
    "created_at": "2026-09-18T10:00:00+00:00",
}

PARTNER_FIELDS = {
    "title",
    "source",
    "published_date",
    "partners",
    "ecosystem_density",
    "relevance",
    "alignment",
    "raw_text",
    "created_at",
}


def test_extract_partners() -> None:
    partners = extract_partners(MODERNIZATION_OBJECT)
    assert "Veterans Housing Alliance" in partners
    assert "Community Health Plan" in partners
    assert all(value in partners for value in [
        "Community Partners",
        "Modernization Vendors",
        "Health Plans",
        "Nonprofit Organizations",
        "Service Providers",
    ])
    assert len(partners) == len(set(partners))


def test_calculate_density() -> None:
    partners = extract_partners(MODERNIZATION_OBJECT)
    density = calculate_density(MODERNIZATION_OBJECT, partners)
    sparse = calculate_density(MODERNIZATION_OBJECT | {
        "relevance": 10,
        "raw_text": "General funding notice.",
    }, [])
    assert 0.0 <= sparse < density <= 1.0


def test_score_partner_relevance() -> None:
    partners = extract_partners(MODERNIZATION_OBJECT)
    score = score_partner_relevance(MODERNIZATION_OBJECT, partners)
    sparse = score_partner_relevance(MODERNIZATION_OBJECT | {
        "relevance": 5,
        "alignment": [],
        "raw_text": "General local notice.",
    }, [])
    assert 0 <= sparse < score <= 100


def test_alignment_mapping() -> None:
    partners = extract_partners(MODERNIZATION_OBJECT)
    assert map_alignment_to_jrocker(MODERNIZATION_OBJECT, partners) == [
        "veteran_stability_clients",
        "housing_stability_clients",
        "behavioral_health_clients",
        "modernization_intelligence_clients",
        "ecosystem_engine_clients",
    ]


def test_pipeline_partners(monkeypatch) -> None:
    modernization = [MODERNIZATION_OBJECT, MODERNIZATION_OBJECT | {"title": "Second modernization signal"}]
    monkeypatch.setattr(gne_state, "gne_modernization", modernization)
    monkeypatch.setattr(gne_state, "gne_partners", [])

    results = run_partners_pipeline()

    assert len(results) == len(modernization)
    assert results is gne_state.gne_partners
    assert [item["title"] for item in results] == [item["title"] for item in modernization]
    assert all(set(item) == PARTNER_FIELDS for item in results)
    assert results[0]["partners"] == run_partners(modernization[0])["partners"]
