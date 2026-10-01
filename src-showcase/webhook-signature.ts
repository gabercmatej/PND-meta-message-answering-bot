/**
 * EXCERPT from a private codebase (src/meta/webhook-signature.ts), trimmed for illustration.
 * Not runnable on its own. No secrets: the app secret and verify token are injected at runtime.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureStatus = 'valid' | 'invalid' | 'missing';

/**
 * Verifies an X-Hub-Signature-256 header ("sha256=<hex>") over the ORIGINAL request bytes with a
 * timing-safe comparison. Nothing is parsed before this succeeds.
 */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, appSecret: string): SignatureStatus {
  if (!header) return 'missing';
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return 'invalid';
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const provided = Buffer.from(match[1]!, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected) ? 'valid' : 'invalid';
}

/** Subscription challenge check (GET). The verify token is distinct from the app secret. */
export function verifySubscriptionChallenge(
  query: Record<string, unknown>,
  verifyToken: string
): { ok: true; challenge: string } | { ok: false } {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return { ok: false };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return { ok: false };
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, challenge };
}
