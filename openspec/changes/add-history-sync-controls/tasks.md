## 1. Schema and storage

- [x] 1.1 Add `migrations/0007_history_sync.sql`: `history_covered_from`, `history_complete`,
      `history_cursor`, `history_requested_from`, `history_state` on `repositories` (design D3), and
      widen the `sync_runs.kind` CHECK to include `'history'` (design D6)
- [x] 1.2 In the same migration, seed existing rows — `history_covered_from = backfill_window_start`
      and `history_state = 'idle'` for repositories with `backfill_state = 'complete'` (migration
      plan step 2)
- [x] 1.3 Extend `RepositoryRecord` / row mapping in `src/repositories/store.ts` with the new
      columns
- [x] 1.4 Add store functions in `src/repositories/store.ts`: `markHistorySyncStarted`,
      `recordHistoryProgress` (advances cursor and `history_covered_from` together),
      `markHistoryComplete`, `markHistoryPaused`, `markHistoryFailed`
- [x] 1.5 Extend `syncStatus` in `src/repositories/store.ts` to return coverage and history state per
      repository, and a workspace-level coverage start (earliest complete point across in-scope
      repositories)

## 2. GraphQL paging by creation date

- [x] 2.1 Add a created-at-ordered PR page query to `src/github/graphql.ts`
      (`orderBy: {field: CREATED_AT, direction: DESC}`), reusing the existing node selection so
      normalization is unchanged (design D2)
- [x] 2.2 Add a client method for it alongside `fetchPullRequestPage`, returning the same page shape
- [x] 2.3 Unit-test the new query against the existing GraphQL fixtures in `tests/github`

## 3. History sync ingestion

- [x] 3.1 Create `src/ingest/history.ts` with `runHistorySync(db, { workspaceId, repositoryId, from },
      deps)` — chunked like backfill (bounded pages per run, cursor recorded after every page,
      re-enqueues itself while work remains)
- [x] 3.2 Stop the walk when `createdAt < from`, or when `hasNextPage` is false for an unbounded
      request; mark `history_complete` only in the latter case (spec: "Repository has no history
      older than its coverage")
- [x] 3.3 Short-circuit when the requested range is already covered — no pages fetched, outcome
      reports `alreadyCovered` (spec: "Requested range is already covered")
- [x] 3.4 Persist via the existing `persistPullRequest` with a new `source` value for this path, so
      raw payloads stay attributable and reprocessing keeps working
- [x] 3.5 Call `rateLimit.assertHeadroom` between pages; on the pause path write
      `history_state = 'paused'` and finish the `sync_runs` row as `paused`, distinct from failure
      (design D5)
- [x] 3.6 Do not write `synced_through` from this path — it belongs to incremental sync (design R3)
- [x] 3.7 Record a `sync_runs` row with `kind = 'history'` per run, carrying the requested range and
      cursor

## 4. Job wiring

- [x] 4.1 Add `repository.history_sync` to `src/jobs/types.ts` with payload
      `{ repositoryId, from: string | null }` (design D4)
- [x] 4.2 Register the handler in `src/jobs/handlers/index.ts`, wrapped in `withInstallationHealth`
      like the other GitHub-touching handlers
- [x] 4.3 Enqueue at priority 100 with dedupe key `history:<repositoryId>` so incremental work is
      dispatched first and duplicate requests are no-ops (design D1, D5)
- [x] 4.4 Add `requestHistorySync(db, workspaceId, from)` that fans out one job per in-scope
      repository and returns per-repository outcome (enqueued / already covered / already running)

## 5. API

- [x] 5.1 Add `POST /api/workspaces/[workspaceId]/history-sync` accepting `{ from: ISO date | null }`,
      guarded by `requireWorkspaceAccess` like the existing sync route
- [x] 5.2 Validate `from`: reject future dates and unparseable values with 400
- [x] 5.3 Return the per-repository outcome from 4.4 plus current progress, so the UI can render
      "already covered" and "already running" without a second request
- [x] 5.4 Extend `requestOnDemandSync` in `src/ingest/incremental.ts` to also return repositories
      skipped for incomplete backfill, and surface that in the existing sync route's response
      (spec: "Member triggers a sync during backfill")
- [x] 5.5 Give `requestOnDemandSync` an optional `repositoryId`, narrowing both the fan-out and the
      debounce window to that repository, and accept it on the sync route behind
      `assertRepositoryVisible` (spec: "Member syncs a single repository")

## 6. UI

- [x] 6.1 Add a client component for the sync-now button: posts to the existing sync endpoint,
      renders enqueued / debounced / skipped-repository outcomes (design D7)
- [x] 6.2 Add a client component for the history sync control: choose all-history or a start date,
      post, and show the returned per-repository outcome
- [x] 6.3 Wire both into `app/w/[workspaceId]/settings/page.tsx`, keeping the page a server
      component and passing initial state as props
- [x] 6.4 Show per-repository coverage start and history state in the settings repository table
      (spec: "History sync progress is observable"), with the paused-for-rate-limits case worded
      distinctly from failure
- [x] 6.5 Add shared presentation for coverage state in `src/ui/components.tsx`
- [x] 6.6 Add a per-repository sync button to `app/w/[workspaceId]/pulls/page.tsx`, shown only while
      the list is filtered to a single visible repository

## 7. Analytics surfaces

- [x] 7.1 Thread workspace coverage start into the metric surfaces so a selected period can be
      compared against it
- [x] 7.2 When the selected period starts before coverage, show the partial-coverage notice naming
      the date data begins, and link to the history sync control (spec: analytics-dashboard
      "A viewer selects a period reaching before synced coverage")
- [x] 7.3 Keep a fully covered but empty period rendering as genuinely empty, not as missing data
- [x] 7.4 Show the in-progress notice while a history sync is running, without suppressing metrics
      for periods inside existing coverage

## 8. Tests

- [x] 8.1 `tests/ingest`: history sync resumes from its cursor after an interruption and creates no
      duplicates
- [x] 8.2 `tests/ingest`: a bounded request stops at the requested date; an unbounded one runs to
      `hasNextPage: false` and sets `history_complete`
- [x] 8.3 `tests/ingest`: deepening a repository backfilled under the default window ingests only
      the older PRs and leaves existing rows unchanged
- [x] 8.4 `tests/ingest`: rate-limit headroom failure mid-walk records progress and marks paused,
      not failed
- [x] 8.5 `tests/jobs`: duplicate history requests for one repository enqueue a single job; history
      jobs are dispatched after pending incremental jobs
- [x] 8.6 `tests/surfaces`: partial-coverage notice appears for a period predating coverage and is
      absent for a covered-but-empty period
- [x] 8.7 `tests/e2e`: request a history sync from settings and observe coverage extending; trigger
      sync-now twice and observe the debounced response surfaced
- [x] 8.8 `tests/ingest`: a single-repository request enqueues only that repository, and the
      debounce is measured per target rather than per workspace

## 9. Configuration and docs

- [x] 9.1 Document `BACKFILL_WINDOW_DAYS` as the connect-time default rather than a ceiling in
      `src/config/env.ts` and the README env table
- [x] 9.2 Add any new tunables (pages per history run) to `src/config/env.ts` with defaults, matching
      how `PAGES_PER_RUN` is currently expressed
- [x] 9.3 Update `docs/` with the two controls and what a full-history request costs in time and API
      quota (design R1, R5)
