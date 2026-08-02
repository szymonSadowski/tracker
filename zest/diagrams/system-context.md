# System context

Who talks to what, and which way the data flows.

```mermaid
flowchart LR
    dev(["👤 Developer"])
    mgr(["👤 Manager / Lead"])

    subgraph editor["Developer machine"]
        agent["AI coding agent<br/>(Claude Code, Cursor, Codex, VS Code, Hermes)"]
        plug["Zest plugin daemon<br/>local queue · exclusion rules"]
        agent --> plug
    end

    subgraph zest["Zest platform"]
        ing["Ingest"]
        raw[("raw: sessions + diffs")]
        gh[("raw: GitHub events")]
        anz["Session analysis (LLM)"]
        der[("derived: analysis summaries")]
        skills[("Skill library<br/>versioned prompts")]
        gen["Artifact generation<br/>standups · reports · Ask Zest"]
        tl[("Timeline events")]
        web["Web app<br/>rings · leaderboards · timelines"]
        sched["Scheduler"]
        api["Zest API<br/>(personal access tokens)"]
    end

    ghsrc["GitHub App"]
    slack["Slack"]
    mail["Email"]
    stripe["Stripe"]
    mcp["External MCP agents"]

    dev --> agent
    plug -->|sync every 60s| ing
    ing --> raw
    ghsrc --> gh
    raw --> anz --> der
    der --> gen
    gh --> gen
    skills --> gen
    sched --> gen
    gen --> tl
    gen --> slack
    gen --> mail
    der --> web
    gh --> web
    tl --> web
    web --> mgr
    web --> dev
    stripe <--> web
    mcp -->|read| api
    api --> der
```

## Reading it

- The plugin is the only writer of session data; everything else in the platform is derived.
- **Two raw sources** (sessions, GitHub) converge at generation time — that's why almost every Ask
  Zest prompt cross-references PRs against sessions.
- The Skill library is an *input* to generation, sitting beside the data, editable by users.
- Timeline is both an output (artifacts land there) and an input (the weekly team standup reads it
  back via `get_timeline`).
