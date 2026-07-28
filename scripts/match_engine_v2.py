import sqlite3
import logging
import re
import time
from difflib import SequenceMatcher
from datetime import datetime

# Paths
OPPS_DB = "/Volumes/Data Drive/Govtech/JE ROCKER/db/opportunities.db"
FPDS_DB = "/Volumes/Data Drive/Govtech/JE ROCKER/db/fpds.db"
MATCH_DB = "/Volumes/Data Drive/Govtech/JE ROCKER/db/matches.db"
LOG_FILE = "/Volumes/Data Drive/Govtech/JE ROCKER/utils/logs/match_engine.log"
FPDS_QUERY_TIMEOUT_SECONDS = 3.0
SQLITE_LOCK_RETRIES = 5
SQLITE_LOCK_RETRY_BASE_SECONDS = 0.25

SUPPRESS_NAICS = {"561720", "561730", "561210"}
SUPPRESS_PSC = {"S201", "S299"}
GOVTECH_NAICS = {"541511", "541512", "541513", "541519", "518210", "611420"}
GOVTECH_PSC = {"D302", "D307", "D399", "R499", "R699"}
PREFERRED_AGENCIES = {
    "Department of the Navy",
    "Department of the Air Force",
    "Department of Agriculture",
    "Department of Veterans Affairs",
    "Small Business Administration",
}
CAPABILITY_KEYWORDS = {
    "automation": 40,
    "dashboard": 40,
    "reporting": 30,
    "data": 30,
    "scraping": 40,
    "workflow": 30,
    "ai": 40,
    "compliance": 30,
    "training": 20,
    "modernization": 30,
}

# Setup logging
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# Agency name mapping: SAM.gov format -> FPDS format
AGENCY_MAP = {
    "DEPT OF DEFENSE": "Department of Defense",
    "AGRICULTURE, DEPARTMENT OF": "Department of Agriculture",
    "COMMERCE, DEPARTMENT OF": "Department of Commerce",
    "EDUCATION, DEPARTMENT OF": "Department of Education",
    "ENERGY, DEPARTMENT OF": "Department of Energy",
    "HEALTH AND HUMAN SERVICES, DEPARTMENT OF": "Department of Health and Human Services",
    "HOMELAND SECURITY, DEPARTMENT OF": "Department of Homeland Security",
    "HOUSING AND URBAN DEVELOPMENT, DEPARTMENT OF": "Department of Housing and Urban Development",
    "INTERIOR, DEPARTMENT OF THE": "Department of the Interior",
    "JUSTICE, DEPARTMENT OF": "Department of Justice",
    "LABOR, DEPARTMENT OF": "Department of Labor",
    "STATE, DEPARTMENT OF": "Department of State",
    "TRANSPORTATION, DEPARTMENT OF": "Department of Transportation",
    "TREASURY, DEPARTMENT OF THE": "Department of the Treasury",
    "VETERANS AFFAIRS, DEPARTMENT OF": "Department of Veterans Affairs",
    "GENERAL SERVICES ADMINISTRATION": "General Services Administration",
    "NATIONAL AERONAUTICS AND SPACE ADMINISTRATION": "National Aeronautics and Space Administration",
    "SMALL BUSINESS ADMINISTRATION": "Small Business Administration",
    "ENVIRONMENTAL PROTECTION AGENCY": "Environmental Protection Agency",
    "NATIONAL SCIENCE FOUNDATION": "National Science Foundation",
    "NUCLEAR REGULATORY COMMISSION": "Nuclear Regulatory Commission",
    "SOCIAL SECURITY ADMINISTRATION": "Social Security Administration",
    "OFFICE OF PERSONNEL MANAGEMENT": "Office of Personnel Management",
    "AMERICAN BATTLE MONUMENTS COMMISSION": "American Battle Monuments Commission",
    "CONSUMER PRODUCT SAFETY COMMISSION": "Consumer Product Safety Commission",
    "CORPORATION FOR NATIONAL AND COMMUNITY SERVICE": "Corporation for National and Community Service",
    "COURT SERVICES AND OFFENDER SUPERVISION AGENCY": "Court Services and Offender Supervision Agency",
    "LIBRARY OF CONGRESS": "Library of Congress",
}

