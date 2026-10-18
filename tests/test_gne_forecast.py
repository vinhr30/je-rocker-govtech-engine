from core.pipeline.gne_pipeline import run_forecast as run_forecast_pipeline
from core.state import gne_state
from engines.grant_neural.forecast.cycle import predict_cycle
from engines.grant_neural.forecast.forecast import run_forecast
from engines.grant_neural.forecast.probability import calculate_probability
from engines.grant_neural.forecast.smoothing import smooth_forecast
from engines.grant_neural.forecast.timeline import map_timeline
from engines.grant_neural.forecast.volatility import detect_volatility


VA_CLASSIFICATION = {
    "title": "VA awards $1.17 billion in grants to fight Veteran homelessness",
    "source": "VA News",
    "published_date": "2026-09-14",
    "categories": ["veteran", "homelessness", "partner", "funding", "federal"],
    "relevance": 80,
    "confidence": 0.9562,
    "matrix": {
        "veteran": 0.8781,
        "homelessness": 0.8781,
        "modernization": 0.0,
        "mental_health": 0.0,
        "partner": 0.8781,
        "funding": 0.8781,
    },
    "raw_text": """
        The Department of Veterans Affairs announced $1.17 billion in grants
        for Veterans who are homeless. Organizations will provide housing,
        case management, rapid re-housing, and eviction prevention.
    """,
    "created_at": "2026-09-14T10:00:00+00:00",
}

FORECAST_FIELDS = {
    "title",
    "source",
    "published_date",
    "cycle",
    "probability",
    "timeline",
    "volatility",
    "raw_text",
    "created_at",
}


def test_predict_cycle() -> None:
    annual = predict_cycle(VA_CLASSIFICATION)
    modernization = predict_cycle(VA_CLASSIFICATION | {
        "categories": ["modernization", "funding", "federal"],
        "raw_text": "HHS announced $42 million for digital modernization.",
    })
    seasonal = predict_cycle(VA_CLASSIFICATION | {
        "categories": ["veteran", "federal"],
        "raw_text": "Veteran services announcement.",
    })

    assert annual == {"cycle_type": "annual", "cycle_start": "2026-09-14", "cycle_end": "2027-09-14"}
    assert modernization["cycle_type"] == "modernization"
    assert modernization["cycle_end"] == "2029-09-14"
    assert seasonal["cycle_type"] == "seasonal"
    assert seasonal["cycle_end"] == "2027-03-14"


def test_calculate_probability() -> None:
    probability = calculate_probability(VA_CLASSIFICATION)
    sparse = calculate_probability(VA_CLASSIFICATION | {
        "categories": ["federal"],
        "relevance": 10,
        "confidence": 0.1,
        "matrix": {key: 0.0 for key in VA_CLASSIFICATION["matrix"]},
        "raw_text": "General federal notice.",
    })
    assert 0.0 <= sparse < probability <= 1.0


def test_map_timeline() -> None:
    timeline = map_timeline(VA_CLASSIFICATION)
    assert timeline == {
        "forecast_window_start": "2027-06-14",
        "forecast_window_end": "2027-09-14",
        "expected_release_quarter": "2027-Q2",
    }


def test_smoothing() -> None:
    smoothed = smooth_forecast({
        "probability": 1.4,
        "previous_probability": 0.2,
        "volatility": "high",
    })
    assert smoothed["probability"] == 0.35
    assert "previous_probability" not in smoothed


def test_volatility_detection() -> None:
    assert detect_volatility(VA_CLASSIFICATION) == "low"
    assert detect_volatility(VA_CLASSIFICATION | {
        "categories": ["homelessness", "federal"],
        "raw_text": "Homelessness response funding under $5 million.",
    }) == "high"
    assert detect_volatility(VA_CLASSIFICATION | {
        "categories": ["modernization", "federal"],
        "matrix": {
            "veteran": 0.0,
            "homelessness": 0.0,
            "modernization": 0.8,
            "mental_health": 0.0,
            "partner": 0.0,
            "funding": 0.5,
        },
        "raw_text": "Digital modernization funding under $5 million.",
    }) == "medium"


def test_pipeline_forecast(monkeypatch) -> None:
    classifications = [VA_CLASSIFICATION, VA_CLASSIFICATION | {"title": "Second classification"}]
    monkeypatch.setattr(gne_state, "gne_classifications", classifications)
    monkeypatch.setattr(gne_state, "gne_forecasts", [])

    forecasts = run_forecast_pipeline()

    assert len(forecasts) == len(classifications)
    assert forecasts is gne_state.gne_forecasts
    assert [item["title"] for item in forecasts] == [item["title"] for item in classifications]
    assert all(set(item) == FORECAST_FIELDS for item in forecasts)
    assert all(item["created_at"] for item in forecasts)
    assert forecasts[0]["cycle"] == run_forecast(classifications[0])["cycle"]
