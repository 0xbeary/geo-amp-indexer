/**
 * geo-amp-indexer HTTP API
 * 
 * Public HTTP interface that proxies AMP's internal JSONL endpoint.
 * This allows remote sinks (neo4j-sink, postgres-sink) to query
 * AMP data over the network instead of requiring co-location.
 * 
 * Endpoints:
 *   GET  /health          — Health check + latest block info
 *   GET  /status          — Detailed indexer status (datasets, sync progress)
 *   POST /query           — SQL query proxy (forwards to AMP JSONL on :1603)
 *   GET  /events          — Convenience: get EditsPublished events by block range
 *   GET  /blocks/latest   — Get latest indexed block number
 * 
 * The sinks' AmpClient can point AMP_ENDPOINT at this service's URL
 * and everything works transparently — same JSONL protocol.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3000');
const AMP_ENDPOINT = process.env.AMP_ENDPOINT || 'http://127.0.0.1:1603';
const AMP_ADMIN_URL = process.env.AMP_ADMIN_URL || 'http://127.0.0.1:1610';
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';

// =============================================================================
// AMP Query Helper
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
// Route Handlers
// =============================================================================

function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** GET /health */
async function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  try {
    const rows = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "geo_evm_rpc".blocks`
    ).catch(() => []);

    // Try full dataset too
    const rowsFull = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "geo_evm_rpc_full".blocks`
    ).catch(() => []);

    const latestRecent = rows[0]?.latest ? Number(rows[0].latest) : null;
    const latestFull = rowsFull[0]?.latest ? Number(rowsFull[0].latest) : null;

    json(res, {
      status: 'ok',
      service: 'geo-amp-indexer',
      ampEndpoint: AMP_ENDPOINT,
      latestBlock: latestFull ?? latestRecent ?? null,
      datasets: {
        recent: latestRecent,
        full: latestFull,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    json(res, {
      status: 'error',
      service: 'geo-amp-indexer',
      error: String(error),
      timestamp: new Date().toISOString(),
    }, 503);
  }
}

/** GET /status */
async function handleStatus(_req: IncomingMessage, res: ServerResponse) {
  try {
    // Try to get dataset list from admin API
    const adminRes = await fetch(`${AMP_ADMIN_URL}/datasets`).catch(() => null);
    const datasets = adminRes?.ok ? await adminRes.json() : null;

    const jobsRes = await fetch(`${AMP_ADMIN_URL}/jobs`).catch(() => null);
    const jobs = jobsRes?.ok ? await jobsRes.json() : null;

    json(res, {
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
    json(res, { status: 'error', error: String(error) }, 500);
  }
}

/** POST /query — SQL query proxy (same JSONL protocol as AMP) */
async function handleQuery(req: IncomingMessage, res: ServerResponse) {
  const contentType = req.headers['content-type'] || '';
  let sql: string;

  if (contentType.includes('application/json')) {
    const body = JSON.parse(await readBody(req));
    sql = body.sql || body.query;
  } else {
    // text/plain — raw SQL (same as AMP's native protocol)
    sql = await readBody(req);
  }

  if (!sql?.trim()) {
    json(res, { error: 'Missing SQL query. Send as text/plain body or JSON { "sql": "..." }' }, 400);
    return;
  }

  try {
    const result = await queryAmp(sql);
    // Stream back as JSONL (same format as AMP) for transparent proxying
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(result);
  } catch (error) {
    json(res, { error: String(error) }, 502);
  }
}

/** GET /events?from=N&to=N&dataset=geo_evm_rpc_full */
async function handleEvents(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const from = url.searchParams.get('from') || '0';
  const to = url.searchParams.get('to');
  const dataset = url.searchParams.get('dataset') || 'geo_evm_rpc_full';

  const EDITS_TOPIC = 'a848eb297c5b02d48ac057876502bddd8bfc8d0199d69c71dc02e4f518fdf380';

  let sql = `
    SELECT block_num, tx_hash, log_index, address, topic0, topic1, data
    FROM "${dataset}".logs
    WHERE topic0 = decode('${EDITS_TOPIC}', 'hex')
      AND block_num >= ${from}
  `;

  if (to) {
    sql += `  AND block_num <= ${to}\n`;
  }

  sql += `    ORDER BY block_num ASC, log_index ASC\n    LIMIT 10000`;

  try {
    const rows = await queryAmpJson(sql);
    json(res, { events: rows, count: rows.length, from: Number(from), to: to ? Number(to) : null });
  } catch (error) {
    json(res, { error: String(error) }, 502);
  }
}

/** GET /blocks/latest?dataset=geo_evm_rpc_full */
async function handleLatestBlock(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const dataset = url.searchParams.get('dataset') || 'geo_evm_rpc_full';

  try {
    const rows = await queryAmpJson<{ latest: string | number }>(
      `SELECT MAX(block_num) as latest FROM "${dataset}".blocks`
    );
    json(res, { latestBlock: rows[0]?.latest ? Number(rows[0].latest) : null, dataset });
  } catch (error) {
    json(res, { error: String(error) }, 502);
  }
}

// =============================================================================
// Server
// =============================================================================

const server = createServer(async (req, res) => {
  setCors(res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === '/health' && req.method === 'GET') {
      await handleHealth(req, res);
    } else if (path === '/status' && req.method === 'GET') {
      await handleStatus(req, res);
    } else if ((path === '/query' || path === '/') && req.method === 'POST') {
      // POST / is supported for drop-in compatibility with AMP's native JSONL endpoint
      // Sinks can set AMP_ENDPOINT=https://your-amp.railway.app and it just works
      await handleQuery(req, res);
    } else if (path === '/events' && req.method === 'GET') {
      await handleEvents(req, res);
    } else if (path === '/blocks/latest' && req.method === 'GET') {
      await handleLatestBlock(req, res);
    } else {
      json(res, {
        error: 'Not found',
        endpoints: {
          'GET /health': 'Health check + latest block',
          'GET /status': 'Detailed indexer status',
          'POST /query': 'SQL proxy (text/plain body = raw SQL)',
          'GET /events?from=N&to=N&dataset=D': 'EditsPublished events',
          'GET /blocks/latest?dataset=D': 'Latest indexed block',
        },
      }, 404);
    }
  } catch (error) {
    console.error('Unhandled error:', error);
    json(res, { error: 'Internal server error' }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[geo-amp-api] Listening on :${PORT}`);
  console.log(`[geo-amp-api] Proxying AMP at ${AMP_ENDPOINT}`);
  console.log(`[geo-amp-api] Endpoints: /health, /status, /query, /events, /blocks/latest`);
});
