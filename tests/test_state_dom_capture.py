import importlib.util
from pathlib import Path
import unittest

WORKER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sam_visual_worker_v1.py"
SPEC = importlib.util.spec_from_file_location("sam_worker_state_dom_capture", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class StateDomCaptureTests(unittest.TestCase):
    def test_supported_states_map_to_canonical_portal_urls(self):
        for state, url in worker.STATE_DOM_CAPTURE_URLS.items():
            with self.subTest(state=state):
                task = worker.state_dom_capture_task({"id": f"job-{state}", "state": state})
                self.assertEqual(task["url"], url)
                self.assertEqual(task["max_pages"], 3)
                self.assertEqual(task["type"], "capture")

    def test_snapshot_page_limit_is_forwarded_and_bounded(self):
        task = worker.state_dom_capture_task({"id": "job-CO", "state": "CO", "max_pages": 3})
        self.assertEqual(task["max_pages"], 3)
        for value in (0, 11, True, "3"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "between 1 and 10"):
                worker.state_dom_capture_task({"id": "job-CO", "state": "CO", "max_pages": value})

    def test_remaining_western_states_are_registered(self):
        expected = {"CO", "ID", "MT", "NM", "OR", "UT", "WA", "WY", "AK", "HI"}
        self.assertTrue(expected.issubset(worker.STATE_DOM_CAPTURE_URLS))
        for state in expected:
            with self.subTest(state=state):
                task = worker.state_dom_capture_task({"id": f"job-{state}", "state": state})
                self.assertEqual(task["state"], state)
                self.assertEqual(worker.source_for(task["url"]), worker.STATE_DOM_SOURCES[state])

    def test_colorado_full_grid_requires_review_for_missing_detail_urls_not_pagination(self):
        issues = worker.state_dom_quality_issues([{
            "solicitation_number": "NCS1-IHHA-2027000058-1",
            "title": "Regional Centers Bathroom Remodel",
            "opportunity_url": None,
        }], "colorado")
        self.assertNotIn({"issue": "displayed_page_only_no_pagination"}, issues)
        self.assertIn({"issue": "public_grid_does_not_expose_detail_urls"}, issues)
        self.assertFalse(any(issue.get("field") == "opportunity_url" for issue in issues))

    def test_arizona_snapshot_uses_configured_app_portal(self):
        task = worker.state_dom_capture_task({"id": "job-AZ", "state": "AZ"})
        self.assertEqual(task["url"], "https://app.az.gov/page.aspx/en/rfp/request_browse_public")
        self.assertEqual(worker.source_for(task["url"]), "arizona")

    def test_nevada_is_not_accidentally_remapped(self):
        with self.assertRaisesRegex(ValueError, "configured state code"):
            worker.state_dom_capture_task({"id": "job-NV", "state": "NV"})

    def test_arizona_native_parser_fields_are_preserved(self):
        record = worker.normalize_state_dom_record("arizona", {
            "solicitation_id": "BPM007765",
            "title": "ADOT Central Campus Project",
            "agency": "Department of Transportation",
            "due_date_raw": "10/23/2026 3:00 PM",
            "detail_url": "https://app.az.gov/page.aspx/en/bpm/process_manage_extranet/14023",
            "status": "Open for Bidding",
        })
        self.assertEqual(record["solicitation_number"], "BPM007765")
        self.assertEqual(record["closing_date"], "10/23/2026 3:00 PM")
        self.assertEqual(record["portal_status"], "Open for Bidding")

    def test_florida_dom_record_uses_real_id_and_verified_detail_route(self):
        records = worker.normalize_florida_dom_candidates([{
            "number": "AD-17246",
            "title": "RFP 26-003 Independent Financial Audit Services",
            "organization": "Northwest Fla Water Management Dist",
            "ad_type": "Agency Decision",
            "start_date": "10/14/2026",
            "end_date": "10/19/2026",
            "status": "OPEN",
            "can_view": True,
        }], "https://vendor.myfloridamarketplace.com/search/bids")
        self.assertEqual(records[0]["solicitation_number"], "AD-17246")
        self.assertEqual(records[0]["opportunity_url"], "https://vendor.myfloridamarketplace.com/search/bids/detail/17246")
        self.assertEqual(records[0]["portal_status"], "OPEN")

    def test_texas_native_row_status_is_retained_for_review(self):
        record = worker.normalize_state_dom_record("texas", {
            "event_id": "701-25-019",
            "event_name": "Audit services",
            "department": "701",
            "end_date_raw": "10/24/2025",
            "detail_url": "https://www.txsmartbuy.gov/esbd/701-25-019",
            "raw_html": "<p><strong>Status: </strong> Awarded </p>",
        })
        self.assertEqual(record["portal_status"], "Awarded")
        self.assertIn({"row": 0, "field": "portal_status", "issue": "not_open"},
                      worker.state_dom_quality_issues([record]))


if __name__ == "__main__":
    unittest.main()