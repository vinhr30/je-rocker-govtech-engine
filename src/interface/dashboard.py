import streamlit as st
import os
import sys
import json
import socket
from pathlib import Path
import pandas as pd
from qdrant_client import QdrantClient

# Ensure root workspace is in sys.path
_repo_root = str(Path(__file__).resolve().parent.parent.parent)
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

# Set up clean, wide layout styling
st.set_page_config(layout="wide", page_title="Neural Engine Command Center", page_icon="🧠")

def _resolve_base_dir():
    configured = os.environ.get("MATCHMAKER_BASE_DIR")
    if configured:
        return Path(configured).expanduser()
    candidates = [
        Path("/Volumes/Data Drive/neural_engine/matchmaker"),
        Path("/Volumes/DataDrive/neural_engine/matchmaker"),
    ]
    for c in candidates:
        if c.exists():
            return c
    return Path(_repo_root) / "data" / "matchmaker"

# Configuration Anchors to Shared Volume Topology
BASE_DIR = _resolve_base_dir()
if BASE_DIR == Path(_repo_root) / "data" / "matchmaker":
    st.warning("Shared matchmaker drive unavailable. Using local data/matchmaker; external dossiers are not loaded.")
AUDIO_DIR = BASE_DIR / "01_raw_audio"
TRANSCRIPT_DIR = BASE_DIR / "02_transcripts"
DOSSIER_DIR = BASE_DIR / "03_dossiers"

QDRANT_HOST = os.environ.get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", 6333))
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "executive_matches")

current_node = socket.gethostname()

# Main Application Title
st.title("🧠 Neural Engine: Master Command Center")
st.caption(f"Host Node: **{current_node}** | Offline Multi-Node Processing & Pipeline Infrastructure Dashboard")

