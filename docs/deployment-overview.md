# Deployment overview

A high-level view of how the system runs. Host-specific details (provider, panel, paths, accounts,
certificates, runbooks) are intentionally omitted.

## Topology

| Component | How it runs |
|---|---|
| **API process** | A Node.js 22 application on a managed Node.js host, behind HTTPS (Meta requires TLS and does not accept self-signed certificates). Serves the Meta webhook endpoint, the authenticated admin API, the static admin console and the health endpoints `/health/live` and `/health/ready` (database check) |
| **Worker process** | The same codebase, a separate entry point. In production it runs as a **bounded drain** started every minute by a scheduler, because the API host may idle the application between requests. A long-running mode exists for hosts that keep processes alive |
| **PostgreSQL** | A managed PostgreSQL instance holding all state and the pg-boss job queue (own schema) |
| **Admin console** | React + Vite, built to static files and served by the API on the same origin |

## One worker drain run

1. Take a PostgreSQL **advisory lock**. If a previous run still holds it, exit immediately, so two
   drains never overlap.
2. Write a start **heartbeat** (with the worker's `BOT_MODE`, publishing transport and autosend
   flag, so a readiness check can detect configuration drift between the API and the worker).
3. Let pg-boss expire jobs a crashed run left active, so they are retried or dead-lettered.
4. **Expire stale backlog**: events still pending more than 24 hours after receipt are marked
   `STALE_BACKLOG_EXPIRED` instead of being answered late (deletions and unsends are always
   processed).
5. Process queued events until the queue is empty or the time budget (about 50 seconds) is used.
6. **Publisher pass** (only when a publishing transport is configured): crash recovery of stale
   pending attempts, dispatch of human-approved items, reconciliation of unknown outcomes.
7. If the event queue was emptied, advance queued Test Lab replay runs with any remaining budget; a
   replay pauses between cases at the deadline and resumes on the next run.
8. Write an end heartbeat with counts and exit.

The worker is the **only process that sends**. With `PUBLISHING_TRANSPORT=none` no transport object
exists and no publisher runs.

## Configuration and secrets

- Configuration is validated at startup (Zod). Unsafe combinations are startup errors: REVIEW or
  LIVE without a transport; autosend without `BOT_MODE=LIVE`; a Graph publishing transport without
  the Graph read adapter (pre-send checks and reconciliation read from Meta); the Graph adapter
  without a pinned API version and token; a fake transport outside development and test; in
  staging or production, a fake Meta adapter, a fake AI provider, a missing database URL or
  insecure cookies.
- Secrets (Meta app secret, verify token, Page token, AI provider key, database URL) live only in
  the server environment. They are never committed, never logged (structured logs with redaction)
  and never sent to the admin browser.
- Production settings in effect on 1 October 2026: `BOT_MODE=REVIEW`, `PUBLISHING_TRANSPORT=graph`,
  `LIVE_AUTOSEND_ENABLED=false`, `AI_PROVIDER=anthropic`, `META_ADAPTER=graph`.

## Database migrations

14 explicit SQL migrations, applied in order with checksums. Editing an applied migration fails
loudly. Later migrations are written to be additive and backward-compatible (new tables, nullable
columns, widened checks), so a previous build can run against a newer schema during a rollback.
The worker refuses to start against a database missing a migration. Migrations are covered by
integration tests.

## Operations tooling (compiled CLIs)

| Tool | Purpose | Writes? |
|---|---|---|
| `access-health` | Meta token, scopes, subscriptions and reads per surface | Records the check result only |
| `review-readiness` | REVIEW readiness per system, account and surface | No |
| `public-traffic-diagnostic` | How far the latest real inbound event per surface got | No (read-only, no Meta calls) |
| `sender-profile-retry` | Bounded re-read of failed sender-profile lookups | Graph GET only; audited |
| `write-verify` | Controlled write verification (`prepare`, `execute`, `status`, `reconcile`, `resolve`, `cancel`) | One owner-confirmed write per verification |
| `set-account-mode` | Gated, audited mode changes | Mode only; REVIEW only through the readiness gate |

## Rollback and kill switch

In order of escalation:

1. **Pause** (admin console): blocks new send permits at once (database trigger plus dispatcher).
   Requests already sent cannot be recalled and are shown honestly as in flight.
2. **Mode down** to SHADOW (always allowed, audited): approved or scheduled items go back to review;
   nothing is sent.
3. **Hard stop**: `PUBLISHING_TRANSPORT=none` and a lower `BOT_MODE`, set for both API and worker.
4. **Release rollback**: activate an earlier approved release (audited), or revoke a release, which
   removes all its activations in one transaction.
5. **Code rollback**: redeploy the previous build; additive migrations keep it compatible.

## Local development

`embedded-postgres` runs real PostgreSQL binaries under the developer's user account, so neither
local development nor the integration tests need a PostgreSQL install or Docker. The local console
defaults to a fake AI provider and a fake Meta adapter; a signed synthetic webhook can be simulated
from the command line. Nothing is sent anywhere.
