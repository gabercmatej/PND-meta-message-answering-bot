# Testing and evaluation

Two separate things, labelled separately:

- **Engineering tests**: deterministic unit and PostgreSQL integration tests with fake or recorded
  providers and fake Meta transports. They prove correctness of ingestion, policy, publishing and
  recovery logic. They say nothing about the quality of model-written Slovenian replies.
- **Quality evaluation**: replay of evaluation datasets through the same decision pipeline with a
  simulated publisher, scored against labels and gated. Only runs with a real model ("fresh") and
  human ratings say anything about reply quality.

No routine automated test performs a production public write, and no test calls the real Meta API
or a real model.

## Measured test results

Measured on **1 October 2026** against the private repository, in a fresh
clone (no `.env`, no credentials in the environment), Node.js 22.17.0 on Windows, integration tests against embedded real PostgreSQL.

The gate is `npm run check`: lint, then typecheck, unit tests, PostgreSQL integration tests and
build.

| Stage | Result |
|---|---|
| Lint (ESLint) | Pass, no findings |
| Typecheck (`tsc`, server and admin) | Pass |
| Unit + contract tests (Vitest) | **511 passed / 0 failed / 0 skipped**, 30 files, 5.1 s |
| Integration tests (Vitest + real PostgreSQL) | **222 passed / 0 failed / 0 skipped**, 21 files |
| Build (`tsc` + Vite admin build) | Pass |

**Total: 733 automated tests (511 unit + 222 integration) in 51 files.** `tests/contract/` and
`tests/e2e/` exist as directories but contain no tests yet. The admin workflow is covered through
HTTP-level integration tests rather than browser tests.

## Test categories

### Unit and contract (`tests/unit/`, 30 files, 511 tests)

| Category | Files | Tests |
|---|---:|---:|
| Webhook signature, payload normalization and resilience (all four surfaces, echoes, unsends, both Instagram routes, malformed shapes) | 3 | 64 |
| Meta Graph HTTP, read adapter, POST-only write transport, permission inventory | 4 | 57 |
| Decision pipeline, adversarial cases, building blocks (retrieval, validators, manifests), redaction, explanations | 6 | 118 |
| AI routing and providers, recorded-response regressions from the first real-model evaluation, fake-classifier gates | 4 | 96 |
| LIVE autosend eligibility (hard exclusions) | 1 | 32 |
| Sender context and reviewer-facing models | 3 | 41 |
| Evaluation tooling and seed-content validation | 3 | 18 |
| Configuration, environment loading, logging redaction, deployment packaging, traffic diagnostic | 6 | 85 |

### Integration on real PostgreSQL (`tests/integration/`, 21 files, 222 tests)

Each test file creates its own migrated database on a real PostgreSQL server.

| Category | Files | Tests |
|---|---:|---:|
| Webhook ingestion and durability | 2 | 42 |
| Reply items, review actions, publishing and idempotency | 5 | 63 |
| Controlled write verification | 1 | 14 |
| REVIEW readiness gate and Meta app status | 2 | 17 |
| Sender context | 1 | 10 |
| Worker operations (DM path, self-message suppression, drain with advisory lock and time budget, stale-backlog expiry, access health, SHADOW gate) | 1 | 17 |
| Decision outcomes and AI usage ledger (incl. daily cost cap, fresh-evidence approval rule) | 2 | 10 |
| Evaluation, Test Lab and seed CLI | 3 | 27 |
| Admin API, workspace API, roles | 2 | 14 |
| Migrations | 1 | 4 |
| Public traffic diagnostic | 1 | 4 |

### Representative scenarios (actual test titles, abbreviated)

Ingestion and durability:
- rejects unsigned and wrongly signed payloads without persisting anything
- persists a batched payload atomically with one job per new event, deduplicating redeliveries
- keeps an edit and a delete of the same comment as separate events
- does not acknowledge when the database is unavailable; rolls back the receipt when the job handoff fails
- handles delete-before-create out of order without resurrecting the comment
- keeps two concurrent deliveries of the same event down to one row and one job
- records the Slovenian text hash unchanged through signing, HTTP and persistence
- quarantines unreadable envelopes and unrecognised messaging events instead of acknowledging them silently
- processes queued jobs end-to-end through pg-boss, including after a worker restart

Review and publishing:
- stores a SHADOW item that the API, the dispatcher and the database all refuse to send
- edit & send preserves the AI draft, sends the exact human text once and audits every step
- a duplicate or concurrent approval never sends twice
- requires a verified capability per surface before any send
- an unknown outcome is never resent blindly and is reconciled from Meta
- a crash after recording the attempt becomes outcome_unknown, not a resend
- a pause holds approved items and resuming releases them
- a deleted source cancels the open item; an edited source blocks the send
- a business reply already on Meta marks the item handled instead of double-answering
- Messenger: no send after the 24-hour window
- without `LIVE_AUTOSEND_ENABLED` nothing is scheduled automatically; an auto item is handed back if LIVE is lowered before it is due

