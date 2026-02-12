#!/bin/bash
set -e

echo "================================================"
echo "  geo-amp-indexer"
echo "  AMP Indexer + HTTP API for Geo Protocol"
echo "================================================"

# ── Resolve ports ────────────────────────────────────────────────────
# Railway injects PORT for the public-facing service
export API_PORT="${PORT:-3000}"
export CORS_ORIGINS="${CORS_ORIGINS:-*}"

# ── Initialize embedded PostgreSQL ──────────────────────────────────
echo "Initializing embedded PostgreSQL..."
PGDATA=/var/lib/postgresql/data

# Fresh DB every deploy (ephemeral metadata)
if [ -d "$PGDATA" ]; then
  rm -rf "$PGDATA"/*
fi

su postgres -c "/usr/lib/postgresql/15/bin/initdb -D $PGDATA --auth=trust --no-locale --encoding=UTF8"

# Start PG temporarily to run migrations
su postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $PGDATA -l /tmp/pg_init.log start -o '-c listen_addresses=127.0.0.1 -c port=5432'"

# Wait for PG to be ready
until pg_isready -h 127.0.0.1 -p 5432 -U postgres 2>/dev/null; do
  echo "Waiting for embedded PostgreSQL..."
  sleep 1
done
echo "Embedded PostgreSQL is ready!"

# Create the amp database
su postgres -c "createdb -h 127.0.0.1 amp" 2>/dev/null || true

# Set the metadata DB URL for AMP config
export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/amp"
sed -i "s|metadata_db_url = .*|metadata_db_url = \"$DATABASE_URL\"|" /app/amp/amp.config.toml

# ── Run migrations ──────────────────────────────────────────────────
echo "Running database migrations..."
export AMP_CONFIG=/app/amp/amp.config.toml
ampd migrate

# ── Clear workers table ─────────────────────────────────────────────
echo "Clearing workers table..."
psql "$DATABASE_URL" -c "TRUNCATE TABLE public.workers CASCADE;" || true

# Stop temporary PG (supervisord will manage it from here)
su postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D $PGDATA stop"
echo "PostgreSQL initialized, supervisord will manage it"

# ── Generate unique worker ID ───────────────────────────────────────
export AMP_NODE_ID="worker_$(date +%s)"
echo "Using worker ID: $AMP_NODE_ID"

# ── AMP sync mode ───────────────────────────────────────────────────
export AMP_SYNC_MODE="${AMP_SYNC_MODE:-full}"
echo "Sync mode: $AMP_SYNC_MODE"

# ── Register datasets (runs in background after AMP starts) ─────────
register_datasets() {
  echo "[amp] Waiting for AMP admin API..."
  export AMP_ADMIN_URL=http://127.0.0.1:1610
  for i in $(seq 1 30); do
    if ampctl --admin-url "$AMP_ADMIN_URL" dataset list > /dev/null 2>&1; then
      echo "[amp] Admin API is ready"
      break
    fi
    sleep 2
  done

  echo "[amp] Registering dataset (mode: $AMP_SYNC_MODE)..."
  if [ "$AMP_SYNC_MODE" = "full" ]; then
    echo "Registering _/geo_testnet_full from sync-data-full.json (start_block: 0)"
    ampctl dataset register _/geo_testnet_full manifests/sync-data-full.json --tag 1.0.0 2>/dev/null || true
    ampctl dataset deploy _/geo_testnet_full@1.0.0 2>/dev/null || true
  else
    echo "Registering _/geo_testnet from sync-data-recent.json (start_block: 80000)"
    ampctl dataset register _/geo_testnet manifests/sync-data-recent.json --tag 1.0.0 2>/dev/null || true
    ampctl dataset deploy _/geo_testnet@1.0.0 2>/dev/null || true
  fi
  echo "[amp] Dataset registered and deployed!"
  ampctl job list || true
}

(
  cd /app/amp
  register_datasets
) &

# ── Start supervisord ───────────────────────────────────────────────
echo "Starting AMP indexer + HTTP API..."
echo "  AMP JSONL:  port 1603 (internal)"
echo "  AMP Admin:  port 1610 (internal)"
echo "  HTTP API:   port $API_PORT (public)"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/geo-amp.conf
