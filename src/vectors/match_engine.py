import os
import json
import hashlib
from pathlib import Path
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue, Range

def stable_hash_id(name: str) -> int:
    """Produces a deterministic 64-bit integer ID from a name or filename across processes."""
    cleaned = str(name).replace("_profile.json", "").replace("_profile", "")
    return int(hashlib.sha256(cleaned.encode("utf-8")).hexdigest()[:16], 16)

def _resolve_path(target_path):
    if os.path.exists(target_path):
        return target_path
    if target_path.startswith("/Volumes/DataDrive") and os.path.exists("/Volumes/Data Drive"):
        return target_path.replace("/Volumes/DataDrive", "/Volumes/Data Drive", 1)
    if target_path.startswith("/Volumes/Data Drive") and os.path.exists("/Volumes/DataDrive"):
        return target_path.replace("/Volumes/Data Drive", "/Volumes/DataDrive", 1)
    return target_path

BASE_DIR = Path(_resolve_path("/Volumes/Data Drive/neural_engine/matchmaker"))
QDRANT_PATH = BASE_DIR / "qdrant_db"

QDRANT_HOST = os.environ.get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", 6333))
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "executive_matches")

def get_client():
    # Attempt configured host first, then cluster nodes
    for host in [QDRANT_HOST, "Mac-Mal.local", "192.168.0.163"]:
        try:
            c = QdrantClient(host=host, port=QDRANT_PORT, timeout=1.5)
            c.get_collections()
            return c
        except Exception:
            continue
    # Fallback to shared Data Drive embedded storage
    QDRANT_PATH.mkdir(parents=True, exist_ok=True)
    return QdrantClient(path=str(QDRANT_PATH))

def execute_reciprocal_match(client_id_hash, target_gender, min_age, max_age, city, state):
    """
    Executes a hard-filtered pre-pass in Qdrant, then performs a local 
    two-way reciprocal vector calculation to guarantee mutual compatibility.
    """
    client = get_client()
    try:
        # 1. Retrieve the primary Client's profile vectors out of Qdrant
        try:
            retrieved = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[client_id_hash],
                with_vectors=True
            )
            if not retrieved:
                print(f"[Error]: Could not retrieve client point {client_id_hash}.")
                return []
            client_point = retrieved[0]
        except Exception as e:
            print(f"[Error]: Could not retrieve client point {client_id_hash}. Detail: {e}")
            return []

        client_vectors = client_point.vector
        
        # Extract Client A's vector components
        c_ipp_vals = client_vectors.get("ipp_values") if isinstance(client_vectors, dict) else None
        c_prof_vals = client_vectors.get("profile_values") if isinstance(client_vectors, dict) else None

        if not c_ipp_vals:
            print(f"[Error]: Client {client_id_hash} missing ipp_values vector.")
            return []

        # 2. Query Qdrant with Client A's IPP vectors against Candidate Profiles using Hard Pre-Filters
        query_filter = Filter(
            must=[
                FieldCondition(key="demographics.gender", match=MatchValue(value=target_gender)),
                FieldCondition(key="demographics.location_state", match=MatchValue(value=state)),
                FieldCondition(key="demographics.age", range=Range(gte=min_age, lte=max_age)),
                FieldCondition(key="verification_status.status", match=MatchValue(value="pending_verification"))
            ]
        )

        try:
            if hasattr(client, "query_points"):
                query_res = client.query_points(
                    collection_name=COLLECTION_NAME,
                    query=c_ipp_vals,
                    using="profile_values",
                    query_filter=query_filter,
                    limit=50,
                    with_vectors=True,
                    with_payload=True
                )
                candidate_matches = query_res.points
            else:
                candidate_matches = client.search(
                    collection_name=COLLECTION_NAME,
                    query_vector=("profile_values", c_ipp_vals), # Querying Candidate Profiles with Client IPP
                    query_filter=query_filter,
                    limit=50,
                    with_vectors=True,
                    with_payload=True
                )
        except Exception as e:
            print(f"[Error]: Qdrant search failed for {COLLECTION_NAME}. Detail: {e}")
            return []

        scored_pairings = []

        # 3. Perform the Reciprocal Check (The "Two-Way Street" mathematical confirmation)
        for candidate in candidate_matches:
            # Score 1: How well the Candidate matches the Client's preferences (Cosine Sim out of Qdrant)
            score_client_to_candidate = candidate.score 
            
            # Score 2: How well the Client matches the Candidate's preferences
            cand_vectors = candidate.vector if isinstance(candidate.vector, dict) else {}
            cand_ipp_vals = cand_vectors.get("ipp_values")
            
            # Calculate dot product / cosine similarity locally using a simple python loop to avoid heavy libraries
            # In a normalized vector space (like Qdrant's Cosine setting), dot product equals cosine similarity
            if c_prof_vals and cand_ipp_vals:
                score_candidate_to_client = sum(a * b for a, b in zip(c_prof_vals, cand_ipp_vals))
            else:
                score_candidate_to_client = 0.0
            
            # Combined Multiplicative Mutual Score
            mutual_score = score_client_to_candidate * score_candidate_to_client
            
            payload = candidate.payload or {}
            scored_pairings.append({
                "candidate_id": candidate.id,
                "filename": payload.get("client_filename", "Unknown"),
                "demographics": payload.get("demographics", {}),
                "qualitative": payload.get("qualitative_traits", {}),
                "mutual_score": round(mutual_score, 4)
            })

        # Sort results highest to lowest mutual compatibility score
        return sorted(scored_pairings, key=lambda x: x["mutual_score"], reverse=True)
    finally:
        try:
            client.close()
        except Exception:
            pass
