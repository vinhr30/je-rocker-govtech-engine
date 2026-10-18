import os
import time
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import whisper

# Ensure Homebrew ffmpeg is in PATH for Apple Silicon / Mac Mal
if "/opt/homebrew/bin" not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"/opt/homebrew/bin:{os.environ.get('PATH', '')}"

def _resolve_path(target_path):
    if os.path.exists(target_path):
        return target_path
    if target_path.startswith("/Volumes/DataDrive") and os.path.exists("/Volumes/Data Drive"):
        return target_path.replace("/Volumes/DataDrive", "/Volumes/Data Drive", 1)
    return target_path

# Configuration anchored directly to your shared Data Drive layout
WATCH_DIR = os.environ.get("WATCH_DIR", _resolve_path("/Volumes/DataDrive/neural_engine/matchmaker/01_raw_audio"))
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", _resolve_path("/Volumes/DataDrive/neural_engine/matchmaker/02_transcripts"))
ALLOWED_EXTENSIONS = {'.mp3', '.wav', '.m4a', '.mp4'}

print("Initializing local Whisper model ('base')...")
# Load the transcription model into local memory once upon startup
# Options: 'base', 'small', 'medium' depending on your cluster VRAM headroom
model = whisper.load_model("base")
print("Whisper model loaded successfully. Monitoring pipeline active.")

class AudioFolderHandler(FileSystemEventHandler):
    def on_created(self, event):
        # Ignore directories completely
        if event.is_directory:
            return
        
        file_path = Path(event.src_path)
        
        # Ensure it's a valid audio track and not a system artifact (like hidden .DS_Store files)
        if file_path.suffix.lower() in ALLOWED_EXTENSIONS and not file_path.name.startswith('.'):
            print(f"\n[Detected New Client Intake]: {file_path.name}")
            self.process_audio(file_path)

    def process_audio(self, file_path):
        # Allow the file copy/mount write operation to fully finish buffering before accessing
        time.sleep(2)
        
        output_file_name = f"{file_path.stem}_transcript.txt"
        output_path = Path(OUTPUT_DIR) / output_file_name
        
        # Avoid duplicate processing if the file somehow triggers multiple write events
        if output_path.exists():
            print(f"[Skipping]: Transcript already exists for {file_path.name}")
            return

        print(f"[Processing]: Executing zero-cloud offline transcription loop...")
        start_time = time.time()
        
        try:
            # Run the Whisper decoding step entirely within your local hardware
            result = model.transcribe(str(file_path))
            transcript_text = result["text"]
            
            # Commit the plain text output straight back onto the shared Data Drive
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(transcript_text.strip())
                
            elapsed = time.time() - start_time
            print(f"[Success]: Transcript saved to {output_file_name} (Took {elapsed:.1f}s)")
            
        except Exception as e:
            print(f"[Error]: Failed to process file {file_path.name}. Detail: {e}")

if __name__ == "__main__":
    # Ensure directories exist on the share prior to kicking off the observer loops
    os.makedirs(WATCH_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    event_handler = AudioFolderHandler()
    observer = Observer()
    observer.schedule(event_handler, path=WATCH_DIR, recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping local audio watch pipeline...")
        observer.stop()
    observer.join()
