# Meta integration

How the bot connects to Facebook and Instagram, what Meta actually confirmed, and where the
integration stands on **1 October 2026**.

## Current status (1 October 2026)

| Item | Status |
|---|---|
| Runtime | `BOT_MODE=REVIEW`, global mode REVIEW, Facebook and Instagram accounts REVIEW, `PUBLISHING_TRANSPORT=graph`, `LIVE_AUTOSEND_ENABLED=false`, `AI_PROVIDER=anthropic`, `META_ADAPTER=graph` |
| Meta Business Verification | **Verified** |
| Meta Access Verification | **In review** |
| Meta App Review (Advanced Access) | **In review**. Covers Facebook / Instagram messaging and comment permissions plus Business Asset User Profile Access |
| Meta app | **Unpublished** (Development mode). Only people with a role on the app produce events |

| Surface | Real inbound | Sending capability | Notes |
|---|---|---|---|
| Facebook Messenger | Works with real DMs | `messenger_send` **verified** | AI draft, human Approve / Edit & Send, Hold, No reply; exactly-once sending; real sender name and avatar for app-role / test users after Business Asset User Profile Access was enabled. Public users depend on Meta approving that feature |
| Instagram DM | Works with real DMs | `instagram_dm_send` **verified** | Sender name, @username and avatar work. The missing Development-mode prerequisite turned out to be the Instagram Tester role |
| Facebook comments | **Not yet reaching the pipeline** | `facebook_comment_reply` **unverified, sending blocked** | Page token valid, `feed` subscription present, Page reads pass and the test comment is readable through the Graph API, but a Development-mode Page comment has not been delivered to the pipeline. To be retested with an ordinary non-role account after the Meta app is published |
| Instagram comments | **Not proven** | `instagram_comment_reply` **unverified, sending blocked** | `comments` field subscribed; Meta's dashboard test webhook reaches the system, the signature verifies and it normalizes as an Instagram comment, then stops at `UNMANAGED_ACCOUNT` (the test payload is not the managed account). A real comment cannot arrive while the app is unpublished |

> **"Meta app Live" is not "bot LIVE."** Publishing the Meta app only lets Meta deliver events for
> people without an app role. The bot stays in REVIEW, autosend stays off, and every reply still
> needs a human. No environment change is expected when the app is published.

Next steps once Meta approves: publish the app, run the read-only access-health and REVIEW
readiness checks, test public DMs and public comments with ordinary accounts, and verify each
comment surface with one controlled write. Phase 1 is complete only when all four surfaces work in
REVIEW for ordinary public users.

## API contract

- **Graph API `v26.0`**, pinned explicitly in every URL (`META_GRAPH_VERSION` has no default and
  rejects `latest`).
- **Instagram API with Facebook Login** (the Instagram professional account is linked to a Facebook
  Page), so one Page token covers all four surfaces. The normalizer still accepts both Instagram
  payload routes.
- Webhook subscriptions: Page `feed` and `messages`; Instagram `comments` and `messages`.

| Surface | Webhook | Reply endpoint | Target |
|---|---|---|---|
| Facebook comment | `page` / `feed` (`item = comment`) | `POST /{comment-id}/comments` | Comment id; a reply-to-reply is posted under the top-level parent |
| Messenger | `page` / `messages` | `POST /{page-id}/messages` (`messaging_type: RESPONSE`) | PSID from the webhook |
| Instagram comment | `instagram` / `comments` | `POST /{ig-comment-id}/replies` | IG comment id; a reply goes under the parent |
| Instagram DM | `instagram` / `messages` | `POST /{linked-page-id}/messages` | IGSID from the webhook |

Conservative text limits per endpoint: Messenger 2000, Instagram DM 1000, Instagram comment 2200,
Facebook comment bounded at 8000 (database column). DMs respect Meta's 24-hour standard messaging
window with a 5-minute safety margin; the human-agent tag is not used.

### Identifiers

All external ids are **strings**. Instagram account ids exceed `Number.MAX_SAFE_INTEGER`, so numeric
parsing would silently corrupt them. Facebook comment ids are composite and parsed defensively;
message ids are opaque. Facebook and Instagram ids are never compared across APIs; uniqueness is
scoped by platform and managed account.

### Signature, acknowledgement, retries

- `X-Hub-Signature-256` HMAC-SHA256 over the **exact received bytes**, timing-safe comparison. The
  subscription challenge (GET) compares the verify token in constant time and only echoes a
  bounded, safe challenge string.
- Acknowledge only after the receipt, events and queue jobs have committed (see
  [message-lifecycle.md](message-lifecycle.md)). Meta's documentation describes retries for up to
  36 hours, and an endpoint failing for an hour can be unsubscribed, so durability and fast
  acknowledgement both matter.
