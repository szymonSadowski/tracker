# Zest — reference map

A map of [app.meetzest.com](https://app.meetzest.com), captured 2 Aug 2026, to serve as the base for
building a similar product.

**What Zest is:** an AI-coding-productivity tracker. An editor plugin captures AI coding sessions;
GitHub supplies PR/issue data; an LLM turns both into standups, leaderboards, timelines, scheduled
reports and a chat agent — all driven by a user-editable library of prompts called *Skills*.

## Read in this order

| File | What's in it |
|---|---|
| [architecture.md](architecture.md) | **Start here.** How the system works: four planes, the Skill indirection, scope model, scheduling, the timeline as event bus, permissions, cold start |
| [features.md](features.md) | Every feature, in 15 groups, with route + backing data + screenshot ref. Doubles as a build backlog |
| [routes.md](routes.md) | Route table, URL grammar, page anatomy, modal inventory, sidebar tree |
| [data-model.md](data-model.md) | Observed tables and RPCs, agent tools, inferred entities, ER diagram, metric vocabulary, data-control model |
| [skills.md](skills.md) | The prompt library: 4 categories, all 47 skills, and 10 prompt conventions worth stealing |
| [skills/](skills/) | Verbatim text of all 47 skills, one file each |
| [diagrams/](diagrams/) | Mermaid: system context · data model · session pipeline · report pipeline · navigation · permissions |
| [screenshots/](screenshots/) | 23 captures, numbered |

## The three ideas worth copying

1. **A report is just a stored prompt + a scope + a schedule + destinations.** Standups, scheduled
   reports and the chat agent are one pipeline over one versioned prompt library. New analytics
   ship as prompts, not deploys.
2. **Everything reads from a derived analysis layer, never from raw transcripts.** One LLM summary
   per session; raw data can expire on its retention clock without emptying the product.
3. **A dignity policy enforced in prompt text.** Never rank individuals on cycle time, never present
   a quiet member as failing, describe friction not people, separate bots before ranking. Without
   these rules a team-productivity tool becomes a surveillance tool by default.

## Screenshot index

| # | File | Page |
|---|---|---|
| 01 | `01-home-top.jpg` | `/home` — onboarding banner, Zest Ring, standup |
| 02 | `02-home-reports-leaderboard.jpg` | `/home` — Teams overview, My Reports, Team Leaderboard, Team Timeline |
| 03 | `03-profile-top.jpg` | `/users/{slug}` — profile, About Me, teams, reports |
| 04 | `04-profile-my-coding-metrics.jpg` | `/users/{slug}` — My coding, tiles, period chart, Session Log |
| 05 | `05-profile-timeline.jpg` | `/users/{slug}/timeline` |
| 06 | `06-team-leaderboard.jpg` | `/teams/{slug}` |
| 07 | `07-team-timeline.jpg` | `/teams/{slug}/timeline` (note: Message log) |
| 08 | `08-workspace-overview.jpg` | `/workspaces/{slug}` — team cards, leaderboard, timeline, People |
| 09 | `09-workspace-timeline.jpg` | `/workspaces/{slug}/timeline` |
| 10 | `10-reports-registry.jpg` | `/workspaces/{slug}/reports` |
| 11 | `11-report-new-modal.jpg` | Create new report modal |
| 12 | `12-skills-library.jpg` | `/workspaces/{slug}/library` |
| 13 | `13-skill-edit-modal.jpg` | Edit Skill modal (versioning notice) |
| 14 | `14-ask-zest.jpg` | `/workspaces/{slug}/agents/ask-zest` |
| 15 | `15-install-plugin.jpg` | `/docs/install/claude-code` |
| 16 | `16-workspace-settings-general.jpg` | Workspace Settings → General |
| 17 | `17-workspace-settings-data-controls.jpg` | Workspace Settings → Data Controls |
| 18 | `18-invite-member-modal.jpg` | Invite to Workspace |
| 19 | `19-team-settings-modal.jpg` | Team Settings (timezone, Slack channel) |
| 20 | `20-daily-team-targets-modal.jpg` | Set Daily Team Targets (the Zest Ring goals) |
| 21 | `21-user-menu.jpg` | Sidebar user menu |
| 22 | `22-user-settings-account.jpg` | `/me/settings/account` |
| 23 | `23-user-settings-billing.jpg` | `/me/settings/billing` — L3 plan, trial, credits |

## Method & caveats

- Mapped by driving a logged-in browser session over every reachable route, reading page text and
  the accessibility tree, and opening each modal. **Nothing was written**: no form submitted, no
  setting saved, no report created (the New-report and settings modals were opened and cancelled).
- The 47 skill bodies were read out of the Edit Skill textarea for each skill, verbatim.
- The mapped workspace had **1 member, no plugin installed, and no session or PR data**. Every
  populated view (filled Zest Ring, leaderboard values, timeline cards, standup content, report run
  history, Ask Zest answers) is therefore reconstructed, not observed — those claims are marked
  `[inferred]` in the docs.
- Capture-side detail comes from the plugin's public repo,
  [`Winding-Labs/zest-claude`](https://github.com/Winding-Labs/zest-claude), documented from its
  README only. Worth cloning separately if you build the capture side.
- `meetzest.com` (marketing) returns 403 to automated fetches, so pricing is documented only from
  what the app itself shows.
