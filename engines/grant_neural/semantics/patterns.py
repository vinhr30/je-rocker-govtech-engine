"""Deterministic patterns for Grant Neural Engine semantic extraction."""

from __future__ import annotations

import re
from typing import Final


FUNDING_PATTERN: Final = re.compile(
    r"\$?\s*(\d+(?:\.\d+)?)\s*(million|billion)\b",
    re.IGNORECASE,
)

AGENCY_PATTERNS: Final = {
    "Department of Veterans Affairs": (
        re.compile(r"\bDepartment of Veterans Affairs\b", re.IGNORECASE),
        re.compile(r"\bVA\b"),
    ),
    "Department of Housing and Urban Development": (
        re.compile(r"\bDepartment of Housing and Urban Development\b", re.IGNORECASE),
        re.compile(r"\bHUD\b"),
    ),
    "Department of Health and Human Services": (
        re.compile(r"\bDepartment of Health and Human Services\b", re.IGNORECASE),
        re.compile(r"\bHHS\b"),
    ),
    "Department of Energy": (
        re.compile(r"\bDepartment of Energy\b", re.IGNORECASE),
        re.compile(r"\bDOE\b"),
    ),
    "Department of Transportation": (
        re.compile(r"\bDepartment of Transportation\b", re.IGNORECASE),
        re.compile(r"\bDOT\b"),
    ),
}

TARGET_POPULATION_PATTERNS: Final = {
    "veterans": (r"\bveterans?\b",),
    "homeless": (r"\bhomeless(?:ness)?\b",),
    "at-risk": (r"\bat[ -]risk\b", r"\brisk of becoming homeless\b"),
    "families": (r"\bfamil(?:y|ies)\b",),
    "disabled": (r"\bdisabled\b", r"\bdisabilit(?:y|ies)\b"),
}

PROGRAM_TYPE_PATTERNS: Final = {
    "housing": (r"\bhousing\b",),
    "job training": (r"\bjob training\b", r"\bworkforce training\b"),
    "health care": (r"\bhealth care\b", r"\bhealthcare\b"),
    "counseling": (r"\bcounsel(?:ing|ling)\b",),
    "case management": (r"\bcase management\b",),
    "rapid re-housing": (r"\brapid re-housing\b", r"\brapid(?:ly)? re-house\b"),
    "eviction prevention": (
        r"\beviction prevention\b",
        r"\bprevent(?:ing)? the imminent loss of a home\b",
    ),
}

MODERNIZATION_CUE_PATTERNS: Final = {
    cue: (rf"\b{re.escape(cue)}\b",)
    for cue in ("workflow", "data", "automation", "digital", "upgrade", "modernization", "system", "reporting")
}

VETERAN_CUE_PATTERNS: Final = {
    "VA": (r"\bVA\b", r"\bDepartment of Veterans Affairs\b"),
    "veterans": (r"\bveterans?\b",),
    "military families": (r"\bmilitary families\b",),
}

HOMELESSNESS_CUE_PATTERNS: Final = {
    "homeless": (r"\bhomeless(?:ness)?\b",),
    "rapid re-housing": (r"\brapid re-housing\b", r"\brapid(?:ly)? re-house\b"),
    "eviction prevention": (
        r"\beviction prevention\b",
        r"\bprevent(?:ing)? the imminent loss of a home\b",
    ),
    "transitional housing": (r"\btransitional housing\b",),
}

MENTAL_HEALTH_CUE_PATTERNS: Final = {
    "behavioral health": (r"\bbehavioral health\b",),
    "mental health": (r"\bmental health\b",),
    "counseling": (r"\bcounsel(?:ing|ling)\b",),
}

PARTNER_CUE_PATTERNS: Final = {
    "community partners": (r"\bcommunity partners\b",),
    "organizations": (r"\borganizations?\b",),
    "providers": (r"\bproviders?\b",),
}

GEOGRAPHY_PATTERNS: Final = {
    "national": (r"\bnationwide\b", r"\bacross the country\b", r"\bnational\b"),
    "Northeast": (r"\bnortheast(?:ern)?\b",),
    "Southeast": (r"\bsoutheast(?:ern)?\b",),
    "Midwest": (r"\bmidwest(?:ern)?\b",),
    "Southwest": (r"\bsouthwest(?:ern)?\b",),
    "West": (r"\bwestern region\b", r"\bwest coast\b"),
}
