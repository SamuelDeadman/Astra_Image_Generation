"""Offline contracts for immutable cache and the actual GPU request handler."""
import asyncio
import hashlib
import importlib
import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers/huggingface"))
catalogue = importlib.import_module("catalogue")
seed = importlib.import_module("cache_seed")
server = importlib.import_module("server")

class Blob:
    def __init__(self, bucket, name):
        self.bucket, self.name, self.metadata = bucket, name, {}
        self.data = b""
        self.size = 0

    def upload_from_string(self, data, **kwargs):
        if kwargs.get("if_generation_match") != 0 or self.name in self.bucket.objects:
            raise ValueError("Overwrite denied")
        self.data = data
        self.size = len(data)
        self.bucket.objects[self.name] = self

    def upload_from_filename(self, name, **kwargs):
        self.upload_from_string(Path(name).read_bytes(), **kwargs)

    def download_as_bytes(self):
        return self.data

class Bucket:
    def __init__(self):
        self.objects = {}

    def get_blob(self, name):
        return self.objects.get(name)

    def blob(self, name):
        return Blob(self, name)

class Hub:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.corrupt = False
        self.data = {"model_index.json": b'{"_class_name":"ReviewedPipeline"}', "transformer/model.safetensors": b"test-only-safetensors", "tokenizer/tokenizer.json": b"{}"}

    def model_info(self, repository, revision, files_metadata):
        self.calls.append(repository)
        entries = []
        for name, data in self.data.items():
            lfs = types.SimpleNamespace(sha256=hashlib.sha256(data).hexdigest()) if name.endswith(".safetensors") else None
            entries.append(types.SimpleNamespace(rfilename=name, size=len(data), lfs=lfs, blob_id=hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()))
        # Explicitly excluded: executable code, pickle weights and traversal paths.
        for name in ["handler.py", "transformer/model.bin", "../escape.json", "assets/image.png"]:
            entries.append(types.SimpleNamespace(rfilename=name, size=1))
        return types.SimpleNamespace(sha=revision, gated=False, siblings=entries)

    def download(self, repo_id, filename, revision, local_dir, token):
        if filename == self.fail:
            raise ConnectionError("test-only failure")
        assert token is False
        path = Path(local_dir) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.data[filename]
        path.write_bytes(b"X" * len(data) if self.corrupt else data)
        return path

def request_data(model_id=None):
    model = catalogue.MODELS[model_id or next(iter(catalogue.MODELS))]
    return {"model": model["id"], "revision": model["revision"], "catalogue_sha256": catalogue.CATALOGUE_SHA256, "prompt": "A ceramic cup in studio lighting", "width": 1024, "height": 1024, "timeout_seconds": 10}

class CacheTests(unittest.TestCase):
    def test_exact_catalogue_and_request_allowlist(self):
        self.assertEqual(catalogue.CATALOGUE_SHA256, "8e6d29fa26321aaf9232249d77e5b13847e453e88cf3c6781bea9bd9272cb6fc")
        self.assertGreaterEqual(catalogue.MAX_FILE_BYTES, 9973714824)
        self.assertGreaterEqual(catalogue.MAX_MODEL_BYTES, 32848305533)
        for model_id in catalogue.MODELS:
            self.assertEqual(catalogue.validate_request(request_data(model_id))["id"], model_id)
        for change in [{"model": "other"}, {"revision": "main"}, {"width": 512}, {"width": True}, {"timeout_seconds": True}, {"timeout_seconds": 1801}, {"prompt": ""}, {"prompt": "x" * 20001}, {"url": "https://attacker.example"}]:
            with self.assertRaises(ValueError):
                catalogue.validate_request({**request_data(), **change})

    def test_safe_file_paths_and_formats(self):
        for path in ["../weights.safetensors", "/vae/config.json", "vae/../config.json", "vae\\config.json", "text_encoder/pytorch_model.bin", "handler.py", "tokenizer//vocab.json"]:
            self.assertFalse(catalogue.allowed_file(path), path)
        self.assertTrue(catalogue.allowed_file("text_encoder/model-00001-of-00003.safetensors"))

    def test_cache_downloads_both_exact_commits_then_reuses_without_hub(self):
        bucket, hub = Bucket(), Hub()
        ready = seed.prepare_cache(bucket, hub, hub.download)
        self.assertEqual(set(ready["models"]), set(catalogue.MODELS))
        self.assertEqual(len(bucket.objects), 7)
        self.assertEqual(seed.prepare_cache(bucket, None, None), ready)
        for snapshot in ready["models"].values():
            self.assertEqual(len(snapshot["files"]), 3)
        self.assertEqual(len(hub.calls), 2)

    def test_failed_download_leaves_no_ready_marker_and_retry_resumes(self):
        bucket, hub = Bucket(), Hub()
        hub.fail = "transformer/model.safetensors"
        with self.assertRaises(ConnectionError):
            seed.prepare_cache(bucket, hub, hub.download)
        self.assertIsNone(bucket.get_blob(seed.PREFIX + "/READY.json"))
        count = len(bucket.objects)
        self.assertGreater(count, 0)
        hub.fail = None
        seed.prepare_cache(bucket, hub, hub.download)
        self.assertEqual(len(bucket.objects), 7)

    def test_upstream_hash_mismatch_never_publishes(self):
        bucket, hub = Bucket(), Hub()
        hub.corrupt = True
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            seed.prepare_cache(bucket, hub, hub.download)
        self.assertEqual(bucket.objects, {})

    def test_cache_metadata_tampering_or_missing_object_fails_closed(self):
        bucket, hub = Bucket(), Hub()
        seed.prepare_cache(bucket, hub, hub.download)
        name = next(name for name in bucket.objects if name.endswith(".safetensors"))
        blob = bucket.objects[name]
        blob.metadata["sha256"] = "invalid"
        with self.assertRaises(ValueError):
            seed.prepare_cache(bucket, None, None)
        del bucket.objects[name]
        with self.assertRaises(ValueError):
            seed.prepare_cache(bucket, None, None)

    def test_runtime_checks_snapshot_files_configuration_hashes_and_marker(self):
        bucket, hub = Bucket(), Hub()
        seed.prepare_cache(bucket, hub, hub.download)
        with tempfile.TemporaryDirectory() as root:
            for name, blob in bucket.objects.items():
                path = Path(root) / name.removeprefix(seed.PREFIX + "/")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(blob.data)
            catalogue.ready_cache(root)
            path = Path(root) / next(iter(catalogue.MODELS)) / "model_index.json"
            path.write_bytes(b"X" * path.stat().st_size)
            with self.assertRaises(ValueError):
                catalogue.ready_cache(root)

