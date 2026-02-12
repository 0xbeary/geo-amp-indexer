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
      ampEndpoint: AMP_ENDPOINT,
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
        ampEndpoint: AMP_ENDPOINT,
        ampAdmin: AMP_ADMIN_URL,
        syncMode: process.env.AMP_SYNC_MODE || 'full',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({ status: 'error', error: String(error) }, 500);
  }
});

// POST /query and POST / — SQL query proxy (same JSONL protocol as AMP)
const handleQuery = async (c: any) => {
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
  const from = c.req.query('from') || '0';
  const to = c.req.query('to');
  const dataset = c.req.query('dataset') || 'geo_evm_rpc_full';

  const EDITS_TOPIC = 'a848eb297c5b02d48ac057876502bddd8bfc8d0199d69c71dc02e4f518fdf380';

  let sql = `
    SELECT block_num, tx_hash, log_index, address, topic0, topic1, data
    FROM "${dataset}".logs
    WHERE topic0 = decode('${EDITS_TOPIC}', 'hex')
      AND block_num >= ${from}
  `;
  if (to) sql += `  AND block_num <= ${to}\n`;
  sql += `    ORDER BY block_num ASC, log_index ASC\n    LIMIT 10000`;

  try {
    const rows = await queryAmpJson(sql);
    return c.json({ events: rows, count: rows.length, from: Number(from), to: to ? Number(to) : null });
  } catch (error) {
    return c.json({ error: String(error) }, 502);
  }
});

// GET /blocks/latest?dataset=geo_evm_rpc_full
app.get('/blocks/latest', async (c) => {
  const dataset = c.req.query('dataset') || 'geo_evm_rpc_full';

  try {
    const rows = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "${dataset}".blocks`
    );
    return c.json({ latestBlock: rows[0]?.latest ? Number(rows[0].latest) : null, dataset });
  } catch (error) {
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
