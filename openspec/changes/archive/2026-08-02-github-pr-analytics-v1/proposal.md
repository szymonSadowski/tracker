## Why

We want to build an engineering-productivity tracker in the shape mapped in `zest/` — a telemetry
pipeline over developer work, wrapped in an org hierarchy, with a derived analysis layer feeding
every read surface. The full product depends on two integrations (editor plugin + GitHub) and an
LLM analysis layer, which is too much surface to get right at once.

This change builds the GitHub half end-to-end and stops there. It proves the pipeline — install →
ingest → normalize → derive → present — with **deterministic** metrics only. No LLM, no editor
plugin, no prompt layer. Those slot into the same seam later without reshaping anything.

## What Changes

- **GitHub App** installed per-account with **selected repositories** (not org-wide). Installation
  yields the org, its repos, and the contributors we care about.
- **Backfill on install** via GraphQL (90-day default window), so a new workspace is populated
  immediately rather than empty until the first webhook.
- **Incremental sync on a cron** via REST, writing through the *same* normalizer as backfill.
  Webhooks are explicitly deferred — they become a third caller of the same code path.
- **Deterministic PR analysis worker**: one `pr_analysis` row per pull request holding cycle time,
  time-to-first-review, time-to-merge-after-approval, review cycles, rework commits, diff size, and
  draft duration. Computed, exact, testable, recomputable from raw events.
- **Multi-tenant from the first migration.** Every table carries an installation/workspace key.
- **Teams are product-owned groupings**, not mirrored GitHub teams. Contributors are discovered
  from PR activity in selected repos; a workspace owner assigns them to teams.
- **GitHub OAuth is the only login.** `github_id` is the identity everywhere, which removes the
  author-to-user mapping problem entirely.
- **Access mirrors GitHub repo permissions**: if you cannot see the repo on GitHub, you cannot see
  its PRs here. No second permission model.
- **Dashboard ships team scope first, personal scope second.** Ranked per-individual throughput is
  deliberately out of scope for this change (see Non-goals).

### Non-goals

- Editor/session capture, and every metric that depends on it (AI Tasks, AI Time, Agents Ran,
  Cheatcodes, AI Adoption, Plan-vs-Impl, AI Stack).
- LLM analysis, the versioned skill/prompt library, scheduled reports, standups, chat agent.
- Slack and email delivery.
- Billing, credits, personal access tokens.
- Company/org-wide scope tier — `me` and `team` only.
- **A ranked individual leaderboard.** Every metric this change produces is per-person throughput,
  which is exactly what the `zest/` dignity rules forbid ranking. Team aggregates and per-person
  *self* views are in; a cross-person ranking is not.

## Capabilities

### New Capabilities

- `github-app-installation`: installing the GitHub App against an account, selecting repositories,
  storing and refreshing installation tokens, discovering repos and contributors, handling
  uninstall and repo-selection changes.
- `github-data-sync`: the backfill (GraphQL) and incremental (REST) sync paths, the shared
  normalizer, idempotency by GitHub node id, sync-run bookkeeping, and rate-limit handling.
- `pr-metrics`: the deterministic derived layer — what each metric means, how it is computed from
  raw events, how recomputation works, and how incomplete data is represented.
- `tenancy-and-teams`: the multi-tenant model (workspace ↔ installation), the contributor roster
  derived from PR activity, and product-owned team groupings with membership management.
- `auth-and-access-control`: GitHub OAuth sign-in, session handling, and access checks that mirror
  GitHub repository permissions.
- `analytics-dashboard`: the read surfaces — team view, personal view, PR list, and the empty/
  cold-start states while a backfill is still running.

### Modified Capabilities

None — this is the first change in the repository; `openspec/specs/` is empty.

## Impact

- **New codebase.** The repo currently contains only the `zest/` reference map and OpenSpec
  scaffolding; there is no application code to modify.
- **New external dependencies**: a registered GitHub App (App ID, private key, OAuth client
  credentials, webhook secret reserved for later), GitHub GraphQL v4 and REST v3.
- **Operational surface introduced**: a database, a job queue or scheduled worker for sync and
  analysis, and a cron trigger.
- **Rate limits are a design constraint**, not an afterthought — per-PR commit and file detail is
  what makes rework and churn computable, and it is what makes backfill expensive.
- **Forward compatibility is a requirement, not a hope**: `pr_analysis` is designed so the future
  LLM layer adds nullable columns to existing rows, and future session data becomes a second
  producer into the same derived table.
