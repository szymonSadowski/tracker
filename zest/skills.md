# Zest — The Skills Library

Zest's central abstraction. A **Skill** is a stored prompt with a type; the type decides which
pipeline consumes it. One library, four consumers.

Location in the app: **Skills** (sidebar footer) → `/workspaces/{slug}/library`
Screenshots: `12-skills-library.jpg`, `13-skill-edit-modal.jpg`

## Anatomy of a skill

| Field | Notes |
|---|---|
| Skill Name | free text, emoji-prefixed by convention |
| Skill Type | one of the 4 categories below — **this is the routing key** |
| Skill Content | the prompt body (long-form markdown; standup skills wrap it in `<prompt>` tags) |
| Set as default prompt | starred skills are the default for their type |
| Enabled toggle | per-skill on/off |
| Version | `v1`, `v2`, … — *"Editing will create a new version and preserve the original. All previous versions remain accessible in history."* |
| Author + created date | shown on every card |
| Order | cards have a drag handle → user-defined ordering |

Library chrome: tabs `All / AI Standup / AI Team Standup / Cheatcodes / Ask Zest`, sort (`Newest`),
search, per-category `+`, and a global `Create Skill`.

## The four categories

| Category | Count | Consumed by | Shape |
|---|---|---|---|
| **AI Standup Skill** | 3 | daily personal standup generation | long prompt: audience, format, content rules, worked example |
| **AI Team Standup Skill** | 1 | weekly team standup (Fri 5pm, team timezone) | reducer over N individual standups |
| **Cheatcodes Skill** | 20 | injected into / measured in the coding session | one-line rules |
| **Ask Zest Skill** | 23 | the chat agent *and* scheduled reports | analyst prompt with an explicit output shape |

Full text of all 47 lives under [`skills/`](skills/).

### AI Standup (3) — same pipeline, three audiences

- [Daily Standup Summary (3x2)](skills/ai-standup/daily-standup-summary-3x2.md) — product owners/managers ★ default
- [Technical Engineering Log](skills/ai-standup/technical-engineering-log.md) — engineers, tech leads
- [Leadership Brief](skills/ai-standup/leadership-brief.md) — directors, VPs, C-level

All three share a skeleton: `## Audience & Style` → `## Format Requirements` → `## Content Focus`
→ `## Example Structure` (a full worked example in `<example_developer_standup_note>` tags) →
an emoji-encoding footnote. Swapping the audience is the entire difference.

### AI Team Standup (1)

- [Team Standup: Weekly Summary](skills/ai-team-standup/team-standup-weekly-summary.md) ★ default

Emits exactly `### 🏆 Epic Wins` and `### 🚧 Team Blockers`. Deduplicates work across members.

### Cheatcodes (20)

One-line, portable prompt rules. Two flavours mixed in one category:

*Behavioural rules you give the agent* — 🌱 Plan don't code · 🦎 Break into tasks · ❓ Ask me
questions · 🧠 Be simple like John Carmack · ⚡ Remove any extras · 📜 Agent.md rules

*Checklists you attach to a task* — ⚛️ React performance · 🧩 Installing React · 📊 Posthog · 🧭
Sentry · 📈 Analytics · 🔎 SEO · 🧰 Relevant MCP servers

*Meta-prompting* — 💡 Planning before coding · 🧩 AI Tasks · 📘 Productive Hours · 🧩 Critique my
prompts (×2, different bodies) · 💡 Suggest prompt hacks · 📘 Compare to prompting guide

Cheatcodes are also a **measured metric** ("Cheatcodes" tile, `get_practice_usage` cheatcodes facet,
"🎮 Epic cheatcodes of the week", "🔍 Cheatcodes I haven't tried"). They are both an input to the
coding session and an output of the analysis — that loop is the product's flywheel.

### Ask Zest (23)

Analyst prompts. Each answers one recurring management question over a fixed window. All 23 also
appear as **playbook chips** on every page and as **report types** in the New-report modal.