- Meta provides no delivery id and no idempotency key, so deduplication is on business identity.
  Only Messenger documents ordering; every event is treated as possibly duplicated or out of order.

### Errors and rate limits

`classifyGraphError` maps Graph errors to kinds: `transient` (codes 1, 2, 5xx, timeouts: retried,
bounded), `rate_limited` (4, 17, 32, 613, 80001 / 80002 / 80006, HTTP 429: retried honouring
`Retry-After`), `auth` (190, 102: never retried, needs re-auth), `permission` (10, 200-family: never
retried), `not_found` (100 / 33) and `invalid_response`. On the **write** path the rules are
stricter: a timeout, 5xx, or a 2xx without an id is `unknown` (the write may have happened), and
codes 1 / 2 on a 4xx are also treated as `unknown`. Instagram window-closed subcodes map to
`window_closed`.

### Tokens and permissions

A single Page token, sent in the `Authorization` header and redacted from logs. A permission
inventory in code (`src/meta/permissions.ts`) maps every operation to its endpoint and permissions.
It drives three consumers: access health (required read scopes), the REVIEW readiness gate (write
scopes per surface) and the App Review package. `instagram_content_publish` is not used.

## Read adapters

Graph **read** adapters (GET only) for both platforms: comment, replies, content (caption, format,
preview image), message, conversation, sender profile. Verified against real Graph v26.0 responses.
The worker uses them to re-read sources, build context and run pre-send / reconciliation checks.
Errors are typed (`not_found`, `permission`, `auth`, `rate_limited`, `transient`,
`invalid_response`), so the worker can distinguish "retry later" from "the source is gone".

## Access health

`access-health` (CLI and admin card; runs persisted) is a read-only check of the Meta connection:
token validity, type, expiry, data-access expiry, scopes, write scopes for reply endpoints
(`token_write_scopes`), Page token resolution, Page subscribed fields, Facebook comment reads,
Messenger reads, Page / Instagram linkage, Instagram comment and conversation reads. Exit code 0 is
PASS, 2 is FAIL. The REVIEW readiness gate requires a recent PASS.

## Controlled write verification

The **only** way a sending surface becomes `verified` (`src/publishing/write-verification.ts`,
owner-only CLI):

1. **prepare**: owner names the account, endpoint and a known inbound test item produced by a
   consenting tester account, plus the exact short reply text. The system stores the exact text,
   target and a **hashed confirmation code** (valid 30 minutes) and prints the plan in plain words.
2. **execute**: requires the typed confirmation code. Row lock, pause check, a fresh Meta read, then
   `sending` is **committed before** exactly one POST.
3. Outcome: `succeeded` (capability verified, with evidence `write_verification:<id>`), `failed`
   (capability untouched), or `outcome_unknown` (never retried; `reconcile` reads Meta back, or the
   owner `resolve`s it as sent or absent after checking by hand).

It never touches a reply item or its AI draft. A hand-set `verified` is refused by the API.
Invariants are also enforced in the database.

## Diagnostics

- **Public traffic diagnostic** (read-only CLI): for each surface, shows how far the latest real
  inbound event got through: delivery observed, signature valid, normalized, managed account
  matched, recorded, reply item created, decision created, visible in Messages, sendable in REVIEW.
  The first "no" is printed as `STOPPED AT <stage> because <REASON_CODE>`. Example reason codes:
  `NO_WEBHOOK_DELIVERY`, `UNMANAGED_ACCOUNT`, `OWN_CONTENT_NOT_ANSWERED`, `NO_ACTIVE_RELEASE`,
  `SHADOW_ITEM`, `CAPABILITY_NOT_VERIFIED`, `MODE_NOT_PUBLISHING`, `PAUSED`,
  `MESSAGING_WINDOW_CLOSED`. It never prints message bodies, names, tokens or full identifiers.
- **Signature rejections** are counted per hour without storing bodies or identifiers.
- **Owner-recorded Meta app status** (app mode, Business Verification, Advanced Access per
  permission) is shown in Settings with an explicit note that it changes no bot mode.

## Paid / boosted content: honest limits

Instagram comment webhooks on the Facebook Login route can carry ad context; Facebook comment
webhooks carry none. There is no documented reverse lookup from a post to the ads using it, and one
post can back many ads, so the system does not invent campaign attribution. Campaign context comes
only from owner-maintained campaign profiles mapped to content, recorded as
`none | single | multiple | unknown`. Conflicting briefs on a shared post send pricing questions to
review.

## Out of scope by design

Cold outreach, comment-to-DM marketing, auto-hide / delete / ban, and ad or spend changes are not
part of this system.
