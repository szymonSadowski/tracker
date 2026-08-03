## Context

See proposal.md — Why. What shapes the approach technically:

- **The derived layer already exists and was built to be extended.** `pr_analysis` is one row per pull
  request keyed `(workspace_id, pull_request_id)`, carries `computed_version`, and already reserves
  `summary`, `pr_type`, `risk_flags`, `analysis_skill_version` for "the later LLM layer: added to this
  row, never a second row". This change is that layer arriving, plus phase and churn columns.
- **Aggregation today is on-read SQL.** `src/analysis/aggregate.ts` queries `pr_analysis` directly and
  returns `{median, p75, covered, total}`. There is no materialized rollup and no invalidation
  machinery to inherit.
- **Ingestion is raw-payload-first.** `github_raw_events` retains verbatim GitHub payloads keyed by
  `(workspace_id, entity_node_id, payload_hash)`, so normalized and derived data can be rebuilt
  without the API. Anything we ingest now can be reprocessed later without re-spending quota.
- **The dependency surface is deliberately small.** Runtime dependencies are `next`, `react`,
  `react-dom`, `pg`. No CSS framework, no ORM, no charting library, no HTTP client. Every dependency
  this change adds is a real decision, not a default.
- **Two product invariants constrain everything.** Absent is never zero, and no code path may order
  contributors by a metric. `aggregate.ts` enforces the second by construction — "There is no
  function that orders contributors" — and the new spec extends both to churn, charts, and
  classification.

## Goals / Non-Goals

**Goals**

- Keep every deterministic metric a pure function of stored rows, computable without network access,
  so the LLM provider being down degrades exactly one surface.
- Make churn honest: define it in terms of data we actually have, and say plainly where the
  definition is an approximation rather than shipping a number that implies more precision than the
  inputs support.
- Add the phase, churn, and rollup work without introducing a second source of truth that can drift
  from `pr_analysis`.
- Keep the frontend dependency count at zero additions.

**Non-Goals**

- No deployment or incident ingestion, and therefore no deploy time, deploy frequency, change
  failure rate, or MTTR. Cycle time terminates at merge.
- No line-level `git blame`. Churn is computed from the diffs we ingest, not from full file history.
- No materialized rollup tables in this change. See D3 for the threshold at which that changes.
- No per-contributor comparison surface, ranked or otherwise, anywhere in the new work.

## Decisions

### D1 — Cycle time is redefined to start at the first commit, and history is recomputed

`pull_requests.first_commit_at` already exists and is populated. Cycle time moves from
`ready_for_review → merged` to `first_commit → merged`, decomposing into coding, pickup, and review.
This is the definition both LinearB and getDX use, and the phase decomposition is the whole point of
the metric — a merge-terminated span with no phases tells a leader nothing actionable.

`COMPUTED_VERSION` bumps to 2. `scripts/recompute.ts` already exists and rebuilds analysis records
from stored data; the migration runs it workspace-wide. Historical cycle times will shift upward —
that is the correct behavior, and the definition revision on each row is what makes it explainable.

*Alternative considered*: keep the old anchor and add "total cycle time" as a separate metric. Rejected
— two metrics named cycle time that differ by one anchor is exactly the ambiguity this product exists
to remove, and the surfaces would have to explain which one they mean forever.

Guards, all covered by spec scenarios: `first_commit_at` after `ready_for_review_at` clamps coding
time to zero rather than going negative; a missing `first_commit_at` makes coding time absent and
falls back to the ready-for-review anchor; phases sum to the whole whenever all three are computable.

### D2 — Churn is computed from ingested diffs, with file-level recency standing in for line age

Rework, as LinearB defines it, needs to know when each modified line was written. That is
`git blame` per file per pull request — far outside the API budget, and not derivable from diff
statistics at all.

What we ingest instead, per pull request, is a `pr_files` row per changed path with additions,
deletions, and change kind, plus the same per commit. From that:

