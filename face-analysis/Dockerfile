# Cloud Run GPU (NVIDIA L4) service for backend/src/avatar_gen's photo
# analysis step. Deliberately its own Docker-based deploy (unlike backend/'s
# Render-native-Python service) for two reasons: (1) mediapipe's compiled
# bindings need Mesa/GLES system libraries Render's native runtime has no
# apt/root access to install -- owning the base image fixes that outright;
# (2) an actual GPU delegate needs a CUDA runtime matching whatever driver
# Cloud Run's GPU nodes provide.
#
# NOTE: verify this base image's CUDA version against Cloud Run's currently
# documented/supported GPU driver version before deploying -- Google updates
# that pairing over time and this was not verified against a live Cloud Run
# GPU deploy. Cloud Run's forward-compatible driver model generally tolerates
# a CUDA runtime at or below the host driver's supported version; adjust the
# tag below if `gcloud run deploy` rejects it or the GPU delegate can't
# initialize (photo_analysis.py falls back to CPU either way, so this is a
# performance concern, not a correctness one).
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# libgles2 (Mesa's GLESv2, the actual missing `libGLESv2.so.2` from Render's
# environment) + the handful of other shared libs mediapipe's native bindings
# commonly need on a minimal Debian/Ubuntu base (libgomp1 for OpenMP-based
# CPU parallelism, the rest for the image/video decode paths inside
# mediapipe's compiled core) -- this is the entire fix for Bug 1, independent
# of whether the GPU delegate itself ends up working.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3-pip python3.11-venv \
    libgles2 libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY src ./src

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

# Shell form so $PORT (Cloud Run sets this at runtime) actually expands --
# an exec-form CMD would pass the literal string "$PORT" to uvicorn.
CMD uv run uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8080}
