from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingestion.states.arizona.details import extract_details_from_html, is_browser_check_page


class ArizonaChallengeTests(unittest.TestCase):
    def test_verified_detail_ignores_security_script_names(self):
        html = '<html><head><script src="captcha-challenge.js"></script></head><body><main id="mainContentDiv"><h1>Road construction</h1><p>Bid challenge procedures and work description.</p></main></body></html>'
        self.assertFalse(is_browser_check_page(html))
        self.assertIn("Road construction", extract_details_from_html(html, "https://app.az.gov/detail")["description_raw"])

    def test_actual_verification_still_blocks_extraction(self):
        html = '<html><body><h1>Verify you are human</h1><p>Complete the challenge</p></body></html>'
        self.assertTrue(is_browser_check_page(html))
        self.assertIsNone(extract_details_from_html(html, "https://app.az.gov/detail")["description_raw"])

    def test_hidden_challenge_template_is_not_a_challenge_page(self):
        html = '<body><div hidden>Security check captcha</div><h1>Solicitation information</h1></body>'
        self.assertFalse(is_browser_check_page(html))


if __name__ == "__main__":
    unittest.main()