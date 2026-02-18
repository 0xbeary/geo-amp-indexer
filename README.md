# AMP Indexer

Standalone AMP indexer for EVM chains. Extracts **all** on-chain data (blocks, transactions, logs) into Parquet files and serves them via SQL over HTTP.

## Architecture

```
EVM Chain (via RPC)
        │
        ▼
┌─────────────────┐
│  AMP Daemon     │  Extracts ALL blockchain data to Parquet
│  (ampd)         │  Internal JSONL API on :1603
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  HTTP API       │  Generic proxy — no domain logic
│  (:3000/$PORT)  │  /query, /health, /status, /blocks/latest
└─────────────────┘
         │
    ┌────┴────────────────────┐
    ▼                         ▼
┌──────────────┐      ┌──────────────┐
│  neo4j-sink  │      │ postgres-sink│
│  (consumer)  │      │  (consumer)  │
└──────────────┘      └──────────────┘
Queries AMP for         Queries AMP for
events, decodes         events, decodes
& writes to Neo4j       & writes to Postgres
```

**This service is a raw data layer.** It indexes _all_ EVM data (blocks, transactions, logs) without any domain-specific filtering or interpretation. The sinks are responsible for:

- Knowing which event topics to query (e.g. `EditsPublished`, `SafeOwnerAdded`)
- Decoding event data (ABI parsing, address extraction)
- Writing structured data to their target databases

## Getting Data

AMP stores raw blockchain data. To actually use it, you need a **sink** — a consumer that queries AMP, filters for relevant events, decodes them, and writes to a downstream database.

### Available Sinks

| Sink | Target DB | Location |
|------|-----------|----------|
| `amp-postgres` | PostgreSQL | `../sinks/amp-postgres/` |
| `amp-neo4j` | Neo4j | `../sinks/amp-neo4j/` |

### How Sinks Connect

Sinks query AMP via the `POST /query` endpoint (or directly to port `:1603` if co-located). They send raw SQL and receive NDJSON results:

```bash
# What a sink does internally:
curl -X POST http://amp-api:3000/query \
  -H "Content-Type: text/plain" \
  -d 'SELECT block_num, tx_hash, log_index, address, topic0, topic1, data
      FROM "geo_evm_rpc_full".logs
      WHERE topic0 = decode('\''a848eb...'\'', '\''hex'\'')
        AND block_num >= 80000
      ORDER BY block_num, log_index'
```

The sink knows the event signatures, contract addresses, and how to decode the raw log data. AMP just stores and serves the raw bytes.

### Pointing a Sink at This Service

```env
# In your sink's .env:
AMP_ENDPOINT=https://your-amp-instance.railway.app/query
```

The `/query` endpoint speaks the same JSONL protocol as AMP's native `:1603` — sinks work transparently with either a local or remote AMP endpoint.

## Deployment (Railway)

This deploys as its own Railway service, separate from the data sinks.
PostgreSQL is **embedded in the container** (ephemeral — recreated on each deploy).
No external database service needed.

### Setup

1. Create a new service in Railway pointing to this repo
2. **Mount a volume** at `/app/amp/data` (Parquet file storage — persists across deploys)
3. **Generate a public domain** — this is the URL your sinks will use
4. (Optional) Set `AMP_SYNC_MODE=recent` for faster initial sync from block 80k+

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AMP_SYNC_MODE` | `full` | `recent` (block 80k+) or `full` (block 0+) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins for the HTTP API |
| `SERVICE_NAME` | `amp-api` | Service name in health/log output |
| `RATE_LIMIT_MAX` | `60` | Max requests per minute per IP on `/query` |

### What Runs Inside

All managed by `supervisord`:

| Process | Description | Port |
|---------|-------------|------|
| PostgreSQL | Embedded metadata DB (ephemeral) | 5432 (internal) |
| AMP Controller | Dataset scheduling | internal |
| AMP Server | JSONL SQL endpoint | 1603 (internal) |
| AMP Worker | Indexing execution | — |
| HTTP API (Hono) | Public query proxy | `$PORT` (public) |

## HTTP API

The HTTP API is a **generic, protocol-agnostic proxy** for AMP's internal JSONL endpoint. It has no knowledge of specific events, contracts, or chains — that logic belongs in the sinks.

### Endpoints

#### `GET /health`
Health check. Dynamically discovers datasets from AMP's admin API and reports the latest indexed block for each.

#### `GET /status`
Detailed indexer status (active datasets, jobs, sync progress).

#### `POST /query`
SQL query proxy. Accepts raw SQL as `text/plain` body (same protocol as AMP's native JSONL endpoint) or JSON `{ "sql": "SELECT ..." }`. Rate-limited per IP.

```bash
# Raw SQL (compatible with AMP protocol)
curl -X POST https://your-amp.railway.app/query \
  -H "Content-Type: text/plain" \
  -d 'SELECT * FROM "geo_evm_rpc_full".logs LIMIT 5'

# JSON format
curl -X POST https://your-amp.railway.app/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT MAX(block_num) FROM \"geo_evm_rpc_full\".blocks"}'
```

#### `GET /blocks/latest?dataset=<name>`
Get the latest indexed block number for a specific dataset.

```bash
curl "https://your-amp.railway.app/blocks/latest?dataset=geo_evm_rpc_full"
```

## Local Development

### Prerequisites

1. [Install Amp](https://ampup.sh/install):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://ampup.sh/install | sh
   ```

2. Start PostgreSQL locally (for AMP metadata):
   ```bash
   # Using docker:
   docker run -d --name amp-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
   createdb -h localhost -U postgres amp

   # Or use the devcontainer's built-in postgres at db:5432
   ```

### Run

```bash
# Set config path
export AMP_CONFIG=./amp.config.toml

# Run migrations
ampd migrate

# Start in dev mode
ampd solo

# Register dataset (in another terminal)
ampctl dataset register _/geo_testnet_full manifests/sync-data-full.json --tag 1.0.0 --admin-url http://127.0.0.1:1610
ampctl dataset deploy _/geo_testnet_full@1.0.0 --admin-url http://127.0.0.1:1610

# Start HTTP API (in another terminal)
cd api && pnpm dev
```

## Current Chain Config

This instance is configured for Geo Protocol Testnet (see `providers/` and `manifests/`):

- **Chain ID**: 19411
- **RPC**: `https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz`

To index a different chain, add a new provider in `providers/` and a manifest in `manifests/`.
