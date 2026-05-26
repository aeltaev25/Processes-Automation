/**
 * @file services/cache.service.ts
 * @description Redis cache service with Leaky Bucket rate limiting.
 *
 * DESIGN:
 *   • Implements the cache-aside pattern (Section 10 of architecture doc).
 *   • The Redis-backed Leaky Bucket algorithm (Section 25) protects all
 *     ingress endpoints against DoS/DDoS at the application layer.
 *   • All keys are namespaced to prevent collisions across services.
 *   • Cache hit/miss ratio is tracked as a Prometheus metric.
 */

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../config/logger';
import { metrics } from '../db/metrics';

// ─── Redis Client ─────────────────────────────────────────────────────────────
export const redisClient = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
  db: config.REDIS_DB,
  lazyConnect: true,
  retryStrategy: (times) => {
    // Exponential back-off: 1s, 2s, 4s … capped at 30s
    const delay = Math.min(1000 * Math.pow(2, times), 30_000);
    logger.warn('Redis reconnect attempt', { attempt: times, delayMs: delay });
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 5000,
});

redisClient.on('connect', () => logger.info('Redis: connected'));
redisClient.on('ready', () => logger.info('Redis: ready to serve'));
redisClient.on('error', (err) => logger.error('Redis: error', { error: err.message }));
redisClient.on('close', () => logger.warn('Redis: connection closed'));

// ─── Cache-Aside Pattern ──────────────────────────────────────────────────────
/**
 * Generic cached query: try cache first, fall back to `loader`, then cache result.
 * @param key    Namespaced cache key (e.g., 'tours:list:page1')
 * @param loader Async function that fetches the data from the DB if cache misses
 * @param ttl    Time-to-live in seconds (default: from config)
 */
export async function cachedQuery<T>(
  key: string,
  loader: () => Promise<T>,
  ttl: number = config.REDIS_TTL_DEFAULT,
): Promise<T> {
  const namespacedKey = `adv:${config.NODE_ENV}:${key}`;

  try {
    const cached = await redisClient.get(namespacedKey);
    if (cached !== null) {
      metrics.cacheHitRatio.set({ cache: 'redis' }, 1);
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    // Redis failure must NOT break the application – degrade gracefully.
    logger.error('Cache read failed – falling through to DB', { key, error: (err as Error).message });
  }

  metrics.cacheHitRatio.set({ cache: 'redis' }, 0);
  const value = await loader();

  try {
    await redisClient.setex(namespacedKey, ttl, JSON.stringify(value));
  } catch (err) {
    logger.error('Cache write failed', { key, error: (err as Error).message });
  }

  return value;
}

/**
 * Invalidate one or more cache keys (call after mutations).
 */
export async function invalidateCache(keys: string[]): Promise<void> {
  try {
    const namespacedKeys = keys.map((k) => `adv:${config.NODE_ENV}:${k}`);
    if (namespacedKeys.length > 0) {
      await redisClient.del(...namespacedKeys);
    }
  } catch (err) {
    logger.error('Cache invalidation failed', { keys, error: (err as Error).message });
  }
}

// ─── Leaky Bucket Rate Limiter ────────────────────────────────────────────────
/**
 * Implements the Redis-backed Leaky Bucket algorithm from Section 25 of the
 * architecture document (Denial of Service mitigation).
 *
 * Each identifier (IP or user ID) gets a sliding window counter in Redis.
 * Requests are allowed up to `limit` per `windowMs` milliseconds.
 *
 * @returns { allowed: boolean; remaining: number; retryAfterMs: number }
 */
export async function checkRateLimit(
  identifier: string,
  limit: number = config.RATE_LIMIT_MAX,
  windowMs: number = config.RATE_LIMIT_WINDOW_MS,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const key = `adv:ratelimit:${identifier}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  // Lua script ensures atomicity – no race conditions between ZREMRANGEBYSCORE and ZADD.
  const luaScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window_start = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local window_ms = tonumber(ARGV[4])

    -- Remove timestamps outside the current window
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Count remaining requests in the window
    local count = redis.call('ZCARD', key)

    if count < limit then
      -- Allow: add the current timestamp
      redis.call('ZADD', key, now, now)
      redis.call('PEXPIRE', key, window_ms)
      return {1, limit - count - 1, 0}
    else
      -- Deny: return time until oldest entry expires
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local retry_after = window_ms - (now - tonumber(oldest[2]))
      return {0, 0, retry_after}
    end
  `;

  try {
    const result = await redisClient.eval(
      luaScript, 1, key,
      now.toString(), windowStart.toString(), limit.toString(), windowMs.toString(),
    ) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      retryAfterMs: result[2],
    };
  } catch (err) {
    // Redis failure → fail open (allow the request) to avoid availability issues.
    logger.error('Rate limit check failed – allowing request', { error: (err as Error).message });
    return { allowed: true, remaining: limit, retryAfterMs: 0 };
  }
}

// ─── Health Check ──────────────────────────────────────────────────────────────
export async function checkRedisHealth(): Promise<{ status: string; latencyMs: number }> {
  const start = Date.now();
  try {
    await redisClient.ping();
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch {
    return { status: 'unhealthy', latencyMs: Date.now() - start };
  }
}

export async function closeRedis(): Promise<void> {
  await redisClient.quit();
}