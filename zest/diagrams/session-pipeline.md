# Session capture → analysis → standup

From a keystroke in the editor to a standup on the timeline.

```mermaid
sequenceDiagram
    autonumber
    participant Dev as Developer
    participant Agent as AI coding agent
    participant Plug as Zest plugin daemon
    participant Q as local queue
    participant API as Ingest
    participant An as Analysis (LLM)
    participant DB as derived summaries
    participant Gen as Standup generator
    participant TL as Timeline
    participant Out as Email / Slack

    Dev->>Agent: prompt / work
    Agent-->>Plug: session events + file diffs
    Plug->>Plug: apply .gitignore + ignore rules
    alt local-only mode (/zest:disable)
        Plug->>Q: store, never sync
    else normal
        Plug->>Q: enqueue
        loop every 60s
            Q->>API: sync batch
        end
    end
    API->>An: new session
    An->>An: summarize · classify task type/phase/urgency<br/>· intent (plan vs impl) · extract tools/skills/agents<br/>· score quality
    An->>DB: one analysis summary per session

    Note over Gen: daily, at the user's delivery hour<br/>(or manual "Standup" button)
    Gen->>DB: fetch today's sessions for this user
    Gen->>Gen: load default AI Standup skill (versioned prompt)
    Gen->>An: prompt + session facts
    An-->>Gen: standup markdown
    Gen->>TL: zest/standup event (full text inline)
    Gen->>Out: email · optional Slack post
    TL-->>Dev: appears on /home and My Timeline

    Note over Gen: Friday 5pm, team timezone
    Gen->>TL: get_timeline → all members' zest/standup entries
    Gen->>Gen: load AI Team Standup skill
    Gen->>An: N standups → 1 team summary
    An-->>Gen: "### 🏆 Epic Wins" / "### 🚧 Team Blockers"
    Gen->>TL: team timeline event
```

## Why it's shaped this way

- **Queue before sync**, so developer flow is never blocked and connectivity never loses data.
- **Exclusion at the source**, so excluded code never leaves the machine — not filtered server-side.
- **One analysis record per session** is the contract every downstream surface depends on. Raw
  transcripts can expire on their retention clock without breaking the product.
- **The generator is dumb; the skill is smart.** Changing what a standup says means editing a
  prompt, and the old version is preserved so past standups stay explainable.
- **The team standup reads the timeline**, not a standup table — the timeline is the read model.
