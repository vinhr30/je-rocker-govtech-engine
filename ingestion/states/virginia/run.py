from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from ingestion.states.virginia.details import hydrate_details
from ingestion.states.virginia.listings import fetch_listing_pages
from ingestion.states.virginia.normalize import normalize_records

ROOT_DIR = Path(__file__).resolve().parents[3]
DB_PATH = ROOT_DIR / "data" / "opportunities_VA.db"
LOG_PATH = ROOT_DIR / "data" / "va_ingestion_background.log"


def notify(title: str, message: str) -> None:
    try:
        script = (
            f'display notification {json.dumps(message)} with title {json.dumps(title)}'
        )
        subprocess.run(
            ["osascript", "-e", script],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        print(f"[{title}] {message}")


def run_pipeline(quiet: bool = False, reset: bool = True, max_pages: int = 999) -> dict:
    if not quiet:
        print("Starting VA ingestion pipeline...")
    rows = fetch_listing_pages(reset=reset, max_pages=max_pages)
    if not quiet:
        print(f"Fetched {len(rows)} raw listing rows")

    hydrate_details(reset=reset)
    normalize_records(reset=reset)

    conn = sqlite3.connect(DB_PATH)
    counts = {
        "raw_listings": conn.execute("SELECT COUNT(*) FROM raw_listings").fetchone()[0],
        "raw_details": conn.execute("SELECT COUNT(*) FROM raw_details").fetchone()[0],
        "normalized_listings": conn.execute("SELECT COUNT(*) FROM normalized_listings").fetchone()[0],
    }
    conn.close()

    if not quiet:
        print(counts)
    return counts


def start_background_run(max_pages: int = 999, reset: bool = True, quiet: bool = True, notify_on_complete: bool = True) -> dict:
    script_path = Path(__file__).resolve()
    cmd = [
        sys.executable,
        str(script_path),
        "--quiet",
        "--max-pages",
        str(max_pages),
    ]
    if reset:
        cmd.append("--reset")
    if notify_on_complete:
        cmd.append("--notify")

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=log_file,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    return {"pid": process.pid, "log": str(LOG_PATH), "cmd": cmd}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Virginia eligibility ingestion pipeline.")
    parser.add_argument("--quiet", action="store_true", help="Suppress chatter and only emit completion notification/output when requested.")
    parser.add_argument("--notify", action="store_true", help="Send a macOS notification when the run completes.")
    parser.add_argument("--max-pages", type=int, default=1, help="Maximum number of listing pages to crawl.")
    parser.add_argument("--reset", action="store_true", help="Reset the raw tables before re-crawling.")
    parser.add_argument("--background", action="store_true", help="Start the crawl in a background process without streaming results.")
    args = parser.parse_args()

    if args.background:
        start_background_run(max_pages=args.max_pages, reset=args.reset, quiet=args.quiet, notify_on_complete=args.notify)
        return

    counts = run_pipeline(quiet=args.quiet, reset=args.reset, max_pages=args.max_pages)
    if args.notify:
        notify("VA ingestion complete", ", ".join(f"{key}={value}" for key, value in counts.items()))


if __name__ == "__main__":
    main()
