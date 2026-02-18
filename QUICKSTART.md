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

## 5. Get data out — run a sink

AMP stores raw blockchain data (blocks, transactions, logs). To do anything useful with it, you need a **sink** — a consumer that queries AMP, filters for specific events, decodes them, and writes structured data to a downstream database.

```
AMP (raw data) ──POST /query──▶ sink ──▶ PostgreSQL / Neo4j
```

### Run the Postgres sink

```bash
cd ../sinks/amp-postgres
cp .env.example .env
# Edit .env — set AMP_ENDPOINT and database connection
npm install && npm run dev
```

### Run the Neo4j sink

```bash
cd ../sinks/amp-neo4j
cp .env.example .env
# Edit .env — set AMP_ENDPOINT and Neo4j connection
npm install && npm run dev
```

Both sinks point `AMP_ENDPOINT` at this API (or directly at AMP's `:1603` if co-located):

```env
# Local — through the HTTP API proxy
AMP_ENDPOINT=http://localhost:3000/query

# Local — direct to AMP (if running on the same machine)
AMP_ENDPOINT=http://localhost:1603

# Remote — deployed instance
AMP_ENDPOINT=https://your-amp-instance.railway.app/query
```

The sinks handle all domain logic: knowing which event topics to query, decoding ABI data, and writing to their target databases. The API is just a passthrough.

## Full stack (Docker)

Builds AMP from Rust source (~15-30 min first time), then runs Postgres + AMP + API together:

```bash
docker build -t amp-indexer .
docker run -p 3000:3000 -e AMP_SYNC_MODE=recent -v amp-data:/app/amp/data amp-indexer
```

Set `AMP_SYNC_MODE=recent` to start from block 80k, or omit it for full sync from block 0.

## Remote AMP instance

If you have AMP deployed elsewhere, point the API at it:

```bash
AMP_ENDPOINT=https://your-instance.up.railway.app npm run dev
```
