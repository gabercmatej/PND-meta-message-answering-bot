# Message lifecycle

From the raw webhook bytes Meta sends to exactly one human-approved reply. Status as of
**1 October 2026**. Diagram: [../diagrams/message-flow.md](../diagrams/message-flow.md).

## 1. Webhook acceptance (API process)

`acceptWebhook()` (`src/api/ingest.ts`). Order matters:

1. **Verify the HMAC over the original request bytes**: `X-Hub-Signature-256: sha256=<hex>`,
   HMAC-SHA256 keyed with the app secret, compared with `crypto.timingSafeEqual`. Nothing is parsed
   before this. The SHA-1 header is not accepted as a fallback.
   - Missing or invalid signature: HTTP 401. The body is **not stored** (it is unauthenticated);
     only an hourly counter per status is incremented (`webhook_signature_rejections`).
2. Parse and **normalize** the payload into platform-neutral events (see §2).
3. In **one database transaction**: insert the receipt (minimized payload: message text, names,
   usernames and media URLs replaced by `[removed]`, identifiers kept), insert each normalized event
   with `ON CONFLICT (dedupe_key)`, and enqueue one pg-boss job per *new* event **inside the same
   transaction**.
4. **Acknowledge only after commit.** Any persistence failure returns 503 so Meta retries. If the
   queue refuses a job, the whole transaction rolls back (an event must never sit `pending` behind
   an HTTP 200 with no job).

No AI call and no Meta call happens on the request path. Meta's Messenger documentation asks for a
200 within 5 seconds and treats a slow acknowledgement as a failure, which is why all decision work
is deferred to the worker.

The receipt also records byte-level facts (`bytes`, `nonAscii`, `unicodeEscapes`) because the raw
body is not retained. This instruments an open question from Meta's documentation (whether the
signature is computed over literal UTF-8 or a `\uXXXX`-escaped serialization), which matters for
Slovenian letters such as č, š and ž.

## 2. Normalization (`src/meta/webhook-payload.ts`)

Event kinds: `comment_created`, `comment_edited`, `comment_deleted`, `message_received`,
`message_deleted`, `unknown`.

| Surface | Webhook object / field | Notes |
|---|---|---|
| Facebook Page comment | `page` / `feed` with `item = comment` | `verb` accepted in both documented spellings (`edit`/`edited`, `remove`/`delete`); `hide`/`unhide` recorded as moderation signals, not acted on |
| Messenger | `page` / `messages` | `message.text` is never assumed (attachments, stickers, reactions, unsends) |
| Instagram comment | `instagram` / `comments` | Both Instagram routes accepted: `value.comment_id` (Facebook Login) and `value.id` (Instagram Login). Accepting only one silently dropped every comment in an earlier version |
| Instagram DM | `instagram` / `messages` | `message.is_deleted` marks an unsend |

Facebook and Instagram are separate adapters with separate id spaces. All ids are strings.

**Anything unrecognized is quarantined, never acted on**, with a reason such as
`UNRECOGNIZED_<object>_messaging`, `IGNORED_page_feed_item_<item>`, `UNPARSEABLE_CHANGE_...`,
`MODERATION_page_feed_comment_<verb>` or `NO_EVENTS_...`. An envelope that yields no event at all
still leaves one quarantined, findable row (`UNPARSEABLE_ENVELOPE_...`).

**Self-echo suppression**: Meta replays the business's own outgoing messages back as webhooks. These
are quarantined as `SELF_ECHO_<object>_messaging`. The worker adds a second line of defence: a
message whose sender is the Page or the linked Instagram account is ignored as `SELF_MESSAGE`, and a
comment written by the account itself gets no reply item and is skipped by the pipeline
(`SELF_AUTHORED`).

### Deduplication

Transport deduplication and business deduplication are deliberately different:

- **Transport**: `dedupeKey = sha256(platform | account | kind | objectId | textHash | ...)`. The same
  change delivered twice maps to the same key and only increments `observation_count`. An **edit**
  (new text hash) or a **delete** of the same comment is a different event and is kept.
- **Business**: one reply item per inbound comment or DM (unique indexes on `reply_items.comment_id`
  and `.message_id`), and one decision per `(comment, text hash, release checksum)` via a unique
  partial index. Regenerating a draft never creates a second publish entitlement.

## 3. Worker processing (`src/worker/process-event.ts`, `process-message.ts`)

The worker claims an event (`FOR UPDATE`), marks it `processing`, and does the slow work **outside**
database transactions:

1. Incomplete event: `quarantined / INCOMPLETE_EVENT`. Unknown Page or Instagram account:
   `ignored / UNMANAGED_ACCOUNT`.
2. `comment_deleted`: the comment is marked deleted and every open reply item for it is cancelled.
3. **Authoritative mode check at processing time** (not at receipt time). `OFF` stops here
   (`MODE_OFF`).
4. **Re-read the source from Meta.** Comment webhooks carry ids, and the Graph read is authoritative
   for text and thread position. A `not_found` read marks the comment deleted. A permission error
   is recorded. Transient and rate-limit errors throw `RetryableReadError`, so the job is retried by
   pg-boss with backoff and, after the retry limit, dead-lettered (`RETRIES_EXHAUSTED`).
