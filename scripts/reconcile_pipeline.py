import argparse
from collections import defaultdict
import json
from pathlib import Path
import re

FIELDS = ("solicitation_number", "title", "closing_date", "primary_agency")


def normalize(value):
    return re.sub(r"\s+", " ", value or "").strip().casefold()


def load_records(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("structured_data")
    if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
        raise ValueError("Expected a record array or a receiver result containing structured_data")
    for item in data:
        if any(item.get(field) is not None and not isinstance(item[field], str) for field in FIELDS):
            raise ValueError("Record fields must be strings or null")
    return data


def reconcile(dom_data, vlm_data):
    def index(records):
        indexed = defaultdict(list)
        invalid = []
        for position, record in enumerate(records):
            identifier = normalize(record.get("solicitation_number"))
            if identifier in ("", "unknown", "n/a", "null"):
                invalid.append(position)
            else:
                indexed[identifier].append(record)
        return indexed, invalid

    baseline, baseline_invalid = index(dom_data)
    vision, vision_invalid = index(vlm_data)
    mismatches = []
    for identifier in sorted(baseline.keys() & vision.keys()):
        if len(baseline[identifier]) != 1 or len(vision[identifier]) != 1:
            continue
        for field in FIELDS[1:]:
            if field in baseline[identifier][0] and normalize(baseline[identifier][0].get(field)) != normalize(vision[identifier][0].get(field)):
                mismatches.append({"id": identifier, "field": field,
                                   "dom": baseline[identifier][0].get(field),
                                   "vlm": vision[identifier][0].get(field)})
    report = {
        "dom_count": len(dom_data), "vlm_count": len(vlm_data),
        "missing_from_vision": sorted(baseline.keys() - vision.keys()),
        "unexpected_in_vision": sorted(vision.keys() - baseline.keys()),
        "dom_duplicates": {key: len(value) for key, value in baseline.items() if len(value) > 1},
        "vlm_duplicates": {key: len(value) for key, value in vision.items() if len(value) > 1},
        "dom_invalid_id_rows": baseline_invalid, "vlm_invalid_id_rows": vision_invalid,
        "field_mismatches": mismatches,
    }
    report["aligned"] = bool(dom_data) and not any(report[key] for key in (
        "missing_from_vision", "unexpected_in_vision", "dom_duplicates", "vlm_duplicates",
        "dom_invalid_id_rows", "vlm_invalid_id_rows", "field_mismatches"))
    return report


def run_data_reconciliation(dom_file_path, vlm_file_path):
    report = reconcile(load_records(dom_file_path), load_records(vlm_file_path))
    print(json.dumps(report, indent=2))
    return report["aligned"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare contemporaneous DOM and VLM records; alignment is not proof of source accuracy")
    parser.add_argument("dom_file", type=Path)
    parser.add_argument("vlm_file", type=Path)
    arguments = parser.parse_args()
    raise SystemExit(0 if run_data_reconciliation(arguments.dom_file, arguments.vlm_file) else 1)