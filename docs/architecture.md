# Architecture

Tracker reads pull request activity from GitHub and presents throughput and latency for
engineering teams. It ingests from a GitHub App, stores what GitHub returned verbatim, derives a
deterministic per-pull-request analysis record from it, and renders team and personal views over
period-bucketed aggregates of those records.

No editor plugin, no agent, no write-back to GitHub. The one non-deterministic component is an
LLM that labels each pull request's *work type*; it is off by default and no deterministic metric
depends on it.

---

## Processes

Three processes over one Postgres database. They share the codebase and the database and talk to
each other only through the `jobs` table.

| Process | Command | Responsibility |
| --- | --- | --- |
| **web** | `npm run start` | Next.js App Router — dashboard, settings, OAuth callback, GitHub App setup callback, on-demand sync endpoints |
| **worker** | `npm run worker` | claims and executes queued jobs: ingestion, analysis, classification, recompute |
| **scheduler** | `npm run scheduler` | ticks once a minute and enqueues due periodic work; never executes it |

Both the worker and the scheduler are safe to run in multiple copies. Jobs are claimed with
`FOR UPDATE SKIP LOCKED`; scheduled ticks are claimed with a row lock inside the same transaction
that advances `next_run_at`, so two schedulers cannot both fire one tick.

**Execution is one operation with two triggers.** `runDrain` (`src/jobs/drain.ts`) is the only way
jobs are executed: it reclaims abandoned jobs, fires due scheduled tasks, then claims and runs work
until its budget is spent or the queue empties. The worker process is that operation in a loop with
no budget; a timer-driven deployment calls it over HTTP with one. The two cannot drift, because
there is one implementation rather than two.

The order is fixed inside `runDrain` rather than left to callers, because two of its three steps
fail silently when skipped — an unreclaimed job wedges its subject through the dedupe key, and an
unfired tick means periodic sync never runs while the on-demand button keeps working. `Worker`
therefore offers no way to run more than one job; looping `runOnce` is how those steps go missing.

The web process never calls GitHub for data and never computes a metric from raw rows. It reads
the derived layer and asks GitHub only one question: *may this user read this repository?*

```
                    ┌──────────┐         ┌──────────────┐
    browser ───────▶│   web    │         │  scheduler   │
                    └────┬─────┘         └──────┬───────┘
                         │  enqueue             │ enqueue
                         ▼                      ▼
                    ┌───────────────────────────────────┐
                    │        jobs  (Postgres queue)     │
                    └────────────────┬──────────────────┘
                                     │ claim
                                     ▼
                              ┌─────────────┐
                              │   worker    │──────▶ GitHub API
                              └─────────────┘──────▶ Anthropic API
```

---

## The three storage layers

The central structural decision. Each layer can be rebuilt from the one above it without calling
GitHub again.

```
  ┌────────────────────────────────────────────────────────────────────┐
  │ RAW        github_raw_events                                       │
  │            verbatim provider payloads, keyed by                    │
  │            (workspace_id, entity_node_id, payload_hash)            │
  └───────────────────────────┬────────────────────────────────────────┘
                              │  npm run reprocess
                              ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ NORMALIZED pull_requests · pr_reviews · pr_commits · pr_events     │
  │            pr_files · pr_commit_files · pr_review_comments         │
  │            repository_commits · contributors · repository_coverage │
  └───────────────────────────┬────────────────────────────────────────┘
                              │  npm run recompute
                              ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ DERIVED    pr_analysis   — one row per pull request                │
  │            pr_classifications — LLM work type, versioned           │
  └───────────────────────────┬────────────────────────────────────────┘
                              │  computed on read (no cache)
                              ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ AGGREGATE  src/analysis/series.ts — period buckets × scopes        │
  └────────────────────────────────────────────────────────────────────┘
```

Why it matters in practice:

- A metric definition change is a `COMPUTED_VERSION` bump plus a recompute — no re-ingestion, no
  GitHub quota spent.
- A normalizer bug is fixable retroactively against retained payloads.
- Raw retention is therefore what bounds how far back the product can be rebuilt offline. Nothing
  is purged today; a retention policy is an open question.

---

## Data flow

### Ingestion

Four paths, one write function.

```
  connect a repo ──▶ repository.backfill        (GraphQL, BACKFILL_WINDOW_DAYS back)
  settings UI    ──▶ repository.history_sync    (GraphQL, walks backwards, HISTORY_PAGES_PER_RUN
                                                 pages per run, then re-enqueues itself)
  scheduler      ──▶ repository.incremental_sync(REST, since last success − SYNC_OVERLAP_MINUTES)
  backlog fill   ──▶ repository.file_fill_in    (file diffs / comments for older PRs)
                                    │
                                    ▼
                     src/ingest/normalize.ts  ·  persistPullRequest()
                                    │
              upsert keyed by (workspace_id, github node id)
                                    │
                                    ▼
                       normalized tables + coverage record
                                    │
                    same transaction: enqueue pull_request.analyze
```

