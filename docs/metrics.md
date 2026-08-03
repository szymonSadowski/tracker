# Delivery metrics

How the metrics are defined, where a definition is an approximation, and what we measured.

## Release notes — what changes for a viewer

**Cycle time is redefined.** It now runs from the first commit to the merge, and historical values
shift **upward** because they now include the time spent writing the change. If you screenshotted a
dashboard before this release and compare it after, the numbers will differ; that is the
redefinition, not a data problem. Every analysis row records the definition that produced it.

**Churn's rework figure is partly an approximation.** The post-review component is exact; the
recency component is file-level, and where it contributed the surface says so.

**The churn chart is titled "Change composition", not "Code churn".** It draws three bands, and
only one of them — rework — is what the industry calls code churn. The old title invited reading
the new-code band's 95% as a churn figure. The metric family, the columns, and the
`--family churn` recompute flag keep the name `churn`; the change is to what the chart says.

**Churn share values can differ in the third decimal from before this release.** The three shares
are now rounded together so that they sum to exactly 1 at the precision they are reported in
(largest remainder). Previously each was rounded on its own and the three could sum to 1.001,
which also rescaled the chart's axis to 200%. No stored value changed and no recompute is needed —
the shares are derived on read.

**Churn coverage lags pull request coverage.** File-level data is filled in for existing history by
a background pass that runs below incremental sync. Until it catches up, churn charts mark their
earlier buckets as uncovered rather than drawing them as zero.

**Work classification is off by default.** Where it is off, work types and the defect and
innovation ratios are unavailable and every other metric is unaffected.

### Rollout order

1. `npm run db:migrate` — additive migrations `0008`–`0017`, including the membership backfill and
   the benchmark seed.
2. `npx tsx scripts/rollout-check.ts` against a copy of production — rehearses the whole sequence
   and asserts the guarantees below.
3. Deploy ingestion. New pull requests carry file, comment, and commit data immediately.
4. `npm run recompute -- --workspace <id>` at `COMPUTED_VERSION` 2. Latency and size metrics are
   correct at the new definitions immediately; churn stays absent where file data has not arrived.
   Narrow a later definition change with `--family churn|latency|review`.
5. The file fill-in pass starts on the existing sync schedule at low priority. Churn coverage
   extends backwards as it runs, and it resumes rather than restarting after an interruption.
6. Enable classification per workspace, last.

**Rollback.** The migrations are additive, so reverting code leaves unread tables and null columns
behind. Reverting `COMPUTED_VERSION` to 1 and re-running the recompute restores the previous cycle
time definition; `scripts/rollout-check.ts` exercises that path.

## Rollup query timings

Aggregation is computed on read (design.md D3): there is no cached rollup that can disagree with
the analysis row beneath it. D3 names the point at which that stops being the right trade — when a
90-bucket daily series exceeds **~200ms at p95** — and `scripts/series-timings.ts` is how we know
whether we have reached it.

```
npx tsx scripts/series-timings.ts --rows 1000,10000,50000 --samples 15
```

Measured 2 August 2026, embedded Postgres (PGlite, WASM) on a development machine, one repository,
20 contributors, pull requests spread evenly over 90 days:

| `pr_analysis` rows | p50 | p95 | max |
| --- | --- | --- | --- |
| 1,000 | 12.9 ms | 27.8 ms | 27.8 ms |
| 10,000 | 31.7 ms | 58.2 ms | 58.2 ms |
| 50,000 | 126.3 ms | 144.1 ms | 144.1 ms |

Read these as a **floor**, not a forecast: the embedded engine is the same Postgres but not
production hardware, and a real workspace spans several repositories and a broader contributor set.
The shape is what matters — roughly linear in row count, with 50,000 rows landing inside the same
order of magnitude as the threshold. Re-run against a production-shaped server before deciding to
add the `metric_rollups` cache table D3 describes; the on-read query stays as its correctness
reference either way.

## Cycle time was redefined

Cycle time now runs from the **first commit** to the merge, and decomposes into coding, pickup, and
review time. It previously ran from ready-for-review to merge.

- Historical values shift **upward** — they now include the time spent writing the change.
- Every analysis row carries `computed_version` and `definition_revision`, so which definition
  produced a number is always answerable.
- A pull request with no known first commit falls back to the ready-for-review anchor, and its
  coding time is absent rather than zero.
- The phases sum to the whole whenever all three are computable.

The reconciliation is a bulk recompute at `COMPUTED_VERSION` 2 (`npm run recompute`), run as part of
the release rather than left to drift.

## Churn's recency component is an approximation

Churn splits a merged pull request's changed lines into new code, refactor, and rework. The
three-way split is the **change composition**, which is what the chart draws and what the shares
sum to; **code churn**, as the published studies use the term, is the rework band alone. Two of the
three components are exact:

- **New code** — additions in an added file, and additions beyond the deletion count in a modified
  one. Exact.
- **Rework, post-review** — lines touched by commits that landed after the first human review.
  Exact, and the component that actually drives a conversation about review churn.

The third is not:

- **Rework, recency** — deletions in a file whose most recent prior change **in our own ingested
  history** falls inside the rework window (21 days by default, a workspace setting).

That component is **file-level, not line-level**, and it can only see as far back as the
repository's file coverage extends. It stands in for `git blame`, which would need one query per
file per pull request. Where it contributed, the analysis row records
`churn_used_recency_estimate` and the surfaces say so — the number is not presented as more precise
than its inputs support.

Churn is **absent, never zero**, for a pull request that has not merged, one whose file data was
never collected, and one whose file list GitHub truncated.

The three shares are reported to three decimals and **sum to exactly 1** at that precision. They
are rounded together by largest remainder rather than independently, so no consumer has to
re-derive the sum from the line counts, and no one component is the residual that absorbs the
rounding drift.

Two of the three bands carry a published benchmark, and **for both of them the study treats a lower
share as better**: `rework_rate` and `refactor_rate` in `benchmark_thresholds`, from the LinearB
community benchmarks. New code carries no benchmark, and none is implied from the other two. Both
directions are stated on the chart itself and attributed to the study rather than presented as a
target this workspace set. The needs-focus rework threshold is drawn as a rule on the shares view
and the buckets at or above it are marked; the refactor threshold is stated in the chart's note and
its tier is shown, without a second rule on the same plot.

## Coverage is recorded per class of data

Pull request coverage and file-level coverage move at different speeds: the file fill-in pass runs
below incremental sync and extends backwards over time. `repository_coverage` records a start per
data class (`pull_requests`, `file_diffs`, `default_branch_commits`), so a churn surface can say
"covered from" separately from the pull request coverage the latency surfaces show.
