from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_briefing import build_portfolio_briefing
except ImportError:
    from portfolio_briefing import build_portfolio_briefing


def classify_priority(risk_score: int, opportunity_score: int) -> str:
    if opportunity_score >= 4 or risk_score >= 4:
        return "High"
    if opportunity_score >= 2 or risk_score >= 2:
        return "Medium"
    return "Low"


def action_recommendation(risk_score: int, opportunity_score: int) -> str:
    if opportunity_score >= 4 and risk_score <= 2:
        return "Pursue opportunity: align capture plan and outreach."
    if risk_score >= 4 and opportunity_score <= 2:
        return "Mitigate risk: review pipeline fit and modernization posture."
    if opportunity_score >= 3 and risk_score >= 3:
        return "Balance: pursue opportunity while actively managing risk."
    if opportunity_score == 0 and risk_score == 0:
        return "Monitor: no immediate action required under current data."
    return "Light touch: maintain awareness and revisit after next cycle."


def build_portfolio_actions() -> dict[str, Any]:
    briefing = build_portfolio_briefing()
    actions = []
    for client in briefing["clients"]:
        risk = int(client.get("risk_score", 0) or 0)
        opportunity = int(client.get("opportunity_score", 0) or 0)
        actions.append({
            "clientId": client["clientId"],
            "clientName": client["clientName"],
            "risk_score": risk,
            "opportunity_score": opportunity,
            "priority": classify_priority(risk, opportunity),
            "recommendation": action_recommendation(risk, opportunity),
        })
    return {"generated_at": briefing["generated_at"], "actions": actions}


def main() -> None:
    print(json.dumps(build_portfolio_actions(), default=str))


if __name__ == "__main__":
    main()
