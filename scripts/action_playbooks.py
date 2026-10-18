from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_action_queue import build_action_queue
except ImportError:
    from portfolio_action_queue import build_action_queue


def build_playbook_for_action(action: dict[str, Any]) -> dict[str, Any]:
    priority = action["priority"]
    opportunity = action["opportunity_score"]
    risk = action["risk_score"]
    recommendation = action["recommendation"]

    if priority == "High" and opportunity >= 4 and risk <= 2:
        steps = [
            "Review top aligned NAICS and agency forecasts.",
            "Prepare outreach messaging for the next 30-day window.",
            "Validate modernization alignment before engagement.",
            "Schedule a client strategy call within 48 hours.",
        ]
    elif priority == "High" and risk >= 4 and opportunity <= 2:
        steps = [
            "Review pipeline alignment and category drift.",
            "Check modernization posture and capability gaps.",
            "Prepare a risk mitigation summary for the client.",
            "Schedule an internal review within 72 hours.",
        ]
    elif priority == "High" and opportunity >= 3 and risk >= 3:
        steps = [
            "Review both opportunity and risk narratives.",
            "Draft a dual-track strategy: capture + mitigation.",
            "Prepare client briefing materials.",
            "Schedule a joint strategy session within 72 hours.",
        ]
    elif priority == "Medium":
        steps = [
            "Review forecast trends for the next cycle.",
            "Check confidence bands for stability.",
            "Prepare light-touch notes for future engagement.",
        ]
    else:
        steps = [
            "Monitor forecast changes in the next cycle.",
            "Revisit after the next ingestion window.",
        ]

    return {
        "clientId": action["clientId"],
        "clientName": action["clientName"],
        "priority": priority,
        "opportunity_score": opportunity,
        "risk_score": risk,
        "recommendation": recommendation,
        "steps": steps,
    }


def build_action_playbooks() -> dict[str, Any]:
    action_queue = build_action_queue()
    playbooks = [build_playbook_for_action(action) for action in action_queue["queue"]]
    return {"generated_at": action_queue["generated_at"], "playbooks": playbooks}


def main() -> None:
    print(json.dumps(build_action_playbooks(), default=str))


if __name__ == "__main__":
    main()
