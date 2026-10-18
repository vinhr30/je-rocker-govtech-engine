import os
import json
import random
import hashlib
from pathlib import Path
import requests
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, VectorParams, Distance

def _resolve_path(target_path):
    if os.path.exists(target_path):
        return target_path
    if target_path.startswith("/Volumes/DataDrive") and os.path.exists("/Volumes/Data Drive"):
        return target_path.replace("/Volumes/DataDrive", "/Volumes/Data Drive", 1)
    if target_path.startswith("/Volumes/Data Drive") and os.path.exists("/Volumes/DataDrive"):
        return target_path.replace("/Volumes/Data Drive", "/Volumes/DataDrive", 1)
    return target_path

# Configuration tied to your cluster network mapping
BASE_DIR = Path(_resolve_path("/Volumes/Data Drive/neural_engine/matchmaker"))
DOSSIER_DIR = BASE_DIR / "03_dossiers"
QDRANT_PATH = BASE_DIR / "qdrant_db"

OLLAMA_EMBED_URL = os.environ.get("OLLAMA_EMBED_URL", "http://localhost:11434/api/embeddings")
EMBED_MODEL = "mxbai-embed-large"
QDRANT_HOST = os.environ.get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", 6333))
COLLECTION_NAME = "executive_matches"

# Pool definitions to create realistic matching scenarios in Arizona
CITIES = ["Phoenix", "Scottsdale", "Paradise Valley", "Gilbert", "Chandler"]
VALUES_POOL = [
    "Prioritizes intellectual growth, deep familial loyalty, and absolute open communication in high-pressure environments.",
    "Values emotional independence, structured daily routines, artistic expression, and calm conflict resolution.",
    "Driven by heavy career ambition, shared legacy building, high-fitness pacing, and adventurous world travel.",
    "Focused on quiet privacy, traditional family structures, community impact, and low-stress lifestyle rhythms."
]
LIFESTYLE_POOL = [
    "Disciplined early riser, balances high-stress executive corporate role with endurance athletics and mindful downtime.",
    "Fluid creative schedule, enjoys metropolitan fine dining, gallery openings, and frequent long-distance coastal travel.",
    "Tech founder routine, heavy dedication to professional building, structured calendar, values evening unwinding.",
    "Family-centric pacing, balances boutique real estate investing with outdoor hobbies, hiking, and quiet weekend retreats."
]

def get_qdrant_client():
    # Probe network/daemon Qdrant instances first
    for host in [QDRANT_HOST, "Mac-Mal.local", "192.168.0.163"]:
        try:
            client = QdrantClient(host=host, port=QDRANT_PORT, timeout=1.5)
            client.get_collections()
            return client
        except Exception:
            continue
    # Fallback to embedded disk storage on shared Data Drive
    QDRANT_PATH.mkdir(parents=True, exist_ok=True)
    return QdrantClient(path=str(QDRANT_PATH))

def ensure_collection(q_client):
    try:
        exists = q_client.collection_exists(COLLECTION_NAME)
    except Exception:
        exists = False
        
    if not exists:
        print(f"[Init]: Creating collection '{COLLECTION_NAME}' with multi-vector configuration (1024-dim)...")
        q_client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config={
                "profile_values": VectorParams(size=1024, distance=Distance.COSINE),
                "profile_lifestyle": VectorParams(size=1024, distance=Distance.COSINE),
                "ipp_values": VectorParams(size=1024, distance=Distance.COSINE),
                "ipp_lifestyle": VectorParams(size=1024, distance=Distance.COSINE),
            }
        )

def get_embedding(text):
    payload = {"model": EMBED_MODEL, "prompt": text}
    try:
        res = requests.post(OLLAMA_EMBED_URL, json=payload, timeout=30)
        res.raise_for_status()
        return res.json()["embedding"]
    except Exception as e:
        print(f"Embedding error: {e}")
        return None

def generate_mock_pool(count=10):
    q_client = get_qdrant_client()
    DOSSIER_DIR.mkdir(parents=True, exist_ok=True)
    ensure_collection(q_client)
    
    print(f"[Seeding]: Generating {count} mock executive profiles onto Data Drive...")
    
    for i in range(count):
        gender = "female" if i % 2 == 0 else "male"
        target_gender = ["male"] if gender == "female" else ["female"]
        age = random.randint(30, 52)
        name = f"Executive_Candidate_{100 + i}"
        
        # Pull diverse qualitative traits
        val_text = random.choice(VALUES_POOL)
        life_text = random.choice(LIFESTYLE_POOL)
        
        # Build clean JSON schema matching your parse_profile structure
        profile = {
            "demographics": {
                "gender": gender,
                "age": age,
                "location_city": random.choice(CITIES),
                "location_state": "Arizona"
            },
            "filters": {
                "target_genders": target_gender,
                "age_range": {"min": age - 5, "max": age + 7},
                "max_distance_miles": 50,
                "relationship_goal": "marriage" if i % 3 == 0 else "long-term"
            },
            "qualitative_traits": {
                "core_values_summary": val_text,
                "lifestyle_pacing": life_text,
                "communication_style": "Values calm, direct conversation and proactive problem solving."
            }
        }
        
        # 1. Write the physical document copy to the shared storage disk
        json_path = DOSSIER_DIR / f"{name}_profile.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(profile, f, indent=4)
            
        # 2. Compute vectors via local cluster endpoint
        v_prof_val = get_embedding(val_text)
        v_prof_life = get_embedding(life_text)
        # Use reversed assignments for the partner preference arrays to ensure clear cross-matching targets
        v_ipp_val = get_embedding(random.choice(VALUES_POOL))
        v_ipp_life = get_embedding(random.choice(LIFESTYLE_POOL))
        
        if not all([v_prof_val, v_prof_life, v_ipp_val, v_ipp_life]):
            print(f"[Skip]: Could not compute embeddings for {name}")
            continue
            
        # 3. Formulate the database record payload
        point_id = int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:16], 16)
        payload = {
            "client_filename": name,
            "demographics": profile["demographics"],
            "filters": profile["filters"],
            "qualitative_traits": profile["qualitative_traits"],
            "verification_status": {
                "id_matched": True,
                "background_check_passed": True,
                "status": "pending_verification"
            }
        }
        
        # 4. Upsert vector point directly to local Qdrant
        q_client.upsert(
            collection_name=COLLECTION_NAME,
            points=[
                PointStruct(
                    id=point_id,
                    vector={
                        "profile_values": v_prof_val,
                        "profile_lifestyle": v_prof_life,
                        "ipp_values": v_ipp_val,
                        "ipp_lifestyle": v_ipp_life
                    },
                    payload=payload
                )
            ]
        )
        print(f"  -> Upserted {name} (ID: {point_id})")
    try:
        q_client.close()
    except Exception:
        pass
    print(f"[Success]: Data Drive populated and {count} records active in Qdrant pool.")

if __name__ == "__main__":
    generate_mock_pool()
