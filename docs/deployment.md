# Deployment

Three processes over one Postgres database:

| Process | Command | What it does |
| --- | --- | --- |
| web | `npm run start` | dashboard, read API, OAuth callback, GitHub App setup callback |
| worker | `npm run worker` | executes queued jobs: backfill, history sync, incremental sync, analysis |
| scheduler | `npm run scheduler` | enqueues due periodic work; never executes it |

The worker and scheduler are safe to run in more than one copy: jobs are claimed with
`FOR UPDATE SKIP LOCKED`, and scheduled ticks are claimed with a row lock.

## Environment

Every variable is read once at startup (`src/config/env.ts`); a missing secret fails immediately
with its name rather than at the first GitHub request. See `.env.example` for the full list.

Required: `DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `APP_BASE_URL`.

Optional, with defaults: `BACKFILL_WINDOW_DAYS=90`, `HISTORY_PAGES_PER_RUN=5`,
`SYNC_INTERVAL_MINUTES=15`, `SYNC_OVERLAP_MINUTES=30`, `RATE_LIMIT_SAFETY_THRESHOLD=200`,
`ON_DEMAND_SYNC_DEBOUNCE_SECONDS=120`, `PERMISSION_CACHE_SECONDS=300`,
`SESSION_INACTIVITY_MINUTES=10080`, `GITHUB_APP_SLUG`.

`BACKFILL_WINDOW_DAYS` is how far back a repository is ingested **when it is connected**, not a
ceiling on what the product will hold: a member can request history earlier than it at any time
(see the runbook). Changing it does not alter what has already been ingested — each repository
records its own coverage depth in `repositories.history_covered_from`.

`GITHUB_WEBHOOK_SECRET` is reserved for the webhook path deferred by design.md D3 and is unused.

## Migrations on deploy

```bash
npm run db:migrate
```

Run it as a release step, before the new web and worker processes start. Migrations are ordered
SQL files applied once each inside a transaction and recorded in `schema_migrations`; re-running
the command is a no-op. Every migration in this release is additive, so a rolling deploy where
old and new processes overlap is safe.

## Container

```dockerfile
# See Dockerfile at the repository root — one image, three commands.
docker build -t tracker .
docker run --env-file .env tracker                      # web
docker run --env-file .env tracker npm run worker       # worker
docker run --env-file .env tracker npm run scheduler    # scheduler
```

## Scheduled trigger without a long-lived process

If the platform prefers cron to a resident scheduler, replace the scheduler process with a
one-shot invocation on the same cadence:

```bash
node -e "import('./src/jobs/scheduler-main.js')"   # or: npm run scheduler with a timeout
```

The scheduler only enqueues; the worker does the work, so a missed tick delays freshness by one
interval and loses nothing.

## Health checks

- **Queue depth**: `SELECT count(*) FROM jobs WHERE state = 'pending' AND run_after <= now();`
  A number that grows without bound means the workers are down or under-provisioned.
- **Terminal failures**: `SELECT count(*) FROM jobs WHERE state = 'failed';` should be near zero.
- **Sync freshness**: `SELECT max(last_success_at) FROM repositories;` should be within a couple
  of `SYNC_INTERVAL_MINUTES`.
- **History syncs stuck**: `SELECT full_name, history_state, history_covered_from FROM repositories
  WHERE history_state IN ('running', 'paused', 'failed');` — `paused` means rate limits and clears
  itself; `failed` does not.
- **Installations needing attention**:
  `SELECT count(*) FROM installations WHERE status = 'needs_attention';`

## Backups and retention

The derived and normalized layers are rebuildable from `github_raw_events`
(`npm run reprocess`, then `npm run recompute`), so raw retention determines how far back the
product can be rebuilt without GitHub. A retention policy for raw events is an open question in
design.md; until it is settled, nothing is purged.
