from core.pipeline.gne_pipeline import run_classifier
from core.state import gne_state
from engines.grant_neural.classifier.caps import apply_caps
from engines.grant_neural.classifier.categories import assign_categories
from engines.grant_neural.classifier.classifier import run_classification
from engines.grant_neural.classifier.matrix import MATRIX_CATEGORIES, build_matrix
from engines.grant_neural.classifier.relevance import calculate_confidence, score_relevance


VA_SEMANTIC = {
    "source": "VA News",
    "title": "VA awards $1.17 billion in grants to fight Veteran homelessness",
    "published_date": "2026-09-14",
    "funding_amount": 1_170_000_000,
    "agency": "Department of Veterans Affairs",
    "target_population": ["veterans", "homeless", "at-risk", "families"],
    "program_types": ["housing", "case management", "rapid re-housing", "eviction prevention"],
    "geography": "national",
    "modernization_cues": ["data"],
    "veteran_cues": ["VA", "veterans"],
    "homelessness_cues": ["homeless", "rapid re-housing", "eviction prevention"],
    "mental_health_cues": [],
    "partner_cues": ["organizations", "providers"],
    "raw_text": "VA grant article text",
    "created_at": "2026-09-14T10:00:00+00:00",
}


def test_assign_categories() -> None:
    categories = assign_categories(VA_SEMANTIC)
    assert categories == ["veteran", "homelessness", "modernization", "partner", "funding", "federal"]
    assert assign_categories(VA_SEMANTIC | {"source": "State of Virginia"})[-1] == "state"
    assert assign_categories(VA_SEMANTIC | {"source": "California State Portal"})[-1] == "state"


def test_score_relevance() -> None:
    score = score_relevance(VA_SEMANTIC)
    sparse_score = score_relevance(VA_SEMANTIC | {
        "funding_amount": None,
        "agency": None,
        "target_population": [],
        "program_types": [],
        "modernization_cues": [],
        "geography": "local",
    })
    assert 0 <= sparse_score < score <= 100


def test_confidence_calculation() -> None:
    confidence = calculate_confidence(VA_SEMANTIC)
    incomplete = calculate_confidence(VA_SEMANTIC | {
        "funding_amount": None,
        "agency": None,
        "program_types": [],
        "modernization_cues": [],
        "veteran_cues": [],
        "homelessness_cues": [],
        "partner_cues": [],
    })
    assert 0.0 <= incomplete < confidence <= 1.0


def test_matrix_building() -> None:
    matrix = build_matrix(["veteran", "funding", "federal"], 80, 0.9)
    assert set(matrix) == set(MATRIX_CATEGORIES)
    assert matrix["veteran"] > 0
    assert matrix["funding"] > 0
    assert matrix["homelessness"] == 0
    assert all(0.0 <= value <= 1.0 for value in matrix.values())


def test_caps_application() -> None:
    capped = apply_caps({
        "categories": [],
        "relevance": 140,
        "confidence": 1.5,
        "matrix": {"veteran": 2, "funding": -1},
    })
    assert capped["categories"] == ["general"]
    assert capped["relevance"] == 100
    assert capped["confidence"] == 1.0
    assert capped["matrix"] == {"veteran": 1.0, "funding": 0.0}


def test_pipeline_classification(monkeypatch) -> None:
    semantics = [VA_SEMANTIC, VA_SEMANTIC | {"title": "Second semantic signal"}]
    monkeypatch.setattr(gne_state, "gne_semantics", semantics)
    monkeypatch.setattr(gne_state, "gne_classifications", [])

    classifications = run_classifier()

    assert len(classifications) == len(semantics)
    assert classifications is gne_state.gne_classifications
    assert [item["title"] for item in classifications] == [item["title"] for item in semantics]
    assert all(item["created_at"] for item in classifications)
    assert all(0 <= item["relevance"] <= 100 for item in classifications)
    classification_fields = {
        "title",
        "source",
        "published_date",
        "categories",
        "relevance",
        "confidence",
        "matrix",
        "raw_text",
        "created_at",
    }
    assert all(set(item) == classification_fields for item in classifications)
