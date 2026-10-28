"""Offline cache tests: fake GCS and registry, no Google credentials or model download."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from urllib.request import Request

spec = importlib.util.spec_from_file_location("cache_seed", Path(__file__).parents[1] / "workers/gpu/cache_seed.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class Missing(Exception):
    code = 404


class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket, self.name = bucket, name
        self.metadata, self.size, self.generation = None, None, None

    def reload(self):
        if self.name not in self.bucket.objects:
            raise Missing()
        item = self.bucket.objects[self.name]
        self.metadata, self.size, self.generation = copy.copy(item["metadata"]), len(item["data"]), 1

    def download_as_bytes(self, if_generation_match):
        assert if_generation_match == 1
        return self.bucket.objects[self.name]["data"]

    def upload_from_string(self, data, if_generation_match, checksum, **kwargs):
        assert if_generation_match == 0 and checksum == "crc32c"
        with self.bucket.lock:
            if self.name in self.bucket.objects:
                raise RuntimeError("existing generation may not be overwritten")
            self.bucket.objects[self.name] = {"data": data, "metadata": copy.copy(self.metadata)}
            self.bucket.uploads.append(self.name)

    def upload_from_file(self, file, size, rewind, **kwargs):
        assert rewind
        file.seek(0)
        data = file.read()
        assert len(data) == size
        self.upload_from_string(data, **kwargs)


class FakeBucket:
    def __init__(self):
        self.objects, self.uploads = {}, []
        self.lock = threading.Lock()

    def blob(self, name):
        return FakeBlob(self, name)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.saved_lock = copy.copy(seed.LOCK)
        self.blobs = {seed.digest_bytes(b"config"): b"config", seed.digest_bytes(b"tensor-data"): b"tensor-data"}
        descriptors = [{"digest": digest, "size": len(data), "mediaType": "test"} for digest, data in self.blobs.items()]
        self.raw = json.dumps({"schemaVersion": 2, "config": descriptors[0], "layers": descriptors[1:]}).encode()
        self.digest = seed.digest_bytes(self.raw)
        seed.LOCK["manifest_digest"] = self.digest
        self.prefix = "ollama/" + self.digest.replace(":", "-")
        self.calls, self.bucket = [], FakeBucket()

    def tearDown(self):
        seed.LOCK.clear()
        seed.LOCK.update(self.saved_lock)

    def upstream(self, path):
        self.calls.append(path)
        if path.startswith("/manifests/"):
            return io.BytesIO(self.raw)
        return io.BytesIO(self.blobs[path.removeprefix("/blobs/")])

    def run_cache(self, upstream=None):
        return seed.prepare_cache(self.bucket, self.digest, self.prefix, upstream or self.upstream, workers=1)

    def test_publishes_verified_ollama_layout_then_completion_marker(self):
        marker = self.run_cache()
        self.assertEqual(marker["model"], "x/flux2-klein:4b-fp8")
        self.assertEqual(marker["blob_count"], 2)
        self.assertEqual(self.bucket.uploads[-2:], [self.prefix + "/" + seed.MANIFEST_PATH, self.prefix + "/READY.json"])
        for digest, data in self.blobs.items():
            obj = self.bucket.objects[self.prefix + "/blobs/" + digest.replace(":", "-")]
            self.assertEqual(obj["data"], data)
            self.assertEqual(obj["metadata"]["sha256"], digest)

    def test_repeated_startup_reuses_cache_without_upstream_or_overwrites(self):
        self.run_cache()
        self.calls.clear()
        uploads = list(self.bucket.uploads)
        self.run_cache()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.bucket.uploads, uploads)

    def test_failed_transfer_can_resume_without_redownloading_verified_blobs(self):
        failed = False
        def interrupted(path):
            nonlocal failed
            if path == "/blobs/" + list(self.blobs)[1]:
                failed = True
                raise seed.CacheError("injected interruption")
            return self.upstream(path)
        with self.assertRaises(seed.CacheError):
            self.run_cache(interrupted)
        self.assertTrue(failed)
        self.assertNotIn(self.prefix + "/READY.json", self.bucket.objects)
        self.calls.clear()
        self.run_cache()
        self.assertNotIn("/blobs/" + list(self.blobs)[0], self.calls)

    def test_changed_manifest_never_publishes_any_object(self):
        with self.assertRaises(seed.CacheError):
            self.run_cache(lambda _path: io.BytesIO(b"{}"))
        self.assertEqual(self.bucket.objects, {})

    def test_wrong_checksum_or_oversized_blob_is_never_published(self):
        for corrupt in (b"bad", b"x" * 100):
            def damaged(path):
                return self.upstream(path) if path.startswith("/manifests/") else io.BytesIO(corrupt)
            with self.assertRaises(seed.CacheError):
                self.run_cache(damaged)
            self.assertEqual(self.bucket.objects, {})

    def test_conflicting_existing_snapshot_is_not_overwritten(self):
        name = self.prefix + "/blobs/" + list(self.blobs)[0].replace(":", "-")
        self.bucket.objects[name] = {"data": b"existing", "metadata": {"sha256": "wrong"}}
        original = copy.deepcopy(self.bucket.objects)
        with self.assertRaises(seed.CacheError):
            self.run_cache()
        self.assertEqual(self.bucket.objects[name], original[name])
        self.assertNotIn(self.prefix + "/READY.json", self.bucket.objects)

    def test_path_traversal_excessive_sizes_and_unreviewed_pins_are_rejected(self):
        with self.assertRaises(seed.CacheError):
            seed.prepare_cache(self.bucket, "sha256:" + "f" * 64, self.prefix, self.upstream)
        with self.assertRaises(seed.CacheError):
            seed.prepare_cache(self.bucket, self.digest, "../bad", self.upstream)
        manifest = json.loads(self.raw)
        for layer in ({"digest": "../../bad", "size": 1}, {"digest": list(self.blobs)[0], "size": seed.MAX_BLOB_BYTES + 1}):
            manifest["layers"] = [layer]
            raw = json.dumps(manifest).encode()
            with self.assertRaises(seed.CacheError):
                seed.parse_manifest(raw, seed.digest_bytes(raw))

    def test_redirects_cannot_downgrade_https_or_access_unapproved_hosts(self):
        for target in ("http://registry.ollama.ai/blob", "https://169.254.169.254/", "https://attacker.example/", "https://user:pass@registry.ollama.ai/"):
            with self.assertRaises(seed.CacheError):
                seed.RegistryRedirects().redirect_request(Request(seed.REGISTRY), None, 302, "", {}, target)


if __name__ == "__main__":
    unittest.main()
