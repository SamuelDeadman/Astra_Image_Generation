"""Private Linux/CUDA Diffusers API. Cloud Run IAM authenticates its sole caller."""
import asyncio
import concurrent.futures
import gc
import io
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from catalogue import CATALOGUE_SHA256, MODELS, ready_cache, validate_request

MAX_BODY_BYTES = 96 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024

class PipelineManager:
    """Exactly one pipeline resident per instance, with CPU offload for 24GB L4."""
    def __init__(self, root):
        self.root = Path(root)
        self.current_id = None
        self.pipeline = None

    def generate(self, data, cancelled, deadline):
        import torch
        from diffusers import Flux2KleinPipeline, ZImagePipeline

        def check():
            if cancelled.is_set() or time.monotonic() >= deadline:
                raise TimeoutError("HF_REQUEST_CANCELLED")

        def step_end(_pipe, _step, _timestep, kwargs):
            check()
            return kwargs

        model = validate_request(data)
        check()
        if not torch.cuda.is_available():
            raise RuntimeError("HF_CUDA_REQUIRED")
        if self.current_id != model["id"]:
            self.pipeline = None
            self.current_id = None
            gc.collect()
            torch.cuda.empty_cache()
            pipeline_class = {"ZImagePipeline": ZImagePipeline, "Flux2KleinPipeline": Flux2KleinPipeline}[model["pipeline"]]
            snapshot = self.root / model["id"]
            # No Hub calls, arbitrary code, pickle weights, runtime adapters or user repositories.
            pipeline = pipeline_class.from_pretrained(str(snapshot), torch_dtype=torch.bfloat16, local_files_only=True, use_safetensors=True)
            pipeline.enable_model_cpu_offload()
            pipeline.vae.enable_tiling()
            pipeline.set_progress_bar_config(disable=True)
            check()
            self.pipeline = pipeline
            self.current_id = model["id"]
        try:
            check()
            with torch.inference_mode():
                image = self.pipeline(prompt=data["prompt"].strip(), width=1024, height=1024,
                    num_inference_steps=model["steps"], guidance_scale=model["guidance"],
                    callback_on_step_end=step_end).images[0]
            check()
            if image.size != (1024, 1024):
                raise RuntimeError("HF_OUTPUT_INVALID")
            output = io.BytesIO()
            image.save(output, format="PNG")
            if output.tell() > MAX_IMAGE_BYTES:
                raise RuntimeError("HF_OUTPUT_TOO_LARGE")
            return output.getvalue()
        except Exception:
            # An interrupted offload hook may leave weights on CUDA; discard before retry.
            self.pipeline = None
            self.current_id = None
            gc.collect()
            torch.cuda.empty_cache()
            raise

def create_app(manager=None):
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, Response

    # Tokenizer truncation warnings may contain the original prompt text.
    for library in ("diffusers", "transformers", "huggingface_hub"):
        logging.getLogger(library).setLevel(logging.ERROR)
    root = os.environ.get("MODEL_CACHE_ROOT", "/models")
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    busy = threading.Lock()
    runtime = manager or PipelineManager(root)
    @asynccontextmanager
    async def lifespan(_app):
        ready_cache(root)
        # Import before accepting traffic, but defer expensive model loading to the request.
        import torch
        from diffusers import Flux2KleinPipeline, ZImagePipeline  # noqa: F401
        if not torch.cuda.is_available():
            raise RuntimeError("HF_CUDA_REQUIRED")
        yield
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    @app.get("/healthz")
    async def health():
        return {"status": "ready", "catalogue_sha256": CATALOGUE_SHA256}

    # Avoid postponed annotation evaluation: FastAPI needs the concrete Request type.
    async def generate(request):
        cancelled = threading.Event()
        future = None
        if not busy.acquire(blocking=False):
            return JSONResponse({"error": "HF_BUSY"}, status_code=429)
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_BODY_BYTES:
                    return JSONResponse({"error": "HF_INPUT_TOO_LARGE"}, status_code=413)
            try:
                data = json.loads(body)
                model = validate_request(data)
            except (ValueError, TypeError, KeyError):
                return JSONResponse({"error": "HF_INPUT_INVALID"}, status_code=422)
            deadline = time.monotonic() + data["timeout_seconds"]
            future = executor.submit(runtime.generate, data, cancelled, deadline)
            # Keep health checks responsive while Torch runs; stop diffusion on disconnect.
            while not future.done():
                if await request.is_disconnected() or time.monotonic() >= deadline:
                    cancelled.set()
                await asyncio.sleep(0.1)
            result = future.result()
            if cancelled.is_set():
                return JSONResponse({"error": "HF_REQUEST_CANCELLED"}, status_code=504)
            return Response(result, media_type="image/png", headers={"X-Model-Id": model["id"], "X-Model-Revision": model["revision"], "X-Model-Catalogue-Sha256": CATALOGUE_SHA256, "Cache-Control": "no-store"})
        except asyncio.CancelledError:
            cancelled.set()
            raise
        except Exception:
            # Do not log prompts, request bodies, repository tokens or raw provider errors.
            logging.error("HF_INFERENCE_FAILED")
            return JSONResponse({"error": "HF_INFERENCE_FAILED"}, status_code=503)
        finally:
            cancelled.set()
            if future is not None and not future.done():
                # Never admit another model while a cancelled CUDA invocation is still running.
                future.add_done_callback(lambda _result: busy.release())
            else:
                busy.release()

    generate.__annotations__["request"] = Request
    app.add_api_route("/v1/images/generations", generate, methods=["POST"])
    return app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), workers=1, access_log=False)
