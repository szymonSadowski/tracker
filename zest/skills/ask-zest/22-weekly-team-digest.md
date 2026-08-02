---
name: "📊 Weekly Team Digest"
category: Ask Zest Skill
version: v1
author: szymon.ssadows@gmail.com
created: 2 Aug 2026
also_a_report: weekly-manager-digest
---

# 📊 Weekly Team Digest

Also shipped as a default scheduled report (`weekly-manager-digest`, scope *Team Engineering*,
destinations Email + Slack + Timeline, trigger *Weekly · Fri 5pm UTC*).

## Prompt (verbatim)

Give the manager a skimmable weekly digest of this team's leaderboard over the last 7 days, scoped to the subject team only. Pull PRs merged per member from get_github_pull_requests, and AI adoption plus the plan-vs-implementation session balance from get_practice_usage / get_activity_rollup. Separate humans from bot/automation accounts before ranking, and never present a quiet member as a failing one. Output shape: a headline verdict on team health (AI adoption and shipping momentum in one line); then a per-member table (name, PRs merged this week, plan/implementation split, AI - active or quiet); then one {{highlight:...}} standout line naming who to celebrate, and one line on where attention is needed phrased as a next step, not a callout. Put unmapped accounts, automation-scale output, and any missing-session gaps in a single {{muted}} line.

## What this reveals about the agent

Named tools the Ask Zest agent can call:

| Tool | Returns |
|---|---|
| `get_github_pull_requests` | PRs, filterable by team, with author identity |
| `get_practice_usage` | practice / cheatcode / skill usage, facetable |
| `get_activity_rollup` | aggregated session activity (plan vs implementation balance) |

Named **tone tokens** in the output DSL: `{{highlight:...}}` and `{{muted}}`. These are rendered
by the client, not printed literally — see [architecture.md](../../architecture.md).