Every path produces an identical normalized record, so replaying an overlapping window creates no
rows and changes no values. A webhook path, when it lands, becomes a fourth caller of the same
function with no new write logic.

`repository.commit_sync` ingests default-branch commits independently of pull requests, so commit
activity is a real series rather than a by-product.

### Analysis

`pull_request.analyze` loads the stored data for one pull request, computes metrics, and writes
the single `pr_analysis` row. Currently at `COMPUTED_VERSION = 2`.

```
   first_commit ──▶ ready_for_review ──▶ first_review ──▶ merged
   └── coding ─────┘└──── pickup ───────┘└─── review ────┘
   └──────────────────── cycle time ────────────────────────┘
```

Cycle time starts at the first commit and terminates at merge. It does **not** extend to deploy —
deployment and incident data are not ingested, so change failure rate and MTTR are deliberately
absent rather than approximated.

Also on the record: code churn split into **new / refactor / rework**, review depth, PR maturity,
and PR size.

An uncomputable metric is stored as absent, never as zero. A pull request with no file data is
missing from churn aggregates rather than counted as zero churn.

### Classification (optional)

```
  workspace.classify_pull_requests ──▶ Anthropic Message Batches (claude-opus-5)
                                              │  (hours)
  workspace.collect_classifications ◀─────────┘  re-enqueues itself until the batch ends
```

Content-hashed and version-gated, so an unchanged pull request at the current revision costs
nothing on a re-run. Spend bounds are checked *before* a batch is enqueued; exceeding one pauses
the run with a reason visible to owners rather than failing. Runs at the lowest job priority.

Owners can override a work type by hand; overrides survive bulk re-runs.

`src/classification/provider.ts` is the only module that imports `@anthropic-ai/sdk`. A lint rule
keeps it out of `app/` and `src/analysis/`. With the provider unreachable, pull requests stay
unclassified and eligible for a later run — every other metric and surface is unaffected.

### Aggregation and rendering

`src/analysis/series.ts` produces metrics per period bucket (day/week/month) across four scopes:
workspace, team, repository, contributor. Every chart and tile reads from it, so two surfaces
showing the same metric cannot disagree.

Computed on read. There are no materialized rollup tables and therefore no invalidation to get
wrong. Bucketing happens in Postgres in the workspace's time zone, so bucket assignment is stable
across recomputation and independent of server locale. Percentiles (p50/p75/p90) sit alongside
means because latency distributions are skewed.

The revisit threshold is measured, not vibes: when a 90-bucket daily series exceeds ~200ms at p95,
add a `metric_rollups` cache table. `scripts/series-timings.ts` is the measurement.

Charts are server-rendered SVG in `src/ui/charts.tsx` — no charting library, no client bundle.
Each carries a visually-hidden value table, distinguishes series by pattern as well as colour,
renders absent buckets as gaps and uncovered buckets as a labelled hatch, and drills through by
linking into the filtered pull request list.

---

## Module map

| Path | Role |
| --- | --- |
| `app/` | Next.js App Router — pages, server actions, API routes |
| `src/config/env.ts` | every environment read, once, at startup |
| `src/db/` | driver abstraction, `pg` pool, migrations, workspace scope |
| `src/github/` | App auth, REST + GraphQL clients, rate-limit accounting |
| `src/installations/` | GitHub App installation lifecycle, repository reconciliation |
| `src/ingest/` | backfill, history, incremental, file fill-in, commits, normalizer, reprocess |
| `src/analysis/` | metrics, churn, benchmarks, aggregation, series, settings |
| `src/classification/` | prompt, provider, model, store, run orchestration |
| `src/jobs/` | queue, one-job execution, the drain operation, scheduler, handler registry, entrypoints |
| `src/repositories/`, `src/teams/`, `src/workspaces/`, `src/auth/` | stores and access control |
| `src/ui/` | server-rendered components, charts, formatting |
| `migrations/` | ordered SQL, applied once each, recorded in `schema_migrations` |
| `scripts/` | migrate, reset, reprocess, recompute, rollout-check, series-timings |

### Surfaces

```
/                                  landing
/signin                            GitHub OAuth
/dashboard                         workspace picker
/w/[workspaceId]                   team view
/w/[workspaceId]/me                personal view
/w/[workspaceId]/people/[id]       one contributor's own values
/w/[workspaceId]/pulls             pull request list (drill-through target)
/w/[workspaceId]/teams             team membership
/w/[workspaceId]/settings          sync now, history sync, metric + classification settings
```

---

## The job queue

A database-backed queue in the `jobs` table. Analysis is enqueued in the same transaction as the
data that justifies it, so no job can be lost between a commit and an enqueue.