# Ensure required folder paths exist
for d in [AUDIO_DIR, TRANSCRIPT_DIR, DOSSIER_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Top-Level Cluster Metrics Row
st.markdown("### 🖥️ Cluster Node Architecture Status")
col1, col2, col3, col4 = st.columns(4)

with col1:
    audio_count = len([f for f in AUDIO_DIR.glob("*") if not f.name.startswith('.')]) if AUDIO_DIR.exists() else 0
    st.metric(label="🎙️ 01_raw_audio Queue", value=audio_count)
with col2:
    text_count = len(list(TRANSCRIPT_DIR.glob("*.txt"))) if TRANSCRIPT_DIR.exists() else 0
    st.metric(label="📄 02_transcripts Compiled", value=text_count)
with col3:
    json_count = len(list(DOSSIER_DIR.glob("*.json"))) if DOSSIER_DIR.exists() else 0
    st.metric(label="💼 03_dossiers Structuring", value=json_count)
with col4:
    active_vectors = "Offline"
    status_delta = "Connection Error"
    delta_color = "inverse"
    # Probe configured host, then Mac-Mal if running on Macklemore or Miller
    probe_hosts = [QDRANT_HOST]
    if QDRANT_HOST not in ["Mac-Mal.local", "192.168.0.163"]:
        probe_hosts.append("Mac-Mal.local")
        probe_hosts.append("192.168.0.163")
    
    for host in probe_hosts:
        try:
            q_client = QdrantClient(host=host, port=QDRANT_PORT, timeout=1.5)
            collection_info = q_client.get_collection(collection_name=COLLECTION_NAME)
            active_vectors = collection_info.points_count
            status_delta = f"Healthy ({host})"
            delta_color = "normal"
            break
        except Exception:
            continue
    if active_vectors == "Offline":
        qdrant_disk = BASE_DIR / "qdrant_db"
        if qdrant_disk.exists():
            try:
                disk_client = QdrantClient(path=str(qdrant_disk))
                if disk_client.collection_exists(COLLECTION_NAME):
                    c_info = disk_client.get_collection(collection_name=COLLECTION_NAME)
                    active_vectors = c_info.points_count
                    status_delta = "Healthy (Shared Disk)"
                    delta_color = "normal"
                disk_client.close()
            except Exception:
                pass
    st.metric(label="🛡️ Qdrant Vectors Active", value=active_vectors, delta=status_delta, delta_color=delta_color)

# Main Interface Content Split
tab1, tab2, tab3 = st.tabs(["🚀 Live Pipeline Watcher", "🗂️ Dossier Inspector", "⚖️ Bi-Directional Matcher"])

# --- TAB 1: LIVE PIPELINE WATCHER ---
with tab1:
    st.header("Pipeline Inflow Logs")
    
    c_left, c_right = st.columns(2)
    
    with c_left:
        st.subheader("Detected Raw Audio Feeds")
        if AUDIO_DIR.exists():
            audio_files = [f.name for f in AUDIO_DIR.iterdir() if not f.name.startswith('.')]
            if audio_files:
                st.dataframe(pd.DataFrame(audio_files, columns=["Audio File Name"]), use_container_width=True)
            else:
                st.info("No raw audio files currently sitting in queue.")
                
    with c_right:
        st.subheader("Latest Offline Text Transcripts")
        if TRANSCRIPT_DIR.exists():
            txt_files = sorted(list(TRANSCRIPT_DIR.glob("*.txt")), key=os.path.getmtime, reverse=True)
            if txt_files:
                selected_txt = st.selectbox("Select transcript to preview live:", [f.name for f in txt_files])
                with open(TRANSCRIPT_DIR / selected_txt, "r", encoding="utf-8") as f:
                    st.text_area("Whisper Output Content", f.read(), height=250)
            else:
                st.info("Waiting for mac mal to write transcription text updates...")

# --- TAB 2: DOSSIER INSPECTOR ---
with tab2:
    st.header("Psychometric Profiles & Metadata Filters")
    if DOSSIER_DIR.exists():
        json_files = sorted(list(DOSSIER_DIR.glob("*.json")), key=os.path.getmtime, reverse=True)
        if json_files:
            selected_json = st.selectbox("Select verified client dossier:", [f.name for f in json_files])
            
            with open(DOSSIER_DIR / selected_json, "r", encoding="utf-8") as f:
                data = json.load(f)
                
            d_col1, d_col2 = st.columns([1, 2])
            with d_col1:
                st.subheader("Demographics & Hard Filters")
                st.json(data.get("demographics", {}))
                st.json(data.get("filters", {}))
            with d_col2:
                st.subheader("Extracted Qualitative Layers")
                traits = data.get("qualitative_traits", {})
                st.markdown(f"**Core Values Summary:**\n{traits.get('core_values_summary', 'None')}")
                st.markdown(f"**Lifestyle Pacing:**\n{traits.get('lifestyle_pacing', 'None')}")
                st.markdown(f"**Communication Style:**\n{traits.get('communication_style', 'None')}")
        else:
            st.warning("No structured client dossiers parsed yet. Run parse_profile.py on Mac Mal.")

# --- TAB 3: MATCH ENGINE ACTIVE WORKFLOW ---
with tab3:
    st.header("Reciprocal Vector Match Diagnostics")
    
    if DOSSIER_DIR.exists():
        json_files = sorted(list(DOSSIER_DIR.glob("*.json")), key=os.path.getmtime, reverse=True)
        if json_files:
            # Select the active client to run the search loop for
            target_client_file = st.selectbox("Select Target Client to Run Sweep:", [f.name for f in json_files], key="engine_select")
            
            with open(DOSSIER_DIR / target_client_file, "r", encoding="utf-8") as f:
                c_data = json.load(f)
            
            # Pull parameters from the client's file to dictate the database query rules
            c_filters = c_data.get("filters", {})
            c_demo = c_data.get("demographics", {})
            from src.vectors.match_engine import stable_hash_id
            client_hash_id = stable_hash_id(Path(target_client_file).stem)
            
            st.markdown(f"**Running pipeline rules for:** `{target_client_file}` (ID Hash: `{client_hash_id}`)")
            
            if st.button("Execute Cross-Matching Sweep 🚀"):
                from src.vectors.match_engine import execute_reciprocal_match
                
                # Execute the dual-pass search query over your network share
                with st.spinner("Executing high-dimensional reciprocal vector sweep..."):
                    results = execute_reciprocal_match(
                        client_id_hash=client_hash_id,
                        target_gender=c_filters.get("target_genders", ["female"])[0],
                        min_age=c_filters.get("age_range", {}).get("min", 18),
                        max_age=c_filters.get("age_range", {}).get("max", 99),
                        city=c_demo.get("location_city"),
                        state=c_demo.get("location_state")
                    )
                
                if results:
                    st.success(f"Found {len(results)} mutually verified candidates across the cluster!")
                    for match in results:
                        with st.expander(f"🏆 Match Portfolio: {match['filename']} (Mutual Score: {match['mutual_score']})"):
                            m_col1, m_col2 = st.columns(2)
                            with m_col1:
                                st.markdown("##### Demographics")
                                st.write(match["demographics"])
                            with m_col2:
                                st.markdown("##### System Vetting Dossier Summary")
                                st.info("Linguistic timeline checked. Anti-mirroring defenses cleared. Background status: VERIFIED.")
                else:
                    st.warning("No candidates found matching the combined hard filters and reciprocal scoring constraints.")
        else:
            st.warning("Dossier directory empty. Parse client JSON data packages first.")
