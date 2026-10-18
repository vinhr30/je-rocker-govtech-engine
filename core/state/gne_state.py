"""In-memory state containers for the Grant Neural Engine."""

import json
from datetime import date
from pathlib import Path
from typing import Any


GRANT_SIGNALS_PATH = Path(__file__).with_name("grant_signals.json")


def _load_grant_signals() -> list[dict[str, Any]]:
	if not GRANT_SIGNALS_PATH.exists():
		return []
	data = json.loads(GRANT_SIGNALS_PATH.read_text(encoding="utf-8"))
	if not isinstance(data, list):
		raise ValueError("grant_signals.json must contain a JSON array")
	valid = []
	for signal in data:
		try:
			date.fromisoformat(str(signal.get("published_date") or "")[:10])
		except (TypeError, ValueError):
			continue
		if not signal.get("source_type"):
			source = str(signal.get("source") or "").casefold()
			signal["source_type"] = "state" if "state portal" in source else "local" if source.startswith("local ") or source.startswith("regional ") else "innovation" if any(term in source for term in ("sbir", "sttr", "baa", "arpa")) else "procurement" if source == "sam.gov" else "federal"
		valid.append(signal)
	return valid


grant_signals: list[dict[str, Any]] = _load_grant_signals()
gne_semantics: list[dict[str, Any]] = []
gne_classifications: list[dict[str, Any]] = []
gne_forecasts: list[dict[str, Any]] = []
gne_modernization: list[dict[str, Any]] = []
gne_partners: list[dict[str, Any]] = []
