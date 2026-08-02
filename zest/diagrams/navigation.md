# Navigation / information architecture

Three scope tiers, each with the same two primitives.

```mermaid
flowchart TB
    HOME["/home<br/>personal dashboard"]

    subgraph me["ME"]
        P["/users/{slug}<br/>Profile"]
        PM["#metrics — My Metrics"]
        PS["#standup — My Standup"]
        PT["/users/{slug}/timeline"]
        P --- PM
        P --- PS
    end

    subgraph team["TEAM"]
        T["/teams/{slug}<br/>Team Leaderboard"]
        TT["/teams/{slug}/timeline"]
        TS[["Settings modal"]]
        TI[["Invite modal"]]
        TM[["Daily Team Targets modal"]]
        T --- TS
        T --- TI
        T --- TM
    end

    subgraph co["COMPANY"]
        W["/workspaces/{slug}<br/>Teams · Leaderboard · People"]
        WT["/workspaces/{slug}/timeline"]
        WR["/workspaces/{slug}/reports"]
        WL["/workspaces/{slug}/library<br/>Skills"]
        WA["/workspaces/{slug}/agents/ask-zest"]
        WS[["Settings modal<br/>General · Data Controls"]]
        WI[["Invite modal"]]
        W --- WS
        W --- WI
        WR --- WN[["New report modal"]]
        WL --- WE[["Edit Skill modal"]]
    end

    subgraph acct["ACCOUNT"]
        S1["/me/settings/account"]
        S2["/me/settings/data"]
        S3["/me/settings/notifications"]
        S4["/me/settings/billing"]
        S5["/me/settings/tokens"]
    end

    DOC["/docs/install/{editor}"]

    HOME --> P
    HOME --> T
    HOME --> W
    HOME --> WR
    P --> PT
    T --> TT
    W --> WT
    HOME -.-> DOC
    HOME -.-> WL
    HOME -.-> WA
    HOME -.-> acct
```

## The symmetry

|  | ranked view | activity feed |
|---|---|---|
| **me** | Zest Ring + metric tiles | My Timeline |
| **team** | Team Leaderboard | Team Timeline |
| **company** | team metric cards + leaderboard | Company Timeline |

Company adds the three cross-cutting surfaces that have no per-scope equivalent: **Reports**,
**Skills**, **Ask Zest**. Those are workspace-level because the skill library and report registry
are shared assets.

## Persistent chrome

- Ask Zest composer + 23-playbook chip rail: bottom of **every** page.
- Breadcrumbs: top of every content page.
- Sidebar: collapsible, with workspace/team switcher at top and Install Plugin / Skills / user menu
  pinned to the bottom.