- **New code** — additions in files whose change kind is `added`, plus additions in modified files
  beyond the deletion count in that file. Exact.
- **Rework, post-review component** — lines added or deleted by commits whose `committed_at` is after
  the pull request's first human review. Exact, and it is the component that actually drives the
  conversation about review churn.
- **Rework, recency component** — deletions in a file whose most recent prior change *in our own
  ingested history* falls inside a 21-day window. **This is an approximation**: it is file-level, not
  line-level, and it can only see back as far as our coverage extends.
- **Refactor** — the remaining deletions and matched modifications.

The approximation is recorded on the analysis record and surfaced, not hidden: a pull request whose
churn used the recency component in a repository with shallow coverage is flagged, and the spec
already requires churn to be absent rather than guessed where file data is missing entirely.

*Alternative considered*: fetch blame via GraphQL `blame(path:)`. Rejected — one query per file per
pull request, on a product that already treats quota as a first-class constraint, to sharpen a metric
whose consumers read it as a trend rather than an absolute.

*Alternative considered*: drop refactor/rework and ship only new-vs-changed. Rejected — rework after
review is the single most actionable churn signal and it is exactly the component we can compute
exactly.

The 21-day window and the churn exclusion patterns (lock files, generated code, vendored paths) are
workspace configuration with defaults, not constants, and they participate in the definition revision
so changing one triggers a targeted recompute.

### D3 — Aggregation stays on-read SQL; no rollup tables yet

Every aggregate in the new spec is expressible as one query over `pr_analysis` with `date_trunc` for
bucketing and `percentile_cont` for p50/p75/p90, filtered by the viewer's readable repository set.
The existing indexes — `pr_analysis_merged_idx`, `_author_idx`, `_repo_idx` — already cover the
bucketing predicates.

Computing on read makes the spec's invalidation requirements true by construction: there is no cached
value that can disagree with the row beneath it, no invalidation queue to get wrong, and no window
where a chart and a tile show different numbers for the same metric. That is worth more here than the
latency a rollup table would save at current data volumes.

*Alternative considered*: materialize daily buckets and roll weekly/monthly up from them. Rejected for
now — percentiles do not compose across buckets, so it would mean storing per-bucket value arrays and
merging them on read, which is a materially more complex thing to get right than the query it
replaces.

**The threshold for revisiting**: when a workspace's `pr_analysis` row count makes a 90-bucket daily
series exceed ~200ms at p95. At that point add a `metric_rollups` cache table keyed by
`(scope, metric, granularity, bucket, definition_version)`, written by a job, read only when its
version matches — with the on-read query retained as the fallback and the correctness reference. The
task list includes recording the query timings needed to know when we have crossed it.

Percentiles are suppressed below a minimum sample size (default 5) rather than computed from a handful
of pull requests, per spec.

### D4 — The contributor denominator comes from a membership-interval table

PR throughput needs contributor-days per scope per bucket, prorated across joins, departures, and
team moves. The current `teams` schema records current membership; proration needs history.

Add `team_memberships` with `(workspace_id, team_id, contributor_id, started_at, ended_at)`, ended
open, and the equivalent at workspace scope. The denominator for a bucket is then the summed overlap
between each contributor's membership intervals and the bucket, divided by the bucket length —
a contributor who moved teams mid-month contributes 0.5 to each, exactly as the spec's scenario
requires. Bots and contributors flagged non-contributor are excluded from both numerator and
denominator.

Existing memberships are backfilled with `started_at` set to the contributor's `first_seen_at`, which
is the earliest defensible claim we can make from data we hold.

### D5 — File diffs and default-branch commits ride the existing GraphQL backfill

GitHub's GraphQL `pullRequest.files(first: 100)` returns `path`, `additions`, `deletions`, and
`changeType` nested inside the pull request query the backfill already issues. Folding the file
connection into that query costs no additional round trips for pull requests going forward, which
substantially reduces the backfill-cost concern raised in the proposal. Review comments come from the
same query via `reviews.comments` and `reviewThreads`.

