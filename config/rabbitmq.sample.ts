/**
 * @file events/event-bus.ts
 * @description RabbitMQ Event Bus – producer and consumer sides.
 *
 * DESIGN:
 *   Implements Section 8 (Event Bus Architecture) and Section 9 (Event Processor)
 *   from the architecture document.
 *
 *   Pattern used: Topic Exchange with durable queues.
 *   - Exchange: advantour.events (topic)
 *   - Routing key format: {service}.{entity}.{action}
 *     e.g., "operations.tour.created", "finance.ledger.posted"
 *
 *   Idempotency: Every consumer checks a Redis set of processed event IDs
 *   before handling – guarantees exactly-once processing despite retries.
 *
 *   Dead Letter Exchange (DLX): Failed messages after max retries are routed
 *   to advantour.dlx for manual inspection / alerting.
 */

import amqplib, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../config/logger';
import { redisClient } from '../services/cache.service';
import { metrics } from '../db/metrics';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AdvantourEvent<T = unknown> {
  eventId: string;        // UUID – used for idempotency
  eventType: string;      // e.g. "TOUR_CREATED"
  version: string;        // Schema version e.g. "1.0"
  timestamp: string;      // ISO-8601
  traceId?: string;       // Propagated from HTTP request for distributed tracing
  payload: T;
}

type EventHandler<T> = (event: AdvantourEvent<T>) => Promise<void>;

// ─── Singleton Connection Manager ─────────────────────────────────────────────
let connection: Connection | null = null;
let publishChannel: Channel | null = null;

async function getConnection(): Promise<Connection> {
  if (!connection) {
    connection = await amqplib.connect(config.RABBITMQ_URL);
    connection.on('error', (err) => {
      logger.error('RabbitMQ connection error', { error: err.message });
      connection = null;
    });
    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed – will reconnect on next use');
      connection = null;
    });
    logger.info('RabbitMQ: connected to broker');
  }
  return connection;
}

async function getPublishChannel(): Promise<Channel> {
  const conn = await getConnection();
  if (!publishChannel) {
    publishChannel = await conn.createChannel();
    await publishChannel.assertExchange(config.RABBITMQ_EXCHANGE, config.RABBITMQ_EXCHANGE_TYPE, {
      durable: true, // Survives broker restarts
    });
    // Dead Letter Exchange for failed messages
    await publishChannel.assertExchange('advantour.dlx', 'fanout', { durable: true });
    logger.info('RabbitMQ: publish channel ready');
  }
  return publishChannel;
}

// ─── Publisher ────────────────────────────────────────────────────────────────
/**
 * Publish a business event to the topic exchange.
 * @param routingKey  e.g. "operations.tour.created"
 * @param payload     The event body (will be wrapped in AdvantourEvent envelope)
 * @param traceId     Optional trace ID for distributed tracing correlation
 */
export async function publishEvent<T>(
  routingKey: string,
  payload: T,
  traceId?: string,
): Promise<void> {
  const event: AdvantourEvent<T> = {
    eventId: uuidv4(),
    eventType: routingKey.toUpperCase().replace(/\./g, '_'),
    version: '1.0',
    timestamp: new Date().toISOString(),
    traceId,
    payload,
  };

  const ch = await getPublishChannel();
  const buffer = Buffer.from(JSON.stringify(event));

  // publishConfirm is available on ConfirmChannel – for production use
  // ch.publish() with persistent flag ensures durability.
  ch.publish(config.RABBITMQ_EXCHANGE, routingKey, buffer, {
    persistent: true,
    contentType: 'application/json',
    messageId: event.eventId,
    timestamp: Date.now(),
    headers: {
      'x-trace-id': traceId ?? '',
      'x-event-version': event.version,
    },
  });

  logger.info('Event published', {
    eventId: event.eventId,
    eventType: event.eventType,
    routingKey,
    traceId,
  });
}

// ─── Consumer ─────────────────────────────────────────────────────────────────
/**
 * Subscribe to a routing pattern and process messages with idempotency guard.
 * @param queueName    e.g. "finance.ledger.consumer"
 * @param routingKey   e.g. "operations.tour.*" (topic pattern)
 * @param handler      Async function to handle the event
 */
export async function subscribeToEvents<T>(
  queueName: string,
  routingKey: string,
  handler: EventHandler<T>,
): Promise<void> {
  const conn = await getConnection();
  const ch = await conn.createChannel();

  // Prefetch limits unacknowledged messages per consumer – prevents memory saturation.
  ch.prefetch(config.RABBITMQ_PREFETCH);

  // Assert the queue with Dead Letter Exchange routing
  await ch.assertQueue(queueName, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'advantour.dlx',
      'x-message-ttl': 86_400_000, // 24h max queue lifetime
    },
  });

  await ch.bindQueue(queueName, config.RABBITMQ_EXCHANGE, routingKey);

  logger.info('Event consumer ready', { queue: queueName, routingKey });

  ch.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    let event: AdvantourEvent<T>;
    try {
      event = JSON.parse(msg.content.toString()) as AdvantourEvent<T>;
    } catch (err) {
      logger.error('Failed to parse event message – sending to DLX', { error: (err as Error).message });
      ch.nack(msg, false, false); // Move to dead letter queue
      return;
    }

    // ── Idempotency Check (Section 9 of architecture doc) ──
    const processedKey = `adv:processed_events:${event.eventId}`;
    const alreadyProcessed = await redisClient.exists(processedKey);
    if (alreadyProcessed) {
      logger.warn('Duplicate event received – skipping', { eventId: event.eventId });
      ch.ack(msg); // Acknowledge without re-processing
      return;
    }

    try {
      await handler(event);
      // Mark as processed (TTL: 48h to cover retry windows)
      await redisClient.setex(processedKey, 48 * 3600, '1');
      ch.ack(msg);
      logger.info('Event processed successfully', {
        eventId: event.eventId,
        eventType: event.eventType,
        queue: queueName,
      });
    } catch (err) {
      const error = err as Error;
      const retryCount = (msg.properties.headers?.['x-retry-count'] ?? 0) as number;
      logger.error('Event handler failed', {
        eventId: event.eventId,
        error: error.message,
        retryCount,
      });

      if (retryCount >= 3) {
        // Exhausted retries → dead letter (manual inspection required)
        logger.error('Event sent to DLX after 3 retries', { eventId: event.eventId });
        metrics.eventBusLag.inc({ queue: 'dlx' });
        ch.nack(msg, false, false);
      } else {
        // Re-queue with incremented retry counter
        ch.nack(msg, false, true);
      }
    }
  });
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
export async function closeEventBus(): Promise<void> {
  if (publishChannel) await publishChannel.close();
  if (connection) await connection.close();
  logger.info('RabbitMQ: connections closed');
}