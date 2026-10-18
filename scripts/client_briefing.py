from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

try:
    from .strategic_briefing import build_briefing
except ImportError:
    from strategic_briefing import build_briefing

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
CLIENT_DB = DASHBOARD_ROOT / "client.db"


def split_values(value: Any) -> set[str]:
    return {
        item.strip().casefold()
        for item in str(value or "").replace(";", ",").split(",")
        if item.strip()
    }


def client_profile(client_id: int, database_path: Path = CLIENT_DB) -> dict[str, set[str]] | None:
    if not database_path.exists():
        return None
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(clients)")}
        if "client_id" not in columns:
            return None
        row = connection.execute("SELECT * FROM clients WHERE client_id = ?", (client_id,)).fetchone()
    finally:
        connection.close()
    if row is None:
        return None

    values = dict(row)
    modernization_source = values.get("modernization_focus") or values.get("modernization_profile") or values.get("keywords")
    capability_source = values.get("capability_zones") or values.get("capability_signals") or values.get("keywords")
    return {
        "naics": split_values(values.get("naics")),
        "preferred_agencies": split_values(values.get("preferred_agencies")),
        "modernization_focus": split_values(modernization_source),
        "capability_zones": split_values(capability_source),
    }


def matches(value: Any, preferences: set[str]) -> bool:
    return str(value or "").casefold() in preferences


def build_client_briefing(client_id: int) -> dict[str, Any] | None:
    client = client_profile(client_id)
    if client is None:
        return None

    base = build_briefing()
    pipeline_filtered = [
        row for row in base["pipeline"]["forecast"]
        if matches(row.get("stableNaics"), client["naics"])
        or matches(row.get("stableAgency"), client["preferred_agencies"])
    ]
    grants_filtered = [
        row for row in base["grants"]["forecast"]
        if matches(row.get("stableAgency"), client["preferred_agencies"])
    ]
    modernization_filtered = [
        row for row in base["modernization"]["forecast"]
        if matches(row.get("stableModernization"), client["modernization_focus"])
        or matches(row.get("stableCapabilityZone"), client["capability_zones"])
    ]

    pipeline_narr = [
        narrative for narrative in base["pipeline"]["narrative"]
        if matches(narrative.get("stableAgency"), client["preferred_agencies"])
        or matches(narrative.get("stableNaics"), client["naics"])
    ][:3]
    grants_narr = [
        narrative for narrative in base["grants"]["narrative"]
        if matches(narrative.get("stableAgency"), client["preferred_agencies"])
    ][:3]
    modernization_narr = [
        narrative for narrative in base["modernization"]["narrative"]
        if matches(narrative.get("stableModernization"), client["modernization_focus"])
        or matches(narrative.get("stableCapabilityZone"), client["capability_zones"])
    ][:3]

    return {
        "clientId": client_id,
        "generated_at": base["generated_at"],
        "pipeline": {"forecast": pipeline_filtered, "narrative": pipeline_narr},
        "grants": {"forecast": grants_filtered, "narrative": grants_narr},
        "modernization": {"forecast": modernization_filtered, "narrative": modernization_narr},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Return a client-specific strategic briefing as JSON.")
    parser.add_argument("client_id", type=int)
    args = parser.parse_args()
    briefing = build_client_briefing(args.client_id)
    if briefing is None:
        print(json.dumps({"error": "Client not found"}))
        raise SystemExit(2)
    print(json.dumps(briefing, default=str))


if __name__ == "__main__":
    main()
