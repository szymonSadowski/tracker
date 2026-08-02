# Tracker

Pull request throughput and latency for engineering teams, read from GitHub.

Install a GitHub App on selected repositories; the product backfills their recent history, keeps
it current on a poll, derives a deterministic per-pull-request analysis record, and presents team
aggregates and personal views over it. Older history is fetched on request — settings carries a
history sync that deepens coverage backwards, and a sync-now button for immediate refresh. No LLM, no editor plugin — those are later layers that add
to the same seams (see `openspec/changes/github-pr-analytics-v1/`).

## Quick start

```bash
cp .env.example .env       # fill in the GitHub App credentials — see docs/github-app.md
docker compose up -d db
npm install
npm run db:migrate
npm run dev                # web on :3000
npm run worker             # sync and analysis jobs
npm run scheduler          # enqueues the periodic sync
```

## How it fits together

```
GitHub ──GraphQL backfill──┐
                           ├─▶ normalizer ─▶ pull_requests / reviews / commits / events
GitHub ──REST poll─────────┘        │                 │
                                    ▼                 ▼
                          github_raw_events      pr_analysis (one row per pull request)
                          (rebuildable)                │
                                                       ▼
                                             team view · personal view · pull request list
```

- **Three storage layers.** Raw payloads are retained, so normalized data can be rebuilt without
  calling GitHub, and the derived layer can be recomputed from stored data when a metric
  definition changes.
- **One write path.** Backfill, history sync, and incremental sync all go through the same
  normalizer, keyed by GitHub node id, so replaying an overlapping window is a no-op.
- **Coverage is recorded, not assumed.** Each repository stores how far back its data reaches, so
  a surface can tell "no pull requests in that period" from "never synced that far back".
- **A database-backed queue.** Analysis is enqueued in the same transaction as the data that
  justifies it, so no job can be lost between a commit and an enqueue.
- **Multi-tenant from the first migration.** Every workspace-scoped table carries `workspace_id`,
  and reads go through a scope that rejects a query without one.
- **Access mirrors GitHub.** Sign-in is GitHub OAuth; you see a repository's data here only if you
  can read that repository there.
- **No cross-person ranking.** Team aggregates and self views only — see `docs/dignity-review.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `start` | web application |
| `npm run worker` | job worker |
| `npm run scheduler` | enqueues periodic sync |
| `npm run db:migrate` / `db:reset` | schema |
| `npm run reprocess -- --workspace <id>` | rebuild normalized data from retained payloads |
| `npm run recompute -- --workspace <id>` | recompute analysis from stored data |
| `npm test` | test suite |
| `npm run lint` / `typecheck` | static checks |

## Tests

`npm test` runs against an embedded Postgres, so no service is required. Set `TEST_DATABASE_URL`
to run the same suite against a real server; one test that needs several simultaneous connections
runs only in that mode.

## Documentation

- `docs/github-app.md` — registering the App and the permissions it needs
- `docs/deployment.md` — processes, environment, migrations on deploy
- `docs/runbook.md` — rerun a sync, recompute analysis, reconnect a failed installation
- `docs/dignity-review.md` — how each surface is held to the no-ranking constraint
- `openspec/changes/github-pr-analytics-v1/` — the proposal, specs, design decisions, and tasks
