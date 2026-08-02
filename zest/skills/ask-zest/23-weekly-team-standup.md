---
name: "📋 Weekly Team Standup"
category: Ask Zest Skill
version: v1
author: szymon.ssadows@gmail.com
created: 2 Aug 2026
also_a_report: weekly-team-standup
---

# 📋 Weekly Team Standup

Also shipped as a default scheduled report (`weekly-team-standup`, scope *Team Engineering*,
destinations Email + Slack + Timeline, trigger *Weekly · Fri 5pm UTC*).

The single most informative prompt in the library — it spells out the entire retrieval plan,
the attribution rules, the exact output contract, and the skip condition.

## Prompt (verbatim)

Synthesize this team's week into a manager-facing standup, scoped to the subject team only, covering the current Monday-Friday work week (this runs Friday afternoon in the team's timezone). Fetch the roster with search_workspace_users (workspaceId + teamId, no query). Pull every member's individual standups for the week with get_timeline - the zest/standup entries carry each standup's full summary text; paginate until exhausted. Pull the week's pull requests with get_github_pull_requests scoped to the team and attribute each by authorUserId; for members with no standup but with PR activity, describe their GitHub work from those PRs, and NEVER credit a PR to someone who only reviewed or merged it - author identity only. Pull the top team cheatcodes for the week with get_practice_usage (cheatcodes facet). Audience: engineering managers and team leads - professional, specific, concise, sparse emoji. Output EXACTLY these three markdown sections and nothing else (a downstream email renderer parses these exact headings): '### 🏆 Epic Wins' - 3-5 outcome-focused items deduplicated across members, only claiming 'shipped' or 'done' when there is evidence such as a merged PR; '### 🚧 Team Blockers' - the blockers raised this week, or the literal line 'No blockers reported this period' if there are none; '### ⚡ This Week's Cheatcodes' - a plain bullet list of up to 4 cheatcode or practice names, short labels only with no descriptions. If the team has NO individual standups AND no PR activity for the week, return completely empty output with no text at all - the pipeline treats an empty result as skip this week.

## What this reveals about the system

**Agent tools** (with argument shapes):

| Tool | Args seen | Notes |
|---|---|---|
| `search_workspace_users` | `workspaceId`, `teamId`, `query` | roster lookup; empty query = all |
| `get_timeline` | paginated | timeline entries are **typed**: `zest/standup` is one type |
| `get_github_pull_requests` | team scope | PRs carry `authorUserId` |
| `get_practice_usage` | facet (`cheatcodes`) | faceted practice analytics |

**Timeline event type namespace**: `zest/standup` — implies siblings like `zest/github`,
`zest/ask-zest` matching the timeline filter tabs (All / Standups / Ask Zest / GitHub).

**Attribution rule**: author identity only, never reviewer or merger. Bot/automation accounts are
separated before any ranking — this rule repeats across nearly every Ask Zest skill.

**Skip semantics**: empty output = "skip this week". The scheduler distinguishes *no output* from
*failed run*.

**Output contract**: the three `###` headings are parsed by an email renderer downstream, and match
the [AI Team Standup skill](../ai-team-standup/team-standup-weekly-summary.md) headings.
