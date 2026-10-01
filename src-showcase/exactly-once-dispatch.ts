/**
 * EXCERPT from a private codebase (src/publishing/dispatch.ts), trimmed for illustration.
 * Not runnable on its own: the SQL context loader, the full list of local and remote checks,
 * outcome recording for rejections and the reconciliation reader are omitted or shortened.
 */

/**
 * Dispatcher: the ONLY path from a reply item to a Meta write.
 *
 * Exactly-once logical send per reply item:
 *  1. Lock the item (SKIP LOCKED), run every local pre-send check.
 *  2. Outside any transaction, re-read the source from Meta (still exists? already answered?).
 *  3. Lock again, verify nothing changed (row_version), re-check pause/mode, then record the
 *     attempt with the EXACT text and move the item to `sending`, and commit.
 *  4. Only then call the transport (one attempt, no internal retry).
 *  5. Record the outcome. A timeout/5xx/unreadable success is `outcome_unknown`: it is reconciled
 *     by reading Meta and is never resent automatically. A crash between 3 and 5 leaves a
 *     `pending` attempt that recovery turns into `outcome_unknown`.
 */
export async function dispatchReplyItem(deps: PublisherDeps, itemId: string): Promise<DispatchOutcome> {
  const now = deps.clock.now();

  // Phase 1: lock and local checks (SHADOW origin, pause, transport, mode, verified surface,
  // deleted / edited / taken-over source, messaging window, text limits, release and knowledge validity, daily limit).
  const first = await withTransaction(deps.db, async (tx) => {
    const ctx = await loadContext(tx, itemId, 'skip');
    if (!ctx) return { kind: 'skip' as const, code: 'LOCKED_OR_MISSING' };
    if (ctx.state !== 'approved' && ctx.state !== 'scheduled') return { kind: 'skip' as const, code: `STATE_${ctx.state.toUpperCase()}` };
    return { kind: 'ctx' as const, ctx, block: await localChecks(deps, tx, ctx, now) };
  });
  if (first.kind === 'skip') return { outcome: 'waiting', code: first.code };
  if (first.block) return applyBlock(deps.db, first.ctx, first.block, now);

  // Phase 2: remote checks, outside any transaction (fresh Meta reads).
  const remote = await remoteChecks(deps, first.ctx);
  if (remote) return applyBlock(deps.db, first.ctx, remote, now);

  // Phase 3: record the attempt with the exact text, then move to `sending`, then COMMIT.
  const { endpoint, target, page } = targetOf(first.ctx);
  const prepared = await withTransaction(deps.db, async (tx) => {
    const ctx = await loadContext(tx, itemId, 'wait');
    if (!ctx || ctx.row_version !== first.ctx.row_version || ctx.state !== first.ctx.state) return null;
    const recheck = await localChecks(deps, tx, ctx, now);
    if (recheck) return { block: recheck, ctx };
    const text = ctx.final_text!;
    const attemptNo = await nextAttemptNo(tx, ctx.id);
    const key = `${ctx.idempotency_key}#${attemptNo}`;
    await tx.query(`UPDATE reply_items SET state = 'sending', row_version = row_version + 1 WHERE id = $1`, [ctx.id]);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO publish_attempts (reply_item_id, attempt_no, idempotency_key, endpoint_kind, target_external_id, text_sent, text_sha256, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [ctx.id, attemptNo, key, endpoint, target, text, sha256Hex(text), now]
    );
    await recordAudit(tx, { actor: DISPATCHER_ACTOR, action: 'reply_item.send_started', targetType: 'reply_item', targetId: ctx.id });
    return { attemptId: rows[0]!.id, attemptNo, key, text, ctx };
  }).catch(() => 'refused' as const); // the database refused `sending` (a pause or mode change raced us): nothing was written
  if (prepared === 'refused') return { outcome: 'waiting', code: 'SEND_REFUSED_BY_DATABASE' };
  if (!prepared) return { outcome: 'waiting', code: 'CHANGED_CONCURRENTLY' };
  if ('block' in prepared && prepared.block) return applyBlock(deps.db, prepared.ctx, prepared.block, now);

  // Phase 4: the write. One attempt; any exception is an unknown outcome, never a failure.
  let result: SendOutcome;
  try {
    result = await deps.transport!.send({ endpoint, targetExternalId: target!, pageExternalId: page, text: prepared.text, idempotencyKey: prepared.key });
  } catch (err) {
    result = { kind: 'unknown', status: null, traceId: null, summary: err instanceof Error ? err.message.slice(0, 200) : 'transport error' };
  }

  // Phase 5: record the outcome (sent / bounded retry for throttling / failed / outcome_unknown).
  return recordOutcome(deps, prepared.ctx, prepared.attemptId, prepared.attemptNo, result);
}

/** Pending attempts left by a crash may have reached Meta: they become outcome_unknown, never resent. */
export async function recoverStalePending(deps: PublisherDeps): Promise<number> {
  const now = deps.clock.now();
  return withTransaction(deps.db, async (tx) => {
    const { rows } = await tx.query<{ id: string; reply_item_id: string }>(
      `UPDATE publish_attempts SET state = 'outcome_unknown', error_kind = 'crash_recovery', finished_at = $2, next_reconcile_at = $2
       WHERE state = 'pending' AND started_at < $1 RETURNING id, reply_item_id`,
      [new Date(now.getTime() - PENDING_STALE_MS), now]
    );
    for (const r of rows) {
      await tx.query(`UPDATE reply_items SET state = 'outcome_unknown', failure_code = 'OUTCOME_UNKNOWN', row_version = row_version + 1 WHERE id = $1 AND state = 'sending'`, [
        r.reply_item_id
      ]);
    }
    return rows.length;
  });
}
