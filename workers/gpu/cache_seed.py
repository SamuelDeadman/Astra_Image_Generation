"""Prepare an immutable Ollama model snapshot in private GCS; no inference/GPU needed."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

LOCK = json.loads(Path(__file__).with_name("model-lock.json").read_text())
REGISTRY = "https://registry.ollama.ai/v2/" + LOCK["repository"]
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_BLOB_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024 * 1024
MANIFEST_PATH = "manifests/registry.ollama.ai/x/flux2-klein/4b-fp8"


class CacheError(Exception):
    """Safe operator-visible failure, containing no signed URLs or credentials."""


class RegistryRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        host = target.hostname or ""
        if (target.scheme != "https" or target.username or target.password
                or target.port not in (None, 443)
                or not any(host == domain or host.endswith("." + domain)
                           for domain in ("ollama.ai", "ollama.com", "cloudflarestorage.com"))):
            raise CacheError("Registry redirected to an unapproved download origin.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(path):
    # The only upstream input is an already validated digest or the code-owned tag.
    return build_opener(RegistryRedirects()).open(Request(REGISTRY + path, headers={
        "Accept": "application/vnd.docker.distribution.manifest.v2+json",
        "User-Agent": "AstraFlow-Model-Cache/1"
    }), timeout=60)


def digest_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def parse_manifest(raw, expected_digest):
    if len(raw) > MAX_MANIFEST_BYTES or digest_bytes(raw) != expected_digest:
        raise CacheError("Registry manifest does not match the reviewed model digest.")
    try:
        manifest = json.loads(raw)
        if manifest["schemaVersion"] != 2 or manifest.get("manifests"):
            raise ValueError()
        layers = [manifest["config"], *manifest["layers"]]
        if not 1 <= len(layers) <= 10000:
            raise ValueError()
        unique = {}
        for layer in layers:
            digest, size = layer["digest"], layer["size"]
            if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
                raise ValueError()
            if type(size) is not int or not 0 < size <= MAX_BLOB_BYTES:
                raise ValueError()
            if digest in unique and unique[digest] != size:
                raise ValueError()
            unique[digest] = size
        if sum(unique.values()) > MAX_TOTAL_BYTES:
            raise ValueError()
        return unique
    except (ValueError, TypeError, KeyError):
        raise CacheError("Registry manifest has invalid or excessive blob descriptors.") from None


def matches(blob, digest, size):
    try:
        blob.reload()
    except Exception as error:
        if getattr(error, "code", None) == 404:
            return False
        raise
    return blob.size == size and (blob.metadata or {}).get("sha256") == digest


def immutable_upload(blob, digest, size, upload):
    if matches(blob, digest, size):
        return
    blob.metadata = {"sha256": digest, "model": LOCK["model"]}
    blob.chunk_size = 8 * 1024 * 1024
    blob.cache_control = "private, max-age=31536000, immutable"
    try:
        upload()  # Always uses if_generation_match=0: no overwrite, even under concurrent jobs.
    except Exception:
        if matches(blob, digest, size):
            return
        raise CacheError("Cache upload failed or an existing immutable object differs.") from None


def prepare_cache(bucket, expected_digest, prefix, upstream=fetch, workers=4):
    if expected_digest != LOCK["manifest_digest"] or not DIGEST.fullmatch(expected_digest):
        raise CacheError("Only the reviewed FLUX.2 Klein 4B FP8 snapshot may be prepared.")
    if prefix != "ollama/" + expected_digest.replace(":", "-"):
        raise CacheError("Cache prefix must be derived from the reviewed digest.")
    # A verified manifest in GCS lets repeat runs resume without any upstream requests.
    manifest_blob = bucket.blob(prefix + "/" + MANIFEST_PATH)
    try:
        manifest_blob.reload()
        if manifest_blob.size > MAX_MANIFEST_BYTES:
            raise CacheError("Cached manifest is oversized.")
        raw = manifest_blob.download_as_bytes(if_generation_match=manifest_blob.generation)
    except Exception as error:
        if getattr(error, "code", None) != 404:
            raise
        with upstream("/manifests/" + LOCK["tag"]) as response:
            raw = response.read(MAX_MANIFEST_BYTES + 1)
    blobs = parse_manifest(raw, expected_digest)

    def prepare_blob(entry):
        digest, size = entry
        blob = bucket.blob(prefix + "/blobs/" + digest.replace(":", "-"))
        if matches(blob, digest, size):
            return
        # At most four bounded files at a time; large weights never accumulate on job disk.
        for attempt in range(3):
            try:
                with tempfile.TemporaryFile() as local:
                    actual = hashlib.sha256()
                    total = 0
                    with upstream("/blobs/" + digest) as response:
                        while True:
                            chunk = response.read(min(1024 * 1024, size - total + 1))
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > size:
                                raise CacheError("Registry blob exceeds its pinned size.")
                            actual.update(chunk)
                            local.write(chunk)
                    if total != size or "sha256:" + actual.hexdigest() != digest:
                        raise CacheError("Registry blob checksum or size mismatch.")
                    local.seek(0)
                    immutable_upload(blob, digest, size, lambda: blob.upload_from_file(
                        local, size=size, rewind=True, if_generation_match=0, checksum="crc32c", timeout=600))
                return
            except CacheError:
                raise
            except Exception:
                if attempt == 2:
                    raise CacheError("Model transfer failed after bounded retries; rerun to resume.") from None
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(prepare_blob, blobs.items()))
    # Publish the Ollama manifest and completion marker only after every blob is verified.
    immutable_upload(manifest_blob, expected_digest, len(raw), lambda: manifest_blob.upload_from_string(
        raw, if_generation_match=0, content_type="application/json", checksum="crc32c"))
    marker = json.dumps({"version": 1, "model": LOCK["model"], "manifest_digest": expected_digest,
                         "blob_count": len(blobs), "total_bytes": sum(blobs.values())}, sort_keys=True).encode()
    ready = bucket.blob(prefix + "/READY.json")
    immutable_upload(ready, digest_bytes(marker), len(marker), lambda: ready.upload_from_string(
        marker, if_generation_match=0, content_type="application/json", checksum="crc32c"))
    return json.loads(marker)


def main():
    from google.cloud import storage
    bucket = storage.Client().bucket(os.environ["CACHE_BUCKET"])
    result = prepare_cache(bucket, os.environ["MODEL_DIGEST"], os.environ["CACHE_PREFIX"])
    print(json.dumps({"status": "ready", **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, CacheError) else "Model-cache preparation failed; review IAM/connectivity and rerun to resume.", flush=True)
        raise SystemExit(1) from None
