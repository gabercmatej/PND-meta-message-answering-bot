# Architecture

> Status as of **1 October 2026**. Everything below describes code that exists in the private
> repository. Where something is built but switched off (LIVE autosend) or not yet proven against
> real traffic (comment surfaces), it is labelled that way.

## Shape of the system

One Node.js 22 / strict TypeScript repository, one PostgreSQL database, two runtime processes and a
small admin console. It is a **modular application**: one codebase with separate API and worker
processes, not microservices.

| Part | Responsibility |
|---|---|
| **API process** (Fastify) | Meta webhook endpoint (signature check over raw bytes, durable acceptance), authenticated admin API, static admin UI, health endpoints |
| **Worker process** | Processes queued events: Meta reads, context snapshot, decision pipeline, reply items, publisher pass, reconciliation, Test Lab replay jobs |
| **PostgreSQL** | All application state, plus the job queue (pg-boss in its own schema). Invariants are also enforced by CHECK constraints and triggers |
| **Admin console** (React + Vite, built to static files) | Home, Messages (the human review workspace), Knowledge, Test Lab, Settings |

Diagram: [../diagrams/architecture.md](../diagrams/architecture.md).

## Module boundaries (`src/`)

| Module | What it owns | What it may not do |
|---|---|---|
| `api` | HTTP: webhooks, admin API, auth (sessions, CSRF, roles), static console | Make AI or Meta calls on the webhook request path |
| `meta` | Webhook signature verification, payload normalization, Graph **read** adapters (Facebook and Instagram kept separate), permission inventory | Write to Meta |
| `context` | Immutable, bounded `ContextSnapshot` (comment or DM, thread / conversation, post, campaign briefs, explicit unknowns) | Carry sender names or avatars |
| `domain` | Modes, intents (categories), legal areas, risk vocabulary, redaction | Depend on infrastructure |
| `behavior` | Versioned, immutable release manifests; scoped overrides; approval / activation / rollback / revocation | Loosen code invariants |
| `knowledge` | Knowledge schema, eligibility (approved / validity window / scope), keyword retrieval, contradiction detection | Ground replies with unapproved or unpinned entries |
| `ai` | Provider contract, release-pinned routing (Anthropic, fake, recorded), structured-output schemas, usage ledger | Hold a Meta token, a publisher, or database access |
| `pipeline` | `runDecisionPipeline()`: the single decision function; deterministic validators | Know the runtime mode or publish |
| `inbox` | Reply items (the "Messages" workspace), human review actions, sender lookup for reviewers | Write to Meta |
| `publishing` | **The only module that may write to Meta**: eligibility, dispatcher, Graph POST transport, controlled write verification, reconciliation | Be imported by AI / pipeline / evaluation code |
| `evaluation` | Datasets, frozen cases, replay, scoring, gates, comparisons, ratings | Publish (simulated publisher only) |
| `operations` | Runtime controls (mode, pause), accounts, audit log, access health, REVIEW readiness gate, traffic diagnostic, heartbeat | — |
| `worker` | Queue drain, event processing, publisher pass, stale-backlog expiry | — |
| `cli` | Owner / operator CLIs compiled for production (read-only diagnostics, gated mode changes, write verification) | — |

The two most important boundaries are enforced mechanically, not by convention:

1. **Only `src/publishing/` can construct or import a write transport.** ESLint `no-restricted-imports`
   rejects any import of the transport modules from outside `src/publishing/` (tests excepted).
2. **AI, pipeline and evaluation code cannot reach Meta adapters or publishing.** A second ESLint
   rule forbids those imports. The AI provider interface receives a rendered, already-redacted
   prompt and a JSON schema, and returns text. It has no tools and no side effects.

## One decision pipeline

`runDecisionPipeline(snapshot, release, knowledge)` in `src/pipeline/decide.ts` is used by:

- the worker for real Meta events (any runtime mode),
- the admin "Try a message" preview,
- Test Lab replay runs and offline evaluation.

