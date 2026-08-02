## Context

See proposal.md — Why. The mechanics that constrain the approach:

- `src/ingest/backfill.ts` pages `pullRequests(orderBy: {field: UPDATED_AT, direction: DESC})`,
  stops at the first PR older than `windowStart`, records `backfill_cursor` after every page, and
  re-enqueues itself every `PAGES_PER_RUN` (5 × 25 PRs). Resumability already works.
- When it stops at the window edge it marks `backfill_state = 'complete'` and leaves the cursor at
  the page where it stopped. That cursor is *not* reusable for deepening — see D2.
- `repositories` already carries `backfill_state`, `backfill_cursor`, `backfill_window_start`,
  `synced_through`, and the last-sync/last-error columns (`migrations/0002_installations.sql:38`).
- The queue dedupes on `(workspace_id, dedupe_key)` for pending/running jobs and dispatches
  `ORDER BY priority ASC` (`src/jobs/queue.ts:84,123`). Backfill enqueues at priority 50, on-demand
  incremental at 10.
- `POST /api/workspaces/[workspaceId]/sync` exists, debounces on recent `on_demand` jobs, and
  returns `{ enqueued, debounced }`. It has no caller.
- `app/w/[workspaceId]/settings/page.tsx` is a server component; both buttons need client
  interactivity added.

## Goals / Non-Goals

**Goals:**

- Deepening a repository is a resumable, idempotent pass that is correct under concurrent
  incremental sync, and cannot starve incremental sync of API quota.
- Coverage depth is a recorded fact, not inferred from config, so it stays true after
  `BACKFILL_WINDOW_DAYS` changes.
- Both controls reuse the existing job/queue/rate-limit machinery rather than adding a second
  execution path.

**Non-Goals:**

- Changing how a repository's *first* backfill behaves on connect. Default-window-on-connect stays;
  full history is an explicit request. (Revisit once cost on a real org is measured.)
- Per-workspace or per-repository history retention policy.
- Backfilling anything other than pull requests and their attached reviews/commits.

## Decisions

### D1: A history sync is a workspace request that fans out to per-repository jobs

`POST /api/workspaces/[workspaceId]/history-sync` with `{ from: <ISO date> | null }` (null = all
history) enqueues one `repository.history_sync` job per in-scope repository, mirroring how
`reconcileRepositories` fans out backfills (`src/installations/service.ts:111`). Dedupe key
`history:<repositoryId>` makes a repeated request while one is running a no-op, satisfying
"History sync is requested while one is running".

*Alternative rejected:* a single workspace-wide job looping repositories. It serialises repositories
behind the slowest one and gives one cursor for many repositories, breaking per-repository progress
reporting.

### D2: Deepening pages by `CREATED_AT DESC` with its own cursor — not `UPDATED_AT`

The existing backfill orders by `UPDATED_AT DESC`. That ordering is *unstable*: any PR updated
mid-walk jumps to the front of the connection, and a resumed cursor then skips whatever shifted
across it. That is tolerable for a 90-day pass — incremental sync re-covers the same recent window
minutes later — but not for a walk of several thousand pages where a skipped PR is never revisited.

The history pass therefore uses `orderBy: {field: CREATED_AT, direction: DESC}` and stores its
position in a separate `history_cursor` column. `created_at` is immutable, so the ordering is
stable, resume is exact, and the stop condition (`createdAt < from`) means exactly what a member
asking for "history since March" expects.

Consequence: the pass starts from the newest PR by creation date and walks back through PRs already
ingested by the initial backfill before reaching new ground. Upserts make that harmless for
correctness but not free in API cost — see R2.

*Alternative rejected:* reusing `backfill_cursor`. It is a position in a differently-ordered
connection; resuming from it would silently sample the wrong slice.

*Alternative considered:* the GraphQL `search` connection with `created:<date`, which would skip
straight to the uncovered range. Rejected for now — `search` caps at 1000 results per query, so it
needs date-slicing to walk a large repository, which is a second paging scheme to get right.
Worth revisiting if R2 proves painful in practice.

### D3: Coverage is recorded, not derived

New columns on `repositories`:

| column | meaning |
| --- | --- |
| `history_covered_from timestamptz` | earliest creation time from which PR data is known complete |
| `history_complete boolean` | true once the repository's earliest PR has been reached |
| `history_cursor text` | resume position for the created-at walk |
| `history_requested_from timestamptz` | the range the outstanding request asked for; null when idle |
| `history_state text` | `idle` / `running` / `paused` / `complete` / `failed` |

