# Architecture diagram

Runtime components and module boundaries. Details: [../docs/architecture.md](../docs/architecture.md).

```mermaid
flowchart LR
    subgraph META["Meta platform"]
        FB["Facebook Page: comments, Messenger"]
        IG["Instagram: comments, DMs"]
        GRAPH["Graph API v26.0"]
    end

    subgraph API["API process"]
        WH["Webhook endpoint: HMAC over raw bytes"]
        ADMINAPI["Admin API: sessions, CSRF, roles"]
        STATIC["Static admin console"]
    end

    subgraph DB["PostgreSQL"]
        INBOX["Receipts and normalized events"]
        QUEUE["pg-boss job queue"]
        STATE["Decisions, reply items, publish attempts"]
        CONF["Releases, knowledge, activations, audit"]
    end

    subgraph WORKER["Worker process"]
        PROC["Event processing"]
        PIPE["Decision pipeline"]
        PUB["Publishing module: the only writer"]
    end

    AIP["AI provider: redacted prompt in, JSON out"]
    HUMAN["Human reviewer"]

    FB -->|webhook| WH
    IG -->|webhook| WH
    WH -->|"one transaction"| INBOX
    WH -->|"same transaction"| QUEUE
    QUEUE --> PROC
    PROC -->|"GET reads"| GRAPH
    PROC --> PIPE
    PIPE -->|"no tools, no tokens"| AIP
    PIPE --> STATE
    CONF --> PIPE
    HUMAN --> STATIC
    STATIC --> ADMINAPI
    ADMINAPI -->|"approve, edit, hold, no reply"| STATE
    STATE --> PUB
    PUB -->|"rechecks via GET"| GRAPH
    PUB -->|"one POST per attempt"| GRAPH
```

Enforced boundaries:

- Only `src/publishing/` may import a write transport (ESLint rule).
- AI, pipeline and evaluation code may not import Meta adapters or publishing (ESLint rule).
- The AI provider receives an already-redacted prompt and a JSON schema; it holds no Meta token,
  database access or publishing capability.