Default-branch commits use `defaultBranchRef.target.history(since:, until:)` with `additions` and
`deletions` per commit — a separate paged query, but one per repository per window rather than one per
pull request.

Pull requests exceeding GitHub's file enumeration limit are marked `files_truncated`, and metrics
requiring a complete file list are absent for them rather than computed from a partial list.

Filling in file data for already-ingested history is a separate resumable job class, ranked below
incremental sync in the existing quota priority, writing progress to `sync_runs` with a new `kind`.
Per-class coverage is recorded on the repository so a churn surface can say "covered from" separately
from the pull request coverage the surfaces already show.

### D6 — Work classification uses Claude Opus 5 through the Batches API

Classification is high-volume, entirely latency-insensitive, and has a small closed output space.
That maps onto three things in combination:

- **Message Batches** (`client.messages.batches`) — 50% of standard pricing, up to 100k requests per
  batch, results keyed by `custom_id`. Backfilling a workspace's history is a batch job by nature, and
  ongoing classification batches per sync cycle rather than per pull request.
- **Structured outputs** — `output_config.format` with a JSON schema whose `type` field is an enum of
  the seven work types. The spec requires the set to be closed and an out-of-set value to be treated
  as a failure; a schema-constrained enum makes that the normal path rather than a validation branch.
- **Prompt caching** — the instruction block and taxonomy are byte-stable across every request and go
  first; the per-pull-request content (title, body, commit messages, changed paths) goes last, after
  the breakpoint. Opus 5's 512-token cache minimum means the shared prefix caches even though it is
  short.

Model is `claude-opus-5`. Effort is set to `low` with thinking left on its default rather than
disabled — on this model disabling thinking is the more expensive lever in practice and carries known
failure modes, while low effort gets the token saving without them.

`@anthropic-ai/sdk` is the one new runtime dependency, and only the worker imports it. Nothing in
`app/` or `src/analysis/` may.

Caching and versioning: each classification stores a hash over `(title, body, commit messages, changed
paths)` and a `classification_version` covering prompt and model. A pull request is eligible for
re-classification only when its hash changed or its version is stale, which makes the spec's
"unchanged pull request makes no provider call" requirement a lookup rather than a heuristic.
Human corrections set a flag that bulk re-runs skip.

Spend control is per workspace: a token budget per period, enforced before enqueueing a batch, with
the pause and its reason recorded where owners can see it. Classification runs at the lowest job
priority in the existing queue.

**Diff contents are never sent.** Paths, titles, bodies, commit messages, and counts only. This is a
spec requirement, and it also keeps the payload small enough that batching is cheap.

### D7 — Charts are hand-rolled server-rendered SVG

The frontend has four runtime dependencies and no styling framework. A charting library would be the
largest dependency in the project, would pull a client bundle into a codebase that renders on the
server, and would fight the spec's requirements rather than help them — "values available as text",
"series distinguishable without color", and "gaps rather than zero points" are all defaults we have to
implement ourselves in any library.

Instead: a small set of chart primitives in `src/ui/` emitting SVG from the server, in the same shape
as the existing `components.tsx`. Line/area for series, stacked bars for the cycle-time and churn
compositions, histogram bars for distributions. Each chart renders a visually-hidden table of its
underlying values, which satisfies the text-values requirement and the accessibility one at once.
Series get both a distinct pattern and a label. Absent buckets break the path rather than dropping to
zero, and uncovered buckets render in a distinct hatch with an explicit label.

Interactivity is limited to what plain links give us — drilling into a bucket is a link to the pull
request list with that bucket's filter applied, not a client-side tooltip layer.

*Alternative considered*: Recharts or similar. Reconsider if the product later needs brushing, zoom,
or cross-filtering — none of which the spec asks for.

### D8 — Benchmark thresholds are seeded configuration, not constants

