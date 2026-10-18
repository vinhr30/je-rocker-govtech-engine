from core.pipeline.gne_pipeline import run_modernization as run_modernization_pipeline
from core.state import gne_state
from engines.grant_neural.modernization.alignment import map_alignment_to_jrocker
from engines.grant_neural.modernization.cycle import predict_modernization_cycle
from engines.grant_neural.modernization.density import calculate_density
from engines.grant_neural.modernization.modernization import run_modernization
from engines.grant_neural.modernization.relevance import score_modernization_relevance


MODERNIZATION_FORECAST = {
    "title": "HHS digital modernization funding",
    "source": "HHS News",
    "published_date": "2026-09-18",
    "cycle": {
        "cycle_type": "modernization",
        "cycle_start": "2026-09-18",
        "cycle_end": "2029-09-18",
    },
    "probability": 0.84,
    "timeline": {
        "forecast_window_start": "2028-03-18",
        "forecast_window_end": "2029-09-18",
        "expected_release_quarter": "2028-Q1",
    },
    "volatility": "medium",
    "raw_text": """
        The Department of Health and Human Services announced digital
        modernization funding for veterans experiencing homelessness and
        behavioral health needs. Community partners and providers will use
        workflow automation, reporting systems, data, and case management.
    """,
    "created_at": "2026-09-18T10:00:00+00:00",
}

MODERNIZATION_FIELDS = {
    "title",
    "source",
    "published_date",
    "density",
    "cycle",
    "relevance",
    "alignment",
    "raw_text",
    "created_at",
}


def test_calculate_density() -> None:
    assert calculate_density(MODERNIZATION_FORECAST) == 1.0
    assert calculate_density(MODERNIZATION_FORECAST | {
        "cycle": {"cycle_type": "annual"},
        "raw_text": "General grant funding notice.",
    }) == 0.0


def test_predict_modernization_cycle() -> None:
    cycle = predict_modernization_cycle(MODERNIZATION_FORECAST)
    no_cycle = predict_modernization_cycle(MODERNIZATION_FORECAST | {
        "cycle": {"cycle_type": "annual"},
        "raw_text": "General grant funding notice.",
    })
    assert cycle == {"type": "modernization", "start": "2026-09-18", "end": "2029-09-18"}
    assert no_cycle == {"type": "none", "start": "2026-09-18", "end": "2026-09-18"}


def test_score_modernization_relevance() -> None:
    score = score_modernization_relevance(MODERNIZATION_FORECAST)
    sparse = score_modernization_relevance(MODERNIZATION_FORECAST | {
        "cycle": {"cycle_type": "annual"},
        "probability": 0.1,
        "raw_text": "General local funding notice.",
    })
    assert 0 <= sparse < score <= 100


def test_alignment_mapping() -> None:
    assert map_alignment_to_jrocker(MODERNIZATION_FORECAST) == [
        "veteran_stability",
        "housing_stability",
        "behavioral_health",
        "ecosystem",
        "modernization_intelligence",
    ]


def test_pipeline_modernization(monkeypatch) -> None:
    forecasts = [MODERNIZATION_FORECAST, MODERNIZATION_FORECAST | {"title": "Second forecast"}]
    monkeypatch.setattr(gne_state, "gne_forecasts", forecasts)
    monkeypatch.setattr(gne_state, "gne_modernization", [])

    results = run_modernization_pipeline()

    assert len(results) == len(forecasts)
    assert results is gne_state.gne_modernization
    assert [item["title"] for item in results] == [item["title"] for item in forecasts]
    assert all(set(item) == MODERNIZATION_FIELDS for item in results)
    assert results[0]["cycle"] == run_modernization(forecasts[0])["cycle"]
