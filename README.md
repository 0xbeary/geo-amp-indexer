# geo-amp-indexer

Standalone AMP indexer for Geo Protocol testnet. Extracts **all** on-chain data (blocks, transactions, logs) into Parquet files and serves them via SQL over HTTP.

## Architecture

```
Geo Testnet (chain 19411)
        │
        ▼
┌─────────────────┐
│  AMP Daemon     │  Extracts ALL blockchain data to Parquet
│  (ampd)         │  Internal JSONL API on :1603
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  HTTP API       │  Public interface for remote sinks
│  (:3000/$PORT)  │  /query, /events, /health, /status
└─────────────────┘
         │
    ┌────┴────────────────────┐
    ▼                         ▼
Remote sink               Remote sink
(neo4j-sink)              (postgres-sink)
```

## Deployment (Railway)

This deploys as its own Railway service, separate from the data sinks/APIs.
PostgreSQL is **embedded in the container** (ephemeral — recreated on each deploy).
No external database service needed.

### Setup

1. Create a new service in Railway pointing to this repo
2. **Mount a volume** at `/app/amp/data` (Parquet file storage — persists across deploys)
3. **Generate a public domain** — this is the URL your sinks will use
4. (Optional) Set `AMP_SYNC_MODE=recent` for faster initial sync from block 80k+

### Branches

| Branch | `AMP_SYNC_MODE` | Start Block | Use Case |
|--------|-----------------|-------------|----------|
| `main` | `full` | 0 | Full history sync |
| `testing` | `recent` | 80,000 | Fast testing/dev |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AMP_SYNC_MODE` | `full` | `recent` (block 80k+) or `full` (block 0+) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins for the HTTP API |

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

The HTTP API proxies AMP's internal JSONL endpoint, making it accessible over the network. Sinks can point `AMP_ENDPOINT` at this URL.

### Endpoints

#### `GET /health`
Health check with latest indexed block info.

#### `GET /status`
Detailed indexer status (active datasets, jobs, sync progress).

#### `POST /query`
SQL query proxy. Accepts raw SQL as `text/plain` body (same protocol as AMP's native JSONL endpoint) or JSON `{ "sql": "SELECT ..." }`.

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

#### `GET /events?from=N&to=N&dataset=D`
Convenience endpoint for EditsPublished events.

```bash
curl "https://your-amp.railway.app/events?from=80000&to=90000"
```

#### `GET /blocks/latest?dataset=D`
Get the latest indexed block number.

```bash
curl "https://your-amp.railway.app/blocks/latest"
```

## Using with Remote Sinks

Once deployed, configure your sinks to point at this service:

```env
# In amp-neo4j-sink or amp-postgres-sink .env:
AMP_ENDPOINT=https://your-amp-indexer.railway.app/query
```

The `/query` endpoint speaks the same JSONL protocol as AMP's native `:1603` — sinks work transparently with either a local or remote AMP endpoint.

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

## Chain Info

- **Network**: Geo Protocol Testnet
- **Chain ID**: 19411
- **RPC**: `https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz`
- **EditsPublished topic0**: `0xa848eb297c5b02d48ac057876502bddd8bfc8d0199d69c71dc02e4f518fdf380`
