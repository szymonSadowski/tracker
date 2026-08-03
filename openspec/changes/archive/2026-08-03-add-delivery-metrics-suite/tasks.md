## 1. Schema

- [x] 1.1 Add migration `0008_file_diffs.sql`: `pr_files` (workspace, pull request, path, additions, deletions, change kind, unique on workspace+pr+path) and `pr_commit_files` (per-commit file stats, keyed workspace+commit+path), both with indexes for per-pull-request lookup
- [x] 1.2 Add `files_truncated boolean` to `pull_requests` for pull requests exceeding GitHub's file enumeration limit
- [x] 1.3 Add migration `0009_review_comments.sql`: `pr_review_comments` (workspace, pull request, optional review, author contributor, node id, submitted_at), unique on workspace+node id
- [x] 1.4 Add migration `0010_default_branch_commits.sql`: `repository_commits` (workspace, repository, oid, author contributor, committed_at, additions, deletions, changed_files, `reachable boolean`), unique on workspace+repository+oid, indexed on workspace+repository+committed_at
- [x] 1.5 Add migration `0011_membership_history.sql`: `team_memberships` (workspace, team, contributor, started_at, ended_at nullable) and `workspace_memberships` with the same shape; index for interval-overlap queries
- [x] 1.6 Add migration `0012_pr_analysis_v2.sql`: nullable columns on `pr_analysis` for coding/pickup/review seconds, new/refactor/rework line counts, excluded line count, review depth, PR maturity, `churn_used_recency_estimate`, and per-metric input-presence flags
- [x] 1.7 Add migration `0013_classification.sql`: `pr_classifications` (workspace, pull request, work type, confidence, rationale, content hash, classification version, human corrected, corrected by, timestamps) and per-workspace classification settings (enabled, spend bound, spend consumed, paused reason)
- [x] 1.8 Add migration `0014_benchmarks.sql`: `benchmark_thresholds` (metric, tier, lower bound, upper bound, source, study date) and seed it from the published 2026 study values
- [x] 1.9 Add migration `0015_coverage_by_class.sql`: per-repository coverage start per data class (pull requests, file diffs, default-branch commits), replacing the single coverage marker with a per-class one and backfilling existing values into the pull request class
- [x] 1.10 Backfill `team_memberships` and `workspace_memberships` from current membership with `started_at` set to each contributor's `first_seen_at`

## 2. Ingestion

- [x] 2.1 Extend the GraphQL backfill pull request query with the `files(first: 100)` connection (path, additions, deletions, changeType) and page it until complete
- [x] 2.2 Normalize file connections into `pr_files`, idempotent on workspace+pull request+path; mark `files_truncated` when GitHub stops enumerating
- [x] 2.3 Extend the same query with review comments (review-attached and diff threads) and normalize into `pr_review_comments`, including removal when a previously ingested comment disappears
- [x] 2.4 Add per-commit file statistics ingestion for commits on a pull request, into `pr_commit_files` — the input for the post-review rework component
- [x] 2.5 Add a default-branch commit ingestion job using `defaultBranchRef.target.history(since:, until:)`, writing `repository_commits`; mark commits unreachable rather than deleting them when history is rewritten
- [x] 2.6 Add a `file_fill_in` sync run kind: resumable pass that fills `pr_files`, `pr_commit_files`, and `pr_review_comments` for already-ingested pull requests, ranked below incremental sync in the quota priority, recording progress and pause reasons on `sync_runs`
- [x] 2.7 Update per-class coverage on each ingestion path so churn coverage can be reported separately from pull request coverage
- [x] 2.8 Extend the REST incremental path to produce the same normalized file, comment, and commit records as the GraphQL path
- [x] 2.9 Tests: identical normalized records across paths; file list paging to completion; truncated file list marked and not silently partial; re-ingesting an identical file list is a no-op; commit reachable both via a pull request and the default branch resolves to one record

## 3. Per-pull-request metrics

