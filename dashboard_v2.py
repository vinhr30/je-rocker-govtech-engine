import json
import re
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

import redis
import streamlit as st
import streamlit.components.v1 as components


def legacy_workspace(label, routes, key):
    selected = st.selectbox("Workspace", list(routes), key=key)
    address = routes[selected]
    st.link_button(f"Open {label} separately", address, icon=":material/open_in_new:")
    components.iframe(address, height=950, scrolling=True)


def parse_intent(command):
    lowered = command.lower()
    states = {"california": "CA", "arizona": "AZ", "texas": "TX", "florida": "FL", "ohio": "OH", "new york": "NY"}
    return {
        "action": "search" if re.search(r"\b(show|find|search|list)\b", lowered) else "review",
        "query": command.strip(),
        "state": next((code for name, code in states.items() if name in lowered), None),
        "active_only": bool(re.search(r"\bactive\b", lowered)),
        "profile": next((name.title() for name in ("jordan", "nataly") if name in lowered), None),
    }


def broker():
    return redis.Redis(host="127.0.0.1", port=6379, decode_responses=True,
                       socket_connect_timeout=1, socket_timeout=2)


def enqueue(client, payload):
    job = {"id": str(uuid4()), "created_at": datetime.now(timezone.utc).isoformat(),
           "schema_version": 1, **payload}
    client.lpush("contract_queue", json.dumps(job))
    return job["id"]


def switch_page(destination):
    st.session_state.active_page = destination


def main():
    st.set_page_config(page_title="JE ROCKER | Command Center", page_icon=":material/hub:", layout="wide")
    st.session_state.setdefault("active_page", "main_control_room")
    st.markdown("""<style>
    .stApp {background: #f3f6f8; color: #182b32;}
    h1,h2,h3 {letter-spacing: 0 !important;}
    [data-testid="stMetric"] {border-top: 3px solid #16766b; padding: 12px 0;}
    [data-testid="stMetricValue"] {font-size: 20px; white-space: normal;}
    [data-testid="stMetricValue"] > div {white-space: normal; overflow-wrap: anywhere;}
    .stButton>button {border-radius: 6px;}
    </style>""", unsafe_allow_html=True)
    if st.session_state.active_page != "main_control_room":
        render_business_page()
        return
    st.title("JE ROCKER")
    st.subheader("Executive Command Center")
    client = broker()
    try:
        client.ping()
        pending = client.llen("contract_queue")
        online = True
    except redis.RedisError:
        online, pending = False, None

    with st.sidebar:
        st.header("Macklemore")
        st.caption("Central orchestrator · Port 8501")
        if online:
            st.success("Redis online")
        else:
            st.error("Redis unavailable")
        st.button("Refresh", icon=":material/refresh:")
        st.caption("Worker heartbeats and drive telemetry are not connected.")

    columns = st.columns(4)
    for column, label, value in zip(columns,
            ["Broker", "Pending jobs", "Mac Miller", "Mac Mal"],
            ["Online" if online else "Offline", str(pending) if pending is not None else "Unavailable", "Not monitored", "Not monitored"]):
        column.metric(label, value)

    with st.expander("Command Desk", expanded=True):
        with st.form("intent_form"):
            command = st.text_input("Command", placeholder="Show active engineering bids from California matching Jordan's profile")
            parse = st.form_submit_button("Parse command", icon=":material/manage_search:")
        if parse:
            if command.strip():
                st.session_state["intent"] = parse_intent(command)
            else:
                st.warning("Enter a command.")
        if "intent" in st.session_state:
            st.json(st.session_state["intent"])
        st.caption("Typed intent preview only. Voice transcription and search execution are not connected.")

    st.header("Core Portals")
    portals = [
        ("GovTech Scraper Engine", "govtech_page", ":material/account_balance:", "Procurement and capture requests"),
        ("AI Reverse Headhunter", "headhunter_page", ":material/person_search:", "Candidate and placement workflows"),
        ("Executive Matchmaker", "matchmaker_page", ":material/handshake:", "Dossiers and reciprocal matching"),
    ]
    for column, (label, destination, icon, description) in zip(st.columns(3), portals):
        with column:
            st.subheader(label)
            st.caption(description)
            st.button(f"Enter {label}", icon=icon, use_container_width=True,
                      on_click=switch_page, args=(destination,))