Write verification:
- prepare then execute sends ONE reply and marks the endpoint verified exactly once
- two concurrent executes of the same verification send exactly once
- read-back reconciliation confirms a write that reached Meta after a lost response
- a pause refuses prepare and execute; the database refuses `sending` while paused

### Fixtures

- 22 sanitized Meta webhook payload fixtures (`tests/fixtures/meta/`): Facebook comment created /
  edited (both verbs) / deleted / removed / hidden / reply, feed post and field-only changes,
  Instagram comment on both login routes, Messenger and Instagram DMs including attachment-only,
  echo, story reply and unsend, malformed envelope, unsupported field and event.
- Synthetic fixtures for end-to-end demos. Real customer exports and production corpora are kept
  out of Git.

## Evaluation harness

### Datasets (counts only)

| Dataset | Cases | Notes |
|---|---:|---|
| Synthetic smoke suite | 54 | All synthetic; Facebook and Instagram comments; 19 flagged critical; splits: 25 dev, 16 critical, 13 holdout. Covers FAQ, prices with and without facts, expired offers, campaign conflicts, complaints, legal questions, distress and threats, spam, prompt injection, personal data, invented links, self-threads, takeover, deletion, media-only |
| Synthetic Slovenian legal corpus | 90 | All synthetic; all 17 legal areas; 59 comments and 31 DMs; 56 Facebook and 34 Instagram; 24 flagged critical; splits: 53 dev, 24 holdout, 13 critical |
| Knowledge snapshots | 1 file | Frozen knowledge for chronological replay |
| Historical harvest | local only | Unlabelled public comments, read-only Graph, redacted, authors dropped. Never committed |

Both committed corpora were written alongside the pipeline. Passing them is a smoke and regression
signal, **not** an independent quality measurement.

### Case format and leakage controls

JSONL cases validated by a Zod schema: origin (`historical`, `synthetic`, `operator`), split
(`dev`, `holdout`, `critical`, `regression`), `asOf`, surface, thread / conversation (earlier turns
only), knowledge snapshot id, and expectations (allowed actions, intents, legal areas, required
facts, forbidden claims, required source ids).

- Thread turns after `asOf` and later brand replies are rejected as inputs. Later human replies are
  kept only as labels.
- A `groupKey` (thread or post) may not straddle holdout and other splits.
- Holdout cases are owner-only and must not be used for prompt tuning.
- Imports redact e-mails, phone numbers, IBANs, tax numbers and long digit sequences.

### Replay

- **chronological** mode: each case runs at its `asOf` with the knowledge as it was then (old
  offers are historical, not current truth).
- **current_policy** mode: each case runs now against the release's pinned knowledge.
- Replays run as queued background jobs with progress, cancellation, abandoned-run detection and an
  optional cost cap for real-model runs. They use the same `runDecisionPipeline()` as production
  with a simulated publisher.

### Provider kinds (always labelled)

| Kind | Meaning |
|---|---|
| `fake` | Deterministic keyword stand-in. Tests rules and grounding only |
| `recorded` | Replays captured model outputs by request hash. Engineering regressions |
| `fresh` | A real model. The only kind that can support release approval for a release pinning a real model |

### Gates (`gates-v1`)

Mandatory: zero critical violations, zero public-write escapes, action accuracy at least 95 %,
auto-reply precision at least 98 %, and every release-pinned knowledge version approved. These are
**gate thresholds**, not measured results. Informational: human quality (recorded at approval) and
representation (synthetic-only warning). The comparison gate requires no new critical failure versus
a baseline. Commands exit non-zero when a gate fails.

Human ratings (`good` / `acceptable` / `bad`, issue tags, note) are stored per run and case,
aggregated, and exported as CSV.

### How evaluation was used

The first real-model release candidate **failed** its mandatory gates. Every failure was reproduced
locally through the same pipeline and classified (retrieval, validator, policy, classifier output,
dataset, evaluator). The fixes were made in code, prompts and evaluation logic without weakening any
gate or changing labels, and each fixed case became a recorded-response regression test. The failed
candidate stayed immutable with its failed evidence and was never approved. A new release was
created, evaluated and approved on fresh-model evidence. A later production replay surfaced one
false positive in a forbidden-claim pattern (a correct negated statement); the pattern was made
negation-aware with dedicated regression tests, without changing the release.

### Test Lab (admin console)

- **Try a message**: one message through the same pipeline, showing every stage (input,
  understanding, retrieved knowledge, draft, deterministic and model validation, final decision)
  with latency and estimated cost. Stores no decision.
- **Replay runs, comparisons and ratings**: queue a replay of a dataset against a release, drill
  into each case (expected vs actual), compare two runs side by side, rate results.

Nothing in Test Lab can publish.
