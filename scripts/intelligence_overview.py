from __future__ import annotations

import json
from typing import Any

try:
    from .portfolio_actions import build_portfolio_actions
    from .portfolio_briefing import build_portfolio_briefing
    from .portfolio_cycle_momentum import build_cycle_momentum
    from .portfolio_cycle_trends import build_cycle_trends
    from .portfolio_resilience import build_portfolio_resilience
    from .portfolio_resilience_advisory import build_resilience_advisory
    from .portfolio_resilience_forecast import build_resilience_forecast
    from .portfolio_shock import build_portfolio_shock
    from .portfolio_shock_advisory import build_shock_advisory
    from .portfolio_shock_forecast import build_shock_forecast
    from .portfolio_stability import build_portfolio_stability
    from .portfolio_stability_advisory import build_stability_advisory
    from .portfolio_stability_forecast import build_stability_forecast
    from .strategic_briefing import build_briefing
except ImportError:
    from portfolio_actions import build_portfolio_actions
    from portfolio_briefing import build_portfolio_briefing
    from portfolio_cycle_momentum import build_cycle_momentum
    from portfolio_cycle_trends import build_cycle_trends
    from portfolio_resilience import build_portfolio_resilience
    from portfolio_resilience_advisory import build_resilience_advisory
    from portfolio_resilience_forecast import build_resilience_forecast
    from portfolio_shock import build_portfolio_shock
    from portfolio_shock_advisory import build_shock_advisory
    from portfolio_shock_forecast import build_shock_forecast
    from portfolio_stability import build_portfolio_stability
    from portfolio_stability_advisory import build_stability_advisory
    from portfolio_stability_forecast import build_stability_forecast
    from strategic_briefing import build_briefing


def pick(data: dict[str, Any], key: str, client_id: int) -> dict[str, Any] | None:
    return next((item for item in data.get(key, []) if item.get("clientId") == client_id), None)


def build_intelligence_overview() -> dict[str, Any]:
    strategic = build_briefing()
    briefing = build_portfolio_briefing()
    stability = build_portfolio_stability()
    stability_forecast = build_stability_forecast()
    stability_advisory = build_stability_advisory()
    resilience = build_portfolio_resilience()
    resilience_forecast = build_resilience_forecast()
    resilience_advisory = build_resilience_advisory()
    shock = build_portfolio_shock()
    shock_forecast = build_shock_forecast()
    shock_advisory = build_shock_advisory()
    trends = build_cycle_trends()
    momentum = build_cycle_momentum()
    actions = build_portfolio_actions()

    overview = []
    for client in briefing["clients"]:
        client_id = client["clientId"]
        overview.append({
            "clientId": client_id,
            "clientName": client["clientName"],
            "briefing": client,
            "stability": pick(stability, "stability", client_id),
            "stability_forecast": pick(stability_forecast, "forecasts", client_id),
            "stability_advisory": pick(stability_advisory, "advisory", client_id),
            "resilience": pick(resilience, "resilience", client_id),
            "resilience_forecast": pick(resilience_forecast, "forecasts", client_id),
            "resilience_advisory": pick(resilience_advisory, "advisory", client_id),
            "shock": pick(shock, "shocks", client_id),
            "shock_forecast": pick(shock_forecast, "forecasts", client_id),
            "shock_advisory": pick(shock_advisory, "advisory", client_id),
            "cycle_trends": pick(trends, "trends", client_id),
            "cycle_momentum": pick(momentum, "momentum", client_id),
            "portfolio": client,
            "actions": pick(actions, "actions", client_id),
        })

    return {
        "generated_at": briefing.get("generated_at") or strategic.get("generated_at"),
        "overview": overview,
    }


def main() -> None:
    print(json.dumps(build_intelligence_overview(), default=str))


if __name__ == "__main__":
    main()