def normalize_agency(sam_agency: str) -> str:
    """Convert SAM.gov agency name to FPDS format."""
    if not sam_agency:
        return ""
    upper = sam_agency.strip().upper()
    if upper in AGENCY_MAP:
        return AGENCY_MAP[upper]
    # Fallback: handle "X, DEPARTMENT OF" pattern not in map
    m = re.match(r'^(.+),\s*DEPARTMENT OF(?:\s+THE)?$', upper)
    if m:
        return f"Department of {m.group(1).title()}"
    # Last resort: title case
    return sam_agency.title()

def normalize_psc_code(psc_code: str) -> str:
    """Normalize PSC values like 'S201 - HOUSEKEEPING...' to 'S201'."""
    if not psc_code:
        return ""
    code = psc_code.strip().upper()
    if code in {"(BLANK)", "BLANK", "N/A", "NONE", "NULL", "-"}:
        return ""
    # Keep only canonical 4-character PSC/FSC code tokens (e.g. S201, 3830).
    m = re.match(r"^([A-Z0-9]{4})\b", code)
    return m.group(1) if m else ""

def normalize_naics_code(naics_code: str) -> str:
    """Normalize NAICS values to canonical 6-digit strings."""
    if not naics_code:
        return ""
    text = str(naics_code).strip()
    m = re.match(r"^(\d{6})", text)
    return m.group(1) if m else ""

def ensure_matches_schema(matches_conn):
    """Backfill required columns for older matches table schemas."""
    existing_cols = {
        row[1]
        for row in matches_conn.execute("PRAGMA table_info(matches)").fetchall()
    }
    required_cols = {
        "opportunity_id": "TEXT",
        "fpds_contract_id": "TEXT",
        "opportunity_url": "TEXT",
        "opportunity_title": "TEXT",
        "fpds_contract_key": "TEXT",
        "fpds_title": "TEXT",
        "matching_strategy": "TEXT",
        "fpds_psc_code": "TEXT",
        "fpds_naics_code": "TEXT",
        "fpds_agency": "TEXT",
        "fpds_place_state": "TEXT",
    }

    for col_name, col_type in required_cols.items():
        if col_name not in existing_cols:
            matches_conn.execute(f"ALTER TABLE matches ADD COLUMN {col_name} {col_type}")

    matches_conn.commit()

def is_locked_error(err: Exception) -> bool:
    msg = str(err).lower()
    return "database is locked" in msg or "database table is locked" in msg

def execute_with_lock_retries(conn, query_str: str, params: tuple = (), fetch: bool = False):
    """Execute SQL with bounded retries when SQLite reports lock contention."""
    for attempt in range(SQLITE_LOCK_RETRIES + 1):
        try:
            cur = conn.execute(query_str, params)
            return cur.fetchall() if fetch else cur
        except sqlite3.OperationalError as e:
            if not is_locked_error(e) or attempt >= SQLITE_LOCK_RETRIES:
                raise
            wait_s = SQLITE_LOCK_RETRY_BASE_SECONDS * (2 ** attempt)
            logging.warning(f"SQLite locked during query; retrying in {wait_s:.2f}s")
            time.sleep(wait_s)

def commit_with_lock_retries(conn):
    """Commit with bounded retries when SQLite reports lock contention."""
    for attempt in range(SQLITE_LOCK_RETRIES + 1):
        try:
            conn.commit()
            return
        except sqlite3.OperationalError as e:
            if not is_locked_error(e) or attempt >= SQLITE_LOCK_RETRIES:
                raise
            wait_s = SQLITE_LOCK_RETRY_BASE_SECONDS * (2 ** attempt)
            logging.warning(f"SQLite locked during commit; retrying in {wait_s:.2f}s")
            time.sleep(wait_s)

