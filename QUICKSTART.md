# Quickstart

## Prerequisites

- Docker & Docker Compose
- Node.js 20+

## 1. Start PostgreSQL

```bash
docker compose up -d
```

## 2. Install API dependencies

```bash
cd api && npm install
```

## 3. Run the HTTP API (dev mode)

```bash
npm run dev
```

The API starts on [http://localhost:3000](http://localhost:3000).

## 4. Test it

```bash
curl http://localhost:3000/health
curl http://localhost:3000/status
```

> **Note:** Without the AMP daemon running, `/query` and `/health` will return errors — the API proxies AMP's JSONL endpoint on `:1603`.

## Full stack (Docker)

Builds AMP from Rust source (~15-30 min first time), then runs Postgres + AMP + API together:

```bash
docker build -t geo-amp-indexer .
docker run -p 3000:3000 -e AMP_SYNC_MODE=recent -v amp-data:/app/amp/data geo-amp-indexer
```

Set `AMP_SYNC_MODE=recent` to start from block 80k, or omit it for full sync from block 0.

## Remote AMP instance

If you have AMP deployed elsewhere, point the API at it:

```bash
AMP_ENDPOINT=https://your-instance.up.railway.app npm run dev
```
