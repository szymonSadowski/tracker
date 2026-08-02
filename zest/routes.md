# Zest — Routes & Page Anatomy

Observed on `app.meetzest.com`, 2 Aug 2026, workspace `windmill-ja8d77no`, team
`engineering-6bt5lbv5`, user `szymon-ssadows`. Anything not directly observed is marked
`[inferred]`.

## URL grammar

Three slugged resource families plus a personal namespace:

```
/users/{user-slug}            username-derived slug        szymon-ssadows
/teams/{team-slug}            name + random suffix         engineering-6bt5lbv5
/workspaces/{workspace-slug}  name + random suffix         windmill-ja8d77no
/me/settings/{tab}            no id — current user
/docs/install/{editor}
```

The random suffix on team/workspace slugs makes them unguessable but still readable — worth copying.
User slugs have no suffix (derived from the email local part: `szymon.ssadows` → `szymon-ssadows`).

## Route table

| Route | Title | Screenshot | Contents |
|---|---|---|---|
| `/` | — | — | redirects to `/home` when signed in |
| `/home` | *Zest - Uplevel your AI coding productivity* | `01`, `02` | Onboarding banner · identity card · My Metrics (Zest Ring + 7 tiles) · today's standup · Teams overview · My Reports · Team Leaderboard · Team Timeline |
| `/users/{slug}` | *{email} - Profile* | `03`, `04` | Profile card + About Me · Teams overview · My Reports · "My coding" (install prompt, metric tiles, period chart, Session Log) |
| `/users/{slug}#metrics` | — | `04` | anchor into the My coding metrics block (sidebar "My Metrics") |
| `/users/{slug}#standup` | — | — | anchor into the standup block (sidebar "My Standup") |
| `/users/{slug}/timeline` | *{email} - Timeline* | `05` | My Timeline; filters All / Standups / Ask Zest / GitHub; range picker (Last 30 days); sort (Newest) |
| `/teams/{slug}` | *Team Leaderboard* | `06` | Team hero (avatar, description, illustrated banner) · header actions GitHub / Settings / Invite Member · Team Leaderboard (+ Metrics button) · Team Timeline |
| `/teams/{slug}#leaderboard` | — | `06` | anchor (sidebar "Leaderboard") |
| `/teams/{slug}/timeline` | *Team Timeline* | `07` | Engineering Timeline, same 4 filters, **+ Message log** button |
| `/workspaces/{slug}` | *Workspace* | `08` | Company hero · header actions GitHub / Connect Slack / Settings / Invite Member · range picker · per-team metric card row · team leaderboard · Company Timeline · People table |
| `/workspaces/{slug}#teams` | — | `08` | anchor (sidebar "Teams") |
| `/workspaces/{slug}#people` | — | `08` | anchor (sidebar "People") |
| `/workspaces/{slug}/timeline` | *Company Timeline* | `09` | company-wide feed, same filters, + Message log |
| `/workspaces/{slug}/reports` | — | `10` | Report registry: 4 KPI tiles · search · 4 filter dropdowns · table · New report modal |
| `/workspaces/{slug}/agents/ask-zest` | *Ask Zest* | `14` | conversation sidebar · playbook cards · playbook chip rail · composer |
| `/workspaces/{slug}/library` | *Skills* | `12` | Skills library: 5 tabs, sort, search, Create Skill, 4 category groups |
| `/me/settings/account` | — | `22` | First/Last name, email, Meme Preferences, GitHub Connection |
| `/me/settings/data` | — | — | personal Data Controls (collection + retention, capped by workspace) |
| `/me/settings/notifications` | — | — | standup email, Slack posting, delivery hour, onboarding recap opt-out, tips |
| `/me/settings/billing` | — | `23` | plan, trial countdown, Stripe portal, credits meter |
| `/me/settings/tokens` | — | — | Personal Access Tokens for MCP-compatible agents |
| `/docs/install/{editor}` | *Installation Guide* | `15` | editor picker + numbered install steps + update steps |
| `/workspaces/{slug}/settings` | — | — | **404** — workspace settings is a modal |
| `/teams/{slug}/settings` | — | — | **404** — team settings is a modal |

Editors on the install page: `claude-code`, Claude Cowork *(DEPRECATED)*, `cursor`, VS Code, Codex,
Hermes.

## Modals (no route of their own)

| Modal | Opened from | Screenshot | Fields |
|---|---|---|---|
| Create new report | Reports → New report | `11` | template row · report type (= an Ask Zest skill) · Name · Scope · Destination · Trigger + "Next run" preview |
| Edit Skill | Skills library → click a skill title | `13` | Skill Name · Skill Type (select) · Skill Content (textarea) · "Set as default prompt" · versioning notice |
| Workspace Settings → General | Workspace → Settings | `16` | Workspace name · ID (copyable) · Delete Workspace |
| Workspace Settings → Data Controls | same, 2nd tab | `17` | collection toggles (User messages, Assistant messages) · retention selects (User messages, Assistant messages, GitHub events — 90 days) |
| Team Settings | Team → Settings | `19` | Team name · ID · Timezone (drives 5pm-Friday team standup) · Slack channel (needs workspace Slack) · Delete Team |
| Invite to Workspace | Invite Member | `18` | repeatable email rows, each with a role select (**Member** / **Owner**) · Add another · Copy Invite Link · Send Invites |
| Set Daily Team Targets | Team → Metrics | `20` | AI Tasks 10 · 10x Time 4 · AI Practices 5 · AI Time 5 · Agents Ran 8 · PRs Open 2 · PRs Merged 2 |
| User menu | sidebar footer avatar | `21` | Settings · Billing & Usage · Support *(Soon)* · Privacy Policy · Terms & Conditions · Log out |

## Navigation (sidebar)

```
Zest ▸ [collapse]
Workspace / Team   ← switcher pill: [Windmill] [Engineering]
─────────────────────────────
Home                          /home
My Profile                    /users/{me}
  My Metrics                  /users/{me}#metrics
  My Standup                  /users/{me}#standup
  My Timeline                 /users/{me}/timeline
Engineering        [Team]     /teams/{team}
  Leaderboard                 /teams/{team}#leaderboard
  Timeline                    /teams/{team}/timeline
Windmill        [Company]     /workspaces/{ws}
  Teams                       /workspaces/{ws}#teams
  Timeline                    /workspaces/{ws}/timeline
  People                      /workspaces/{ws}#people
  Reports                     /workspaces/{ws}/reports
Ask Zest                      /workspaces/{ws}/agents/ask-zest
─────────────────────────────  (pinned to bottom)
Install Plugin                /docs/install/claude-code
Skills                        /workspaces/{ws}/library
[avatar] Szymon Sadowski ···  user menu
© 2026 Zest
```

Three scope tiers — **me → team → company** — each with the same two primitives (a *ranked view* and
a *timeline*). That symmetry is the whole information architecture.

## Persistent chrome

- **Ask Zest composer** floats at the bottom of *every* page (mascot + "Ask Zest.." input + send).
  Above it, a horizontally-scrolling rail of all 23 Ask Zest playbook chips ending in an `All` chip.
- **Breadcrumbs** at the top-left of every content page (`Workspaces / Windmill / Engineering`).
- Team and workspace pages carry a **generated illustrated banner** keyed to the entity.
