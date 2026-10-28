"""CPU-only deployment preparation. Pin, verify and publish both offline snapshots."""
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from catalogue import CATALOGUE_SHA256, MODELS, MAX_FILE_BYTES, MAX_MODEL_BYTES, allowed_file

PREFIX = "huggingface/" + CATALOGUE_SHA256
HEX256 = re.compile(r"^[a-f0-9]{64}$")

def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

def publish_json(bucket, name, value):
    payload = encode(value)
    blob = bucket.blob(name)
    existing = bucket.get_blob(name)
    if existing:
        if existing.download_as_bytes() != payload:
            raise ValueError("Immutable cache metadata differs")
        return
    blob.metadata = {"sha256": hashlib.sha256(payload).hexdigest()}
    blob.cache_control = "private, max-age=31536000, immutable"
    blob.upload_from_string(payload, content_type="application/json", if_generation_match=0, checksum="crc32c")

def cached_ready(bucket):
    blob = bucket.get_blob(PREFIX + "/READY.json")
    if not blob:
        return None
    if blob.size > 2 * 1024 * 1024:
        raise ValueError("Cache marker exceeds its limit")
    marker = json.loads(blob.download_as_bytes())
    if marker.get("version") != 1 or marker.get("catalogue_sha256") != CATALOGUE_SHA256 or set(marker.get("models", {})) != set(MODELS):
        raise ValueError("Cache marker mismatch")
    for model_id, model in MODELS.items():
        snapshot = marker["models"][model_id]
        files = snapshot.get("files", [])
        if snapshot.get("revision") != model["revision"] or not 1 <= len(files) <= 500:
            raise ValueError("Invalid snapshot")
        for item in files:
            if not allowed_file(item["path"]) or not HEX256.fullmatch(item["sha256"]) or not 0 < item["size"] <= MAX_FILE_BYTES:
                raise ValueError("Invalid cache file")
            stored = bucket.get_blob(f"{PREFIX}/{model_id}/{item['path']}")
            if not stored or stored.size != item["size"] or (stored.metadata or {}).get("sha256") != item["sha256"]:
                raise ValueError("Incomplete or replaced cache object")
    return marker

def prepare_cache(bucket, api, download):
    existing = cached_ready(bucket)
    if existing:
        return existing
    snapshots = {}
    # One shard at a time bounds temporary RAM-backed disk usage in Cloud Run Jobs.
    for model_id, model in MODELS.items():
        info = api.model_info(model["repository"], revision=model["revision"], files_metadata=True)
        if info.sha != model["revision"] or info.gated:
            raise ValueError("Model revision unavailable or unexpectedly gated")
        files = sorted((entry for entry in info.siblings if allowed_file(entry.rfilename)), key=lambda entry: entry.rfilename)
        if not 1 <= len(files) <= 500 or sum(entry.size or 0 for entry in files) > MAX_MODEL_BYTES:
            raise ValueError("Model snapshot exceeds cache limits")
        if not any(entry.rfilename == "model_index.json" for entry in files) or not any(entry.rfilename.endswith(".safetensors") for entry in files):
            raise ValueError("Diffusers snapshot incomplete")
        records = []
        for entry in files:
            if type(entry.size) is not int or not 0 < entry.size <= MAX_FILE_BYTES:
                raise ValueError("Invalid Hub file size")
            lfs = entry.lfs
            upstream_hash = lfs.sha256 if lfs else entry.blob_id
            if not isinstance(upstream_hash, str) or not re.fullmatch(r"[a-f0-9]{64}" if lfs else r"[a-f0-9]{40}", upstream_hash):
                raise ValueError("Missing Hub content hash")
            name = f"{PREFIX}/{model_id}/{entry.rfilename}"
            stored = bucket.get_blob(name)
            metadata = (stored.metadata or {}) if stored else {}
            if stored:
                if stored.size != entry.size or metadata.get("upstream_hash") != upstream_hash or not HEX256.fullmatch(metadata.get("sha256", "")):
                    raise ValueError("Immutable cache object differs")
                digest = metadata["sha256"]
            else:
                with tempfile.TemporaryDirectory(prefix="hf-shard-") as temporary:
                    path = Path(download(repo_id=model["repository"], filename=entry.rfilename, revision=model["revision"], local_dir=temporary, token=False))
                    if path.stat().st_size != entry.size:
                        raise ValueError("Hub file size mismatch")
                    sha256 = hashlib.sha256()
                    git_sha = hashlib.sha1(f"blob {entry.size}\0".encode())
                    with path.open("rb") as source:
                        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
                            sha256.update(chunk)
                            git_sha.update(chunk)
                    digest = sha256.hexdigest()
                    if (digest if lfs else git_sha.hexdigest()) != upstream_hash:
                        raise ValueError("Hub content hash mismatch")
                    blob = bucket.blob(name)
                    blob.chunk_size = 8 * 1024 * 1024
                    blob.metadata = {"sha256": digest, "upstream_hash": upstream_hash, "revision": model["revision"]}
                    blob.cache_control = "private, max-age=31536000, immutable"
                    blob.upload_from_filename(str(path), if_generation_match=0, checksum="crc32c")
            records.append({"path": entry.rfilename, "size": entry.size, "sha256": digest})
        snapshots[model_id] = {"revision": model["revision"], "files": records}
    marker = {"version": 1, "catalogue_sha256": CATALOGUE_SHA256, "models": snapshots}
    # No inference service mounts this prefix until every file has been verified.
    publish_json(bucket, PREFIX + "/READY.json", marker)
    return marker

def main():
    from google.cloud import storage
    from huggingface_hub import HfApi, hf_hub_download
    bucket_name = os.environ["CACHE_BUCKET"]
    if os.environ.get("HF_MODEL_CATALOGUE_SHA256") != CATALOGUE_SHA256:
        raise ValueError("Catalogue pin mismatch")
    prepare_cache(storage.Client().bucket(bucket_name), HfApi(token=False), hf_hub_download)
    print("Hugging Face model cache verified: " + CATALOGUE_SHA256)

if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Avoid Hub signed download URLs, credentials or provider error bodies in logs.
        print("HF_CACHE_PREPARATION_FAILED: inspect cache configuration and rerun the preparation job.")
        raise SystemExit(1)
