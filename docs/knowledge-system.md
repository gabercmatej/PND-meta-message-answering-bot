# Knowledge system

How the bot knows what it may say, and how that knowledge is versioned, scoped, retrieved and kept
apart from legal guidance. Status as of **1 October 2026**. Diagram:
[../diagrams/knowledge-flow.md](../diagrams/knowledge-flow.md).

> The knowledge corpus itself (service descriptions, prices, legal-area guidance) is proprietary and
> is **not** part of this showcase. This document describes structure, rules and counts only. The
> single example record in [../examples/sanitized-knowledge-record.json](../examples/sanitized-knowledge-record.json)
> was written for this showcase and is not taken from the corpus.

## Design goals

1. **Never invent business facts.** Prices, offers, links, contact routes and product capabilities
   come only from approved, valid, correctly scoped knowledge.
2. **Separate business facts from legal guidance.** General legal-area guidance can help explain a
   topic or route to a lawyer. It can never ground an answer about the business's products, prices
   or contact details, and it is never individualized advice.
3. **Everything is versioned and pinned.** A decision can always be traced to the exact knowledge
   versions and release that produced it.
4. **Missing, conflicting or expired facts lead to review or an approved bounded response**, never
   to a guess.

## Knowledge object schema (`src/knowledge/schema.ts`)

