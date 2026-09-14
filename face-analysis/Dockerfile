# Cloud Run (CPU) service for backend/src/avatar_gen's photo analysis step.
# Deliberately its own Docker-based deploy (unlike backend/'s Render-native-
# Python service) because mediapipe's compiled bindings need Mesa/EGL/GLES
# system libraries Render's native runtime has no apt/root access to
# install -- owning the base image fixes that outright. Originally deployed
# with an NVIDIA L4 GPU attached; dropped after hitting a GCP GPU-quota wall
# ("no quota for GPUs without zonal redundancy") -- see
# [[project_face_analysis_service]]. CPU-only turned out to need this same
# fix anyway: mediapipe's `Image` construction pulls in its full compiled
# core (GLES *and* EGL) unconditionally, regardless of which delegate
# (CPU/GPU) ends up being used -- there's no smaller dependency set for a
# CPU-only deploy.
FROM ubuntu:22.04

# libgles2 (Mesa's GLESv2, `libGLESv2.so.2` -- the original error on Render)
# + libegl1 (`libEGL.so.1` -- found missing on a first Cloud Run attempt,
# even CPU-only) + libgbm1/libdrm2 (EGL's headless buffer-management chain
# on Linux) + the rest of the shared libs mediapipe's native bindings
# commonly need on a minimal Debian/Ubuntu base (libgomp1 for OpenMP-based
# CPU parallelism, the rest for the image/video decode paths inside
# mediapipe's compiled core). Installed generously in one pass rather than
# discovering each missing .so via a separate failed deploy.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3-pip python3.11-venv \
    libgles2 libegl1 libgl1 libglx-mesa0 libgbm1 libdrm2 \
    libglib2.0-0 libsm6 libxext6 libxrender1 libgomp1 \
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
