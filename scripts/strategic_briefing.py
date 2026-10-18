from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

try:
    from .forecast_engine import forecast_grants, forecast_modernization, forecast_pipeline
    from .forecast_narrative import grants_narrative, modernization_narrative, pipeline_narrative
except ImportError:
    from forecast_engine import forecast_grants, forecast_modernization, forecast_pipeline
    from forecast_narrative import grants_narrative, modernization_narrative, pipeline_narrative


def build_briefing() -> dict[str, Any]:
    pipeline = forecast_pipeline()
    grants = forecast_grants()
    modernization = forecast_modernization()

    pipeline_narr = pipeline_narrative()
    grants_narr = grants_narrative()
    modernization_narr = modernization_narrative()

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "pipeline": {
            "forecast": pipeline,
            "narrative": pipeline_narr[:3],
        },
        "grants": {
            "forecast": grants,
            "narrative": grants_narr[:3],
        },
        "modernization": {
            "forecast": modernization,
            "narrative": modernization_narr[:3],
        },
    }


def main() -> None:
    print(json.dumps(build_briefing(), default=str))


if __name__ == "__main__":
    main()
