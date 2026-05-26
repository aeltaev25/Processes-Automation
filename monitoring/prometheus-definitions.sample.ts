/**
 * @file db/metrics.ts
 * @description Prometheus metrics registry.
 *
 * DESIGN:
 *   All custom business and infrastructure metrics are defined here in one
 *   place so the monitoring team knows exactly what is being tracked.
 *   Follows the "Four Golden Signals" from Section 22 of the architecture doc:
 *   1. Latency  – how long requests take
 *   2. Traffic  – how many requests per second
 *   3. Errors   – rate of failed requests
 *   4. Saturation – how close to full capacity we are
 */

import client from 'prom-client';

// Enable default Node.js metrics (CPU, memory, heap, event loop lag…)
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'advantour_node_' });

// ─── HTTP Layer ────────────────────────────────────────────────────────────────
const httpRequestDuration = new client.Histogram({
  name: 'advantour_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestTotal = new client.Counter({
  name: 'advantour_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// ─── Database Layer ────────────────────────────────────────────────────────────
const dbQueryDuration = new client.Histogram({
  name: 'advantour_db_query_duration_seconds',
  help: 'Duration of PostgreSQL queries in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

const dbConnectionsActive = new client.Gauge({
  name: 'advantour_db_connections_active',
  help: 'Number of active PostgreSQL pool connections',
  registers: [register],
});

const dbErrors = new client.Counter({
  name: 'advantour_db_errors_total',
  help: 'Total database errors by type',
  labelNames: ['type'],
  registers: [register],
});

// ─── Business Metrics ─────────────────────────────────────────────────────────
const bookingsCreated = new client.Counter({
  name: 'advantour_bookings_created_total',
  help: 'Total bookings created by department',
  labelNames: ['department', 'status'],
  registers: [register],
});

const sagaExecutions = new client.Counter({
  name: 'advantour_saga_executions_total',
  help: 'Tour saga execution results',
  labelNames: ['result'], // success | compensated | failed
  registers: [register],
});

const ledgerPostErrors = new client.Counter({
  name: 'advantour_finance_ledger_post_errors_total',
  help: 'Ledger posting errors — triggers Prometheus alert (Section 22.1)',
  registers: [register],
});

// ─── Infrastructure Metrics ────────────────────────────────────────────────────
const cacheHitRatio = new client.Gauge({
  name: 'advantour_cache_hit_ratio',
  help: 'Redis cache hit/miss ratio (0–1)',
  labelNames: ['cache'],
  registers: [register],
});

const eventBusLag = new client.Gauge({
  name: 'advantour_event_bus_queue_lag',
  help: 'RabbitMQ queue depth (unacknowledged messages)',
  labelNames: ['queue'],
  registers: [register],
});

export const metrics = {
  register,
  httpRequestDuration,
  httpRequestTotal,
  dbQueryDuration,
  dbConnectionsActive,
  dbErrors,
  bookingsCreated,
  sagaExecutions,
  ledgerPostErrors,
  cacheHitRatio,
  eventBusLag,
};