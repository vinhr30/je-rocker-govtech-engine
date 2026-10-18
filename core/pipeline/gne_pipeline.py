"""Grant Neural Engine pipeline entrypoints."""

from __future__ import annotations

from typing import Any, Callable, Union

from core.state import gne_state
from engines.grant_neural.classifier.classifier import run_classification
from engines.grant_neural.forecast.forecast import run_forecast as forecast_classification
from engines.grant_neural.modernization.modernization import run_modernization as modernize_forecast
from engines.grant_neural.partners.partners import run_partners as map_partner_ecosystem
from engines.grant_neural.semantics.extractor import run_semantic_extraction
from engines.grant_neural.scraper.normalize import normalize_article_to_signal
from engines.grant_neural.scraper.scraper import (
    fetch_ap_news,
    fetch_arpa_e_baa,
    fetch_arpa_h_baa,
    fetch_cdc,
    fetch_commerce_eda,
    fetch_darpa_baa,
    fetch_dhs,
    fetch_dhs_st_baa,
    fetch_dod_labs_baa,
    fetch_doe,
    fetch_doj,
    fetch_dol,
    fetch_dot,
    fetch_epa,
    fetch_grants_gov,
    fetch_hhs_press,
    fetch_hud_press,
    fetch_local_cities,
    fetch_local_counties,
    fetch_military_com,
    fetch_nih,
    fetch_nsf,
    fetch_regional_planning_orgs,
    fetch_reuters,
    fetch_sam_gov,
    fetch_sba,
    fetch_sbir_sttr_dod,
    fetch_sbir_sttr_doe,
    fetch_sbir_sttr_nasa,
    fetch_sbir_sttr_nih,
    fetch_sbir_sttr_nsf,
    fetch_state_az,
    fetch_state_ca,
    fetch_state_co,
    fetch_state_fl,
    fetch_state_ga,
    fetch_state_il,
    fetch_state_ma,
    fetch_state_mi,
    fetch_state_nc,
    fetch_state_ny,
    fetch_state_oh,
    fetch_state_pa,
    fetch_state_tx,
    fetch_state_va,
    fetch_state_wa,
    fetch_stars_and_stripes,
    fetch_treasury,
    fetch_usda,
    fetch_va_press,
)
from engines.grant_neural.scraper.store import store_signals


Fetcher = Callable[[], Union[dict[str, Any], list[dict[str, Any]]]]

SOURCE_FETCHERS: tuple[tuple[str, Fetcher], ...] = (
    ("NSF", fetch_nsf),
    ("DOE", fetch_doe),
    ("DOT", fetch_dot),
    ("DHS", fetch_dhs),
    ("USDA", fetch_usda),
    ("Treasury", fetch_treasury),
    ("SBA", fetch_sba),
    ("NIH", fetch_nih),
    ("CDC", fetch_cdc),
    ("DOJ", fetch_doj),
    ("DOL", fetch_dol),
    ("Commerce/EDA", fetch_commerce_eda),
    ("EPA", fetch_epa),
    ("VA Press Releases", fetch_va_press),
    ("HUD Press Releases", fetch_hud_press),
    ("HHS Press Releases", fetch_hhs_press),
    ("Grants.gov", fetch_grants_gov),
    ("SAM.gov", fetch_sam_gov),
    ("DoD SBIR/STTR", fetch_sbir_sttr_dod),
    ("NASA SBIR/STTR", fetch_sbir_sttr_nasa),
    ("NIH SBIR/STTR", fetch_sbir_sttr_nih),
    ("NSF SBIR/STTR", fetch_sbir_sttr_nsf),
    ("DOE SBIR/STTR", fetch_sbir_sttr_doe),
    ("DARPA BAA", fetch_darpa_baa),
    ("ARPA-H BAA", fetch_arpa_h_baa),
    ("ARPA-E BAA", fetch_arpa_e_baa),
    ("DHS S&T BAA", fetch_dhs_st_baa),
    ("DoD Labs BAA", fetch_dod_labs_baa),
    ("Arizona State Portal", fetch_state_az),
    ("California State Portal", fetch_state_ca),
    ("Florida State Portal", fetch_state_fl),
    ("Virginia State Portal", fetch_state_va),
    ("Texas State Portal", fetch_state_tx),
    ("New York State Portal", fetch_state_ny),
    ("Washington State Portal", fetch_state_wa),
    ("Colorado State Portal", fetch_state_co),
    ("Illinois State Portal", fetch_state_il),
    ("Georgia State Portal", fetch_state_ga),
    ("North Carolina State Portal", fetch_state_nc),
    ("Pennsylvania State Portal", fetch_state_pa),
    ("Ohio State Portal", fetch_state_oh),
    ("Michigan State Portal", fetch_state_mi),
    ("Massachusetts State Portal", fetch_state_ma),
    ("Local Counties", fetch_local_counties),
    ("Local Cities", fetch_local_cities),
    ("Regional Planning Organizations", fetch_regional_planning_orgs),
    ("AP News", fetch_ap_news),
    ("Reuters", fetch_reuters),
    ("Military.com", fetch_military_com),
    ("Stars and Stripes", fetch_stars_and_stripes),
)


def run_scraper() -> dict[str, Any]:
    """Fetch, normalize, and store the latest signal from every source."""
    fetched = 0
    stored = 0
    duplicates = 0
    errors: list[dict[str, str]] = []
    for source, fetcher in SOURCE_FETCHERS:
        try:
            result = fetcher()
        except Exception as error:
            errors.append({"source": source, "error": str(error)})
            continue
        articles = result if isinstance(result, list) else [result]
        normalized = []
        for article in articles:
            fetched += 1
            try:
                normalized.append(normalize_article_to_signal(article))
            except Exception as error:
                errors.append({"source": source, "error": str(error)})
        if normalized:
            result = store_signals(normalized)
            stored += result["stored"]
            duplicates += result["duplicates"]
            errors.extend({"source": source, "error": error} for error in result["errors"])
    return {"fetched": fetched, "stored": stored, "duplicates": duplicates, "errors": errors}


def run_semantic_extractor() -> list[dict[str, Any]]:
    """Extract semantic intelligence for every normalized grant signal."""
    semantics = [run_semantic_extraction(raw_signal) for raw_signal in gne_state.grant_signals]
    gne_state.gne_semantics[:] = semantics
    return gne_state.gne_semantics


def run_classifier() -> list[dict[str, Any]]:
    """Classify every GNE semantic object and update global state."""
    classifications = [run_classification(semantic_obj) for semantic_obj in gne_state.gne_semantics]
    gne_state.gne_classifications[:] = classifications
    return gne_state.gne_classifications


def run_forecast() -> list[dict[str, Any]]:
    """Forecast every GNE classification object and update global state."""
    forecasts = [forecast_classification(classification) for classification in gne_state.gne_classifications]
    gne_state.gne_forecasts[:] = forecasts
    return gne_state.gne_forecasts


def run_modernization() -> list[dict[str, Any]]:
    """Analyze modernization for every GNE forecast and update global state."""
    modernization = [modernize_forecast(forecast) for forecast in gne_state.gne_forecasts]
    gne_state.gne_modernization[:] = modernization
    return gne_state.gne_modernization


def run_partners() -> list[dict[str, Any]]:
    """Map partner ecosystems for every GNE modernization object."""
    partners = [map_partner_ecosystem(modernization) for modernization in gne_state.gne_modernization]
    gne_state.gne_partners[:] = partners
    return gne_state.gne_partners
