# Mode flow

One pipeline for every mode; modes differ only at dispatch eligibility. Details:
[../docs/safety-and-review.md](../docs/safety-and-review.md).

## Effective mode

```mermaid
flowchart TD
    CEIL["BOT_MODE: deployment ceiling from the environment"]
    GLOB["Global mode: database, audited"]
    ACC["Account mode: database, audited"]
    MIN["Effective mode = least permissive of the three"]
    PAUSE{"Global pause?"}
    TRANSPORT{"Publishing transport configured?"}
    BLOCK["No send permits"]
    EFF["Mode recorded on the reply item"]

    CEIL --> MIN
    GLOB --> MIN
    ACC --> MIN
    MIN --> TRANSPORT
    TRANSPORT -->|"no: REVIEW or LIVE is downgraded to SHADOW"| EFF
    TRANSPORT -->|yes| EFF
    EFF --> PAUSE
    PAUSE -->|yes| BLOCK
```

## Same pipeline, different dispatch

```mermaid
flowchart TD
    IN["Real event, preview or replay case"]
    PIPE["runDecisionPipeline: identical code path"]
    RES["Decision: reply, clarify, handoff, review, skip or error"]

    IN --> PIPE --> RES

    RES --> OFFM{"Mode"}
    OFFM -->|"OFF"| N0["Events stored, no decision run"]
    OFFM -->|"REPLAY or Test Lab"| N1["Simulated publisher: never sends"]
    OFFM -->|"SHADOW"| N2["Stored as evidence<br/>never sendable: code, CHECK, trigger"]
    OFFM -->|"REVIEW"| N3["needs_review<br/>sent only after a human action"]
    OFFM -->|"LIVE: built, disabled"| N4["Low-risk allowlist scheduled<br/>everything else needs review"]
```

On 1 October 2026 production runs REVIEW with `LIVE_AUTOSEND_ENABLED=false`. LIVE is refused
unless `BOT_MODE=LIVE`.
