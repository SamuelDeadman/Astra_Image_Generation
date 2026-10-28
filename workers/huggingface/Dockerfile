# Build from the repository root. Supply the reviewed DLC digest in release builds.
ARG HF_DLC_IMAGE=us-docker.pkg.dev/deeplearning-platform-release/gcr.io/huggingface-pytorch-inference-cu121.2-3.transformers.4-48.ubuntu2204.py311:latest
FROM ${HF_DLC_IMAGE}
USER root
WORKDIR /opt/astraflow
RUN apt-get update && apt-get install -y --no-install-recommends python3.11-venv && rm -rf /var/lib/apt/lists/* && python3.11 -m venv /opt/inference
ENV PATH="/opt/inference/bin:${PATH}"
# CUDA wheels provide their own CUDA userspace; the Cloud Run L4 supplies the driver.
RUN pip install --no-cache-dir torch==2.6.0 --index-url https://download.pytorch.org/whl/cu124
COPY workers/huggingface/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && pip check
COPY workers/huggingface/catalogue.py workers/huggingface/server.py ./
COPY src/lib/models/huggingface-models.json ./models.json
RUN useradd --uid 10001 --create-home inference && mkdir -p /tmp/hf && chown inference /tmp/hf
USER 10001
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HOME=/tmp/hf MODEL_CACHE_ROOT=/models TOKENIZERS_PARALLELISM=false
EXPOSE 8080
ENTRYPOINT ["/opt/inference/bin/python", "server.py"]
