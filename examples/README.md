# Examples

**Every value in these files is synthetic.** They were written for this showcase and are shaped
after the real runtime types and schemas of the private codebase. They are not exports of production
data.

- Identifiers are obvious placeholders (`PAGE_ID_EXAMPLE`, `PSID_EXAMPLE_001`, `MID_EXAMPLE_001`,
  `00000000-0000-4000-8000-0000000000xx`).
- Hashes, signatures, checksums and model ids are placeholders in angle brackets. No real signature,
  token or key appears anywhere.
- The sender ("Ana Kovač"), the message, the handoff text and the human's edited reply are
  invented. The handoff wording is not the production release text.
- Token counts, costs and latencies are zeroed: they are not measurements.
- No prompt text is included.

All four files follow one scenario: a Messenger user asks a general employment-law question about
the notice period. The bot does not calculate legal deadlines or give individualized advice, so
code routes the message to a lawyer with approved handoff text. A human reviewer edits the draft
slightly and sends it once.

| File | Shaped after | Shows |
|---|---|---|
| [sanitized-webhook.json](sanitized-webhook.json) | Meta Messenger webhook envelope; `NormalizedEvent` (`src/meta/webhook-payload.ts`); minimized receipt payload; `IngestResult` | The signed request, the normalized event the API derives from it, what is actually stored (message text removed, identifiers kept) and the acknowledgement |
| [sanitized-decision.json](sanitized-decision.json) | `DecisionResult` schema version 2 (`src/pipeline/decide.ts`) | Understanding (intent, legal area, risk, needsLawyer), retrieval candidates, routing to handoff by code (`ROUTE_NEEDS_LAWYER_HANDOFF`), approved handoff text with no generation call, per-stage trace, reason codes, release checksum reference and privacy record |
| [sanitized-draft.json](sanitized-draft.json) | Messages detail API response (`getMessageDetail` in `src/inbox/queries.ts`), trimmed | The immutable AI draft next to the human's separate final text (`editedByHuman: true`), destination, the single publish attempt and the audit trail |
| [sanitized-knowledge-record.json](sanitized-knowledge-record.json) | `KnowledgeVersionSchema` (`src/knowledge/schema.ts`) | A generic `support_route` entry with scope, validity window, source and legal-area links |

Validation performed while writing them:

- `sanitized-knowledge-record.json` passes the real `KnowledgeVersionSchema`.
- Normalizing `request.body` of `sanitized-webhook.json` with the real normalizer produces exactly
  the fields of `normalizedEvent` (hashes aside), and the real `minimizePayload` produces exactly
  `storedReceiptPayload`.