Tiers come from LinearB's published 2026 study (p75 aggregation, four tiers). They live in a seeded
config table with the source and study date attached, so the spec's "re-evaluate tiers without
recomputing aggregates" requirement is a config read, and so a surface can name where the number came
from rather than presenting an industry benchmark as a target the workspace set. Metrics with no
configured threshold get no tier and none is inferred.

## Risks / Trade-offs

**Churn's recency component is an approximation and will be read as exact.** → Name the approximation
in the UI where the number appears, not only in the docs; flag pull requests whose churn depended on
it in a shallow-coverage repository; keep the exact post-review component separable so a viewer can
see the part we are certain about.

**Redefining cycle time changes every historical number.** → Ship the recompute with the migration
rather than letting rows drift; keep the definition revision on every row; state the change in the
release notes. A leader who screenshots a dashboard before and after and sees different numbers with
no explanation loses trust in the whole product.

**File-diff ingestion increases per-pull-request API cost.** → Fold the file connection into the
existing GraphQL query so ongoing sync costs nothing extra; make the historical fill-in resumable and
lower-priority than incremental sync; let churn coverage lag pull request coverage openly rather than
blocking on a complete backfill.

**LLM classification introduces cost that scales with workspace size.** → Batches API halves it,
prompt caching cuts the shared prefix, content-hash caching prevents re-classifying unchanged pull
requests, and a per-workspace spend bound pauses rather than fails. The deterministic product works
fully with classification disabled.

**Classification is probabilistic and will sometimes be wrong in a way a viewer notices.** → Store
confidence and rationale; drop below-threshold results from ratios while still showing them on the
pull request; let owners correct and preserve corrections across re-runs. Never let it touch a
deterministic metric.

**On-read aggregation will eventually be too slow.** → D3 names the threshold and the migration path,
and the task list includes capturing the timings that tell us we have reached it. The risk of shipping
a cache too early — two numbers that disagree — is worse than the latency.

**More surfaces means more places to violate the no-ranking rule.** → Keep the rule enforced where it
already is: by the absence of an ordering function in the aggregation module. Contributor-scope
aggregates return one contributor's values with no comparison set, and a test asserts no exported
query accepts a contributor ordering.

**Hand-rolled charts are work we own forever.** → Accepted deliberately. The chart set is small and
bounded by the spec, the requirements are ones we would have to implement over a library anyway, and
the alternative is the heaviest dependency in the project for interactivity nothing asks for.

## Migration Plan

1. Additive migrations only: `pr_files`, `pr_review_comments`, `repository_commits`,
   `team_memberships`, `benchmark_thresholds`, `pr_classifications`, plus new nullable columns on
   `pr_analysis` (phase durations, churn counts and shares, review depth, PR maturity, per-metric
   input-presence flags). No existing column changes type or meaning.
2. Backfill `team_memberships` from current membership with `started_at = contributor.first_seen_at`.
3. Seed `benchmark_thresholds` from the published study.
4. Deploy ingestion changes. New pull requests carry file, comment, and commit data immediately;
   existing rows do not, and churn coverage reports as starting from the deploy.
5. Bump `COMPUTED_VERSION` to 2 and run the workspace-wide recompute. Latency and size metrics are
   correct immediately at the new definitions; churn stays absent where file data has not arrived.
6. Start the file-data fill-in pass at low priority. Churn coverage extends backwards as it runs.
7. Ship surfaces behind the existing coverage reporting — charts render from the first deploy and
   mark uncovered buckets rather than waiting for the fill-in.
8. Enable classification last, off by default per workspace, so the deterministic product is verified
   in production before an external dependency is added to it.

**Rollback**: the migrations are additive, so rolling back code leaves unread tables and null columns
behind. Reverting `COMPUTED_VERSION` to 1 and re-running the recompute restores the previous cycle
time definition. Classification is a per-workspace switch and disabling it affects only the work-mix
surface.
