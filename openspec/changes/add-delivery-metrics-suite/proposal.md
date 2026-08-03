## Why

The product today computes a handful of per-pull-request latency metrics and renders them as
numbers on a team and personal page. That is a fraction of what the tools we intend to replace —
LinearB and getDX — put in front of an engineering leader. Neither the metrics people actually ask
for (PR throughput per contributor, code churn, a cycle time broken into the phases you can act on)
nor the graphical reading of trends over time exist yet, and the per-pull-request record has no
notion of what a change was *for*, so mix-of-work questions cannot be answered at all.

This change closes that gap in one pass: the ingestion needed to support it, the metric definitions,
a rollup layer the surfaces read from, an LLM classification of work type, and the charts.

## What Changes

**Ingestion**
- Ingest per-file diff statistics for each pull request (path, additions, deletions, change kind),
  so line-level churn can be classified rather than inferred from a whole-PR total.
- Ingest review comment counts, so review depth and PR maturity are computable.
- Ingest default-branch commits independently of pull requests, so commit activity is a real series
  rather than a by-product of PR ingestion.
- Record, per pull request, which line changes landed after the first review — the input to rework.

**Per-pull-request metrics** (extends the existing analysis record)
- **Coding time** — first commit to ready-for-review. The phase the product currently cannot see,
  and the largest slice of cycle time in the LinearB benchmark data.
- **Pickup time** — ready-for-review to first review activity, named as its own phase.
- **BREAKING** — **cycle time is redefined and decomposed**. Its start anchor moves from
  ready-for-review to the first commit, so the headline covers coding → pickup → review and matches
  how both tools we are replacing state it. It stays merge-terminated. Historical values shift; the
  bulk recompute below is what reconciles them.
- **Code churn** split three ways per merged pull request: **new code** (added lines), **refactor**
  (lines modified in code older than the rework window), **rework** (lines modified after first
  review, or modified within a recency window of when they were written).
- **Review depth** (review comments per pull request) and **PR maturity** (share of the change that
  survived unchanged after submission).

**Aggregation**
- A rollup layer that produces metrics per period bucket (day/week/month) across workspace,
  team, repository, and contributor scopes — the thing every chart and tile reads from, instead of
  each surface aggregating raw rows itself.
- **PR throughput** normalized per active contributor, with the denominator prorated across team
  membership changes, joins, and departures within a bucket.
- Percentile aggregation (p50/p75/p90) alongside means, because latency distributions are skewed and
  p75 is what the published benchmarks are stated in.
- Benchmark tiers (Elite / Good / Fair / Needs Focus) attached to comparable metrics, so a number
  carries a judgment the viewer can act on.

**Work classification (LLM)**
- Classify each pull request into a work type (feature, bug fix, refactor, chore, docs, test,
  dependency) from its title, body, commit messages, and changed paths.
- Derive **defect ratio** (share of work on bug fixes) and **innovation ratio** (share of work on new
  capability) from those classifications.
- Classification is versioned, cached per pull request content, re-runnable in bulk, and never
  blocks a deterministic metric — a pull request with no classification is absent from ratio
  metrics, not counted as zero.

**Surfaces**
- Time-series charts for every rollup metric: throughput, cycle time and its phase decomposition as
  a stacked series, commit activity, merge frequency.
- A churn composition chart (new / refactor / rework) over time.
- Distribution views for PR size and review latency, replacing single-number tiles that hide skew.
- A work-mix chart driven by classification.
- Benchmark banding rendered against the relevant series.

**Not in scope**: deployment and incident ingestion. Cycle time therefore terminates at merge, and
DORA metrics that require deploy or incident data (deploy frequency, change failure rate, MTTR) are
deliberately excluded and left to a later change.

## Capabilities

### New Capabilities
- `metric-aggregation`: The rollup layer — period-bucketed metric aggregates across workspace, team,
  repository, and contributor scopes; per-contributor normalization with prorated denominators;
  percentile and mean aggregation; benchmark tier assignment; and the recomputation rules that keep
  rollups consistent with the per-pull-request records beneath them.
- `work-classification`: LLM-derived classification of pull requests into work types, and the
  mix-of-work ratios derived from it — including versioning, caching, bulk re-runs, failure
  behavior, and the rule that classification never affects a deterministic metric.

### Modified Capabilities
- `pr-metrics`: Adds coding time and pickup time as explicit anchors and decomposes cycle time into
  phases; adds per-pull-request code churn classification (new / refactor / rework); adds review
  depth and PR maturity. The existing rule that uncomputable metrics are absent rather than zero now
  has to hold for churn on pull requests whose file data is unavailable.
- `github-data-sync`: Adds per-file diff statistics, review comment counts, and default-branch
  commits to what every ingestion path produces; extends the normalized record and the "identical
  across paths" guarantee to cover them; and requires that a repository's coverage record account
  for file-level data that older ingested pull requests may lack.
- `analytics-dashboard`: Adds graphical time-series, distribution, and composition surfaces as
  first-class requirements alongside the existing numeric tiles; adds benchmark banding; adds the
  work-mix surface; and extends the existing data-completeness honesty rules to cover a chart whose
  series is partially covered or whose classification is still running.

## Impact

- **Schema**: new tables for per-file diffs, default-branch commits, metric rollups, and work
  classifications; new columns on `pr_analysis` for the phase and churn metrics (the record was
  designed to be extended in place, so no second analysis row).
- **Migrations**: additive only; existing `pr_analysis` rows become stale rather than invalid and are
  refilled by a bulk recompute at the new definition revision.
- **Jobs**: new ingestion job for file diffs and default-branch commits, a rollup job, and an LLM
  classification job with its own rate and cost controls.
- **External dependency**: an LLM provider becomes a runtime dependency for classification only.
  Every deterministic metric and surface must remain fully functional when it is unavailable.
- **Backfill cost**: file-level diff ingestion materially increases GitHub API usage per pull
  request; it must obey the existing quota and priority rules, and history already ingested has to
  be filled in progressively rather than in one pass.
- **Surfaces**: `app/w/[workspaceId]` team, personal, and pull request pages gain chart surfaces; a
  charting dependency enters the frontend.
