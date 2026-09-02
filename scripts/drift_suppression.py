from __future__ import annotations

import json
import os
from pathlib import Path
from time import time
from typing import Any

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
DSM_ROOT = DASHBOARD_ROOT / "dsm"
DRIFT_LOG_PATH = DASHBOARD_ROOT / "logs" / "drift.log"

DSM_FILES = {
    "naics": "naics.json",
    "psc": "psc.json",
    "agency": "agency.json",
    "modernization": "modernization.json",
    "grants": "grants.json",
    "capability": "capability.json",
}


def load_dsm(dsm_root: Path = DSM_ROOT) -> dict[str, dict[str, Any]]:
    return {
        name: json.loads((dsm_root / filename).read_text(encoding="utf-8"))
        for name, filename in DSM_FILES.items()
    }


def apply_drift_suppression(raw: dict[str, Any] | None, dsm: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    raw = raw or {}
    maps = dsm or load_dsm()
    result: dict[str, Any] = {
        "stableNaics": raw.get("naics") or None,
        "stablePsc": raw.get("psc") or None,
        "stableAgency": raw.get("agency") or None,
        "stableModernization": raw.get("modernization") or None,
        "stableGrantCategory": raw.get("grantCategory") or None,
        "stableCapabilityZone": raw.get("capabilityZone") or None,
        "driftEvents": [],
    }

    def suppress(field: str, value: Any, dsm_map: dict[str, Any]) -> Any:
        if not value:
            return value
        value = str(value)
        if value in dsm_map["canonical"]:
            return value
        if value in dsm_map["synonyms"]:
            corrected = dsm_map["synonyms"][value]
            result["driftEvents"].append(event(field, value, corrected, "synonym"))
            return corrected
        for pattern, corrected in dsm_map["driftPatterns"].items():
            if pattern in value:
                result["driftEvents"].append(event(field, value, corrected, "pattern"))
                return corrected
        for rule, corrected in dsm_map["suppressionRules"].items():
            if value == rule:
                result["driftEvents"].append(event(field, value, corrected, "rule"))
                return corrected
        return value

    result["stableNaics"] = suppress("naics", result["stableNaics"], maps["naics"])
    result["stablePsc"] = suppress("psc", result["stablePsc"], maps["psc"])
    result["stableAgency"] = suppress("agency", result["stableAgency"], maps["agency"])
    result["stableModernization"] = suppress("modernization", result["stableModernization"], maps["modernization"])
    result["stableGrantCategory"] = suppress("grantCategory", result["stableGrantCategory"], maps["grants"])
    result["stableCapabilityZone"] = suppress("capabilityZone", result["stableCapabilityZone"], maps["capability"])
    return result


def event(field: str, original: str, corrected: Any, reason: str) -> dict[str, Any]:
    return {
        "field": field,
        "original": original,
        "corrected": corrected,
        "reason": reason,
        "timestamp": int(time() * 1000),
    }


def log_drift_events(events: list[dict[str, Any]] | None) -> None:
    if not events:
        return
    DRIFT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    node = os.environ.get("NODE_NAME", "unknown")
    role = os.environ.get("NODE_ROLE", "unknown")
    with DRIFT_LOG_PATH.open("a", encoding="utf-8") as handle:
        for item in events:
            handle.write(json.dumps({
                "field": item["field"],
                "original": item["original"],
                "corrected": item["corrected"],
                "reason": item["reason"],
                "timestamp": item["timestamp"],
                "node": node,
                "role": role,
            }) + "\n")
