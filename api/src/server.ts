/**
 * AMP HTTP Proxy API (Hono)
 * 
 * Generic HTTP interface that proxies AMP's internal JSONL endpoint.
 * This allows remote sinks (neo4j-sink, postgres-sink) to query
 * AMP data over the network instead of requiring co-location.
 * 
 * Domain-specific logic (event topics, contract addresses, parsing)
 * belongs in the sinks — this layer is a pure, protocol-agnostic proxy.
 * 
 * Endpoints:
 *   GET  /health          — Health check + latest block per dataset
 *   GET  /status          — Detailed indexer status (datasets, sync progress)
 *   POST /query           — SQL query proxy (forwards to AMP JSONL)
 *   POST /                — Same as /query (drop-in AMP endpoint compatibility)
 *   GET  /blocks/latest   — Get latest indexed block number for a dataset
 * 
 * The sinks' AmpClient can point AMP_ENDPOINT at this service's URL
 * and everything works transparently — same JSONL protocol.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3000');
const AMP_ENDPOINT = process.env.AMP_ENDPOINT || 'http://127.0.0.1:1603';
const AMP_ADMIN_URL = process.env.AMP_ADMIN_URL || 'http://127.0.0.1:1610';
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';
const SERVICE_NAME = process.env.SERVICE_NAME || 'amp-api';

// =============================================================================
// Dataset Discovery (cached from AMP admin API)
// =============================================================================

let knownDatasets: Set<string> = new Set();
let datasetsLastFetched = 0;
const DATASETS_CACHE_TTL = 60_000; // 1 minute

async function refreshDatasets(): Promise<Set<string>> {
  const now = Date.now();
  if (knownDatasets.size > 0 && now - datasetsLastFetched < DATASETS_CACHE_TTL) {
    return knownDatasets;
  }
  try {
    const res = await fetch(`${AMP_ADMIN_URL}/datasets`);
    if (res.ok) {
      const data = await res.json() as any[];
      // AMP admin /datasets returns an array of dataset objects with a "name" field
      const names = data
        .map((d: any) => d.name ?? d.id ?? d)
        .filter((n: any) => typeof n === 'string');
      if (names.length > 0) {
        knownDatasets = new Set(names);
        datasetsLastFetched = now;
      }
    }
  } catch {
    // Admin not available — keep using cached set (or empty)
  }
  return knownDatasets;
}

async function validateDataset(dataset: string): Promise<string> {
  // Only allow simple identifier characters (prevent SQL injection via table names)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dataset)) {
    throw new Error(`Invalid dataset identifier: ${dataset}`);
  }
  const datasets = await refreshDatasets();
  if (datasets.size > 0 && !datasets.has(dataset)) {
    throw new Error(`Unknown dataset: ${dataset}. Available: ${[...datasets].join(', ')}`);
  }
  return dataset;
}

// =============================================================================
// AMP Query Helpers
// =============================================================================

async function queryAmp(sql: string): Promise<string> {
  const response = await fetch(AMP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: sql,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AMP query failed: ${response.status} - ${text}`);
  }

  return response.text();
}

async function queryAmpJson<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const text = await queryAmp(sql);
  if (!text.trim()) return [];
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// =============================================================================
// App
// =============================================================================

const app = new Hono();

// CORS
app.use('*', cors({ origin: CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',') }));

// GET /health
app.get('/health', async (c) => {
  try {
    const datasets = await refreshDatasets();

    // Query latest block for each known dataset
    const datasetStatus: Record<string, number | null> = {};
    for (const ds of datasets) {
      const rows = await queryAmpJson<{ latest: string | number }>(
        `SELECT MAX(block_num) as latest FROM "${ds}".blocks`
      ).catch(() => []);
      datasetStatus[ds] = rows[0]?.latest ? Number(rows[0].latest) : null;
    }

    // Overall latest block = max across all datasets
    const blockValues = Object.values(datasetStatus).filter((v): v is number => v !== null);
    const latestBlock = blockValues.length > 0 ? Math.max(...blockValues) : null;

    return c.json({
      status: 'ok',
      service: SERVICE_NAME,
      latestBlock,
      datasets: datasetStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      status: 'error',
      service: SERVICE_NAME,
      error: String(error),
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

// GET /status
app.get('/status', async (c) => {
  try {
    const adminRes = await fetch(`${AMP_ADMIN_URL}/datasets`).catch(() => null);
    const datasets = adminRes?.ok ? await adminRes.json() : null;

    const jobsRes = await fetch(`${AMP_ADMIN_URL}/jobs`).catch(() => null);
    const jobs = jobsRes?.ok ? await jobsRes.json() : null;

    return c.json({
      status: 'ok',
      datasets,
      jobs,
      config: {
        syncMode: process.env.AMP_SYNC_MODE || 'full',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({ status: 'error', error: String(error) }, 500);
  }
});

// =============================================================================
// Simple rate limiter (per-IP, sliding window)
// =============================================================================

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60'); // requests per window
const MAX_QUERY_SIZE = parseInt(process.env.MAX_QUERY_SIZE || '10000'); // max SQL body in bytes
const rateLimitMap = new Map<string, number[]>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return true;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, recent);
  }
}, 300_000);

// POST /query and POST / — SQL query proxy (same JSONL protocol as AMP)
const handleQuery = async (c: any) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!rateLimit(ip)) {
    return c.json({ error: 'Rate limit exceeded. Max 60 requests per minute.' }, 429);
  }

  const contentType = c.req.header('content-type') || '';
  let sql: string;

  if (contentType.includes('application/json')) {
    const body = await c.req.json();
    sql = body.sql || body.query;
  } else {
    sql = await c.req.text();
  }

  if (!sql?.trim()) {
    return c.json({ error: 'Missing SQL query. Send as text/plain body or JSON { "sql": "..." }' }, 400);
  }

  if (sql.length > MAX_QUERY_SIZE) {
    return c.json({ error: `Query too large (${sql.length} bytes). Max: ${MAX_QUERY_SIZE}` }, 413);
  }

  // Only allow SELECT statements (read-only — AMP data is append-only Parquet)
  const normalized = sql.trim().replace(/^--[^\n]*\n/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^SELECT\b/i.test(normalized) && !/^WITH\b/i.test(normalized) && !/^EXPLAIN\b/i.test(normalized)) {
    return c.json({ error: 'Only SELECT, WITH (CTE), and EXPLAIN queries are allowed' }, 403);
  }

  try {
    const result = await queryAmp(sql);
    return new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  } catch (error) {
    return c.json({ error: String(error) }, 502);
  }
};

app.post('/query', handleQuery);
app.post('/', handleQuery);

// GET /blocks/latest?dataset=<name>
app.get('/blocks/latest', async (c) => {
  try {
    const datasetParam = c.req.query('dataset');
    if (!datasetParam) {
      return c.json({ error: 'Missing required query param: dataset' }, 400);
    }
    const dataset = await validateDataset(datasetParam);

    const rows = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "${dataset}".blocks`
    );
    return c.json({ latestBlock: rows[0]?.latest ? Number(rows[0].latest) : null, dataset });
  } catch (error: any) {
    if (error.message?.includes('Invalid') || error.message?.includes('Unknown') || error.message?.includes('Missing')) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: String(error) }, 502);
  }
});

// 404
app.notFound((c) => {
  return c.json({
    error: 'Not found',
    endpoints: {
      'GET /health': 'Health check + latest block per dataset',
      'GET /status': 'Detailed indexer status',
      'POST /query': 'SQL proxy (text/plain body = raw SQL)',
      'POST /': 'Same as /query (AMP drop-in compatibility)',
      'GET /blocks/latest?dataset=D': 'Latest indexed block for a dataset',
    },
  }, 404);
});

// =============================================================================
// Start
// =============================================================================

console.log(`[${SERVICE_NAME}] Starting on :${PORT}`);
console.log(`[${SERVICE_NAME}] Proxying AMP JSONL endpoint`);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[${SERVICE_NAME}] Listening on :${PORT}`);
});
