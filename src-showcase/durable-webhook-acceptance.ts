/**
 * EXCERPT from a private codebase (src/api/ingest.ts), trimmed for illustration.
 * Not runnable on its own: imports, logging, the quarantine fallback for unreadable envelopes and
 * most columns are omitted.
 */

/**
 * Durable webhook acceptance. Order matters:
 *  1. verify the HMAC over the original bytes (no parsing before that);
 *  2. in ONE transaction store the receipt, normalized events and queue jobs;
 *  3. acknowledge only after commit. Any persistence failure returns 503 so Meta can retry.
 * No AI or Meta calls happen on the request path.
 */
export async function acceptWebhook(deps: Deps, input: { rawBody: Buffer; signatureHeader: string | undefined; correlationId: string }) {
  const signature = verifyWebhookSignature(input.rawBody, input.signatureHeader, deps.appSecret);
  if (signature !== 'valid') {
    // Counted per hour, never stored: the body is unauthenticated.
    await countRejection(deps.db, signature).catch(() => undefined);
    return { httpStatus: 401, body: 'invalid signature' };
  }

  const parsed = normalizeWebhookPayload(safeJsonParse(input.rawBody));

  try {
    const outcome = await withTransaction(deps.db, async (tx) => {
      const receiptId = await insertReceipt(tx, {
        payloadSha256: sha256Hex(input.rawBody),
        // Message text, names, usernames and media URLs are removed; identifiers are kept.
        payload: minimizePayload(parsed.payload)
      });

      let created = 0;
      let duplicates = 0;
      for (const e of parsed.events) {
        const { rows } = await tx.query<{ id: string; inserted: boolean }>(
          `INSERT INTO normalized_events (receipt_id, event_kind, object_external_id, dedupe_key, processing_state /* , ... */)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (dedupe_key) DO UPDATE SET observation_count = normalized_events.observation_count + 1,
             last_observed_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
          [receiptId, e.kind, e.objectExternalId, e.dedupeKey, e.kind === 'unknown' ? 'quarantined' : 'pending']
        );
        const row = rows[0]!;
        if (!row.inserted) {
          duplicates++; // a redelivery: observed again, never processed twice
          continue;
        }
        if (e.kind === 'unknown') continue; // quarantined, never acted on

        // The job is inserted INSIDE the same transaction (pg-boss `db` option).
        const jobId = await deps.boss.send('process-event', { eventId: row.id, correlationId: input.correlationId }, {
          db: transactionDb(tx),
          singletonKey: row.id
        });
        // A refused job would leave the event pending forever behind an HTTP 200. Roll back instead.
        if (!jobId) throw new Error(`queue refused a job for event ${row.id}`);
        created++;
      }
      return { receiptId, created, duplicates };
    });
    return { httpStatus: 200, body: 'EVENT_RECEIVED', ...outcome };
  } catch {
    return { httpStatus: 503, body: 'temporarily unavailable' };
  }
}
