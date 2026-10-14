import pytest

from nora_nlp.models import CustomerConfidence


@pytest.mark.parametrize(
    ("score", "reported_band", "expected_band"),
    [
        (0, "HIGH", "LOW"),
        (39, "HIGH", "LOW"),
        (40, "HIGH", "MEDIUM"),
        (69, "LOW", "MEDIUM"),
        (70, "LOW", "HIGH"),
        (100, "LOW", "HIGH"),
    ],
)
def test_customer_confidence_band_matches_score_boundaries(score, reported_band, expected_band):
    assessment = CustomerConfidence.model_validate(
        {
            "score": score,
            "band": reported_band,
            "accountName": "ACME Manufatura S.A.",
            "rationale": "The assessment is supported by the customer's statements.",
        }
    )

    assert assessment.score == score
    assert assessment.band.value == expected_band
    assert assessment.model_dump(by_alias=True)["band"] == expected_band