class PipelineTests(unittest.TestCase):
    def test_selected_pipeline_is_offline_bf16_offloaded_and_replaced_on_switch(self):
        loads, generated, offloaded = [], [], []
        class FakePipeline:
            @classmethod
            def from_pretrained(cls, path, **kwargs):
                loads.append((path, kwargs))
                return cls()
            def enable_model_cpu_offload(self):
                offloaded.append(True)
            def set_progress_bar_config(self, **kwargs):
                pass
            vae = types.SimpleNamespace(enable_tiling=lambda: None)
            def __call__(self, **kwargs):
                generated.append(kwargs)
                kwargs["callback_on_step_end"](self, 0, 0, {})
                image = types.SimpleNamespace(size=(1024, 1024), save=lambda output, format: output.write(b"png-test"))
                return types.SimpleNamespace(images=[image])
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None), bfloat16="bf16", inference_mode=lambda: __import__("contextlib").nullcontext())
        with patch.dict(sys.modules, {"torch": torch, "diffusers": types.SimpleNamespace(ZImagePipeline=FakePipeline, Flux2KleinPipeline=FakePipeline)}):
            manager = server.PipelineManager("/models")
            for model_id in [*catalogue.MODELS, list(catalogue.MODELS)[-1]]:
                self.assertEqual(manager.generate(request_data(model_id), threading.Event(), time.monotonic() + 10), b"png-test")
            self.assertEqual(len(loads), 2)
            self.assertEqual(len(offloaded), 2)
            for _, kwargs in loads:
                self.assertEqual(kwargs, {"torch_dtype": "bf16", "local_files_only": True, "use_safetensors": True})
            self.assertEqual([kwargs["num_inference_steps"] for kwargs in generated], [9, 4, 4])
            self.assertEqual([kwargs["guidance_scale"] for kwargs in generated], [0, 1, 1])
            cancelled = threading.Event()
            cancelled.set()
            with self.assertRaises(TimeoutError):
                manager.generate(request_data(), cancelled, time.monotonic() + 10)

class Response:
    def __init__(self, content, status_code=200, **kwargs):
        self.content, self.status_code, self.kwargs = content, status_code, kwargs

class App:
    def __init__(self, **kwargs):
        self.routes = {}
    def get(self, route):
        return lambda handler: handler
    def add_api_route(self, route, handler, methods):
        self.routes[route] = handler

class Request:
    def __init__(self, body, disconnected=False):
        self.body, self.disconnected = body, disconnected
    async def stream(self):
        yield self.body
    async def is_disconnected(self):
        return self.disconnected

class HandlerTests(unittest.IsolatedAsyncioTestCase):
    def handler(self, manager):
        with patch.dict(sys.modules, {"fastapi": types.SimpleNamespace(FastAPI=App, Request=Request), "fastapi.responses": types.SimpleNamespace(JSONResponse=Response, Response=Response)}):
            app = server.create_app(manager)
        return app.routes["/v1/images/generations"]

    async def test_real_handler_validates_contract_and_returns_pins(self):
        seen = []
        manager = types.SimpleNamespace(generate=lambda *args: seen.append(args[0]) or b"png-test")
        handler = self.handler(manager)
        response = await handler(Request(json.dumps(request_data()).encode()))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.kwargs["headers"]["X-Model-Revision"], request_data()["revision"])
        self.assertEqual(response.kwargs["headers"]["Cache-Control"], "no-store")
        self.assertEqual(len(seen), 1)
        for body, code in [(b"bad-json", 422), (b"x" * (server.MAX_BODY_BYTES + 1), 413), (json.dumps({**request_data(), "repository": "other"}).encode(), 422)]:
            self.assertEqual((await handler(Request(body))).status_code, code)
        self.assertEqual(len(seen), 1)

    async def test_disconnect_stops_work_and_busy_instance_rejects_parallel_request(self):
        started = threading.Event()
        def generate(data, cancelled, deadline):
            started.set()
            while not cancelled.wait(0.01) and time.monotonic() < deadline:
                pass
            return b"png-test"
        handler = self.handler(types.SimpleNamespace(generate=generate))
        first = asyncio.create_task(handler(Request(json.dumps(request_data()).encode(), disconnected=True)))
        while not started.is_set():
            await asyncio.sleep(0.001)
        second = await handler(Request(json.dumps(request_data()).encode()))
        self.assertEqual(second.status_code, 429)
        self.assertEqual((await first).status_code, 504)

if __name__ == "__main__":
    unittest.main()