5. Upsert the comment. An edit bumps `text_version` when the text hash changes.
6. **Reviewer context** (never AI input): commenter name / username from the webhook; for DMs the
   worker reads the Messenger / Instagram user profile at most once per sender per TTL (7 days on
   success, 24 h on permission-type failures, 1 h on transient ones). An empty profile returned
   with HTTP 200 is recorded as a failed lookup (`empty_profile`), not a success. A bounded,
   audited `sender-profile-retry` CLI re-reads failed lookups (GET only). Failures never fail or
   delay the event.
7. **Create the reply item** (unless the comment is the business's own) with `mode_at_creation`
   set to the real effective mode, downgraded to SHADOW when no publisher is configured
   (`MODE_DOWNGRADED_NO_PUBLISHER`).
8. Resolve the **active release** for the account (account scope first, then global; approved only).
   No release: `NO_ACTIVE_RELEASE`.
9. **Build the context snapshot**: comment, up to N earlier thread turns (release-configured),
   whether the business already replied in the thread, post caption and format, campaign briefs and
   attribution (`none | single | multiple | unknown`), or for DMs up to 30 earlier conversation
   turns. Facts that could not be read are listed explicitly in `unknowns` (`POST_CAPTION`,
   `PARENT_COMMENT`, `CONVERSATION_HISTORY`, ...) and are never guessed. The snapshot carries a
   **pseudonym**, not a name.
10. Run `runDecisionPipeline()` (see [safety-and-review.md](safety-and-review.md#the-decision-pipeline)).
11. In one transaction: store the snapshot, the decision (with release checksum, reason codes,
    source refs, intent, legal area, risk level), one `ai_usage` row per model call, and apply the
    decision to the reply item (AI draft, eligibility codes, state `needs_review` / `skipped` / ...).

**Stale backlog** (`src/worker/drain.ts`): pending events older than a threshold are expired as
`STALE_BACKLOG_EXPIRED` rather than answered late in a flood after an outage (deletions are always
processed).

**Out-of-order and edits**: deletes before creates are caught by the pre-send recheck (source
existence is re-read from Meta). Edits after a draft change the stored text hash; the dispatcher
compares it with the hash the draft answered and refuses to send (`SOURCE_EDITED`).

## 4. Human review (Messages)

In REVIEW, every reply item that is not skipped waits in **Messages** as `needs_review`. The server
computes `allowedActions`. The UI only renders what the server allows, and a stale `rowVersion` is
a 409. Details: [safety-and-review.md](safety-and-review.md#human-review).

## 5. Dispatch (publishing module)

`dispatchReplyItem()` (`src/publishing/dispatch.ts`) is the only path from a reply item to a Meta
write. It runs in the worker's publisher pass:

1. **Lock** the item (`FOR UPDATE SKIP LOCKED`) and run every **local pre-send check**: SHADOW
   origin, pause, transport present, effective mode, surface disabled, **surface capability
   verified**, source deleted, human takeover, do-not-answer, source edited, target known,
   24-hour messaging window (5-minute margin), text non-empty and within the endpoint limit,
   release still approved and cited knowledge still approved and in its validity window (for
   unedited AI drafts), daily send limit.
2. **Remote checks, outside any transaction**: re-read the source from Meta (still exists?) and the
   replies / conversation (did someone on the business side already answer?). An existing answer
   makes the item `handled / ALREADY_ANSWERED`.
3. **Lock again**, verify nothing changed (`row_version`), re-run the local checks, then in one
   transaction move the item to `sending` and **insert the publish attempt with the exact text,
   target, endpoint and text hash**, then commit.
4. **One** POST through the Graph transport. No internal retry.
5. Record the outcome:
   - `sent`: store the platform id; the item becomes `sent` (final; a DB trigger refuses changes).
   - definite rejection: `failed` (permission, auth, window closed, ...), or a bounded retry
     (at most 3 attempts in total) only for throttling.
   - **timeout, network failure, 5xx, or 2xx without an id**: `outcome_unknown`. Never resent.

## 6. Unknown outcomes and reconciliation

- A crash between step 3 and 5 leaves a `pending` attempt. After 5 minutes `recoverStalePending()`
  turns it into `outcome_unknown` (`crash_recovery`).
- `reconcileUnknown()` reads Meta (replies under the target comment, or the conversation) looking
  for a business-authored message with the same normalized text in the time window. Found: the
  attempt becomes `reconciled_sent` and the item `sent`. Not found after 3 successful reads: the
  item goes back to a human as `OUTCOME_UNKNOWN_NOT_FOUND` with the instruction to check Facebook /
  Instagram before sending again. A failed read does not count as "not found".
- A unique partial index allows **at most one open (`pending` / `outcome_unknown`) attempt per reply
  item**, so a parallel send or a blind resend is refused by the database.

## Example payloads

Synthetic examples shaped after the runtime schemas: [../examples/](../examples/README.md).