def render_business_page():
    st.button("Return to Main Control Room", icon=":material/arrow_back:",
              on_click=switch_page, args=("main_control_room",))
    page = st.session_state.active_page
    if page == "govtech_page":
        st.title("GovTech Scraper Portal")
        client = broker()
        try:
            online = bool(client.ping())
        except redis.RedisError:
            online = False
        legacy_workspace("GovTech", {
            "Primary Dashboard": "http://localhost:3000/primary-dashboard",
            "Client Dashboard": "http://localhost:3000/client-dashboard",
            "Business Driver": "http://localhost:3000/business-driver",
            "Grant Engine": "http://localhost:3000/grant-engine",
            "Grant Neural Engine": "http://localhost:3000/grant-neural-engine",
            "Intelligence Overview": "http://localhost:3000/portfolio/intelligence-overview",
            "Master Portal": "http://localhost:3000/cover",
        }, "govtech_workspace")
        st.header("Procurement Pipeline")
        with st.form("queue"):
            url = st.text_input("Seed URL", "https://sam.gov")
            cap = st.number_input("Maximum SAM search pages", min_value=1, max_value=100, value=3)
            submit = st.form_submit_button("Queue capture request", icon=":material/add_task:", disabled=not online)
        if submit:
            parsed_url = urlparse(url.strip())
            if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname:
                st.error("Enter a valid HTTP or HTTPS URL.")
            else:
                try:
                    job_id = enqueue(client, {"type": "capture", "url": url.strip(), "max_pages": cap,
                                              "intent": st.session_state.get("intent")})
                    st.success(f"Queued request {job_id}")
                except redis.RedisError:
                    st.error("Broker unavailable. Request was not confirmed; check the queue before retrying.")
        st.caption("SAM and supported state portal URLs use DOM-first capture with screenshot evidence. State workflows retain their state parsers; Nevada uses its dedicated Open Bids adapter.")
        with st.form("state_workflow"):
            state = st.selectbox("State workflow", ["AZ", "CA", "TX", "FL", "VA", "NY", "NV"])
            state_pages = st.number_input("Legacy state discovery page limit", min_value=1, max_value=10, value=1)
            state_details = st.number_input("Legacy state detail-record limit", min_value=1, max_value=100, value=10)
            st.caption("Page and detail limits apply only to AZ, CA, TX, FL, VA, and NY. Nevada uses Miller's browser DOM + screenshot capture on the first displayed NEVADAePro Open Bids page; pagination and detail hydration are not yet implemented. Verification prompts are flagged for review. California's original discovery does not support a page cap. Jobs time out after 10 minutes.")
            run_state = st.form_submit_button("Queue state workflow", icon=":material/add_task:", disabled=not online)
        if run_state:
            try:
                job_id = enqueue(client, {"type": "state_workflow", "state": state,
                                          "max_pages": state_pages, "max_details": state_details})
                st.success(f"Queued {state} workflow {job_id}")
            except redis.RedisError:
                st.error("State workflow submission was not confirmed; check the queue before retrying.")
        with st.form("state_dom_capture"):
            dom_state = st.selectbox("DOM-first state snapshot", ["AZ", "CA", "TX", "FL", "VA", "NY", "CO", "ID", "MT", "NM", "OR", "UT", "WA", "WY", "AK", "HI"])
            dom_pages = st.number_input("DOM snapshot page limit", min_value=1, max_value=10, value=3)
            st.caption("Uses visible page controls and waits for results to change before saving each screenshot. Colorado selects 100 rows per page when available. Results require review; detail hydration remains in full state workflows.")
            run_dom_capture = st.form_submit_button("Queue DOM snapshot", icon=":material/photo_camera:", disabled=not online)
        if run_dom_capture:
            try:
                job_id = enqueue(client, {"type": "state_dom_capture", "state": dom_state,
                                          "max_pages": dom_pages})
                st.success(f"Queued {dom_state} DOM snapshot {job_id}")
            except redis.RedisError:
                st.error("DOM snapshot submission was not confirmed; check the queue before retrying.")
        st.subheader("Pending Requests")
        try:
            rows = []
            for raw in client.lrange("contract_queue", 0, 19):
                try:
                    item = json.loads(raw)
                    rows.append(item if isinstance(item, dict) else {"payload": str(item)})
                except (ValueError, TypeError):
                    rows.append({"payload": raw})
            if rows:
                st.dataframe(rows, use_container_width=True)
            else:
                st.caption("No pending requests.")
        except redis.RedisError:
            st.warning("Queue unavailable.")
    elif page == "headhunter_page":
        st.title("AI Reverse Headhunter")
        legacy_workspace("Headhunter", {
            "AI Headhunter": "http://localhost:3000/ai-headhunter",
            "Placement Terminal": "http://localhost:3000/headhunter/match",
        }, "headhunter_workspace")
    elif page == "matchmaker_page":
        st.title("Executive Matchmaker")
        legacy_workspace("Executive Workspace", {
            "Neural Engine": "http://localhost:8502",
        }, "executive_workspace")
    else:
        st.session_state.active_page = "main_control_room"
        st.rerun()


if __name__ == "__main__":
    main()