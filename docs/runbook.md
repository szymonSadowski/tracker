# Operational runbook

Everything below is safe to repeat. Ingestion is idempotent on GitHub node ids, so re-running a
sync cannot duplicate or corrupt data — "run it again" is a legitimate first response to almost
any ingestion problem.

## Where to look first

```sql
-- Per-repository sync state for a workspace
SELECT full_name, in_scope, backfill_state, last_success_at, last_failure_at,
       consecutive_failures, left(last_error, 120) AS last_error
  FROM repositories WHERE workspace_id = :workspace ORDER BY full_name;

-- The last few sync attempts, with reasons
SELECT r.full_name, s.kind, s.status, s.started_at, s.finished_at, s.pull_requests_seen, s.error
  FROM sync_runs s JOIN repositories r ON r.id = s.repository_id
 WHERE s.workspace_id = :workspace ORDER BY s.started_at DESC LIMIT 20;

-- Queue health
SELECT type, state, count(*), min(run_after) AS next_due, max(attempts) AS worst_attempts
  FROM jobs GROUP BY type, state ORDER BY type, state;

-- Jobs that gave up
SELECT id, type, payload, attempts, left(last_error, 200) AS last_error
  FROM jobs WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 20;
```

## Re-run a sync for one repository

```sql
INSERT INTO jobs (workspace_id, type, payload, dedupe_key)
VALUES (:workspace, 'repository.incremental_sync',
        jsonb_build_object('repositoryId', :repository, 'reason', 'on_demand'),
        'sync:' || :repository)
ON CONFLICT DO NOTHING;
```

Members can do the same from the product: the **Sync recent** button in settings, which posts to
`POST /api/workspaces/<id>/sync`, debounced per workspace by `ON_DEMAND_SYNC_DEBOUNCE_SECONDS`. A
request inside that interval is reported back as such rather than silently dropped, along with any
repositories skipped because their backfill has not finished.

## Restart a backfill that stalled

A backfill resumes from `repositories.backfill_cursor`. To resume it, re-enqueue:

```sql
UPDATE repositories SET backfill_state = 'pending' WHERE id = :repository;
INSERT INTO jobs (workspace_id, type, payload, dedupe_key, priority)
VALUES (:workspace, 'repository.backfill', jsonb_build_object('repositoryId', :repository),
        'backfill:' || :repository, 50)
ON CONFLICT DO NOTHING;
```

To re-run a repository's history **from the beginning**, clear the cursor first
(`UPDATE repositories SET backfill_cursor = NULL, backfill_window_start = NULL WHERE id = …`).
Re-ingesting the same pull requests changes nothing that has not genuinely changed on GitHub.

## Deepen a repository's history

Connecting a repository ingests `BACKFILL_WINDOW_DAYS` (90 by default) of history. Older pull
requests are only fetched when someone asks: the **History** control in settings, or

```
POST /api/workspaces/<id>/history-sync   {"from": "2024-01-01"}   # or {"from": null} for all
```

One `repository.history_sync` job is enqueued per in-scope repository. Each walks the repository's
pull requests by creation date, newest first, recording `repositories.history_cursor` and
`history_covered_from` after every page — so it is safe to interrupt, and resumes where it stopped.

```sql
-- How far back each repository reaches, and what it is doing about it
SELECT full_name, history_state, history_covered_from, history_complete, history_requested_from,
       left(history_error, 120) AS history_error
  FROM repositories WHERE workspace_id = :workspace ORDER BY full_name;
```

`history_state` is `idle`, `running`, `paused` (rate limits — it resumes on its own),
`complete`, or `failed`. `history_complete` means the walk reached the repository's first pull
request, after which further requests do no work.

**What it costs.** Each page is 25 pull requests with up to 100 reviews and 100 commits inline, so
a full-history request on a large organisation is a substantial amount of API quota — plausibly
hours for an active repository and days for an org with years of history. It is deliberately the
lowest-priority work in the queue (priority 100, against 50 for backfill and 10 for incremental
sync), so incremental sync is always dispatched first and current data never goes stale waiting on
old data. Below `RATE_LIMIT_SAFETY_THRESHOLD` it pauses and resumes after the reset rather than
exhausting the quota. Progress stays visible in settings throughout.