def execute_with_timeout(conn, query_str: str, params: tuple, timeout_seconds: float):
    """Execute a SQLite query with a per-query timeout via progress handler."""
    deadline = time.monotonic() + timeout_seconds

    def progress_handler():
        return 1 if time.monotonic() >= deadline else 0

    conn.set_progress_handler(progress_handler, 10000)
    try:
        return execute_with_lock_retries(conn, query_str, params=params, fetch=True)
    except sqlite3.OperationalError as e:
        if "interrupted" in str(e).lower():
            raise TimeoutError(f"SQLite query timed out after {timeout_seconds:.1f}s") from e
        raise
    finally:
        conn.set_progress_handler(None, 0)

def connect_dbs():
    opps = sqlite3.connect(OPPS_DB, timeout=30)
    fpds = sqlite3.connect(FPDS_DB, timeout=30)
    matches = sqlite3.connect(MATCH_DB, timeout=30, isolation_level=None)

    opps.row_factory = sqlite3.Row
    fpds.row_factory = sqlite3.Row
    matches.row_factory = sqlite3.Row

    for conn in (opps, fpds, matches):
        conn.execute("PRAGMA busy_timeout = 30000;")

    # WAL improves read/write concurrency and reduces lock conflicts when available.
    try:
        matches.execute("PRAGMA journal_mode = WAL;")
    except sqlite3.OperationalError as e:
        logging.warning(f"Could not enable WAL mode for matches DB: {e}")

    # Ensure matches table exists
    matches.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opportunity_url TEXT,
            opportunity_title TEXT,
            fpds_contract_key TEXT,
            fpds_title TEXT,
            matching_strategy TEXT,
            score INTEGER,
            incumbent_vendor TEXT,
            incumbent_award_value TEXT,
            incumbent_period_end TEXT,
            match_reason TEXT,
            timestamp TEXT
        );
    """)
    ensure_matches_schema(matches)
    commit_with_lock_retries(matches)
    
    return opps, fpds, matches

def title_similarity(title1: str, title2: str) -> float:
    """Calculate similarity between two titles (0.0 to 1.0)"""
    if not title1 or not title2:
        return 0.0
    
    # Normalize
    t1 = title1.lower().strip()
    t2 = title2.lower().strip()
    
    # Calculate ratio
    ratio = SequenceMatcher(None, t1, t2).ratio()
    return ratio

def coerce_award_value(value) -> float:
    """Convert award value to a numeric amount for scoring comparisons."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if not text:
        return 0.0

    # Handle common formatting like "$123,456.78".
    text = text.replace(",", "").replace("$", "")
    try:
        return float(text)
    except ValueError:
        return 0.0

