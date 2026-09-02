from __future__ import annotations

import argparse
import importlib
import json
from pathlib import Path

from scripts.stabilize_ingestion import stabilize_states

STATE_RUNNERS = {
    "AZ": "ingestion.states.arizona.run",
    "CA": "ingestion.states.california.run",
    "TX": "ingestion.states.texas.run",
    "FL": "ingestion.states.florida.run",
    "VA": "ingestion.states.virginia.run",
    "NY": "ingestion.states.new_york.run",
}
AUTOMATED_STATES = ("AZ", "CA", "TX", "FL", "NY")
REGISTRY_PATH = Path(__file__).resolve().parent / "ingestion" / "registry.json"


def load_registry() -> list[dict]:
    if not REGISTRY_PATH.exists():
        return []
    with REGISTRY_PATH.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    if isinstance(payload, dict):
        payload = [payload]
    return payload


def schedule_state(state_code: str, runner_module: str | None = None) -> str:
    module_name = runner_module or STATE_RUNNERS.get(state_code, "ingestion.states.arizona.run")
    STATE_RUNNERS[state_code] = module_name
    print(f"Scheduled ingestion for {state_code} via {module_name}")
    return module_name


def run_state(state_code: str) -> None:
    module_name = STATE_RUNNERS.get(state_code)
    if not module_name:
        raise ValueError(f"No runner configured for state: {state_code}")

    module = importlib.import_module(module_name)
    runner = getattr(module, "main", None)
    if runner is None:
        raise AttributeError(f"Runner module '{module_name}' does not define main()")

    print(f"Running {state_code} via {module_name}")
    runner()


def run_all_states() -> None:
    registry = load_registry()
    for entry in registry:
        if not isinstance(entry, dict):
            continue
        if entry.get("enabled") is not True:
            continue
        state_code = entry.get("state")
        if not state_code:
            continue
        module_name = entry.get("module")
        if module_name and module_name.endswith(".arizona"):
            runner_module = f"{module_name}.run"
        else:
            runner_module = STATE_RUNNERS.get(state_code)
        if runner_module:
            schedule_state(state_code, runner_module)
            run_state(state_code)


def run_scheduled_states(states: list[str] | None = None) -> None:
    selected = states or list(STATE_RUNNERS.keys())
    for state_code in selected:
        run_state(state_code)


def run_automated_states() -> None:
    for state_code in AUTOMATED_STATES:
        run_state(state_code)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run scheduled state ingestion jobs.")
    parser.add_argument("--state", nargs="+", default=["AZ"], help="State code(s) to run, e.g. --state AZ")
    parser.add_argument("--all", action="store_true", help="Run every enabled state listed in registry.json")
    parser.add_argument("--automated", action="store_true", help="Run the scheduled non-VA states in order")
    args = parser.parse_args()

    if args.automated:
        run_automated_states()
    elif args.all:
        run_all_states()
    else:
        run_scheduled_states(args.state)

    for name, result in stabilize_states().items():
        print(f"DSM stabilized {name}: {result['rows']} rows, {result['events']} drift events")