`history_covered_from` advances only when a page completes, so an interrupted pass never claims
coverage it does not have. Surfaces read this rather than computing a window from config — which is
what makes "coverage is complete but the period is empty" distinguishable from "never fetched".

### D4: A new job type, not an overloaded `repository.backfill`

`repository.history_sync` with payload `{ repositoryId, from: string | null }`. Overloading the
existing type would collide on the `backfill:<id>` dedupe key (a history request would be swallowed
by a pending backfill, or vice versa) and force one handler to switch between two orderings and two
cursors.

### D5: Quota priority is expressed through the existing queue ordering

History jobs enqueue at priority 100, below backfill's 50 and incremental's 10. Since the queue
already dispatches `ORDER BY priority ASC`, a due incremental sync is claimed before queued history
work with no scheduler changes — this is how "History sync competes with incremental sync for
quota" is satisfied.

Rate limit pauses reuse `rateLimit.assertHeadroom` between pages, exactly as backfill does, so a
pause lands with progress already recorded. The handler distinguishes the rate-limit pause from a
genuine failure and writes `history_state = 'paused'`, so the surface can say "paused for rate
limits" rather than showing red.

### D6: `sync_runs.kind` gains `'history'`

Progress reporting reuses `sync_runs` (`migrations/0003_ingestion.sql:131`) rather than adding a
parallel table; the `kind` CHECK constraint is widened. `status` already has the `paused` value the
rate-limit case needs.

### D7: Sync-now is UI-only work

The endpoint, debounce, and outcome shape already exist. The work is a client component in
`app/w/[workspaceId]/settings/page.tsx` that posts and renders the result — including the
`debounced: true` case, which currently returns silently and would otherwise look like a dead
button. The endpoint's response gains the list of repositories skipped for incomplete backfill, so
the UI can explain a zero-enqueued result.

## Risks / Trade-offs

- **R1 — A full-history request across a large org is a large amount of API traffic.** Each PR node
  pulls up to 100 reviews and 100 commits inline (`src/github/graphql.ts:96,107`), so page cost is
  high. → Priority 100 plus the existing safety threshold means it degrades into a slow pause/resume
  loop rather than exhausting quota; progress stays visible throughout so a member can see it is
  advancing rather than stuck.
- **R2 — The created-at walk re-fetches PRs the initial backfill already holds** before reaching
  uncovered ground (D2). → Correctness is unaffected (upserts), and the wasted pages are bounded by
  what the default window covered, not by repository size. If measurement shows this dominating,
  D2's `search` alternative removes it.
- **R3 — Deepening runs concurrently with incremental sync on the same repository.** Both upsert on
  the same GitHub node id, so the last write wins. → The history pass writes older PRs that
  incremental sync will not touch in the same window; where they do overlap, the incremental path
  carries fresher data and runs at higher priority. Acceptable, but the handler must not clobber
  `synced_through`, which belongs to the incremental path alone.
- **R4 — `history_covered_from` is a creation-time boundary while `backfill_window_start` is an
  update-time one.** A PR created before the coverage start but updated inside the default window is
  already present. → Coverage is deliberately a floor, not an exact description of the row set:
  "everything created after this point is present" is true, and extra older rows are harmless.
  Surfaces must phrase completeness as "data from X onwards", not "only data from X".
- **R5 — A very old repository may never finish under a low rate limit.** → `history_state` and
  `history_covered_from` make the stall visible and the pass resumes indefinitely; nothing is lost,
  but a member may wait days for a large org. Set expectations in the UI copy.

## Migration Plan

1. Migration `0007_history_sync.sql`: add the D3 columns, widen the `sync_runs.kind` CHECK to
   include `'history'`. Additive only — no rewrite of existing rows beyond step 2.
2. Seed existing rows: `history_covered_from = backfill_window_start` for repositories with
   `backfill_state = 'complete'`, `history_state = 'idle'`, `history_complete = false`. Existing
   installations then correctly report ~90 days of coverage rather than claiming full history.
3. Ship the handler and endpoint. No behavior changes until a member requests a history sync.
4. Ship the UI controls.

Rollback: the feature is inert without the endpoint being called. Reverting the application leaves
the added columns unused and populated; no data is lost and no re-migration is needed.