def score_govtech_match(opp_title: str, opp_agency: str, opp_naics: str, opp_psc: str, row):
    """Apply the shared GovTech scoring/suppression model to one FPDS row."""
    opp_naics_norm = normalize_naics_code(opp_naics)
    opp_psc_norm = normalize_psc_code(opp_psc)

    if opp_naics_norm in SUPPRESS_NAICS:
        return None

    fpds_title = row["transaction_description"] if "transaction_description" in row.keys() else ""
    fpds_title = fpds_title or ""

    fpds_psc = row["product_or_service_code"] if "product_or_service_code" in row.keys() else ""
    fpds_psc = normalize_psc_code(fpds_psc or "")

    psc_code = fpds_psc
    PSC_SUPPRESS = {
        "6515", "7030", "7050", "7035", "7025", "7010", "7110", "7045", "7125", "7022", "7021", "7020",
        "5810", "5836", "5820", "5805", "5895", "5841", "5840", "5821", "5845", "5830",
        "5998", "5999", "5975", "5965", "5935", "5930",
        "6650", "6640", "6530", "6525", "6350", "6120", "6015",
        "3611", "3444", "1730", "1290",
        "9905", "7510", "6720", "6710", "6610", "6605",
        "Z2AA", "Z1DB", "S205", "W070", "W061", "T016", "T001",
        "J065", "J066", "J070", "J059", "J099", "J074", "J063", "J058", "J016", "J045",
        "N059", "N063", "N065", "N070", "N061",
        "K023", "K070",
        "7B22", "7G20", "7E20", "7A21", "7G21", "7B20", "7A20",
        "H361", "H249",
        "U099", "U008", "U012", "U009", "U006",
        "F999", "F108", "F099",
        "B529", "B519", "B517", "B507",
        "X1AZ", "V999"
    }
    if psc_code in PSC_SUPPRESS:
        return None  # reject this FPDS match immediately

    if fpds_psc in SUPPRESS_PSC:
        return None

    fpds_naics = row["naics_code"] if "naics_code" in row.keys() else ""
    fpds_naics_norm = normalize_naics_code(fpds_naics or "")

    naics_code = fpds_naics_norm
    NAICS_SUPPRESS = {
        "236220", "238320", "238210", "238990", "238290",
        "562112", "562910",
        "337215", "334614", "334290", "334210", "333298", "333293", "332999", "325412",
        "484210", "443120", "424110", "453998",
        "722310", "711510", "812930",
        "811310", "811213"
    }
    if naics_code in NAICS_SUPPRESS:
        return None  # reject this FPDS match immediately

    if fpds_naics_norm in SUPPRESS_NAICS:
        return None

    # Hard gate to GovTech domains on the matched FPDS side.
    fpds_is_govtech = fpds_naics_norm in GOVTECH_NAICS or fpds_psc in GOVTECH_PSC
    if not fpds_is_govtech:
        return None

    opp_is_govtech = opp_naics_norm in GOVTECH_NAICS or opp_psc_norm in GOVTECH_PSC

    score = 0

    if opp_naics_norm in GOVTECH_NAICS:
        score += 50
    if fpds_naics_norm in GOVTECH_NAICS:
        score += 35
    if fpds_psc in GOVTECH_PSC:
        score += 40

    if opp_is_govtech:
        score += 10

    text = f"{opp_title} {fpds_title}".lower()
    for word, weight in CAPABILITY_KEYWORDS.items():
        if word in text:
            score += weight

    if opp_agency in PREFERRED_AGENCIES:
        score += 20

    award_value = row["current_total_value_of_award"] if "current_total_value_of_award" in row.keys() else 0
    award_value = coerce_award_value(award_value)
    if award_value < 250000:
        score += 15

    similarity = title_similarity(opp_title, fpds_title)
    if similarity < 0.12:
        return None
    score += int(similarity * 30)

    score = max(0, min(score, 100))
    if score < 55:
        return None

    return {
        "score": score,
        "similarity": similarity,
        "fpds_title": fpds_title,
    }

def title_search_seed(title: str) -> str:
    """Pick a reasonable token for title-only SQL fallback matching."""
    tokens = re.findall(r"[A-Za-z0-9]{5,}", (title or "").lower())
    return tokens[0] if tokens else ""