A knowledge **entry** has immutable **versions** (a database trigger refuses changes to a stored
version's content; editing creates a new version). Each version has a status and a validated body.

| Field | Type / rule | Purpose |
|---|---|---|
| `entryId` | lowercase slug | Stable identity of the entry |
| `version` | positive integer | Immutable version number |
| `status` | `draft` / `approved` / `retired` / `revoked` | Only `approved` can ground a reply |
| `origin` | `owner` / `synthetic` | Provenance |
| `body.title` | 3 to 160 chars | Shown to reviewers; weighted in retrieval |
| `body.content` | 1 to 2000 chars | The approved statement |
| `body.factType` | `faq`, `product_fact`, `price`, `offer`, `support_route`, `link`, `policy_boundary`, `general_info` | Drives grounding rules |
| `body.factKey` | slug or null | Entries sharing a `factKey` describe the same fact; differing values are a **contradiction** |
| `body.structured` | `price` (decimal `amount`, `currency` EUR, `taxIncluded`, `period`, `terms`) or `url` (https only), or null | Structured values for prices and links |
| `body.language` | `sl` / `en` | Slovenian is primary |
| `body.keywords` | up to 30 | Retrieval |
| `body.scope` | `platforms`, `accountExternalIds`, `campaignProfileIds` (empty = all) | Scoping to platform, account or campaign |
| `body.validFrom` / `validTo` | ISO timestamps or null | Validity window (offers expire) |
| `body.source` | 3 to 500 chars | Where the fact comes from |
| `body.legalAreas` | up to 5 legal-area ids, optional | Links an entry to the legal-area taxonomy |

Schema refinements: a `price` fact must carry a structured price; a `link` fact must carry a
structured https URL; `validTo` must be after `validFrom`.

### Business facts vs legal guidance

| Kind | `factType` | Can ground a product / price / contact reply? |
|---|---|---|
| Deterministic business facts | `product_fact`, `price`, `offer`, `support_route`, `link`, `faq`, `policy_boundary` | Yes, when approved, in scope and valid |
| General legal-area guidance | `general_info` | **No.** It explains a topic in general terms and supports routing; the pipeline adds `MISSING_APPROVED_FACT` if only `general_info` backs a reply that needs grounding |

`general_info` never carries prices, deadlines or case-specific advice.

## Legal-area taxonomy (`src/domain/legal-areas.ts`)

17 stable ids for Slovenian law, with Slovenian display labels. The understanding stage must choose
exactly one (closed enum):

| Id | Area |
|---|---|
| `delovno` | Employment law |
| `druzinsko` | Family law |
| `dedno` | Inheritance law |
| `stvarno_nepremicnine` | Property law and real estate |
| `obligacijsko_pogodbe` | Obligations and contracts |
| `potrosnisko` | Consumer law |
| `odskodninsko` | Damages / tort |
| `kazensko` | Criminal law |
| `prekrskovno` | Minor offences |
| `upravno` | Administrative law |
| `davcno` | Tax law |
| `gospodarsko` | Commercial law |
| `izvrsba_insolvenca` | Enforcement and insolvency |
| `socialno_zdravstveno` | Social and health insurance |
| `tujci` | Foreigners and international protection |
| `drugo` | Other legal area |
| `ni_pravno` | Not a legal question |

`drugo` and `ni_pravno` are non-specific and add nothing to a retrieval query. A release can list
legal areas that **always hand off** to a lawyer (`handoff.alwaysHandoffAreas`) and can hand off
whenever understanding reports `needsLawyer`, for intents whose allowed actions include handoff.

Intents (14, `src/domain/categories.ts`): `product_question`, `pricing_promotion`, `praise_thanks`,
`complaint`, `account_payment_refund`, `individual_legal_situation`, `general_legal_topic`,
`spam_abuse`, `threat_sensitive_distress`, `unclear`, `self_or_handled`, `unsupported_media`,
`other`, `contact_booking`. The model may not choose `self_or_handled`; deterministic prechecks
decide that one.

## Corpus structure (counts only)

The repository ships a **draft** seed corpus, loaded into the database as drafts that a human must
review and approve in the console (`seed:pnd` never approves or activates anything):

| File | Entries | Composition |
|---|---|---|
| Site facts (`knowledge/pnd/site-facts.v1.json`) | 38 | 15 `price`, 8 `link`, 6 `product_fact`, 3 `faq`, 3 `support_route`, 2 `policy_boundary`, 1 `offer` |
| Legal-area guidance (`knowledge/pnd/legal-areas.v1.json`) | 17 | 17 `general_info`, one per legal area |

Each site fact records its public source URL, retrieval date and an "awaiting owner approval"
marker. The site-facts file also lists, explicitly, what the public source **did not** state and
where it **contradicted itself**, so those gaps are visible instead of being filled in. The
legal-area guidance is labelled as not site-sourced and needing legal review.

## Retrieval strategy (`src/knowledge/retrieval.ts`)

Deliberately simple, deterministic and explainable: **keyword retrieval over a bounded, pinned
set**, not embeddings.

1. **Candidate set**: only knowledge versions the active release **pins** (`knowledgePins`). In
   chronological replay, the frozen knowledge snapshot of the case is used instead. Anything
   unpinned is dropped (`UNPINNED_KNOWLEDGE_IGNORED`).
2. **Query**: the redacted message plus the model's suggested retrieval query and the legal-area
   label (never raw personal data).
3. **Eligibility** per version at decision time: `NOT_APPROVED`, `NOT_YET_VALID`, `EXPIRED`,
   `OUT_OF_SCOPE` (platform, account, campaign). Ineligible matches are reported as
   `KNOWLEDGE_EXCLUDED_<REASON>` so reviewers can see that an expired offer *would* have matched.
4. **Scoring**: per query token (diacritics-folded, tolerant matching): keyword hit 3, title hit 2,
   content hit 1. **Figures** (prices, numbers such as "090") are matched as whole numbers and weigh
   6, because a figure is the most specific thing a question names. For comments, figures from the
   post caption are also used (only figures, not caption words), so "price?" under a post naming a
   price finds that price.
5. **Selection**: entries at or above the release's `minScore`, top `maxEntries` (at most 10),
   ordered deterministically.
6. **Contradictions**: eligible entries sharing a `factKey` with different values are flagged
   (`CONFLICTING_FACTS`). If a draft cites a contradicting fact, the decision goes to review
   (`CONFLICTING_FACTS_USED`). The console also warns before approving a fact that contradicts
   another approved fact with an overlapping validity window.

## How context is selected for the model

The generation stage sees only:

- the redacted message and bounded context (thread ancestors or DM turns, post caption) inside a
  single delimited untrusted-data block,
- the **retrieved** knowledge entries (with id and version), not the whole corpus,
- the release's style rules, plan (planned action, allowed actions, surface, intent, legal area,
  redacted summary) and, for clarifications, the owner's guidance.

