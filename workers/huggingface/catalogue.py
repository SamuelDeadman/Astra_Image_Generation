"""Shared allowlist and cache contract. No ML or cloud imports at module load."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath

MANIFEST_PATH = Path(__file__).with_name("models.json")
if not MANIFEST_PATH.exists():  # Repository-only unit tests.
    MANIFEST_PATH = Path(__file__).resolve().parents[2] / "src/lib/models/huggingface-models.json"
CATALOGUE = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
CATALOGUE_SHA256 = hashlib.sha256(json.dumps(CATALOGUE, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
MODELS = {model["id"]: model for model in CATALOGUE["models"]}
# Official Z-Image Turbo transformer shards are about 9.97GB each on the Hub.
MAX_FILE_BYTES = 12 * 1024**3
MAX_MODEL_BYTES = 40 * 1024**3

def allowed_file(name):
    path = PurePosixPath(name)
    return (len(name) < 240 and "\\" not in name and not path.is_absolute()
            and all(part not in ("..", ".", "") for part in name.split("/"))
            and (name == "model_index.json" or (len(path.parts) == 2
            and path.parts[0] in {"scheduler", "tokenizer", "tokenizer_2", "text_encoder", "text_encoder_2", "transformer", "vae"}
            and path.suffix in {".json", ".txt", ".safetensors", ".model"})))

def validate_request(data):
    expected = {"model", "revision", "catalogue_sha256", "prompt", "width", "height", "timeout_seconds"}
    if not isinstance(data, dict) or set(data) != expected:
        raise ValueError("HF_INPUT_INVALID")
    model = MODELS.get(data["model"]) if isinstance(data["model"], str) else None
    if not model or data["revision"] != model["revision"] or data["catalogue_sha256"] != CATALOGUE_SHA256:
        raise ValueError("HF_MODEL_PIN_MISMATCH")
    if not isinstance(data["prompt"], str) or not data["prompt"].strip() or len(data["prompt"]) > 20000:
        raise ValueError("HF_INPUT_INVALID")
    if type(data["width"]) is not int or type(data["height"]) is not int or (data["width"], data["height"]) != (1024, 1024):
        raise ValueError("HF_INPUT_INVALID")
    if type(data["timeout_seconds"]) is not int or not 1 <= data["timeout_seconds"] <= 1800:
        raise ValueError("HF_INPUT_INVALID")
    return model

def ready_cache(root):
    marker = Path(root) / "READY.json"
    if marker.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("HF_CACHE_INVALID")
    ready = json.loads(marker.read_text())
    if ready.get("version") != 1 or ready.get("catalogue_sha256") != CATALOGUE_SHA256 or set(ready.get("models", {})) != set(MODELS):
        raise ValueError("HF_CACHE_INVALID")
    for model_id, model in MODELS.items():
        snapshot = ready["models"][model_id]
        files = snapshot.get("files", [])
        names = [item["path"] for item in files]
        if snapshot.get("revision") != model["revision"] or not 1 <= len(files) <= 500 or len(names) != len(set(names)) or "model_index.json" not in names or not any(name.endswith(".safetensors") for name in names) or sum(item["size"] for item in files) > MAX_MODEL_BYTES:
            raise ValueError("HF_CACHE_INVALID")
        for item in files:
            if not allowed_file(item["path"]) or not 0 < item["size"] <= MAX_FILE_BYTES or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                raise ValueError("HF_CACHE_INVALID")
            cached = Path(root) / model_id / item["path"]
            if cached.is_symlink() or cached.stat().st_size != item["size"]:
                raise ValueError("HF_CACHE_INVALID")
            # Validate the small loader configuration before interpreting it. Large
            # safetensors were hashed during preparation and are mounted read-only.
            if not item["path"].endswith(".safetensors") and hashlib.sha256(cached.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError("HF_CACHE_INVALID")
    return ready