def find_matches_for_opportunity(opps, fpds, opp) -> list:
    """Find matching FPDS contracts for a single opportunity"""
    matches_found = []
    
    opp_url = opp["url"]
    opp_title = opp["title"] or ""
    title = opp_title.lower()

    KEYWORD_SUPPRESS = {
        "maintenance", "maint", "repair", "janitorial", "custodial",
        "grounds", "landscaping", "hvac", "plumbing", "electrical",
        "construction", "renovation", "roof", "paving", "painting",
        "facility", "facilities", "building", "structure", "warehouse",
        "equipment", "hardware", "furniture", "industrial", "machinery",
        "vehicle", "fleet", "transport", "logistics", "cleaning",
        "waste", "remediation", "hazardous", "environmental services",
        "security guard", "armed guard", "unarmed guard"
    }
    for kw in KEYWORD_SUPPRESS:
        if kw in title:
            return None  # reject immediately

    opp_agency = normalize_agency(opp["agency"] or "")
    opp_naics = opp["naics_code"] or ""
    opp_psc = normalize_psc_code(opp["psc_code"] or "")
    
    if not opp_title:
        return matches_found
    
    # Search strategy 1: By exact agency + NAICS (most specific)
    if opp_agency and opp_naics:
        try:
            query_rows = execute_with_timeout(fpds, """
                SELECT contract_transaction_unique_key, recipient_name, current_total_value_of_award,
                       period_of_performance_current_end_date, transaction_description,
                       naics_code, product_or_service_code, awarding_agency_name,
                      primary_place_of_performance_state_name AS place_of_performance_state
                FROM contracts
                WHERE awarding_agency_name = ? AND naics_code = ?
                LIMIT 100;
            """, (opp_agency, opp_naics), FPDS_QUERY_TIMEOUT_SECONDS)

            for row in query_rows:
                scored = score_govtech_match(opp_title, opp_agency, opp_naics, opp_psc, row)
                if not scored:
                    continue

                matches_found.append({
                    "contract_key": row["contract_transaction_unique_key"],
                    "fpds_title": scored["fpds_title"],
                    "strategy": "Agency + NAICS + Title",
                    "score": scored["score"],
                    "vendor": row["recipient_name"],
                    "award_value": row["current_total_value_of_award"],
                    "period_end": row["period_of_performance_current_end_date"],
                    "reason": f"Title similarity: {scored['similarity']:.2%}",
                    "fpds_psc_code": row["product_or_service_code"],
                    "fpds_naics_code": row["naics_code"],
                    "fpds_agency": row["awarding_agency_name"],
                    "fpds_place_state": row["place_of_performance_state"],
                })
        except TimeoutError:
            logging.warning(
                f"Agency+NAICS search timed out after {FPDS_QUERY_TIMEOUT_SECONDS:.1f}s for {opp_url}"
            )
        except Exception as e:
            logging.warning(f"Agency+NAICS search failed for {opp_url}: {e}")
    
    # Search strategy 2: By agency + PSC
    if not matches_found and opp_agency and opp_psc:
        try:
            query_rows = execute_with_timeout(fpds, """
                SELECT contract_transaction_unique_key, recipient_name, current_total_value_of_award,
                       period_of_performance_current_end_date, transaction_description,
                       naics_code, product_or_service_code, awarding_agency_name,
                      primary_place_of_performance_state_name AS place_of_performance_state
                FROM contracts
                WHERE awarding_agency_name = ? AND product_or_service_code = ?
                LIMIT 100;
            """, (opp_agency, opp_psc), FPDS_QUERY_TIMEOUT_SECONDS)

            for row in query_rows:
                scored = score_govtech_match(opp_title, opp_agency, opp_naics, opp_psc, row)
                if not scored:
                    continue

                matches_found.append({
                    "contract_key": row["contract_transaction_unique_key"],
                    "fpds_title": scored["fpds_title"],
                    "strategy": "Agency + PSC",
                    "score": scored["score"],
                    "vendor": row["recipient_name"],
                    "award_value": row["current_total_value_of_award"],
                    "period_end": row["period_of_performance_current_end_date"],
                    "reason": f"Title similarity: {scored['similarity']:.2%}",
                    "fpds_psc_code": row["product_or_service_code"],
                    "fpds_naics_code": row["naics_code"],
                    "fpds_agency": row["awarding_agency_name"],
                    "fpds_place_state": row["place_of_performance_state"],
                })
        except TimeoutError:
            logging.warning(
                f"Agency+PSC search timed out after {FPDS_QUERY_TIMEOUT_SECONDS:.1f}s for {opp_url}"
            )
        except Exception as e:
            logging.warning(f"Agency+PSC search failed for {opp_url}: {e}")

    # Search strategy 3: Title-only fallback
    if not matches_found:
        seed = title_search_seed(opp_title)
        if not seed:
            return matches_found

        query_str = """
            SELECT contract_transaction_unique_key, recipient_name, current_total_value_of_award,
                   period_of_performance_current_end_date, transaction_description,
                   awarding_agency_name, naics_code, product_or_service_code,
                     primary_place_of_performance_state_name AS place_of_performance_state
            FROM contracts
            WHERE lower(transaction_description) LIKE '%' || lower(?) || '%'
            LIMIT 100;
        """
        try:
            for row in execute_with_timeout(fpds, query_str, (seed,), FPDS_QUERY_TIMEOUT_SECONDS):
                scored = score_govtech_match(opp_title, opp_agency, opp_naics, opp_psc, row)
                if not scored:
                    continue

                matches_found.append({
                    "contract_key": row["contract_transaction_unique_key"],
                    "fpds_title": scored["fpds_title"],
                    "strategy": "Title-only fallback",
                    "score": scored["score"],
                    "vendor": row["recipient_name"],
                    "award_value": row["current_total_value_of_award"],
                    "period_end": row["period_of_performance_current_end_date"],
                    "reason": f"Title similarity: {scored['similarity']:.2%}",
                    "fpds_psc_code": row["product_or_service_code"],
                    "fpds_naics_code": row["naics_code"],
                    "fpds_agency": row["awarding_agency_name"],
                    "fpds_place_state": row["place_of_performance_state"],
                })
        except TimeoutError:
            logging.warning(
                f"Title-only fallback timed out after {FPDS_QUERY_TIMEOUT_SECONDS:.1f}s for {opp_url}"
            )
        except Exception as e:
            logging.warning(f"Title-only fallback failed for {opp_url}: {e}")
    
    return matches_found

