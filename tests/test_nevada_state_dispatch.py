import importlib.util
from pathlib import Path
import unittest

WORKER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sam_visual_worker_v1.py"
SPEC = importlib.util.spec_from_file_location("sam_worker_nevada_dispatch", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class NevadaStateDispatchTests(unittest.TestCase):
    def test_nevada_state_job_routes_to_open_bids_dom_capture(self):
        task = worker.state_workflow_capture_task({"id": "job-1", "state": "NV",
                                                   "max_pages": 10, "max_details": 100})
        self.assertEqual(task, {
            "id": "job-1",
            "type": "capture",
            "url": worker.NEVADA_OPEN_BIDS_URL,
            "max_pages": 1,
            "state": "NV",
        })

    def test_other_states_keep_their_existing_workflow(self):
        self.assertIsNone(worker.state_workflow_capture_task({"id": "job-2", "state": "AZ"}))

    def test_nevada_job_requires_an_id(self):
        with self.assertRaisesRegex(ValueError, "requires a job id"):
            worker.state_workflow_capture_task({"state": "NV"})


if __name__ == "__main__":
    unittest.main()