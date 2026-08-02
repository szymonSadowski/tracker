# Zest — Feature Inventory

Every feature observed in the app, grouped so this doubles as a build backlog. Each entry names
where it lives and what data backs it. `[inferred]` marks anything reconstructed from column
headers, API names or the plugin README rather than seen populated — the mapped workspace had no
plugin installed and no session data.

Screenshots referenced as `NN` map to [`screenshots/`](screenshots/).

---

## 1. Onboarding & plugin install

| Feature | Where | Notes |
|---|---|---|
| Two-step onboarding banner | `/home` top · `01` | "Connect your Coding Agent" with a **1/2** progress chip; GitHub shown as connected, plugin not |
| Editor picker | banner + profile + install page · `15` | "Zest for ▾": Claude Code, Claude Cowork *(DEPRECATED)*, Cursor, VS Code, Codex, Hermes |
| Per-editor install guide | `/docs/install/{editor}` · `15` | numbered steps with copyable commands, plus an "Updating the Plugin" section |
| Claude Code flow | install page | `/plugin marketplace add https://github.com/Winding-Labs/zest-claude` → `/plugin install zest` (User scope) → `/reload-plugins` → `/zest:login` |
| Plugin-status chip | `/home` header · `01` | "Plugin not installed" badge next to Standup button |
| Plugin column | People table · `08` | per-member plugin install state |
| Version awareness | `extension_versions` table | drives update prompts; the plugin's status line surfaces "sync errors, plugin updates, dev mode" |
| GitHub connect | workspace + team headers, team card CTA · `08` | "Connect your GitHub to track this metric" |
| Cold-start empty states | everywhere · `01`, `06`, `07`, `09` | illustrated mascot + one-line explanation + the action that fixes it |
| Coding-agent tips email series | Settings → Notifications | opt-out |
| Onboarding adoption recap | `/home` toggle · `01`; Settings → Notifications | owner-run campaign; members can opt out of delivery only |

## 2. Identity, org & permissions

| Feature | Where | Notes |
|---|---|---|
| Workspace (company) | `/workspaces/{slug}` · `08` | name, slug, description, illustrated banner, avatar |
| Team | `/teams/{slug}` · `06` | same shape, plus timezone and Slack channel |
| Workspace/Team switcher | sidebar top pill | `[Windmill] [Engineering]` |
| Workspace roles | Invite modal · `18` | **Member / Owner** |
| Team roles | People table · `08` | **Lead** (seen); member `[inferred]` |
| Invitations | Invite modal · `18` | multiple email rows each with its own role, **Copy Invite Link**, Send Invites |
| People directory | `/workspaces/{slug}#people` · `08` | sortable Member / Team / Role / Plugin, search, per-row remove + overflow menu |
| Team settings | modal · `19` | name, ID, **timezone** (drives 5pm-Fri team standup), Slack channel, Delete Team |
| Workspace settings | modal · `16` | name, ID (copyable), Delete Workspace |
| Membership guards | RPCs | `is_member_of_workspace`, `is_member_of_team`, `get_user_team_membership` |
| Profile | `/users/{slug}` · `03` | avatar, email, **About Me** free-text ("Share a bit about who you are beyond the screen") |
| Account settings | `/me/settings/account` · `22` | first/last name, email, GitHub connection (connect/disconnect) |

## 3. Session capture & metrics

| Feature | Where | Notes |
|---|---|---|
| Session capture | plugin | chat sessions + file diffs, queue-first in `~/.claude-zest/queue/`, syncs every 60s |
| Offline tolerance | plugin | queues locally, syncs when connection returns |
| Exclusion controls | plugin | respects `.gitignore`; `/zest:ignore` / `/zest:unignore` per folder; `/zest:disable` for local-only |
| **Zest Ring** | `/home`, `/users/{slug}` · `01`, `04` | multi-ring progress dial; fills completely on a "perfect day" against Daily Team Targets |
| Metric tiles | same · `01` | AI Tasks (`0 /10`), AI Time (h), Agents Ran, Cheatcodes, PRs Open, PRs Merged |
| Period chart | `/users/{slug}#metrics` · `04` | "No data in selected period" empty state; populated shape `[inferred]` |
| Session Log | `/users/{slug}` · `04` | "No recent sessions." + **View Log** |
| Daily Team Targets | Team → Metrics modal · `20` | AI Tasks 10 · 10x Time 4 · AI Practices 5 · AI Time 5 · Agents Ran 8 · PRs Open 2 · PRs Merged 2 |
| Session analysis | `chat_analysis_summaries` | LLM-derived per session; feeds quality scores, task type/phase/urgency, planning & implementation techniques, tools/skills/agents used `[inferred from prompts + RPC names]` |
| Intent classification | `get_team_member_intent_counts` | the Plan / Impl split |

## 4. Standups

