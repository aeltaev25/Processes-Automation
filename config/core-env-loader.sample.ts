/**
 * @file config/index.ts
 * @description Centralized, type-safe configuration loader.
 *
 * DESIGN RATIONALE:
 *   All configuration is loaded once at startup and validated via Zod.
 *   If a required variable is missing, the process fails FAST with a clear
 *   error message rather than crashing at runtime in a confusing way.
 *   This pattern is standard practice in 12-Factor App methodology.
 *
 *   Per-environment overrides follow the precedence chain:
 *   process.env > .env.{NODE_ENV} > .env.local > .env
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load the correct .env file based on NODE_ENV
const env = process.env.NODE_ENV ?? 'development';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${env}`) });
dotenv.config({ path: path.resolve(process.cwd(), '.env') }); // fallback

// ─── Zod Schema: Every field is typed + documented ─────────────────────────
const ConfigSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  APP_HOST: z.string().default('0.0.0.0'),
  APP_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().transform((s) => s.split(',')),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // PostgreSQL
  POSTGRES_HOST: z.string(),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string(),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_POOL_MIN: z.coerce.number().int().default(2),
  POSTGRES_POOL_MAX: z.coerce.number().int().default(20),
  POSTGRES_SSL: z.coerce.boolean().default(false),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().default(0),
  REDIS_TTL_DEFAULT: z.coerce.number().int().default(600),

  // RabbitMQ
  RABBITMQ_URL: z.string(),
  RABBITMQ_EXCHANGE: z.string().default('advantour.events'),
  RABBITMQ_EXCHANGE_TYPE: z.enum(['topic', 'direct', 'fanout']).default('topic'),
  RABBITMQ_PREFETCH: z.coerce.number().int().default(10),

  // Email
  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().email(),
  SMTP_PASSWORD: z.string(),
  SMTP_FROM: z.string().email(),
  COMPANY_NAME: z.string().default('Advantour'),

  // Monitoring
  PROMETHEUS_PORT: z.coerce.number().int().default(9090),
  METRICS_PATH: z.string().default('/metrics'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('advantour-api'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  // Security
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().default(100),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
});

// ─── Parse + export ──────────────────────────────────────────────────────────
const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ [CONFIG] Invalid environment configuration:');
  parsed.error.issues.forEach((issue) => {
    console.error(`   → ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const config = parsed.data;

// Convenience helpers
export const isProd = config.NODE_ENV === 'production';
export const isDev = config.NODE_ENV === 'development';
export const isStaging = config.NODE_ENV === 'staging';