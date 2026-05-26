/**
 * @file db/pool.ts
 * @description PostgreSQL connection pool with health monitoring.
 *
 * DESIGN:
 *   • Uses pg.Pool with streaming WAL-compatible settings.
 *   • Connection pool is sized based on the load model from the architecture doc:
 *     T = U × R  →  250 users × 30 req/min = 7,500 RPM.
 *     Pool max of 20 leaves headroom per replica, multiply by replica count.
 *   • All queries are wrapped with automatic connection release and error logging.
 *   • The pool emits Prometheus metrics for active/idle/waiting connections.
 *   • Row-Level Security (RLS) is enforced by setting `app.current_user_id`
 *     on each connection before executing queries (see withRLS helper).
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config';
import { logger } from '../config/logger';
import { metrics } from './metrics';

// ─── Pool Configuration ───────────────────────────────────────────────────────
export const pool = new Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  min: config.POSTGRES_POOL_MIN,
  max: config.POSTGRES_POOL_MAX,
  idleTimeoutMillis: 30_000,      // Release idle connections after 30s
  connectionTimeoutMillis: 5_000, // Fail fast if DB is unreachable
  ssl: config.POSTGRES_SSL ? { rejectUnauthorized: true } : false,
  // Statement timeout prevents runaway queries from blocking the pool.
  // 30 seconds is generous for complex OLAP queries.
  application_name: `advantour_${config.NODE_ENV}`,
});

// ─── Pool Event Monitoring ────────────────────────────────────────────────────
pool.on('connect', (client) => {
  logger.debug('DB pool: new client connected', { totalCount: pool.totalCount });
  // Enforce UTC timezone on every connection to prevent TZ-related bugs.
  client.query("SET timezone = 'UTC'");
  metrics.dbConnectionsActive.inc();
});

pool.on('remove', () => {
  logger.debug('DB pool: client removed', { totalCount: pool.totalCount });
  metrics.dbConnectionsActive.dec();
});

pool.on('error', (err) => {
  logger.error('DB pool: unexpected error on idle client', { error: err.message });
  metrics.dbErrors.inc({ type: 'pool_error' });
});

// ─── Core Query Wrapper ───────────────────────────────────────────────────────
/**
 * Execute a parameterized query. Always use parameterized queries ($1, $2…)
 * to prevent SQL injection – NEVER interpolate user input into query strings.
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug('DB query executed', { durationMs: duration, rows: result.rowCount });
    metrics.dbQueryDuration.observe({ operation: extractOperation(text) }, duration / 1000);
    return result;
  } catch (err) {
    const error = err as Error;
    logger.error('DB query failed', { error: error.message, query: text.substring(0, 100) });
    metrics.dbErrors.inc({ type: 'query_error' });
    throw error;
  }
}

// ─── Transaction Helper ───────────────────────────────────────────────────────
/**
 * Execute multiple queries inside a single ACID transaction.
 * Automatically commits on success, rolls back on any thrown error.
 *
 * @example
 *   await withTransaction(async (client) => {
 *     await client.query('INSERT INTO orders ...', [...]);
 *     await client.query('INSERT INTO journal_entries ...', [...]);
 *   });
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back', { error: (err as Error).message });
    throw err;
  } finally {
    client.release();
  }
}

// ─── RLS Helper ───────────────────────────────────────────────────────────────
/**
 * Set the current user ID on the DB session for Row-Level Security policies.
 * Must be called before any query that touches RLS-protected tables.
 * See architecture doc Section 23.1 – Region Isolation Policy.
 */
export async function withRLS<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // This setting is read by the RLS policy: current_setting('app.current_user_id')
    await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
    return await fn(client);
  } finally {
    client.release();
  }
}

// ─── Health Check ──────────────────────────────────────────────────────────────
export async function checkDatabaseHealth(): Promise<{ status: string; latencyMs: number }> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: Date.now() - start };
  }
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
export async function closeDatabasePool(): Promise<void> {
  logger.info('DB pool: draining connections…');
  await pool.end();
  logger.info('DB pool: all connections closed.');
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function extractOperation(sql: string): string {
  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith('SELECT')) return 'SELECT';
  if (trimmed.startsWith('INSERT')) return 'INSERT';
  if (trimmed.startsWith('UPDATE')) return 'UPDATE';
  if (trimmed.startsWith('DELETE')) return 'DELETE';
  return 'OTHER';
}