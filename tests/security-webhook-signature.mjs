import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import signatureModule from '../dist/security/webhookSignature.js';

const { createWebhookAuthHeaders } = signatureModule;

test('emits legacy and replay-resistant v2 signatures during rollout', () => {
  const body = '{"recordingId":"test-recording","status":"completed"}';
  const secret = 'test-only-meeting-webhook-secret';
  const timestamp = '1787601600';
  const nonce = '017c9214-bb7d-4f06-8466-3bbcc7188884';
  const headers = createWebhookAuthHeaders(body, secret, timestamp, nonce);

  assert.equal(headers['X-Webhook-Timestamp'], timestamp);
  assert.equal(headers['X-Webhook-Nonce'], nonce);
  assert.equal(
    headers['X-Webhook-Signature'],
    crypto.createHmac('sha256', secret).update(body).digest('hex'),
  );
  assert.equal(
    headers['X-Webhook-Signature-V2'],
    crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest('hex'),
  );
});

test('uses a fresh RFC 4122 nonce and current seconds by default', () => {
  const before = Math.floor(Date.now() / 1000);
  const headers = createWebhookAuthHeaders('{}', 'test-only-secret');
  const after = Math.floor(Date.now() / 1000);

  assert.match(
    headers['X-Webhook-Nonce'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.ok(Number(headers['X-Webhook-Timestamp']) >= before);
  assert.ok(Number(headers['X-Webhook-Timestamp']) <= after);
});