| # | Skill | Window |
|---|---|---|
| 1 | 🔄 Best AI Workflow | — |
| 2 | 🛠️ Skills & Tools this week | 7d vs prior 7d |
| 3 | 🏆 Best Demos | 7d |
| 4 | 🎮 Epic cheatcodes of the week | 7d |
| 5 | 🦸 PR Hero of the Week | 7d |
| 6 | 🧰 Best of AI Stack | — |
| 7 | 🔍 Cheatcodes I haven't tried | — |
| 8 | ⏱️ Github PR Cycle Time | 14d vs prior |
| 9 | 🎯 Github PR Issue Time | 14d |
| 10 | ✅ Got done this week? | 7d |
| 11 | 📊 Got done this month? | 30d |
| 12 | 📦 What will we ship this month? | forecast |
| 13 | 🎯 Are we meeting our goals? | trend |
| 14 | 🚧 What's blocking progress? | now |
| 15 | 😤 What are dev complaints? | 7d |
| 16 | 🚀 What can we do to go faster? | 14d |
| 17 | ⚡ …make next week go faster? | next week |
| 18 | 📝 Write next weekplan | next week |
| 19 | 📋 Task Analytics | 7d |
| 20 | 🧭 Planning Techniques | 7d |
| 21 | 🔧 Implementation Techniques | 7d |
| 22 | 📊 Weekly Team Digest | 7d |
| 23 | 📋 Weekly Team Standup | Mon–Fri |

## Prompt conventions worth stealing

These recur across the library and are the reason the outputs feel like one product rather than 47
different LLM calls.

**1. "Output shape:" is mandatory.** Almost every Ask Zest prompt contains a literal `Output shape:`
clause specifying the headline, the body, the counts, and the closing line. Not "be concise" —
an actual structure.

**2. Hard caps everywhere.** "top 3", "max 2 lines", "exactly 5 recommendations", "up to the top 8
… rolling the rest into a single muted line", "at most 5 lines". The models are never left to
choose length.

**3. Evidence rules instead of "don't hallucinate".** *"Only mark work as 'completed' or 'shipped'
if there is evidence (e.g., merged PR, confirmed deployment)"*, *"Do NOT invent PR numbers, file
paths, function names, or metrics if they are not in the input"*.

**4. A dignity policy.** This is unusually consistent and is clearly a product value:
- *"never present a quiet member as a failing one"*
- *"Never call out who struggled — describe the friction, not the person"*
- *"praise the podium, never dunk on anyone below it"*
- *"cycle time is a team signal, not a personal scoreboard"* — never rank individuals on it
- *"Present each as a practice worth sharing, never as my gap or deficit"*
- attention items must be *"phrased as a next step, not a callout"*

**5. Bot separation before any ranking.** *"Separate humans from bot/automation accounts before
computing anything"*, *"NEVER credit a PR to someone who only reviewed or merged it — author
identity only"*. Unmapped and automation-scale accounts go in a muted line.

**6. Honest-uncertainty rules.** *"Say small sample sizes in plain words ('based on only 3 scored
sessions')"*, *"State the data window actually covered"*, *"State how much of the work has analysis
coverage"*, *"Keep it factual — no claims that a practice caused faster or better outcomes"*.

**7. Degrade-gracefully rules.** *"If issue data is missing or not syncing, say so in at most 5
lines — what is missing, the most likely cause, one next step — and do not pad the answer."*

**8. A tone-token DSL.** `{{highlight:...}}` and `{{muted}}` are emitted by the model and rendered
by the client. Prompts specify what may be highlighted and what must stay muted (e.g. *"the feature
is the star … review state, approval counts, and PR sizes stay plain or muted, never highlighted"*).

**9. Rendering contracts.** *"Output EXACTLY these three markdown sections and nothing else (a
downstream email renderer parses these exact headings)"*.

**10. An explicit skip signal.** *"If the team has NO individual standups AND no PR activity for
the week, return completely empty output with no text at all — the pipeline treats an empty result
as skip this week."* Empty ≠ failed.
