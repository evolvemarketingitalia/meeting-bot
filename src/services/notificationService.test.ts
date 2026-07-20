import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMeetingFailedPayload,
  createMeetingJoinedPayload,
  createWebhookPayload,
  getMeetingBotLifecycleCapabilities,
  isRetryableWebhookStatus,
} from './notificationService';

const context = {
  url: 'https://zoom.us/j/redacted',
  name: 'Sales Matrix Notetaker',
  teamId: 'workspace-id',
  timezone: 'Europe/Rome',
  userId: 'user-id',
  botId: 'session-id',
  provider: 'zoom',
};

test('joined lifecycle payload identifies the session and omits storage data', () => {
  const payload = createMeetingJoinedPayload(context);

  assert.equal(payload.recordingId, 'session-id');
  assert.equal(payload.status, 'recording');
  assert.equal(payload.blobUrl, undefined);
  assert.equal(payload.meetingLink, undefined);
  assert.equal(payload.metadata?.botId, 'session-id');
});

test('failed lifecycle payload carries a normalized error message', () => {
  const payload = createMeetingFailedPayload(context, new Error('join timeout'));

  assert.equal(payload.recordingId, 'session-id');
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error.message, 'join timeout');
});

test('failure payload redacts meeting URLs from error text', () => {
  const payload = createMeetingFailedPayload(
    context,
    new Error('navigation failed at https://zoom.us/j/123?pwd=secret'),
  );

  assert.equal(payload.error.message, 'navigation failed at [redacted-url]');
});

test('lifecycle webhook payload is versioned, idempotent and redacted', () => {
  const failure = createMeetingFailedPayload(context, new Error('join timeout'));
  const first = createWebhookPayload(failure);
  const second = createWebhookPayload(failure);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.eventType, 'failed');
  assert.equal(first.notificationId, second.notificationId);
  assert.equal(first.meetingLink, undefined);
  assert.equal(first.metadata?.meetingName, undefined);
  assert.equal(first.metadata?.timezone, undefined);
});

test('webhook retry policy rejects permanent client errors', () => {
  assert.equal(isRetryableWebhookStatus(undefined), true);
  assert.equal(isRetryableWebhookStatus(408), true);
  assert.equal(isRetryableWebhookStatus(429), true);
  assert.equal(isRetryableWebhookStatus(503), true);
  assert.equal(isRetryableWebhookStatus(400), false);
  assert.equal(isRetryableWebhookStatus(404), false);
  assert.equal(isRetryableWebhookStatus(401), false);
});

test('lifecycle capability is announced only with signed webhook delivery', () => {
  assert.deepEqual(
    getMeetingBotLifecycleCapabilities(true, 'https://worker.example/webhook', 'secret'),
    { lifecycleWebhook: 'meeting-bot.v1' },
  );
  assert.equal(getMeetingBotLifecycleCapabilities(false, 'https://worker.example/webhook', 'secret'), undefined);
  assert.equal(getMeetingBotLifecycleCapabilities(true, undefined, 'secret'), undefined);
  assert.equal(getMeetingBotLifecycleCapabilities(true, 'https://worker.example/webhook', undefined), undefined);
});