The model must return the ids and versions of the entries it used (`knowledgeRefs`). Code then
checks them: a reference to anything that was not retrieved is `UNKNOWN_SOURCE_REF`, and validators
check every figure, contact, URL and offer term in the draft against the cited entries
(`UNGROUNDED_NUMBER`, `UNGROUNDED_CONTACT`, `UNAPPROVED_URL`, `UNGROUNDED_OFFER_TERM`).

## Uncertainty handling and escalation

| Situation | Outcome |
|---|---|
| No approved fact for a product, price or contact question | `review` (`MISSING_APPROVED_FACT` / `MISSING_PRICE_OR_OFFER_FACT`) |
| Question names figures that no cited fact covers | `review` (`UNGROUNDED_FIGURES_IN_QUESTION`) |
| Conflicting facts used | `review` (`CONFLICTING_FACTS_USED`) |
| Conflicting campaign briefs on a shared post (pricing) | `review` (`CONFLICTING_CAMPAIGN_CONTEXT`) |
| Personal legal situation, legal area set to always hand off, or needsLawyer | Approved **handoff** text from the release (high priority), or `review` if no handoff text exists for that surface |
| Vague message | One short **clarifying** question (approved text, or AI text within policy). On a public comment it never asks for personal or case details |
| Model unsure, or asks for review | `review` (`AI_REQUESTED_REVIEW`) |
| Expired knowledge cited by a queued draft | Blocked at dispatch (`KNOWLEDGE_NOT_VALID`) |

## Releases: versioned, immutable, activated by a scope pointer

A **behavior release** (`src/behavior/manifest.ts`) is an immutable, checksummed manifest that
pins: category rules, per-stage models (understanding, generation, optional validation), retrieval
settings, knowledge pins (entry and version), approved contacts, handoff texts per surface and
always-handoff legal areas, clarification policy and approved texts, thread / conversation limits,
style, scoped overrides, an optional publishing policy, and an optional **engine pin** (pipeline
and prompt-template versions).

Lifecycle (`src/behavior/repository.ts`):

1. **draft**: editing creates a new row with a parent pointer; a database trigger refuses updates
   to a stored manifest.
2. **tested**: a completed replay run on that exact checksum.
3. **approved**: requires the expected checksum, a completed evaluation run **on that checksum**
   with mandatory gates passing, a human review note, and **every pinned knowledge version
   approved**. A release that pins a real model can only be approved on **fresh-model** evidence;
   fake or recorded runs are labelled "engineering evaluation only" and are refused. The approval
   evidence (run id, dataset, checksum, provider kind, gate status, note) is stored with the release.
4. **activated** through a **scope pointer** (`global` or `account:<id>`): an advisory lock plus
   optimistic concurrency on the current pointer, recorded in `activation_history` together with
   the approval evidence, and audited.
5. **Rollback** is an activation of an earlier approved release. **Revocation** removes every
   activation of a release in one transaction. Knowledge that is no longer approved blocks
   (re)activation of releases that pin it.

At decision time the worker resolves the active release (account scope first, then global, approved
only). The pipeline re-validates the manifest and refuses to run a release whose engine pin does not
match the running code (`RELEASE_ENGINE_MISMATCH`), so a prompt change in code can never silently
alter an evaluated release.

Production today runs one approved release backed by Anthropic models, approved on a fresh-model
evaluation run. An earlier real-model release candidate failed its mandatory gates; it was kept
unchanged with its failed evidence and never approved, and a corrected release was created instead.
