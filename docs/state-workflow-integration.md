# State Workflow Integration

Queue state jobs through the GovTech page on the Streamlit command center.
Supported state codes are AZ, CA, TX, FL, VA, NY, and NV.

The queue worker invokes `scripts/state_workflow.py` in a subprocess, retaining
each state's existing discovery, detail hydration, and normalization functions.
Every job writes a new database under `storage/state-runs`. Canonical databases
under `data` are not modified. Results in `results_registry` require review.

Nevada is routed separately through Miller's existing browser capture worker,
not through the legacy parser subprocess. The NV state option captures the
canonical NEVADAePro Open Bids page with DOM records and a screenshot, then
places the review-required result in `results_registry`. It currently captures
only the first displayed page; pagination and detail hydration are not
implemented. Bid Opening Date is kept distinct from an unverified closing date.

Arizona retains its original listing parser but reads HTML through Miller's open
Chrome CDP session instead of launching new browser contexts. Its discovery reads
are capped by the requested limit. California's original discovery does not expose
a page cap. Other adapters use their existing page-limit parameters.

Empty California or Virginia discovery can retry through shared Chrome using the
original parsers. Missing Arizona, California, or Virginia hydration can also
retry through that session. Browser verification is never bypassed. Challenged
tabs remain open for manual action; retry the job after completing verification.
Repeated reads of a challenged URL are suppressed within the same job.

Selected detail pages receive supplementary PNG and rendered-HTML evidence.
These later browser observations are not guaranteed to be the exact HTML that
produced an earlier successful HTTP parse. `parsed_records.json` and `result.json`
retain the original workflow output and evidence provenance. Evidence failures do
not overwrite successfully parsed records, but are flagged for review.

The generic `state_browser_workflow.py` prototype is not the default queue route.
New legacy-parser states should supply tested state-specific discovery, details,
and normalization modules before being added to the state registry and dashboard.

The DOM-first snapshot selector covers AZ, CA, TX, FL, VA, NY, CO, ID, MT, NM,
OR, UT, WA, WY, AK, and HI. Existing state listing parsers are reused where
available; the additional registry sources use visible table rows and retain
their displayed fields for review. The page limit is configurable; when visible
pagination controls exist, the browser clicks Next or the next numbered page and
waits for the page content to change before saving its screenshot. Colorado
selects 100 rows per page when that native option is present. Florida submits
the portal's visible date search for the current date through 90 days ahead.
Snapshots do not hydrate details. Use the full state workflows when detail
hydration is required.

Queued subprocesses have a 600-second timeout. Page and detail limits are not a
guarantee that every live portal will provide data: authentication, changed pages,
and access challenges remain explicit review outcomes. Automatic VLM dispatch and
canonical database ingestion remain disabled for these jobs.