- [x] 3.1 Add coding, pickup, and review time to `src/analysis/metrics.ts`, with cycle time re-anchored to first commit and the phases summing to the whole when all three are computable
- [x] 3.2 Handle the anchor edge cases: first commit after ready-for-review clamps coding time to zero; missing first commit makes coding time absent and falls cycle time back to ready-for-review; no human review makes pickup and review absent while cycle time still computes
- [x] 3.3 Implement review depth from `pr_review_comments`, excluding the author and bots; absent when comment data is unavailable, zero when reviews genuinely carried no comments
- [x] 3.4 Implement PR maturity from commit file statistics before and after ready-for-review, computed from recorded push events so a force-push does not error the record
- [x] 3.5 Implement churn classification: exact new-code and post-review-rework components, file-level recency component for the remainder, refactor as the balance; record excluded lines and set `churn_used_recency_estimate`
- [x] 3.6 Add workspace configuration for the rework recency window (default 21 days) and churn exclusion path patterns, with defaults, participating in the definition revision
- [x] 3.7 Make churn absent (never zero) for unmerged pull requests, pull requests with no ingested file data, and pull requests with a truncated file list
- [x] 3.8 Add per-metric input-presence flags to the analysis record so a definition change can target only affected rows
- [x] 3.9 Bump `COMPUTED_VERSION` to 2 and extend `scripts/recompute.ts` with targeting by metric family
- [x] 3.10 Trigger recompute for a pull request when its file data arrives after it was first analyzed
- [x] 3.11 Tests: the spec's phase decomposition scenario; each anchor edge case; churn on an added file, on long-standing code, on recently-written code, on post-review changes, and with excluded paths; review depth excluding author and bots; PR maturity at 100% and after post-submission revision; recompute determinism at a fixed version

## 4. Aggregation

- [x] 4.1 Add period bucketing (day/week/month) in the workspace time zone, producing a bucket per period including empty ones, with stable assignment across recomputation
- [x] 4.2 Extend `src/analysis/aggregate.ts` with p50/p75/p90 plus mean per latency metric, suppressing percentiles below the minimum sample size while still reporting the contributing count
- [x] 4.3 Implement contributor-day denominators from the membership interval tables, prorated across joins, departures, and team moves, excluding bots and non-contributors
- [x] 4.4 Implement PR throughput as merged pull requests over prorated contributors, absent when a scope has no active contributors
- [x] 4.5 Implement churn composition aggregates (shares and absolute line counts) per bucket and scope
- [x] 4.6 Implement commit activity aggregates from `repository_commits`, excluding unreachable commits
- [x] 4.7 Implement size and latency distribution aggregates for the distribution surfaces
- [x] 4.8 Add benchmark tier assignment against p75, reading `benchmark_thresholds`, exposing the thresholds and source, and assigning no tier where none is configured
- [x] 4.9 Report per-aggregate coverage: contributing count, excluded-for-missing-metric count, and whether a bucket falls outside the relevant per-class coverage
- [x] 4.10 Add a test asserting no exported aggregation function accepts or produces a contributor ordering, at any scope
- [x] 4.11 Tests: bucket assignment at time zone boundaries; empty bucket inside coverage vs bucket outside coverage; team-move proration producing 0.5/0.5; a pull request counted once at workspace scope and in both of its author's teams; minimum sample size suppression; tier assignment and re-evaluation after a threshold change without recomputing aggregates
- [x] 4.12 Capture p95 query timings for a 90-bucket daily series at representative row counts and record them, so the design's rollup-cache threshold is measurable rather than theoretical

## 5. Work classification