The walk starts from the newest pull request, so its first pages re-read what the initial backfill
already holds; those rows are recognised as covered and are not rewritten. A repository that
already walked to a given date resumes from its stored cursor, so asking for an earlier date
extends coverage rather than starting over.

To restart a repository's history walk from scratch (rarely needed — only if the cursor is
believed corrupt):

```sql
UPDATE repositories
   SET history_cursor = NULL, history_state = 'idle', history_error = NULL
 WHERE id = :repository;
```

Leave `history_covered_from` alone unless the data behind it was deleted: it is the claim the
surfaces make about how far back the numbers can be trusted.

## Recompute analysis

No GitHub requests are made; everything comes from stored data.

```bash
npm run recompute -- --workspace <id>                    # whole workspace
npm run recompute -- --workspace <id> --repository <id>  # one repository
npm run recompute -- --workspace <id> --since 2026-01-01 # a time range
npm run recompute -- --workspace <id> --stale-only       # only rows from an older definition
```

Use `--stale-only` after changing a metric definition and bumping `COMPUTED_VERSION` in
`src/analysis/metrics.ts`; `pr_analysis.computed_version` records which revision produced each row.

## Rebuild normalized data after a normalization fix

Raw payloads are retained, so a normalizer defect is a batch job rather than a re-backfill:

```bash
npm run reprocess -- --workspace <id> [--repository <id>]
npm run recompute -- --workspace <id>   # then recompute the derived layer
```

## Reconnect a failed installation

Symptoms: `installations.status = 'needs_attention'`, sync work cancelled, owners see a reconnect
prompt on the team view and in settings.

1. Confirm the cause: `SELECT status, status_reason FROM installations WHERE workspace_id = …;`
2. Have an owner reinstall or re-authorize the App on GitHub (Settings → Installations → the App).
   GitHub redirects to `/api/github/setup`, which records the installation, restores
   `status = 'active'`, and re-enqueues backfills for anything that never finished.
3. If the App itself was fine and only the token was rejected transiently, re-enqueue work:

```sql
UPDATE installations SET status = 'active', status_reason = NULL WHERE id = :installation;
INSERT INTO jobs (workspace_id, type, payload, dedupe_key)
VALUES (:workspace, 'workspace.schedule_syncs', '{}'::jsonb, 'schedule_syncs')
ON CONFLICT DO NOTHING;
```

## Rate limits

The workers pause below `RATE_LIMIT_SAFETY_THRESHOLD` remaining points and retry after the reset;
paused runs are recorded as `sync_runs.status = 'paused'` with their cursor. Nothing is lost. If
pauses are constant, either raise the poll interval (`SYNC_INTERVAL_MINUTES`) or reduce the
backfill window (`BACKFILL_WINDOW_DAYS`).

A history sync makes pauses more likely by design, and shows them as "paused for rate limits"
rather than as a failure. If one must be stopped outright, cancel its jobs:

```sql
UPDATE jobs SET state = 'cancelled', finished_at = now()
 WHERE workspace_id = :workspace AND type = 'repository.history_sync' AND state = 'pending';
UPDATE repositories SET history_state = 'idle' WHERE workspace_id = :workspace
   AND history_state = 'running';
```

Coverage already reached is kept; nothing is re-fetched when it is asked for again.

## Stuck or lost jobs

A worker that dies holding a job leaves it `running` with a stale `locked_at`; any worker reclaims
it after `DEFAULT_STALE_LOCK_SECONDS` (5 minutes). To force it now:

```sql
UPDATE jobs SET state = 'pending', locked_at = NULL, locked_by = NULL
 WHERE state = 'running' AND locked_at < now() - interval '5 minutes';
```

To retry a terminally failed job after fixing its cause:

```sql
UPDATE jobs SET state = 'pending', attempts = 0, run_after = now() WHERE id = :job;
```

## Uninstall and data retention

Uninstalling on GitHub marks the installation inactive, cancels pending work, discards cached
credentials, and leaves the workspace's data readable to its members. Deselecting a repository
stops its sync and removes it from aggregates while retaining its rows.
