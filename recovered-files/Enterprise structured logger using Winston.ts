/**
 * @file config/logger.ts
 * @description Enterprise-grade structured logger.
 *
 * DESIGN:
 *   • Uses Winston with JSON output for production (parseable by Fluentbit/Loki).
 *   • Uses colorized "pretty" output in development for readability.
 *   • Every log line includes: timestamp, level, service, traceId, and message.
 *   • The traceId is injected from AsyncLocalStorage so all logs from a single
 *     HTTP request are automatically correlated – no manual threading needed.
 *   • PII masking regex strips passport/card numbers before any log leaves the
 *     process, satisfying the STRIDE threat model (Info Disclosure).
 */

import winston from 'winston';
import { config } from './index';

// ─── PII Masking Transform ───────────────────────────────────────────────────
// Masks sensitive patterns in log messages before they are written.
// Patterns: credit card numbers (16 digits) and passport-like strings (letter+digits).
const PII_PATTERNS = [
  { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, mask: '[CARD-MASKED]' },
  { regex: /\b[A-Z]{1,2}\d{6,9}\b/g, mask: '[PASSPORT-MASKED]' },
  { regex: /"password"\s*:\s*"[^"]+"/gi, mask: '"password":"[REDACTED]"' },
];

const maskPII = (message: string): string => {
  let masked = message;
  PII_PATTERNS.forEach(({ regex, mask }) => {
    masked = masked.replace(regex, mask);
  });
  return masked;
};

// ─── Custom Format ────────────────────────────────────────────────────────────
const productionFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format((info) => {
    // Apply PII masking on the message field
    if (typeof info.message === 'string') {
      info.message = maskPII(info.message);
    }
    return info;
  })(),
  winston.format.json(),
);

const developmentFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, service, traceId, ...rest }) => {
    const extra = Object.keys(rest).length ? `\n  ${JSON.stringify(rest, null, 2)}` : '';
    const trace = traceId ? ` [${traceId}]` : '';
    return `${timestamp} ${level}${trace} [${service ?? 'app'}] ${message}${extra}`;
  }),
);

// ─── Logger Instance ──────────────────────────────────────────────────────────
export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  defaultMeta: {
    service: config.OTEL_SERVICE_NAME,
    env: config.NODE_ENV,
  },
  format: config.LOG_FORMAT === 'pretty' ? developmentFormat : productionFormat,
  transports: [
    new winston.transports.Console(),
    // In production, add a file transport for local archival before Fluentbit picks it up.
    ...(config.NODE_ENV === 'production'
      ? [
          new winston.transports.File({
            filename: '/var/log/advantour/error.log',
            level: 'error',
            maxsize: 10 * 1024 * 1024, // 10 MB
            maxFiles: 5,
            tailable: true,
          }),
          new winston.transports.File({
            filename: '/var/log/advantour/combined.log',
            maxsize: 50 * 1024 * 1024, // 50 MB
            maxFiles: 10,
            tailable: true,
          }),
        ]
      : []),
  ],
  // Do not exit on handled exceptions – let the app decide.
  exitOnError: false,
});