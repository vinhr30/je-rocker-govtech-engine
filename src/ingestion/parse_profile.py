import os
import json
from pathlib import Path
import requests

def _resolve_path(target_path):
    if os.path.exists(target_path):
        return target_path
    if target_path.startswith("/Volumes/DataDrive") and os.path.exists("/Volumes/Data Drive"):
        return target_path.replace("/Volumes/DataDrive", "/Volumes/Data Drive", 1)
    if target_path.startswith("/Volumes/Data Drive") and os.path.exists("/Volumes/DataDrive"):
        return target_path.replace("/Volumes/Data Drive", "/Volumes/DataDrive", 1)
    return target_path

# Shared drive paths
TRANSCRIPT_DIR = os.environ.get("TRANSCRIPT_DIR", _resolve_path("/Volumes/Data Drive/neural_engine/matchmaker/02_transcripts"))
DOSSIER_DIR = os.environ.get("DOSSIER_DIR", _resolve_path("/Volumes/Data Drive/neural_engine/matchmaker/03_dossiers"))

# Assuming you are running a local LLM server endpoint on your cluster (e.g., Ollama on port 11434)
LOCAL_LLM_URL = os.environ.get("LOCAL_LLM_URL", "http://localhost:11434/api/generate")

def get_default_model(preferred=None):
    if preferred:
        return preferred
    env_model = os.environ.get("MODEL_NAME")
    if env_model:
        return env_model
    try:
        tags_url = LOCAL_LLM_URL.rsplit("/", 1)[0] + "/tags"
        resp = requests.get(tags_url, timeout=3)
        if resp.ok:
            available = [m.get("name") for m in resp.json().get("models", [])]
            for candidate in ["llama3:8b", "llama3", "llama3.2:latest", "llama3.2"]:
                if candidate in available:
                    return candidate
            if available:
                return available[0]
    except Exception:
        pass
    return "llama3"

MODEL_NAME = get_default_model()

EXTRACTION_PROMPT_TEMPLATE = """
You are an expert psychometric profiling assistant for an elite, high-end executive matchmaking platform. 
Your task is to analyze the following raw interview transcript and extract a structured, highly accurate JSON profile of the client.

Rules:
1. Output ONLY valid JSON. Do not include markdown blocks, preamble, or conversational notes.
2. If a specific field is not explicitly mentioned or cannot be confidently inferred, set its value to null.
3. Be objective. Extract explicit traits and synthesize core lifestyle markers from how they describe their routines.

Transcript:
\"\"\"{transcript_text}\"\"\"

Output your analysis in this exact JSON structure:
{{
    "demographics": {{
        "gender": "string (male/female/null)",
        "age": "integer or null",
        "location_city": "string or null",
        "location_state": "string or null"
    }},
    "filters": {{
        "target_genders": ["string"],
        "age_range": {{
            "min": "integer or null",
            "max": "integer or null"
        }},
        "max_distance_miles": "integer or null",
        "relationship_goal": "string (e.g., marriage, long-term, null)"
    }},
    "qualitative_traits": {{
        "core_values_summary": "string describing their top moral, familial, or personal philosophies",
        "lifestyle_pacing": "string describing their energy level, career dedication, and daily habits",
        "communication_style": "string detailing how they express emotional needs and resolve stress"
    }}
}}
"""

def parse_transcript_to_json(transcript_path, model_name=None):
    active_model = model_name or MODEL_NAME
    print(f"[Parsing Transcript]: {transcript_path.name} (Model: {active_model})")
    
    with open(transcript_path, "r", encoding="utf-8") as f:
        transcript_text = f.read()

    # Formulate the local endpoint request payload
    payload = {
        "model": active_model,
        "prompt": EXTRACTION_PROMPT_TEMPLATE.format(transcript_text=transcript_text),
        "stream": False,
        "format": "json" # Forces models like Ollama to strictly reply in valid JSON schemas
    }

    try:
        response = requests.post(LOCAL_LLM_URL, json=payload, timeout=90)
        # If the requested model is not found, fallback to llama3.2:latest or llama3:8b
        if response.status_code == 404 and active_model != "llama3.2:latest":
            fallback_model = "llama3.2:latest"
            payload["model"] = fallback_model
            response = requests.post(LOCAL_LLM_URL, json=payload, timeout=90)
        response.raise_for_status()
        
        # Parse output from the local API wrapper layer
        response_json = response.json()
        raw_ai_response = response_json.get("response", "{}")
        
        # Validate that the string response is structurally sound JSON
        structured_data = json.loads(raw_ai_response)
        
        # Write clean data package back to the Data Drive partition
        output_filename = transcript_path.name.replace("_transcript.txt", "_profile.json")
        output_path = Path(DOSSIER_DIR) / output_filename
        
        os.makedirs(DOSSIER_DIR, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as out_f:
            json.dump(structured_data, out_f, indent=4)
            
        print(f"[Success]: Profile extracted and saved to 03_dossiers/{output_filename}")
        return structured_data
        
    except Exception as e:
        print(f"[Error]: Failed to process local LLM extraction for {transcript_path.name}. Detail: {e}")
        return None

if __name__ == "__main__":
    # Scan folder for raw text files that haven't been compiled into dossiers yet
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    os.makedirs(DOSSIER_DIR, exist_ok=True)
    transcripts = sorted(Path(TRANSCRIPT_DIR).glob("*_transcript.txt"))
    if not transcripts:
        print(f"[Info]: No *_transcript.txt files found in {TRANSCRIPT_DIR}")
    for t_file in transcripts:
        expected_json = Path(DOSSIER_DIR) / t_file.name.replace("_transcript.txt", "_profile.json")
        if not expected_json.exists():
            parse_transcript_to_json(t_file)
        else:
            print(f"[Skipping]: Profile already exists for {t_file.name}")
