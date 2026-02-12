# Dockerfile for geo-amp-indexer
# Standalone AMP indexer that extracts Geo Protocol blockchain data to Parquet
# Exposes both AMP's native JSONL API and an HTTP proxy API

# ---------------------------------------------------------------------------
# Stage 1: Build AMP (Rust)
# ---------------------------------------------------------------------------
FROM rust:1.75-bookworm AS amp-builder

RUN apt-get update && apt-get install -y \
    git pkg-config libssl-dev cmake clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 https://github.com/edgeandnode/amp.git . \
    && cargo build --release -p ampd -p ampctl

# ---------------------------------------------------------------------------
# Stage 2: Build HTTP API (Node.js)
# ---------------------------------------------------------------------------
FROM node:20-slim AS api-builder

RUN npm install -g pnpm@9

WORKDIR /build
COPY api/package.json ./
COPY api/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY api/tsconfig.json ./
COPY api/src/ ./src/
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    supervisor \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (for the HTTP API)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy AMP binaries
COPY --from=amp-builder /build/target/release/ampd /usr/local/bin/
COPY --from=amp-builder /build/target/release/ampctl /usr/local/bin/

# Copy AMP config
WORKDIR /app/amp
COPY amp.config.toml ./
COPY manifests/ ./manifests/
COPY providers/ ./providers/
COPY queries/ ./queries/
RUN mkdir -p ./data

# Copy HTTP API
WORKDIR /app/api
COPY --from=api-builder /build/dist/ ./dist/
COPY --from=api-builder /build/node_modules/ ./node_modules/
COPY --from=api-builder /build/package.json ./

# Copy configs
WORKDIR /app
COPY supervisord.conf /etc/supervisor/conf.d/geo-amp.conf
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Ports:
# 1602: Arrow Flight
# 1603: JSON Lines HTTP (AMP native SQL)
# 1610: Admin API
# 3000: HTTP API (public — proxies AMP + serves health/meta)
EXPOSE 1602 1603 1610 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
