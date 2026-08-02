# Permissions, scope and data governance

```mermaid
flowchart TB
    subgraph org["Org model"]
        U["Profile"]
        WM["Workspace membership<br/>role: Member | Owner"]
        TM["Team membership<br/>role: Lead | member"]
        W["Workspace"]
        T["Team"]
        U --> WM --> W
        U --> TM --> T
        W --> T
    end

    subgraph guards["Read guards (called before every scoped read)"]
        G1["is_member_of_workspace"]
        G2["is_member_of_team"]
        G3["get_user_team_membership"]
    end

    W -.-> G1
    T -.-> G2
    U -.-> G3
```

## Data governance composes downward only

```mermaid
flowchart LR
    A["Plugin exclusions<br/>.gitignore · /zest:ignore · /zest:disable"]
    B["Workspace policy<br/>collect: user msgs · assistant msgs<br/>retain: 90d per data class"]
    C["Personal policy<br/>same switches, default 'Workspace default'"]
    A -->|"never leaves the machine"| B
    B -->|"can only be narrowed"| C
    C --> D[("what Zest actually stores")]
```

Stated rule in the app: *"Your data controls apply across all workspaces. Settings here can only
restrict what your workspace allows — never expand it."*

## The dignity policy

Enforced in prompt text rather than in code — see [../skills.md](../skills.md) §4. It is effectively
a fourth permission layer: not *who may read this*, but *what the system is allowed to say about a
person*.

```mermaid
flowchart TB
    D0[["Analytics output"]]
    R1["never rank individuals on cycle time"]
    R2["never present a quiet member as failing"]
    R3["describe friction, not the person"]
    R4["frame gaps as practices worth borrowing"]
    R5["attention items = next steps, not callouts"]
    R6["separate bots before ranking; credit PR authors only"]
    R7["state small sample sizes and coverage in plain words"]
    D0 --> R1 & R2 & R3 & R4 & R5 & R6 & R7
```
