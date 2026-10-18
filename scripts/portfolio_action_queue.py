from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_actions import build_portfolio_actions
except ImportError:
    from portfolio_actions import build_portfolio_actions

PRIORITY_ORDER = {"High": 0, "Medium": 1, "Low": 2}


def build_action_queue() -> dict[str, Any]:
    portfolio_actions = build_portfolio_actions()
    ranked = sorted(
        portfolio_actions["actions"],
        key=lambda action: (
            PRIORITY_ORDER.get(action.get("priority"), len(PRIORITY_ORDER)),
            -int(action.get("opportunity_score", 0) or 0),
            -int(action.get("risk_score", 0) or 0),
        ),
    )
    queue = [
        {
            "rank": index,
            "clientId": action["clientId"],
            "clientName": action["clientName"],
            "priority": action["priority"],
            "opportunity_score": action["opportunity_score"],
            "risk_score": action["risk_score"],
            "recommendation": action["recommendation"],
        }
        for index, action in enumerate(ranked, start=1)
    ]
    return {"generated_at": portfolio_actions["generated_at"], "queue": queue}


def main() -> None:
    print(json.dumps(build_action_queue(), default=str))


if __name__ == "__main__":
    main()
