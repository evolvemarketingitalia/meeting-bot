import axios from 'axios';
import crypto from 'crypto';
import { Logger } from 'winston';
import config from '../config';
import { createClient, RedisClientType } from 'redis';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';

export interface RecordingCompletedPayload {
  recordingId: string;
  meetingLink?: string;
  status: 'completed' | string;
  blobUrl?: string; // generic storage url (S3, Azure blob, etc.)
  timestamp: string; // ISO string
  metadata?: Record<string, any>;
}

export interface MeetingFailedPayload {
  recordingId: string;
  meetingLink?: string;
  status: 'failed';
  timestamp: string;
  error: {
    type: string;
    message: string;
    name?: string;
    retryable?: boolean;
    maxRetries?: number;
  };
  metadata: {
    userId: string;
    teamId: string;
    botId?: string;
    eventId?: string;
    provider?: string;
    meetingName?: string;
    timezone?: string;
  };
}

export interface MeetingFailureContext {
  url: string;
  name?: string;
  teamId: string;
  timezone?: string;
  userId: string;
  botId?: string;
  eventId?: string;
  provider?: string;
}

type NotificationPayload = RecordingCompletedPayload | MeetingFailedPayload;
type WebhookEventType = 'recording' | 'completed' | 'failed';

type WebhookPayload = NotificationPayload & {
  schemaVersion: 1;
  eventType: WebhookEventType;
  notificationId: string;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function signPayload(body: string, secret?: string): string | undefined {
  if (!secret) return undefined;
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function isRetryableWebhookStatus(status?: number): boolean {
  return status === undefined
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

export function getMeetingBotLifecycleCapabilities(
  enabled = config.notifyWebhookEnabled,
  url = config.notifyWebhookUrl,
  secret = config.notifyWebhookSecret,
): { lifecycleWebhook: 'meeting-bot.v1' } | undefined {
  return enabled && Boolean(url) && Boolean(secret)
    ? { lifecycleWebhook: 'meeting-bot.v1' }
    : undefined;
}

export function createWebhookPayload(payload: NotificationPayload): WebhookPayload {
  const eventType: WebhookEventType = payload.status === 'recording'
    ? 'recording'
    : payload.status === 'failed'
      ? 'failed'
      : 'completed';
  const stableEntityId = payload.metadata?.botId ?? payload.recordingId;
  const notificationId = crypto
    .createHash('sha256')
    .update(`meeting-bot.v1:${eventType}:${stableEntityId}`)
    .digest('hex');

  if (eventType === 'completed') {
    return { ...payload, schemaVersion: 1, eventType, notificationId };
  }

  const metadata: Record<string, any> = { ...payload.metadata };
  delete metadata.meetingName;
  delete metadata.timezone;

  return {
    ...payload,
    meetingLink: undefined,
    metadata,
    schemaVersion: 1,
    eventType,
    notificationId,
  };
}

async function sendWebhook(payload: NotificationPayload, logger: Logger, logLabel: string) {
  if (!config.notifyWebhookEnabled) return;
  if (!config.notifyWebhookUrl) {
    logger.warn('Webhook enabled but NOTIFY_WEBHOOK_URL is not set. Skipping.');
    return;
  }

  const webhookPayload = createWebhookPayload(payload);
  const body = JSON.stringify(webhookPayload);
  const signature = signPayload(body, config.notifyWebhookSecret);

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await axios.post(config.notifyWebhookUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Schema': 'meeting-bot.v1',
          'X-Webhook-Event': webhookPayload.eventType,
          'X-Webhook-Event-Id': webhookPayload.notificationId,
          'Idempotency-Key': webhookPayload.notificationId,
          ...(signature ? { 'X-Webhook-Signature': signature } : {}),
        },
        timeout: 10000,
      });
      logger.info(`${logLabel} webhook delivered.`);
      return;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      logger.error(`Failed to deliver ${logLabel.toLowerCase()} webhook. Attempt ${attempt}/${maxAttempts}.`, {
        status,
        code: axios.isAxiosError(err) ? err.code : undefined,
        message: err instanceof Error ? err.message : 'Unknown webhook error',
      });
      if (attempt === maxAttempts || !isRetryableWebhookStatus(status)) return;
      await sleep(1000 * attempt);
    }
  }
}

async function rpushToRedisList(
  payload: NotificationPayload,
  logger: Logger,
  list: string,
  logLabel: string
) {
  if (!config.notifyRedisEnabled) return;

  const uri = config.notifyRedisUri || config.redisUri;
  const db = config.notifyRedisDb;

  if (!uri) {
    logger.warn('Redis notification enabled but no URI available. Skipping.');
    return;
  }
  if (typeof db !== 'undefined' && (!Number.isInteger(db) || db < 0)) {
    logger.warn('Redis notification DB is invalid. Skipping.');
    return;
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client: RedisClientType | null = null;
    try {
      client = createClient({
        url: uri,
        name: 'meetbot-notify',
        ...(typeof db === 'number' ? { database: db } : {}),
      });
      client.on('error', (e) => logger.error('notify redis client error', e));
      await client.connect();
      const body = JSON.stringify(payload);
      await client.rPush(list, body);
      logger.info(`${logLabel} payload pushed to Redis list ${list} on DB ${typeof db === 'number' ? db : 'default'}.`);
      return;
    } catch (err) {
      logger.error(`Failed to push ${logLabel.toLowerCase()} notification to Redis. Attempt ${attempt}/${maxAttempts}.`, err as any);
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
      }
    } finally {
      try {
        if (client) await client.quit();
      } catch {}
    }
  }
}

export async function notifyRecordingCompleted(payload: RecordingCompletedPayload, logger: Logger) {
  // Delivery channels are independently controlled by config; run all enabled channels.
  await Promise.allSettled([
    sendWebhook(payload, logger, 'Recording completed'),
    rpushToRedisList(payload, logger, config.notifyRedisList, 'Recording completed'),
  ]);
}

export function createMeetingFailedPayload(context: MeetingFailureContext, error: unknown): MeetingFailedPayload {
  const entityId = context.botId ?? context.eventId ?? context.userId;
  const errorType = getErrorType(error);
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const message = rawMessage
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, 2_000);

  return {
    recordingId: entityId,
    meetingLink: context.url,
    status: 'failed',
    timestamp: new Date().toISOString(),
    error: {
      type: errorType,
      message,
      ...(error instanceof Error ? { name: error.name } : {}),
      ...(error instanceof KnownError ? {
        retryable: error.retryable,
        maxRetries: error.maxRetries,
      } : {}),
    },
    metadata: {
      userId: context.userId,
      teamId: context.teamId,
      botId: context.botId,
      eventId: context.eventId,
      provider: context.provider,
      meetingName: context.name,
      timezone: context.timezone,
    },
  };
}

export function createMeetingJoinedPayload(context: MeetingFailureContext): RecordingCompletedPayload {
  return {
    recordingId: context.botId ?? context.eventId ?? context.userId,
    status: 'recording',
    timestamp: new Date().toISOString(),
    metadata: {
      userId: context.userId,
      teamId: context.teamId,
      botId: context.botId,
      eventId: context.eventId,
      provider: context.provider,
    },
  };
}

export async function notifyMeetingJoined(payload: RecordingCompletedPayload, logger: Logger) {
  await sendWebhook(payload, logger, 'Meeting joined');
}

export async function notifyMeetingFailed(payload: MeetingFailedPayload, logger: Logger) {
  await Promise.allSettled([
    sendWebhook(payload, logger, 'Meeting failed'),
    rpushToRedisList(payload, logger, config.notifyRedisFailureList, 'Meeting failed'),
  ]);
}
