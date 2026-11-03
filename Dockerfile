# CLIPFORGE — production image (Phase 13 deployment prep).
#
# STATUS: PREPARED, NOT EXECUTED. Docker is not installed on the
# development machine, so this file has been statically reviewed only
# — no successful `docker build` is claimed. Build it on the target /
# in CI first and treat the first build as a verification step (see
# docs/DEPLOYMENT.md).
#
# Layout: two targets.
#   api — Node 24 + FFmpeg + Python (faster-whisper / tracking) running
#         the COMPILED server (node server/dist/index.js). The repo's
#         own `npm start` uses tsx, a devDependency, so it cannot be
#         used with production-only node_modules — the compiled entry
#         point is used instead.
#   web — Caddy serving the built frontend and reverse-proxying /api
#         to the api service (config supplied by docker-compose).
#
# Base images are pinned to an explicit version tag. They are NOT
# digest-pinned because no registry access was available to resolve
# digests when this file was written; resolve and pin digests
# (docker buildx imagetools inspect) before a real production release
# and record them in the release record (docs/RELEASE_PROCESS.md).

# ---------- Stage 1: frontend build ----------
FROM node:24.22.1-bookworm-slim AS frontend-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
# VITE_API_URL is intentionally NOT set: the production frontend calls
# "/api" same-origin and the reverse proxy routes it (see compose).
RUN npm run build

# ---------- Stage 2: server build ----------
FROM node:24.22.1-bookworm-slim AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---------- Stage 3: api runtime ----------
FROM node:24.22.1-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app/server

# System runtime deps: FFmpeg/FFprobe (media pipeline, invoked from
# PATH — there is no FFMPEG_PATH variable) and Python for the local
# faster-whisper STT worker and the Phase 7 tracking worker.
# Python packages are pinned in server/requirements.txt (versions
# verified on the dev machine, 2026-11-02). The pins were verified on
# x86-64; arm64 wheel availability (the free deployment target is
# ARM — docs/DEPLOYMENT.md) is confirmed on the first build there.
COPY server/requirements.txt ./requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Production dependencies only (dev deps — typescript, tsx, @types —
# are excluded; the server runs from compiled dist/).
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + the Python workers + ONNX models it shells out to.
COPY --from=server-build /build/server/dist ./dist
COPY server/scripts ./scripts
COPY server/models ./models

# Persistent state lives under ./data (SQLite DB, media, outbox,
# reports, avatars, exports, token key file). docker-compose mounts
# a named volume here; the directory must be writable by the
# non-root user below.
RUN mkdir -p data && chown -R node:node /app

USER node
EXPOSE 3001

# /api/health exists in the app (server/src/app.ts) and returns
# {"ok":true}. node:slim has no curl/wget, so probe with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

# ---------- Stage 4: web (static frontend + reverse proxy) ----------
FROM caddy:2.8.4-alpine AS web
COPY --from=frontend-build /build/dist /srv
EXPOSE 80 443
# The Caddyfile is injected by docker-compose (top-level `configs:`),
# so this target stays usable with a bind-mounted Caddyfile too.
