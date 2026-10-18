import importlib.util
from pathlib import Path
import unittest

WORKER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sam_visual_worker_v1.py"
SPEC = importlib.util.spec_from_file_location("sam_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class DomQualityTests(unittest.TestCase):
    def setUp(self):
        self.record = {"solicitation_number": "ABC123", "title": "Example",
                       "closing_date": "October 22, 2026", "primary_agency": "Agency",
                       "opportunity_url": "https://sam.gov/workspace/contract/opp/abc/view"}

    def test_repeated_solicitations_with_distinct_urls_are_preserved(self):
        other = {**self.record, "opportunity_url": "https://sam.gov/workspace/contract/opp/def/view"}
        self.assertEqual(worker.dom_quality([self.record, other]), [])

    def test_duplicate_url_requires_review(self):
        self.assertTrue(any(issue["issue"] == "duplicate" for issue in worker.dom_quality([self.record, self.record])))

    def test_absent_date_is_not_invented(self):
        record = {**self.record, "closing_date": None}
        self.assertIn({"row": 0, "field": "closing_date", "issue": "not_present_in_dom"}, worker.dom_quality([record]))
        self.assertIsNone(record["closing_date"])

    def test_invalid_identity_requires_review(self):
        record = {**self.record, "solicitation_number": None, "opportunity_url": "https://example.com/opp/abc"}
        self.assertEqual(len(worker.dom_quality([record])), 2)


if __name__ == "__main__":
    unittest.main()