- [x] 5.1 Add `@anthropic-ai/sdk` as a runtime dependency, imported only by the worker; add a lint rule or test preventing `app/` and `src/analysis/` from importing it
- [x] 5.2 Build the classification input from stored data only — title, body, commit messages, changed paths, diff statistics — with a test asserting no file contents are included in the payload
- [x] 5.3 Implement the prompt with a byte-stable instruction and taxonomy prefix carrying the cache breakpoint, and per-pull-request content after it
- [x] 5.4 Implement classification via `client.messages.batches` on `claude-opus-5` with `output_config.format` constraining `type` to the seven-value enum, `effort: "low"`, results keyed by `custom_id`
- [x] 5.5 Reject and record out-of-set work types as classification failures rather than coercing them
- [x] 5.6 Store confidence and rationale; treat below-threshold classifications as unclassified for ratios while still showing them on the pull request
- [x] 5.7 Implement content-hash plus version eligibility so an unchanged pull request at the current revision makes no provider call, and a bulk re-run recomputes stale revisions
- [x] 5.8 Implement owner override: set work type, mark human-corrected, preserve across bulk re-runs, reject from non-owners, recompute affected ratios
- [x] 5.9 Implement per-workspace spend bounds — enforced before enqueueing a batch, pausing rather than failing, with the pause reason visible to owners — and run classification at the lowest job priority
- [x] 5.10 Implement defect and innovation ratios over classified merged pull requests per bucket and scope, reporting unclassified counts and going absent when a bucket has no classified pull requests
- [x] 5.11 Tests: provider unavailable leaves pull requests unclassified and eligible later; classification disabled leaves every deterministic metric and surface unaffected; re-classification changing a work type leaves cycle time, churn, and size unchanged; ratios computed over the classified subset with unclassified reported; corrections survive a bulk re-run

## 6. Chart primitives

- [x] 6.1 Add server-rendered SVG chart primitives in `src/ui/`: line/area series, stacked bars, histogram bars — matching the existing `components.tsx` conventions, no client bundle, no new frontend dependency
- [x] 6.2 Render a visually-hidden value table alongside every chart, satisfying both the text-values and accessibility requirements
- [x] 6.3 Distinguish series by pattern and label as well as color
- [x] 6.4 Render absent buckets as gaps rather than zero points, and uncovered buckets in a distinct hatch with an explicit label
- [x] 6.5 Make charts legible on narrow viewports with the page never scrolling horizontally
- [x] 6.6 Implement bucket drill-through as links into the filtered pull request list rather than client-side interaction

## 7. Surfaces

- [x] 7.1 Add a granularity control (day/week/month) that re-buckets without changing the selected period
- [x] 7.2 Add time-series charts for every rollup metric to the team and personal views, alongside the existing headline values
- [x] 7.3 Add the stacked cycle-time phase chart with per-bucket decomposition coverage and phase drill-through
- [x] 7.4 Add the churn composition chart with a shares/absolute toggle and rework marked against the needs-focus threshold
- [x] 7.5 Add the commit activity chart, filterable by repository and team
- [x] 7.6 Add size and latency distribution views with percentile summaries and a too-small-sample state
- [x] 7.7 Add benchmark tier and threshold rendering, naming the published source and making clear it is not a workspace-set target
- [x] 7.8 Add the work mix surface with work-type distribution, both ratios, segment drill-through, and a classification-disabled state that leaves other surfaces unaffected
- [x] 7.9 Extend the existing completeness messaging to charts: uncovered buckets labeled, churn coverage start stated, classification-still-running reported with the ratios shown over the classified subset
- [x] 7.10 Tests: chart with a partially covered series renders uncovered buckets distinctly and never as zero; churn chart over a period predating file coverage states from when data exists; work mix with classification disabled shows the off state while other surfaces render normally

## 8. Migration and rollout

- [x] 8.1 Run all migrations and the membership backfill against a copy of production data; verify additive-only and no changed column meanings
- [x] 8.2 Run the workspace-wide recompute at `COMPUTED_VERSION` 2 and verify historical cycle times shift as expected with the new revision recorded on every row
- [x] 8.3 Start the file fill-in pass and verify it resumes after interruption, yields to incremental sync, and extends churn coverage backwards
- [x] 8.4 Verify the rollback path: reverting `COMPUTED_VERSION` to 1 and re-running the recompute restores the previous cycle time definition
- [x] 8.5 Ship classification off by default per workspace; enable it for one workspace and verify spend bounds, pausing, and the deterministic surfaces staying unaffected
- [x] 8.6 Document the cycle time redefinition and the churn recency approximation in `docs/` and in the release notes
- [x] 8.7 Run `npm run lint`, `npm run typecheck`, and `npm test`; confirm the full suite passes