| Feature | Where | Notes |
|---|---|---|
| Personal daily standup | `/home`, `/users/{slug}#standup` · `01` | "Your standup will appear here once generated" + **Standup** button |
| Manual generate | `/home` · `01` | Standup button in the header and in the empty state |
| Three standup voices | Skills library · `12` | Daily Standup Summary (3x2) ★, Technical Engineering Log, Leadership Brief |
| Team weekly standup | team timeline | AI Team Standup skill; Fri 5pm in the **team's timezone** |
| Delivery | Settings → Notifications | daily standup email; optional auto-post to the team Slack channel; hour-of-day picker in the user's tz (Europe/Warsaw) |
| "Last Standup" column | leaderboards, teams overview · `06`, `08` | `Never` when none |
| Standups on the timeline | all 3 timelines | as `zest/standup` events carrying full summary text |

## 5. Leaderboards

| Feature | Where | Notes |
|---|---|---|
| Team leaderboard | `/teams/{slug}` · `06`; also embedded on `/home` and `/workspaces/{slug}` | columns: Member · AI Adoption · PRs Merged /wk · AI Task · Plan · Impl · Last Standup · AI Stack |
| "You" marker | leaderboard rows · `06` | current user highlighted |
| Horizontal scroll | leaderboard · `06` | wide table scrolls inside its card |
| Teams overview | `/home`, `/users/{slug}` · `01` | Team · AI Adoption · Members · PRs Merged · Median AI Time · Plan vs Imp · Last Standup |
| Company team cards | `/workspaces/{slug}` · `08` | per team: AI Adoption `0% Active 0/1` · PRs Merged (last 30 days) · Median AI Time · Planning vs Implementation `0plan / 0impl` · AI Toolkit ("No platforms") · Members count |
| Range picker | company page · `08` | "Last 30 days" |
| Company metrics RPC | — | `get_company_team_metrics`, `get_latest_user_analysis_per_team` |

## 6. Timelines

| Feature | Where | Notes |
|---|---|---|
| Three scopes | `/users/{s}/timeline`, `/teams/{s}/timeline`, `/workspaces/{s}/timeline` · `05`, `07`, `09` | identical component, different scope |
| Type filters | all three · `05` | **All · Standups · Ask Zest · GitHub** |
| Range + sort | all three · `05` | "Last 30 days", "Newest" |
| Message log | team + company timelines · `07`, `09` | delivery log for messages sent out |
| Embedded preview | `/home`, `/teams/{slug}` · `01`, `06` | Team Timeline card + "View all" |
| Event types | `get_timeline` | namespaced, e.g. `zest/standup` |

## 7. Reports

| Feature | Where | Notes |
|---|---|---|
| Report registry | `/workspaces/{slug}/reports` · `10` | every report in the workspace, with owner |
| KPI tiles | · `10` | Active reports (7) · Runs last 7d · Delivery success (✗ / ➤) · Needs attention / Failed delivery |
| Filters | · `10` | search + Destination / Trigger / Status / Owner + Clear |
| My Reports | `/home`, `/users/{slug}` · `02` | personal slice: Report · Scope · Destinations · Trigger · Last run · **Active** toggle · run-now ▶ · overflow ⋮ |
| Create report | modal · `11` | template row → report type → name → scope → destination → trigger |
| Templates | modal · `11` | ⚙️ Engineering productivity · 🎉 Celebrating AI wins · 📈 Getting better · ⚡ How to ship faster · 🚀 Trajectory · 📅 Next weekplan |
| Report type | modal · `11` | **an Ask Zest skill** — all 23 selectable via "View all" |
| Scope | modal · `11` | All teams / a specific team |
| Destinations | modal · `11` | Email (comma-separated list, defaults to you) · Timeline · Slack — multi-select |
| Trigger | modal · `11` | frequency + day + time, with a live **"Next run: Mon Aug 3, 9:00am GMT+2 · then weekly"** preview |
| 7 seeded defaults | `10` | weekly-manager-digest, weekly-team-standup (Team scope, Fri 5pm UTC); best-of-ai-stack, skills-tools-of-the-week, github-pr-cycle-time, best-of-ai-workflow, cheatcodes-i-havent-tried (Company scope, Mon 7am UTC) |
| Run status | `10` | "Never run" / last run / failed delivery |

## 8. Ask Zest (the agent)

| Feature | Where | Notes |
|---|---|---|
| Dedicated page | `/workspaces/{slug}/agents/ask-zest` · `14` | conversation list (left) + canvas + composer |
| Global composer | every page · all screenshots | floating "Ask Zest.." bar with mascot |
| Playbook chip rail | every page | all 23 Ask Zest skills as chips, ending in `All` |
| Playbook cards | agent page · `14` | 4 featured: Best AI Workflow, Skills & Tools this week, Best Demos, Epic cheatcodes of the week |
| Conversations | agent page · `14` | "Start Asking!" thread; `+` to start a new one |
| Agent tools | named in prompts | `search_workspace_users`, `get_timeline`, `get_github_pull_requests`, `get_practice_usage`, `get_activity_rollup` |
| Tone tokens | prompts | `{{highlight:...}}`, `{{muted}}` rendered by the client |
| Conversations on the timeline | timeline filter "Ask Zest" | agent chats are timeline events |
| Workspace agents registry | `get_workspace_agents` | implies more agents than Ask Zest are possible `[inferred]` |

