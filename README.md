# PND Meta Message Answering Bot

A production human-in-the-loop AI system that handles Facebook and Instagram comments and direct
messages for a Slovenian legal advisory service. Signed Meta webhooks are stored durably and turned
into reply drafts. The system classifies each message by intent, legal area and risk, retrieves
versioned, approved legal and service knowledge, and then either writes a constrained draft with
Anthropic's Claude or uses an approved fixed text. Deterministic code validates the result and
decides what may happen next. A person approves every reply, and a single verified publishing
module sends it exactly once.

Built for [Pravnik na dlani](https://pravniknadlani.si/), a Slovenian legal advisory service that
offers consultations with lawyers, legal opinions and document preparation. Conversations can touch
on employment, family, inheritance and other legal matters, so retrieval quality, uncertainty
handling, human review and controlled publishing were core requirements from the start.

<p align="center">
  <img src="assets/pnd-bot-hero.png" alt="PND admin UI: overview dashboard, unified Facebook and Instagram inbox with an AI draft awaiting human review, approved knowledge base and Test Lab pipeline trace" width="100%">
</p>
<p align="center"><sub>Real admin UI from an isolated instance with synthetic data. No real users or messages are shown.</sub></p>

**At a glance:** Messenger · Instagram DM · Facebook and Instagram comments &nbsp;|&nbsp;
OFF / SHADOW / REVIEW / LIVE modes &nbsp;|&nbsp; deployed in REVIEW &nbsp;|&nbsp; 733 automated tests

> This repository is a portfolio case study of a private production system. It contains
> documentation, diagrams, sanitized examples, representative source excerpts and screenshots, not
> the application source. See [Privacy](#privacy) and [NOTICE.md](NOTICE.md).

---

## Product walkthrough

<table>
  <tr>
    <td width="50%" valign="top"><img src="screenshots/01-overview.png" alt="Overview dashboard"><br><b>1. Overview.</b> Bot mode (Review), channel and AI status, and the day's comments, DMs, items needing review and replies sent.</td>
    <td width="50%" valign="top"><img src="screenshots/02-messages.png" alt="Unified Facebook and Instagram inbox with AI draft"><br><b>2. One inbox for Facebook and Instagram.</b> Comments and DMs in one queue. Each AI draft shows its action, risk, legal area and reason, and nothing is sent until a person decides.</td>
  </tr>
  <tr>
    <td valign="top"><img src="screenshots/04-draft-vs-final.png" alt="AI draft compared with the reply that was sent"><br><b>3. AI draft vs. what was sent.</b> The original draft and the human-edited final reply are both kept, with who sent it.</td>
    <td valign="top"><img src="screenshots/03-edit-and-send.png" alt="Edit and Send with activity trail"><br><b>4. Edit &amp; Send and the activity trail.</b> The reviewer edits a copy; the AI draft stays unchanged and every step is audited.</td>
  </tr>
  <tr>
    <td valign="top"><img src="screenshots/07-knowledge.png" alt="Approved knowledge entries"><br><b>5. Approved knowledge only.</b> Typed entries with validity, approval and source. Anything not here stays unknown and goes to a person.</td>
    <td valign="top"><img src="screenshots/08-test-lab-pipeline.png" alt="Test Lab stage-by-stage pipeline trace"><br><b>6. Test Lab pipeline trace.</b> The same decision pipeline as real traffic, every stage visible, never published. This run uses the deterministic stand-in provider.</td>
  </tr>
</table>

Safety and readiness controls (modes, high-risk holds, write verification, Meta readiness) are shown
further down in [Operating modes](#operating-modes), [Safety and publishing](#safety-and-publishing)
and [Status](#status).

---

## From Meta to production

The system is built and deployed against the real Meta platform, not a mock:

```text
Meta platform          Facebook Page + Instagram professional account (Messenger, IG Direct, comments)
      │  signed webhooks (HMAC-SHA256)
      ▼
PND webhook / API      meta.pravniknadlani.si: verify signature, store, acknowledge
      │  one PostgreSQL transaction
      ▼
Worker + PostgreSQL    durable queue, Graph API re-reads, context snapshot
      │
      ▼
Legal knowledge + AI   classification, release-pinned retrieval, constrained Claude draft, validation
      │
      ▼
Human review           Messages workspace: approve, edit, hold, no reply
      │
      ▼
Verified publisher     full pre-send recheck, exact text persisted, one write
      │
      ▼
Meta Graph API         reply on Messenger / Instagram DM (verified surfaces only)
```

<table>
  <tr>
    <td width="50%" valign="top"><img src="screenshots/13-meta-developer-app.png" alt="Meta Developer dashboard showing the PravnikNaDlani app in Development mode, App ID redacted"><br><b>Meta Developer app.</b> The Meta app behind the Messenger and Instagram integration, still in Development mode while Advanced Access and App Review were being completed. App ID removed.</td>
    <td width="50%" valign="top"><img src="screenshots/14-production-node-app.png" alt="Hosting panel showing the Node.js 22 application for meta.pravniknadlani.si, server path redacted"><br><b>Production Node.js application.</b> The Node.js 22 app serving meta.pravniknadlani.si. The panel's "Application mode" only sets NODE_ENV, which the app does not read; the bot itself runs in REVIEW. Server account path removed.</td>
  </tr>
</table>

A real external platform, a real backend, a real review UI and a real deployment. The Meta app is
registered with Business Verification complete. The Node.js API and worker run on managed hosting
with PostgreSQL, and real Messenger and Instagram DM conversations have gone through the full loop.

## Why this is more than a chatbot

A naive integration is three steps:

```text
user message → LLM → send
```

This system treats the model as one untrusted component inside a controlled pipeline:

```text
Meta event
 → signature validation over the original bytes
 → durable ingestion (receipt, events and queue job in one transaction, then acknowledge)
 → normalization (Facebook and Instagram adapters, string IDs, deduplication)
 → context (source re-read from Meta, thread or conversation, post caption, pseudonymous author)
 → classification (intent, legal area, risk level and flags)
 → knowledge retrieval (only approved entries pinned by the active release)
 → constrained AI draft, or an approved fixed text
 → validation (deterministic validators, optional model check)
 → code-controlled decision (reply, clarify, hand off, review, skip)
 → human review
 → publishing eligibility (mode, pause, verified surface, source still exists, not already answered)
 → one verified Graph API write
```

The model can propose. Only code decides, and only a person approves.

## Operating modes

| Mode | Inbound processing | AI draft | Human review | Sending |
|---|---|---|---|---|
| **OFF** | Webhooks are verified and stored; the worker records `MODE_OFF` and stops | No | No | No |
| **SHADOW** | Full pipeline on real traffic | Yes, stored as evidence | Visible, read-only | **Never.** SHADOW items can never become sendable |
| **REVIEW** | Full pipeline | Yes | Every reply | Only after a human action, on a write-verified surface |
| **LIVE** | Full pipeline | Yes | Everything except a narrow low-risk allowlist | Delayed autosend for eligible items only. Architecture exists, **not enabled** |

- The effective mode is the least permissive of the deployment ceiling, the global mode and the
  per-account mode. A global pause blocks new sends in every mode.
- Startup refuses unsafe combinations, such as REVIEW without a publishing transport or autosend
  outside LIVE.
- **Current deployment: REVIEW.** Automated LIVE sending is **not enabled**.
- **Meta app "Live/Published" is a separate concept from bot LIVE.** Publishing the Meta app only lets
  Meta deliver events from people without a role on the app. The bot stays in REVIEW and every reply
  still needs a person.

![Bot status Off / Shadow / Review / Live with per-channel modes](screenshots/10-mode-controls.png)

*Mode controls: the server caps the bot at Review, and per-channel modes can never exceed the global
mode. Live is not available in this version.*

More: [docs/safety-and-review.md](docs/safety-and-review.md#modes-and-the-dispatch-boundary).

## Legal knowledge

The model is not expected to "just know" Slovenian law. What the bot may say comes from a structured,
versioned knowledge base, and code checks that it did.

- **Classification before retrieval.** Each message is first classified into one of 17 Slovenian
  legal areas (or "not a legal question"), one of 14 intents and a risk level. The legal area shapes
  retrieval and routing.
- **Structured, versioned, immutable.** Knowledge entries are typed (FAQ, service fact, price, offer,
  contact route, link, policy boundary, legal-area guidance) and have a scope, a validity window and
  a source. Editing creates a new version, and stored versions cannot change.
- **Business facts are deterministic.** Prices, links and contact routes are stored as structured
  values. Validators reject any figure, URL, contact or offer term in a draft that the cited entries
  do not support.
- **Only relevant knowledge reaches the model.** Retrieval runs over the entries the active release
  pins, filters out unapproved, expired and out-of-scope entries, and passes only the top matches.
- **Releases are evaluated before activation.** A behavior release pins knowledge versions, prompts,
  models and rules, is replayed against evaluation datasets, and can be approved only on passing
  gates for that exact checksum.
- **Uncertainty forces human handling.** Missing, conflicting or expired facts, personal legal
  situations and elevated risk send the item to a person instead of producing an answer.
- **It supports legal staff; it does not replace a lawyer.** The bot does not give individualized
  advice, calculate deadlines or promise outcomes. Legal questions get an approved referral to a
  lawyer.

A sanitized, conceptual example of how a general legal question is handled:

```text
User:       "Kolikšen je odpovedni rok pri redni odpovedi?"
            ("What is the notice period for an ordinary termination?")
Legal area: employment law
Intent:     general legal topic
Risk:       low, no risk flags; needs a lawyer
Retrieval:  pinned, approved entries for employment law and lawyer referral
Routing:    code chooses a hand-off, so no AI answer to the legal question is generated
Mode:       REVIEW
Result:     approved lawyer-referral draft, waiting for a person to approve, edit or hold
```

The bot does not answer the legal question itself. The full synthetic decision record is in
[examples/sanitized-decision.json](examples/sanitized-decision.json).

More: [docs/knowledge-system.md](docs/knowledge-system.md).

## Safety and publishing

- **The final send decision is code-controlled.** Model output is schema-validated and still treated
  as untrusted. Routing, risk handling and send eligibility are decided in code.
- **The model cannot publish.** AI code has no Meta token, no tools and no database access. Only the
  publishing module can write to Meta, and a lint rule enforces that boundary.
- **Each Meta write surface needs controlled write verification.** A surface can send only after one
  owner-confirmed, audited test write has succeeded on it. A hand-set "verified" is refused.
- **SHADOW items can never become sendable.** The API, the dispatcher and the database (a CHECK
  constraint and triggers) all refuse.
- **Duplicate sends are prevented.** Business-level deduplication, row-version checks on every
  review action and at most one open publish attempt per item.
- **Outbound text is frozen before the Graph write.** The exact text and the attempt are committed
  first, and the dispatcher rechecks pause, mode, source existence and prior replies right before
  the write.
- **Uncertain outcomes are never retried blindly.** A timeout or crash after the write becomes
  `outcome_unknown` and is reconciled by reading Meta back.
- **Self-echoes are ignored.** Meta's echoes of the business's own messages and the business's own
  comments never produce a reply.
- **The AI draft and the human final text are stored separately**, so every edit is visible.
- **Every review action is audited** with the actor and before and after state.
- **High-risk messages go to a person.** Distress, threats and self-harm always need a human, and
  the bot writes no reply text for them.

### REVIEW message lifecycle

```mermaid
flowchart TD
    IN["New message or comment"] --> PIPE["Decision pipeline<br/>draft and reason codes"]
    PIPE --> NR["Needs review"]
    PIPE --> SK["Skipped<br/>no reply needed"]
    NR -->|"Hold, No reply, Mark handled"| DONE["Held, skipped or handled"]
    NR -->|"Approve & Send or Edit & Send"| AP["Approved<br/>AI draft kept, final text stored"]
    AP --> CHK{"Pre-send recheck"}
    CHK -->|"blocked"| NR
    CHK -->|"passes"| SND["Sending<br/>exact text persisted"]
    SND -->|"Meta returned an id"| SENT["Sent"]
    SND -->|"timeout or crash"| UNK["Outcome unknown"]
    UNK -->|"read-back finds the reply"| SENT
    UNK -->|"not found"| NR
```

Full state machine: [diagrams/review-flow.md](diagrams/review-flow.md).

![A distress/threat message with no AI reply text, put on hold](screenshots/05-high-risk-held.png)

*A critical-risk message: the bot writes no reply text, explains why, and the reviewer has put it on
Hold.*

![Rules that always require a person, and the fail-closed sending readiness check](screenshots/11-review-rules-and-readiness.png)

*Rules that always require a person cannot be switched off by settings or releases. The readiness
check is fail-closed: in this local showcase it reports Blocking because it runs on fakes.*

More: [docs/safety-and-review.md](docs/safety-and-review.md) and
[docs/message-lifecycle.md](docs/message-lifecycle.md).

## Architecture

```mermaid
flowchart LR
    Meta["Meta platform<br/>Facebook and Instagram"] -->|"signed webhooks"| API["API process<br/>Fastify, TypeScript"]
    API -->|"one transaction"| DB[("PostgreSQL<br/>state, audit, pg-boss queue")]
    DB --> Worker["Worker process<br/>decision pipeline"]
    Worker -->|"redacted prompt, JSON out"| AI["Anthropic Claude"]
    Worker -->|"GET only"| Meta
    Admin["React admin console<br/>Messages, Knowledge, Test Lab"] -->|"session, CSRF, roles"| API
    DB --> Pub["Publishing module<br/>the only writer"]
    Pub -->|"one POST, verified surfaces"| Meta
```

One strict TypeScript repository and a modular application rather than microservices: separate API
and worker processes, PostgreSQL as both the system of record and the job queue, and a small
authenticated admin console. Domain and policy, Meta adapters, context, knowledge, AI, publishing
and evaluation are separate modules. Live events, the admin preview, Test Lab and historical replay
all run the same decision pipeline; only the publishing sink differs.

More: [docs/architecture.md](docs/architecture.md) and
[docs/deployment-overview.md](docs/deployment-overview.md).

## Validation

**733 automated tests**: 511 unit tests and 222 PostgreSQL integration tests in 51 test files, plus
lint, TypeScript type checking and the production build. All passed in the run measured on
1 October 2026, in a fresh clone without credentials. Integration tests run against real
PostgreSQL, not mocks, and no test calls the real Meta API or a real model.

What is tested:

- webhook signatures and payload normalization
- malformed Meta events and duplicate events
- sender context
- knowledge retrieval and AI routing
- the REVIEW lifecycle and publishing gates
- idempotency and exactly-once behaviour, including lost write responses and crashes
- controlled write verification and access readiness
- Test Lab and the evaluation tooling

Two synthetic evaluation datasets (a 54-case smoke suite and a 90-case Slovenian legal corpus) are
used as **regression signals**, not as quality measurements. Release approval for a real-model
release requires a fresh-model replay that passes mandatory gates.

![Replay run of a synthetic regression suite with mandatory gates](screenshots/09-replay-gates.png)

*A replay run with mandatory release gates. With synthetic cases and a stand-in model, the UI labels
the run as engineering regression evidence, not proof of answer quality.*

More: [docs/testing-and-evaluation.md](docs/testing-and-evaluation.md).

## Engineering highlights

- **One decision pipeline** for SHADOW, REVIEW and LIVE, the admin preview, Test Lab and replay.
  Modes differ only at dispatch eligibility.
- **A human-in-the-loop legal workflow** with an immutable AI draft, a separate human final text and
  a full audit trail.
- **Structured, versioned legal knowledge** pinned by immutable, checksummed behavior releases that
  are evaluated before activation.
- **Facebook and Instagram webhook normalization** for four surfaces, with separate adapters, string
  IDs and quarantine for unknown shapes.
- **Durable ingestion before acknowledgement**: the signature is checked over the original bytes, and
  the receipt, events and queue job commit together.
- **Code-controlled safety and eligibility**, enforced again in PostgreSQL constraints and triggers.
- **Idempotent outbound publishing** with write-ahead attempt state and honest `outcome_unknown`
  reconciliation.
- **Per-surface write verification** before any surface can send.
- **Sender, post and thread context** for reviewers, while the model sees only a pseudonym and
  redacted text.
- **A 733-test suite** with real-PostgreSQL integration tests and fault injection.
- **Production deployment and readiness tooling**: fail-closed configuration, access-health checks,
  a REVIEW readiness gate and a read-only public traffic diagnostic.

## Status

As of **1 October 2026**, rollout is staged on purpose: each surface goes live for public users only
after it has been proven end to end.

| Surface or capability | Implemented | Controlled write verification | Production mode |
|---|---|---|---|
| Facebook Messenger | Yes | **Verified** | REVIEW |
| Instagram DM | Yes | **Verified** | REVIEW |
| Facebook comments | Yes | Pending: needs public delivery after Meta approval | REVIEW, sending blocked |
| Instagram comments | Yes | Pending: needs public delivery after Meta approval | REVIEW, sending blocked |
| Bot LIVE / autosend | Architecture exists | n/a | **Not enabled** |

**Meta:** Business Verification is verified. Access Verification and App Review (messaging and comment
permissions, plus Business Asset User Profile Access) are in review. The Meta app is unpublished
(Development mode), so only people with a role on the app currently produce events.

**Next:** after Meta approval, publish the Meta app (the bot stays in REVIEW), test all four surfaces
with ordinary public accounts, write-verify both comment surfaces, then run a REVIEW stabilization
period on real traffic. Controlled LIVE autosend is a separate future phase.

![Facebook comment with post context and a "sending not verified" lock](screenshots/06-comment-awaiting-verification.png)

*A Facebook comment shown with its post context. The draft is ready, but sending stays locked until
the surface passes a controlled write verification.*

![Meta readiness: messaging verified, comments not verified, app in development](screenshots/12-meta-readiness.png)

*Meta readiness is tracked separately from bot modes. This synthetic instance mirrors production:
messaging verified, comments not verified, app in Development, Advanced Access pending, Business
Verification verified.*

More: [docs/meta-integration.md](docs/meta-integration.md#current-status-1-october-2026).

## Privacy

- Product screenshots and examples use **synthetic data** from a local, isolated instance: invented
  senders and messages, demo account names and showcase-written knowledge entries. They used a
  deterministic stand-in model and fake Meta and publishing adapters.
- The two operational screenshots (the Meta Developer app and the production hosting panel) are real
  and were redacted: the App ID and the server account path are removed.
- In production, text is redacted before it reaches the AI provider, the model sees only a
  pseudonymous author, reviewer-only identity data is pruned on a schedule, and logs are structured
  and redacted.
- No tokens, credentials, account or page IDs, prompts or proprietary legal knowledge appear here.

More: [docs/privacy-and-security.md](docs/privacy-and-security.md).

## Deep dives

- [Architecture](docs/architecture.md): modules, boundaries, data model and technology choices
- [Message lifecycle](docs/message-lifecycle.md): from webhook bytes to one sent reply
- [Safety and review](docs/safety-and-review.md): modes, the decision pipeline, invariants, review actions
- [Knowledge system](docs/knowledge-system.md): schema, retrieval, uncertainty handling, releases
- [Meta integration](docs/meta-integration.md): API contract, surfaces, write verification, diagnostics
- [Testing and evaluation](docs/testing-and-evaluation.md): test suite, datasets, replay and gates
- [Deployment overview](docs/deployment-overview.md): runtime topology, configuration, rollback
- [Privacy and security](docs/privacy-and-security.md): data minimization, access control, curation
- [Diagrams](diagrams/architecture.md) · [Examples](examples/README.md) · [Source excerpts](src-showcase/README.md)

## About

Designed and implemented by **Matej Gaberc** ([@gabercmatej](https://github.com/gabercmatej)) as a
production system for Pravnik na dlani. The scope was the end-to-end V1 conversation workflow: Meta
integration, the decision pipeline, knowledge and release management, the review workspace, the
publisher, evaluation tooling and deployment. The system runs in production in REVIEW mode and is
waiting on Meta's review before public launch.

---

© 2026 Matej Gaberc. Portfolio case study; no licence is granted to use, copy or redistribute the
implementation. See [NOTICE.md](NOTICE.md).
