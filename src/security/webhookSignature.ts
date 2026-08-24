import crypto from 'crypto';

export interface WebhookAuthHeaders {
  'X-Webhook-Signature': string;
  'X-Webhook-Signature-V2': string;
  'X-Webhook-Timestamp': string;
  'X-Webhook-Nonce': string;
}

export function createWebhookAuthHeaders(
  body: string,
  secret: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
  nonce = crypto.randomUUID(),
): WebhookAuthHeaders {
  const legacySignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  const signatureV2 = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');

  return {
    'X-Webhook-Signature': legacySignature,
    'X-Webhook-Signature-V2': signatureV2,
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Nonce': nonce,
  };
}