## 9. Skills library

| Feature | Where | Notes |
|---|---|---|
| Library | `/workspaces/{slug}/library` · `12` | 47 seeded skills in 4 categories |
| Categories | tabs · `12` | AI Standup (3) · AI Team Standup (1) · Cheatcodes (20) · Ask Zest (23) |
| Create / edit | `Create Skill`, click a card · `13` | Name · Type · Content · "Set as default prompt" |
| Versioning | edit modal · `13` | *"Editing will create a new version and preserve the original. All previous versions remain accessible in history."* — version badge on each card |
| Default (★) | cards · `12` | starred skill is the default for its type |
| Enable toggle | cards · `12` | per-skill on/off |
| Reordering | cards · `12` | drag handle |
| Search / sort / per-category add | header · `12` | search box, "Newest", `+` per group |

Full prompt text for all 47: [`skills/`](skills/) · analysis: [`skills.md`](skills.md).

## 10. GitHub integration

| Feature | Where | Notes |
|---|---|---|
| App installation | workspace header, `github_installations` | per workspace |
| Repositories | `github_repositories` | covered repos |
| Events | `github_events` | PRs and issues |
| Personal link | `/me/settings/account` · `22` | "Link your GitHub account to enable repository-level insights" — `@szymonSadowski`, Disconnect |
| Identity mapping | prompts | GitHub accounts map to Zest users; **unmapped** and **automation-scale** accounts are excluded from rankings and reported in a muted line |
| Derived analytics | Ask Zest skills | PR cycle time, issue lifecycle, PR Hero, demo reel, forecasts |
| Metrics | leaderboards | PRs Open, PRs Merged, PRs Merged /wk |
| Connection status dot | team/workspace headers · `06`, `08` | small status indicator next to "GitHub" |

## 11. Slack & email delivery

| Feature | Where | Notes |
|---|---|---|
| Connect Slack | workspace header · `08` | workspace-level install |
| Channel per team | Team Settings · `19` | *"Connect Slack in workspace settings to choose a channel for this team."* |
| Standup → Slack | Settings → Notifications | "Post my standup to Slack", visible to the whole channel; same delivery time as the email |
| Reports → Slack / Email | report modal · `11` | multi-destination |
| Email renderer | prompts | parses the exact `###` headings the standup skills emit |
| Delivery observability | Reports KPIs + Message log · `10`, `07` | success/failure counts, "Failed delivery" bucket |

## 12. Billing & plans

| Feature | Where | Notes |
|---|---|---|
| Plan | `/me/settings/billing` · `23` | **L3 — Agentic Engineering**, badge shown in the sidebar footer |
| Trial | · `23` | Free Trial, "14 days left", "Due after trial ends: $20/mo ($20/user × 1 user)" |
| Stripe portal | · `23` | Manage plan, invoices, payment method; editable billing email |
| Credits | · `23` | "0 / 750 used this month" with a progress meter |
| Spend RPC | — | `get_workspace_mtd_spend` |
| Auto-refresh eligibility | — | `check_auto_refresh_eligibility` `[inferred: credit top-up gate]` |

## 13. Personal access tokens

`/me/settings/tokens` — *"Tokens let MCP-compatible agents access the Zest API on your behalf."*
Create token; empty state "No tokens yet." So the Zest API is itself addressable by agents — the
product both consumes and exposes an agent surface.

## 14. Privacy & data controls

| Feature | Where | Notes |
|---|---|---|
| Workspace collection | Workspace Settings → Data Controls · `17` | toggles for User messages (AI prompts and questions) and Assistant messages (AI responses and suggestions) |
| Workspace retention | · `17` | User messages / Assistant messages / GitHub events — 90 days |
| Personal controls | `/me/settings/data` | same switches, default "Workspace default"; *"can only restrict what your workspace allows — never expand it"* |
| Plugin-side | plugin | `.gitignore` respect, `/zest:ignore`, `/zest:disable` (local-only mode) |

## 15. Cross-cutting UI

- Dark theme throughout; yellow-lemon brand with an illustrated mascot in every empty state.
- Generated illustrated banners per team/workspace.
- Breadcrumbs on every content page; collapsible sidebar.
- Wide tables scroll horizontally inside their card.
- Server-driven `feature_flags`.
- PostHog (incl. session recording, surveys, exception autocapture) + Google Analytics.
- User menu: Settings · Billing & Usage · Support *(Soon)* · Privacy Policy · Terms & Conditions ·
  Log out.
- Meme Preferences ("Spice up your daily memes by mixing in details from your About Me story") —
  there is a daily-meme feature `[inferred: only the preference toggle was observed]`.

---

## Not observed populated

The mapped workspace had 1 member, no plugin, no sessions, no PRs. The following were only seen as
empty states or column headers, so their populated form is `[inferred]`: the Zest Ring filled state,
the personal period chart, session log rows, any standup content, timeline event cards, leaderboard
values, report run history, and Ask Zest answers.
