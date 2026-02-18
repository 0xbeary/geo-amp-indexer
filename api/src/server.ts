/**
 * geo-amp-indexer HTTP API (Hono)
 * 
 * Public HTTP interface that proxies AMP's internal JSONL endpoint.
 * This allows remote sinks (neo4j-sink, postgres-sink) to query
 * AMP data over the network instead of requiring co-location.
 * 
 * Endpoints:
 *   GET  /health          — Health check + latest block info
 *   GET  /status          — Detailed indexer status (datasets, sync progress)
 *   POST /query           — SQL query proxy (forwards to AMP JSONL on :1603)
 *   POST /                — Same as /query (drop-in AMP endpoint compatibility)
 *   GET  /events          — Convenience: get EditsPublished events by block range
 *   GET  /blocks/latest   — Get latest indexed block number
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

// Allowed dataset identifiers (prevents SQL injection via table names)
const ALLOWED_DATASETS = new Set([
  'geo_evm_rpc',
  'geo_evm_rpc_full',
]);

function validateDataset(dataset: string): string {
  if (!ALLOWED_DATASETS.has(dataset)) {
    throw new Error(`Invalid dataset: ${dataset}. Allowed: ${[...ALLOWED_DATASETS].join(', ')}`);
  }
  return dataset;
}

function parseBlockNum(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`Invalid block number: ${value}`);
  }
  return num;
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
    const rows = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "geo_evm_rpc".blocks`
    ).catch(() => []);

    const rowsFull = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "geo_evm_rpc_full".blocks`
    ).catch(() => []);

    const latestRecent = rows[0]?.latest ? Number(rows[0].latest) : null;
    const latestFull = rowsFull[0]?.latest ? Number(rowsFull[0].latest) : null;

    return c.json({
      status: 'ok',
      service: 'geo-amp-indexer',
      latestBlock: latestFull ?? latestRecent ?? null,
      datasets: { recent: latestRecent, full: latestFull },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      status: 'error',
      service: 'geo-amp-indexer',
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

// GET /events?from=N&to=N&dataset=geo_evm_rpc_full
app.get('/events', async (c) => {
  try {
    const fromBlock = parseBlockNum(c.req.query('from'), 0)!;
    const toBlock = parseBlockNum(c.req.query('to'));
    const dataset = validateDataset(c.req.query('dataset') || 'geo_evm_rpc_full');

    const EDITS_TOPIC = 'a848eb297c5b02d48ac057876502bddd8bfc8d0199d69c71dc02e4f518fdf380';

    let sql = `
      SELECT block_num, tx_hash, log_index, address, topic0, topic1, data
      FROM "${dataset}".logs
      WHERE topic0 = decode('${EDITS_TOPIC}', 'hex')
        AND block_num >= ${fromBlock}
    `;
    if (toBlock !== undefined) sql += `  AND block_num <= ${toBlock}\n`;
    sql += `    ORDER BY block_num ASC, log_index ASC\n    LIMIT 10000`;

    const rows = await queryAmpJson(sql);
    return c.json({ events: rows, count: rows.length, from: fromBlock, to: toBlock ?? null });
  } catch (error: any) {
    if (error.message?.startsWith('Invalid')) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: String(error) }, 502);
  }
});

// GET /blocks/latest?dataset=geo_evm_rpc_full
app.get('/blocks/latest', async (c) => {
  try {
    const dataset = validateDataset(c.req.query('dataset') || 'geo_evm_rpc_full');

    const rows = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "${dataset}".blocks`
    );
    return c.json({ latestBlock: rows[0]?.latest ? Number(rows[0].latest) : null, dataset });
  } catch (error: any) {
    if (error.message?.startsWith('Invalid')) {
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
      'GET /health': 'Health check + latest block',
      'GET /status': 'Detailed indexer status',
      'POST /query': 'SQL proxy (text/plain body = raw SQL)',
      'POST /': 'Same as /query (AMP drop-in compatibility)',
      'GET /events?from=N&to=N&dataset=D': 'EditsPublished events',
      'GET /blocks/latest?dataset=D': 'Latest indexed block',
    },
  }, 404);
});

// =============================================================================
// Start
// =============================================================================

console.log(`[geo-amp-api] Starting on :${PORT}`);
console.log(`[geo-amp-api] Proxying AMP at ${AMP_ENDPOINT}`);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[geo-amp-api] Listening on :${PORT}`);
});
