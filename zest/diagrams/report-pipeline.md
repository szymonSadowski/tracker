# Report pipeline

A report = an Ask Zest skill + a scope + destinations + a schedule.

```mermaid
flowchart TB
    subgraph def["Report definition (created in the modal)"]
        T["template<br/>⚙️ Engineering productivity · 🎉 Celebrating AI wins · 📈 Getting better<br/>⚡ How to ship faster · 🚀 Trajectory · 📅 Next weekplan"]
        RT["report type = an Ask Zest skill (23 available)"]
        N["name"]
        SC["scope: All teams | one team"]
        DE["destinations: Email · Timeline · Slack"]
        TR["trigger: frequency + day + time<br/>→ live 'Next run' preview"]
        T --> RT --> N --> SC --> DE --> TR
    end

    TR --> SCHED{{scheduler: due?}}
    SCHED -->|yes| CTX[context assembly<br/>scope + window]
    CTX --> AG[["Ask Zest agent<br/>tools: search_workspace_users · get_timeline<br/>get_github_pull_requests · get_practice_usage · get_activity_rollup"]]
    AG --> ART["artifact<br/>markdown + {{highlight:…}} / {{muted}} tone tokens"]

    ART --> EMPTY{empty?}
    EMPTY -->|yes| SKIP[record: skipped this period]
    EMPTY -->|no| FAN[fan out]

    FAN --> D1[Timeline event]
    FAN --> D2["Email (renderer parses the ### headings)"]
    FAN --> D3[Slack channel]

    D1 --> LOG[(run record)]
    D2 --> LOG
    D3 --> LOG
    SKIP --> LOG

    LOG --> KPI["registry KPIs<br/>Active reports · Runs 7d · Delivery success · Needs attention"]
    LOG --> ML[Message log]
```

## Notes

- The **template row** is a shortcut that preselects a report type — a curation layer over the 23
  skills, not a separate concept.
- **Generation success and delivery success are separate.** A report can generate fine and still
  land in the "Failed delivery" bucket.
- **Empty output means skip**, and is recorded as such rather than as an error.
- Seeded defaults ship with the workspace: 2 team-scoped (Fri 5pm UTC) and 5 company-scoped
  (Mon 7am UTC) — so the registry is populated on day one.
