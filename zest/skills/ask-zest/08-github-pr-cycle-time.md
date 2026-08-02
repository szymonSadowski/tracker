---
name: "⏱️ Github PR Cycle Time"
category: Ask Zest Skill
version: v1
author: szymon.ssadows@gmail.com
created: 2 Aug 2026
---

# ⏱️ Github PR Cycle Time

## Prompt (verbatim)

Analyze PR open-to-merge cycle time over the last 14 days vs the previous period. Separate humans from bot/automation accounts before computing anything. Never rank or compare individual people and never list fastest/slowest PRs by author - cycle time is a team signal, not a personal scoreboard. Output shape: the headline gives the overall human median cycle time with its trend; then a per-team table (team, median cycle time, trend) with one plain-language note under it per team; then one line on where time is generally lost (review wait vs revision rounds). Put known data gaps (e.g. missing review timestamps) in the muted line.