Claimed by `ORDER BY priority ASC, run_after ASC, created_at ASC` — lower number runs first.

| Priority | Job |
| --- | --- |
| 10 | `repository.incremental_sync` when a member pressed Sync recent |
| 80 | `pull_request.analyze` |
| 100 (default) | `repository.backfill`, scheduled `repository.incremental_sync`, `repository.history_sync`, `installation.reconcile_repositories`, `workspace.schedule_syncs`, `workspace.recompute_analysis`, `repository.reprocess` |
| 120 | `repository.commit_sync` |
| 150 | `repository.file_fill_in` |
| 200 | `workspace.classify_pull_requests`, `workspace.collect_classifications` |

So a member waiting on a button outranks everything, analysis of what just arrived comes next,
and backfilling the past never delays either. Classification runs last by construction.

Failure handling distinguishes two kinds. A `RetryableError` backs off and retries to
`max_attempts`. A `PermanentError` fails the job outright. Credentials GitHub rejects are neither
— they mark the *installation* `needs_attention` so its owners can reconnect, and stop scheduling
work that can only fail. Stale locks are reclaimed, so a worker killed mid-job releases it.

---

## Invariants

These hold everywhere and are enforced structurally, not by convention.

**Multi-tenancy is checked, not remembered.** Every workspace-scoped table carries `workspace_id`,
and every read goes through a `WorkspaceScope`. Statements name the scope with a `:workspace`
marker; a statement touching a scoped table without one is rejected before it reaches the
database. A test asserts the scoped-table list matches the columns actually in the schema, so a
new table cannot silently escape enforcement. `users`, `sessions`, `schema_migrations`, and
`benchmark_thresholds` are deliberately global.

**Access mirrors GitHub.** Sign-in is GitHub OAuth. You see a repository's data here only if
GitHub says you can read it there, checked with the user's own token and cached for
`PERMISSION_CACHE_SECONDS`. Every failure — not a member, no such workspace, repository not
visible — surfaces the same error and renders as 404, so the product cannot be used to discover
what exists.

**Coverage is recorded, not assumed.** Each repository records how far back each data class
(`pull_requests`, `file_diffs`, `default_branch_commits`) reaches. Classes move at different
speeds, so a surface can distinguish "no pull requests in that period" from "never synced that far
back" — per class. Charts render uncovered buckets distinctly rather than as zero.

**No cross-person ranking.** Team aggregates and self views only. A test asserts no exported
aggregation function accepts or produces a contributor ordering, at any scope. See
`docs/dignity-review.md`.

**Sessions are unforgeable from a database copy.** The cookie carries a random token; only its
hash is stored. Sessions expire on inactivity, refreshed on use.

**The dependency surface is small on purpose.** Runtime: `next`, `react`, `react-dom`, `pg`, and
`@anthropic-ai/sdk` (worker only). No ORM, no CSS framework, no charting library, no HTTP client.

---

## Rate limits and quota

`src/github/rate-limit.ts` accounts for remaining API points. Below
`RATE_LIMIT_SAFETY_THRESHOLD`, non-urgent work pauses rather than failing — a history sync goes
`paused` and clears itself when the limit resets; `failed` does not clear itself. File-level diff
ingestion is materially more expensive per pull request than the PR record itself, which is why it
runs as a low-priority backwards fill-in rather than in one pass.

---

## Testing

`npm test` runs against embedded Postgres (`@electric-sql/pglite`), so no service is required. Set
`TEST_DATABASE_URL` to run the same suite against a real server; one test needing several
simultaneous connections runs only in that mode.

Tests mirror the module layout, plus `tests/surfaces/` for rendered output and `tests/e2e/`.

---

## Extension seams

Where the next layers attach without restructuring anything:

| Want | Attach at |
| --- | --- |
| Webhooks instead of polling | a fourth caller of `persistPullRequest`; `GITHUB_WEBHOOK_SECRET` is already reserved |
| A serverless deployment | `runDrain` behind a timer; see `docs/deploy.md` Path C |
| DORA deploy metrics | a new ingestion path + data class; cycle time's merge terminator becomes a deploy terminator |
| Materialized rollups | behind `series.ts`, once the measured p95 threshold is crossed |
| A new metric | `src/analysis/metrics.ts`, bump `COMPUTED_VERSION`, recompute |
| A new derived LLM field | its own columns on the generated half of `pr_analysis`, which analysis never touches |

---

## See also

- `docs/deploy.md` — deployment paths, environment, migrations, health checks
- `docs/github-app.md` — registering the App and its permissions
- `docs/metrics.md` — metric definitions
- `docs/runbook.md` — rerun a sync, recompute analysis, reconnect an installation
- `docs/dignity-review.md` — how each surface is held to the no-ranking constraint
- `openspec/specs/` — the eight capability specs
- `openspec/changes/archive/` — proposals, designs, and the decisions behind them
