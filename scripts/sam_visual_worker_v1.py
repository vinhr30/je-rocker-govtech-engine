import argparse
import hashlib
import importlib
import json
import logging
import os
from pathlib import Path
import socket
import sys
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
LOGGER = logging.getLogger("sam_visual_worker")
SOURCES = {
    "sam.gov": None,
    "az.gov": "arizona",
    "caleprocure.ca.gov": "california",
    "txsmartbuy.gov": "texas",
    "myflorida.com": "florida",
    "myfloridamarketplace.com": "florida",
    "myfloridamarketplace.my.site.com": "florida",
    "cgieva.com": "virginia",
    "eva.virginia.gov": "virginia",
    "nyscr.ny.gov": "new_york",
}


def source_for(url):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Only supported public HTTPS procurement URLs are accepted")
    for domain, source in SOURCES.items():
        if host == domain or host.endswith("." + domain):
            return source
    raise ValueError("Unsupported procurement hostname")


def extract_details(source, html, url):
    if source is None:
        return {}
    module = importlib.import_module(f"ingestion.states.{source}.details")
    if source == "virginia":
        return module.extract_detail_fields(html, fallback={"url": url})
    if source == "new_york":
        return module.extract_detail_metadata(html, url)
    return module.extract_details_from_html(html, url)


def capture(page, task, storage):
    if not isinstance(task, dict) or not task.get("id") or not isinstance(task.get("url"), str):
        raise ValueError("Task requires an id and URL")
    source = source_for(task["url"])
    if task.get("type", "capture") != "capture":
        raise ValueError("Unsupported task type")
    if task.get("max_pages", 1) != 1:
        raise ValueError("This worker captures one URL per task; max_pages must be 1")
    started = time.monotonic()
    response = page.goto(task["url"], wait_until="domcontentloaded", timeout=30000)
    source_for(page.url)
    if response and response.status >= 400:
        raise RuntimeError(f"Portal returned HTTP {response.status}")
    page.locator("body").wait_for(state="visible", timeout=15000)
    html = page.content()
    if any(marker in html.lower() for marker in ("verify you are human", "g-recaptcha", "cf-chl-")):
        raise RuntimeError("Portal requires manual browser verification; no bypass attempted")
    storage.mkdir(parents=True, exist_ok=True)
    stem = hashlib.sha256(str(task["id"]).encode()).hexdigest()
    snapshot = storage / f"opp_{stem}.png"
    page.screenshot(path=str(snapshot), full_page=True, timeout=30000)
    details = extract_details(source, html, task["url"])
    return {"id": task["id"], "url": page.url, "source": source or "sam",
            "snapshot_path": str(snapshot), "snapshot_host": socket.gethostname(),
            "snapshot_sha256": hashlib.sha256(snapshot.read_bytes()).hexdigest(),
            "details": details, "elapsed_seconds": round(time.monotonic() - started, 3),
            "timestamp": time.time(), "asset_transport": "worker_local_file"}


def process_one(queue, page, storage, processing_key, timeout=5):
    raw = queue.brpoplpush("contract_queue", processing_key, timeout=timeout)
    if raw is None:
        return False
    try:
        payload = capture(page, json.loads(raw), storage)
    except Exception as error:
        payload = {"task_raw": raw, "error": str(error), "timestamp": time.time()}
        destination = "contract_failed_queue"
        LOGGER.exception("Capture failed; preserving task in failed queue")
    else:
        destination = "vlm_processing_queue"
    with queue.pipeline(transaction=True) as transaction:
        transaction.lpush(destination, json.dumps(payload))
        transaction.lrem(processing_key, 1, raw)
        transaction.execute()
    return True


def main():
    parser = argparse.ArgumentParser(description="Single-URL procurement snapshot worker; requires authenticated Chrome CDP")
    parser.add_argument("--broker-url", default=os.environ.get("BROKER_URL", "redis://127.0.0.1:16379/0"))
    parser.add_argument("--cdp-url", default="http://127.0.0.1:9222")
    parser.add_argument("--storage-dir", type=Path, default=ROOT / "storage" / "snapshots")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--check", action="store_true", help="Check Redis and CDP without consuming jobs")
    args = parser.parse_args()
    from redis import Redis
    from playwright.sync_api import sync_playwright
    queue = Redis.from_url(args.broker_url, decode_responses=True, socket_connect_timeout=3, socket_timeout=10)
    queue.ping()
    processing_key = f"contract_processing:{socket.gethostname()}"
    if queue.llen(processing_key):
        raise RuntimeError(f"Unfinished jobs in {processing_key}; inspect and explicitly requeue before starting")
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(args.cdp_url, timeout=10000)
        if not browser.contexts:
            raise RuntimeError("Chrome has no existing browser context")
        if args.check:
            print("Redis and Chrome CDP ready; no jobs consumed")
            return
        page = browser.contexts[0].new_page()
        try:
            while True:
                process_one(queue, page, args.storage_dir, processing_key)
                if args.once:
                    break
        finally:
            page.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        main()
    except KeyboardInterrupt:
        LOGGER.info("Worker stopped; any unfinished claim remains in processing queue")