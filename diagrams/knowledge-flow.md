# Knowledge flow

From a draft knowledge entry to a grounded reply. Details:
[../docs/knowledge-system.md](../docs/knowledge-system.md).

## Lifecycle

```mermaid
flowchart TD
    K1["Knowledge version: draft"]
    K2["Human review in console"]
    K3["Knowledge version: approved, immutable"]
    R1["Behavior release draft<br/>immutable, checksummed"]
    R2["Replay on that exact checksum"]
    G{"Gates pass, fresh-model evidence,<br/>all pinned knowledge approved?"}
    R3["Release approved with evidence and human note"]
    ACT["Activation: audited scope pointer<br/>global or account"]
    STOP["Not approvable: fix and create a new release"]

    K1 --> K2 --> K3
    K3 -->|"pinned by entry and version"| R1
    R1 --> R2 --> G
    G -->|yes| R3 --> ACT
    G -->|no| STOP
```

## At decision time

```mermaid
flowchart TD
    MSG["Redacted message, retrieval query,<br/>legal-area label"]
    PINS["Only knowledge pinned by the active release"]
    ELIG{"Approved, valid now,<br/>in scope?"}
    EXCL["Reported as KNOWLEDGE_EXCLUDED with reason"]
    SCORE["Keyword scoring<br/>figures weighted highest"]
    TOP["Top entries above minScore, at most maxEntries"]
    CONTRA{"Contradiction on a shared factKey?"}
    GEN["Generation sees only retrieved entries and must cite them"]
    VAL{"Citations known and every figure,<br/>contact, URL and offer grounded?"}
    OK["Grounded reply"]
    REV["Review with reason codes"]

    MSG --> SCORE
    PINS --> ELIG
    ELIG -->|no| EXCL
    ELIG -->|yes| SCORE
    SCORE --> TOP --> CONTRA
    CONTRA -->|"yes and used"| REV
    CONTRA -->|no| GEN --> VAL
    VAL -->|yes| OK
    VAL -->|no| REV
```

General legal-area guidance (`general_info`) can be retrieved for context, but it can never on its
own ground a product, price or contact reply.