def run_matching_engine():
    logging.info("=== MATCH ENGINE v2: Multi-Strategy Matching ===")
    
    opps, fpds, matches = connect_dbs()

    # Regenerate output from scratch on each run so prior contaminated rows do not persist.
    execute_with_lock_retries(matches, "DELETE FROM matches")
    matches.commit()
    logging.info("Cleared existing rows from matches table")
    
    # Get all opportunities
    opportunities = execute_with_lock_retries(
        opps,
        "SELECT * FROM opportunities ORDER BY url",
        fetch=True,
    )
    
    total_opps = len(opportunities)
    matched_count = 0
    total_matches = 0
    
    logging.info(f"Processing {total_opps} opportunities")
    
    for idx, opp in enumerate(opportunities):
        if idx % 100 == 0:
            logging.info(f"Progress: {idx}/{total_opps} opportunities processed, {total_matches} matches found so far")
        
        try:
            matches_found = find_matches_for_opportunity(opps, fpds, opp)
            
            if matches_found:
                matched_count += 1
                total_matches += len(matches_found)
                
                # Take top 3 matches by score
                top_matches = sorted(matches_found, key=lambda x: x["score"], reverse=True)[:3]
                
                for match in top_matches:
                    opportunity_id = opp["notice_id"] if "notice_id" in opp.keys() and opp["notice_id"] else opp["url"]
                    fpds_contract_id = match["contract_key"]
                    execute_with_lock_retries(matches, """
                        INSERT INTO matches
                        (opportunity_id, fpds_contract_id, score, incumbent_vendor,
                         incumbent_award_value, incumbent_period_end, match_reason, timestamp,
                         opportunity_url, opportunity_title, fpds_contract_key, fpds_title,
                         matching_strategy, fpds_psc_code, fpds_naics_code, fpds_agency,
                         fpds_place_state)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        opportunity_id,
                        fpds_contract_id,
                        match["score"],
                        match["vendor"],
                        match["award_value"],
                        match["period_end"],
                        match["reason"],
                        datetime.now().isoformat(),
                        opp["url"],
                        opp["title"],
                        match["contract_key"],
                        match["fpds_title"],
                        match["strategy"],
                        match.get("fpds_psc_code"),
                        match.get("fpds_naics_code"),
                        match.get("fpds_agency"),
                        match.get("fpds_place_state"),
                    ))

                if idx % 200 == 0:
                    commit_with_lock_retries(matches)
        
        except Exception as e:
            logging.error(f"Error matching {opp['url']}: {e}", exc_info=True)
    
    commit_with_lock_retries(matches)
    
    logging.info(f"\n=== MATCHING COMPLETE ===")
    logging.info(f"Total opportunities: {total_opps}")
    logging.info(f"Opportunities with matches: {matched_count} ({100*matched_count//total_opps if total_opps else 0}%)")
    logging.info(f"Total matches saved: {total_matches}")
    logging.info(f"Avg matches per opportunity: {total_matches/matched_count if matched_count else 0:.1f}")
    
    print(f"\n✅ Matching complete!")
    print(f"   Total opportunities: {total_opps}")
    print(f"   Matched: {matched_count}")
    print(f"   Total matches: {total_matches}")
    
    opps.close()
    fpds.close()
    matches.close()

if __name__ == "__main__":
    run_matching_engine()