The pipeline does not know the runtime mode and has no publishing capability. Callers decide what
to do with the result: store it as SHADOW evidence, create a reply item for human review, or (only
in a future LIVE phase) schedule it. Modes therefore differ **only at dispatch eligibility**, not in
how a decision is made. See [message-lifecycle.md](message-lifecycle.md) and
[safety-and-review.md](safety-and-review.md).

## Runtime modes

`OFF < SHADOW < REVIEW < LIVE`, ordered from least to most permissive (`src/domain/modes.ts`). The
effective mode is the **least permissive** of:

- `BOT_MODE`, the deployment ceiling from the environment,
- the global mode (database, audited),
- the per-account mode (database, audited).

A global pause blocks publishing whatever the modes say. Replay is not a runtime mode; it is a
separate code path with a simulated publisher. Diagram: [../diagrams/mode-flow.md](../diagrams/mode-flow.md).

## Data model (shape only)

14 explicit, additive SQL migrations (`db/migrations/0001` to `0014`), applied with checksums that
fail loudly if an applied migration is edited. The main tables:

| Area | Tables |
|---|---|
| Ingestion | `webhook_receipts` (minimized payload, body hash, byte facts), `normalized_events` (dedupe key, processing state), `webhook_signature_rejections` (hourly counters, no bodies) |
| Inbound objects | `comments`, `direct_messages`, `content_objects`, `context_snapshots`, `sender_profiles` (reviewer-only) |
| Campaign context | `context_profiles`, `context_profile_versions`, `content_profile_mappings` |
| Behavior and knowledge | `behavior_releases` (immutable), `activations` (scope pointer), `activation_history`, `knowledge_entries`, `knowledge_versions` |
| Decisions | `decisions` (result JSON, reason codes, source refs, release checksum, intent, legal area, risk level) |
| Review and publishing | `reply_items`, `publish_attempts`, `publishing_settings`, `platform_capabilities`, `write_verifications` |
| Evaluation | `eval_datasets`, `eval_cases`, `eval_runs`, `eval_results`, `eval_labels`, `eval_ratings` |
| Operations | `runtime_controls`, `managed_accounts`, `users`, `sessions`, `audit_events`, `access_health_runs`, `service_heartbeats`, `ai_usage`, `meta_app_status` |

All Meta identifiers are stored as strings. Instagram account ids exceed JavaScript's safe integer
range, so this is a correctness requirement.

## Technology choices (and why)

Recorded as architecture decision records in the private repository:

| Choice | Reason |
|---|---|
| `pg` + explicit SQL migrations, no ORM | The schema is reviewable SQL; parameterized queries throughout |
| pg-boss 12 for the queue | Its `send(..., { db })` option inserts the job **inside the caller's transaction**, so the webhook receipt, normalized events and job commit atomically. No custom outbox needed. Retries with backoff and a dead-letter queue are configured |
| Embedded real PostgreSQL for local dev and tests | Integration tests run against real PostgreSQL, never mocks |
| Zod at every external boundary | Webhook payloads, AI outputs, manifests, knowledge bodies, API bodies, evaluation cases |
| Local username/password admin auth (scrypt, DB sessions, HTTP-only SameSite=Strict cookie, CSRF header, login throttling) | Roles (`viewer`, `editor`, `owner`) are enforced server-side |

## Related documents

- [message-lifecycle.md](message-lifecycle.md): from webhook bytes to a sent reply
- [safety-and-review.md](safety-and-review.md): invariants, REVIEW workflow, publishing safeguards
- [knowledge-system.md](knowledge-system.md): knowledge schema, retrieval, releases
- [meta-integration.md](meta-integration.md): Meta contract, surfaces, write verification, current status
- [testing-and-evaluation.md](testing-and-evaluation.md): test suite and evaluation harness
- [deployment-overview.md](deployment-overview.md): runtime topology at a high level
