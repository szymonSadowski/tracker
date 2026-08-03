## Context

See proposal.md — Why. The defects live in three layers that were built in one pass and never
cross-checked against each other:

```
  series.ts:234        share() rounds each of three components independently
        │                            ↓ sum may be 1.001
  charts.tsx:324       max = niceMax(totals)  → ceil(1.001) = 2  → axis 200%, bars at half height
  charts.tsx:364-382   segments encoded by fill opacity
  charts.tsx:103-114   legend encoded by border-style   ← never reconciled with the line above
  charts.tsx:230-256   line runs stroked as <path>, no markers → a run of 1 renders nothing
```

Constraints that shape every decision below:

- **No client bundle.** `charts.tsx`'s header states the reason the primitives are hand-rolled:
  server-rendered SVG, values as text, no hydration. Nothing here changes that.
- **`docs/dignity-review.md`** — the personal view compares a person only to their own previous
  period. This is why the fix for the personal view is *not* "make it look like the team view".
- **`benchmark_thresholds` is seeded configuration, not code.** `refactor_rate` is already there
  (`0014_benchmarks.sql`); surfacing it is a read, not a migration.

## Goals / Non-Goals

**Goals:**

- Every non-null value in every chart is visible, whatever its neighbours are.
- Legend and mark carry one encoding, derived from one place.
- A share-valued chart is scaled to 1, not to whatever the data rounded to.
- The rework threshold is on the chart, as `analytics-dashboard` already requires.
- The personal view gains the neutral affordances it lost and is *prevented*, by test, from gaining
  the judgmental ones.

**Non-Goals:**

- No charting library. The requirements that motivated hand-rolling are unchanged.
- No change to what churn measures, no new metric, no ingestion change, no `COMPUTED_VERSION` bump.
- No tooltip or hover layer. Drill-through stays a link; `<title>` stays the hover affordance.
- Not redesigning the chart suite's visual language beyond what these defects force.

## Decisions

### D1 — Line charts draw markers, and the run/path structure stays

**Decision.** Keep the run-splitting logic exactly as it is — it is what makes a gap a gap by
construction — and additionally emit a `<circle>` at every non-null point.

**Why not "join across gaps".** That is the obvious alternative and it is wrong: it would draw a
segment through a bucket that has no value, which is the precise misreading `analytics-dashboard`'s
"a gap at that bucket rather than a zero point" scenario exists to prevent. The bug is not that runs
are split; it is that a run of one has no visual form. A marker gives every run a form independent
of its length.

**Why not "special-case length-1 runs".** A marker at every point also fixes the general case: a
6-bucket series with values in buckets 1, 3, and 5 currently draws three invisible runs. Marking
only isolated points would leave the marks inconsistent between adjacent and isolated values.

Markers cost one element per point at the granularities in use (≤90 buckets), which is within the
budget `docs/metrics.md` records for these pages.

### D2 — One encoding table, consumed by both legend and mark

**Decision.** Replace the current split — `SERIES_PATTERNS` + `DASH_ARRAYS` for marks,
`.chart-key-*` CSS for the legend — with a single per-series descriptor that both consume, and give
it a `kind` so a chart declares whether its marks are strokes or fills:

```
  SERIES_ENCODINGS[i] = { dash, fillPatternId, opacity, className }

  LineChart        ──▶ stroke + dash          ──▶ Legend kind="line"  (line swatch, dashed)
  StackedBarChart  ──▶ fill pattern + opacity ──▶ Legend kind="fill"  (filled swatch, hatched)
```

**Why fill patterns rather than more opacity steps.** Opacity alone already failed: 1.0 / 0.75 /
0.5 of one accent is not a non-color distinction, it is a *lightness* distinction, which is exactly
what the "readable without relying on color alone" requirement excludes. SVG `<pattern>` fills
(the file already defines one for the coverage hatch) give a genuine texture difference that
survives greyscale and low-vision viewing, and the existing `Hatch` component is the template.

**Why not drop the legend and label segments in place.** At 6+ buckets there is no room, and the
segments this chart most needs to identify are the small ones.

**Alternative rejected:** distinct hues per series. It would work for most viewers and is what a
library would do, but the spec requires the non-color distinction regardless, so hue would be
additive work on top of this, not instead of it. Hue can be layered later.

### D3 — Share-valued charts declare their ceiling

**Decision.** `StackedBarChart` takes an optional explicit `max`. `ChurnChart` passes `1` in shares
mode and omits it in lines mode. `niceMax` remains for count- and duration-valued charts.

**Why the presentation layer and not only the data fix.** D4 makes the shares sum exactly, which
removes today's trigger — but `niceMax` would still be the wrong function for a share chart. If a
future bucket's data is malformed, a chart that knows its ceiling clamps; a chart that infers it
silently rescales every other bucket. Both fixes land; neither is sufficient alone.

### D4 — Largest-remainder rounding for the three shares

**Decision.** Round the three shares together rather than independently: compute at full precision,
round each down to the reported precision, then distribute the remaining units to the components
with the largest truncated remainders. The reported triple sums to exactly 1.

**Why not "derive the third as 1 − a − b".** It makes one component a residual that silently
absorbs all error, and which component that is would be arbitrary — rework, the benchmarked one,
must not be the dumping ground for rounding drift.

**Why not "stop rounding".** The rounding is what keeps the value stable and printable; the bug is
that three independent roundings do not preserve a sum.

This changes a presentation value in the third decimal only. It is not a metric definition change:
`COMPUTED_VERSION` stays, no recompute is needed, and `pr_analysis` is untouched — the shares are
derived on read in `series.ts`.

### D5 — The rework threshold is a rule on the plot, plus a marked bucket

**Decision.** Draw the needs-focus lower bound as a horizontal reference line across the plot, and
mark the bucket itself (a marker on the bar, not a colour change) when its rework share is at or
above it. Keep the prose note as the text equivalent rather than replacing it.

**Why both.** The rule answers "how far above is it"; the bucket marker answers "which one". The
note answers both for a viewer who cannot read either mark, which is what keeps the
"readable without relying on color alone" requirement satisfied — the note is not redundancy, it is
the accessible channel.

**Applies in shares mode only.** The threshold is a share; in lines mode there is nothing to
compare it to. The chart states that the threshold is not shown rather than silently omitting it.

### D6 — "Churn" is renamed where it means the composition

**Decision.** Title the chart for what it draws — the composition of changed lines — and reserve
"code churn" for the rework band, which is what the published benchmark scores and what the term
means outside this codebase (recently-written code rewritten inside a ~2–3 week window; our
`reworkRecencyDays` default is 21).

```
  before                        after
  ──────                        ─────
  "Code churn (share)"          "Change composition (share)"
     ├── New code                  ├── New code
     ├── Refactor                  ├── Refactor      · benchmarked, lower is better
     └── Rework                    └── Rework (code churn) · benchmarked, lower is better
```

**Why this matters beyond wording.** A viewer who knows the industry term reads "Code churn 95%"
off the current chart as a catastrophe, when 95% is the *new code* band and the churn figure is the
2% sliver. The title is actively misinforming, and no amount of legend work fixes that.

**Why not rename the code.** `churn` is the name throughout `pr-metrics`, the analysis columns, the
`--family churn` recompute flag, and the settings. Renaming the domain is a much larger change with
no benefit; this is a presentation-label decision, scoped to the chart's title, description, and
legend entries.

### D7 — The personal view's exclusion is enforced, not just documented

**Decision.** `me/page.tsx` gains `drillThrough`, `coveredFrom`, and the shares/lines toggle, and
does not gain `benchmark` or `reworkThreshold`. `tests/surfaces/dignity.test.ts` — which already
scans for leaderboard shapes — gains an assertion that no personal-scoped surface passes a benchmark
assignment or a threshold into a chart.

**Why a test rather than a comment.** The two views now differ in a way that looks like an
oversight, and the natural instinct of the next person to read them side by side is to "fix" the
inconsistency. The existing dignity test is the established mechanism in this codebase for making a
constraint fail loudly instead of eroding.

## Risks / Trade-offs

- **Fill patterns can moiré or muddy at small segment heights** → the pattern is applied over the
  opacity step rather than instead of it, so a sliver too small to show texture still differs in
  lightness; the minimum-height rule (spec: "A segment is too small to draw") keeps it above the
  moiré threshold.
- **Minimum segment height makes a stack sum to slightly more than its bucket's true total** →
  applies to shares mode only, is bounded at a few pixels, and the value table carries exact
  figures. Preferred over a 0px band that is indistinguishable from an absent one — the distinction
  between "absent" and "zero" is a stated requirement; the distinction between "0.4%" and "0.6%" is
  not.
- **D6 makes tests, docs, and screenshots that quote "Code churn" stale** → the label lives in one
  component; `docs/metrics.md` and `docs/dignity-review.md` get the same vocabulary in the same
  commit.
- **Markers on a 90-bucket daily series add ~90 elements per chart** → within the page budget
  `docs/metrics.md` records; the rollup query, not the SVG, is the measured cost on these pages.
- **D4 changes displayed share values in the third decimal** → visible only where the old values
  were internally inconsistent. Worth stating in the change's release note.

## Migration Plan

No migration and no recompute. Every change is in the read and render path:

1. Ship `series.ts` (D4), `charts.tsx` (D1, D2, D3), `metric-charts.tsx` (D5, D6), the two page
   files, and the CSS together — D2 splits an encoding across component and stylesheet, so a
   partial deploy would leave legend and mark disagreeing differently rather than not at all.
2. `npm run db:migrate` is not required. `benchmark_thresholds` already carries `refactor_rate`.
3. **Rollback** is a code revert. No stored value changes, so nothing needs undoing behind it.

## Resolved during implementation

- **Should the refactor threshold also draw a rule on the plot, or only carry a tier?**
  **Resolved: tier and stated threshold, no second rule.** Against the rendered chart the reason is
  not clutter, it is arithmetic. A rule is measured from the axis, so only the band sitting *on*
  the axis can be read against one. Rework earns the rule and is stacked at the base for exactly
  that reason (below); refactor is the second band, and a rule at 23% would cross the middle of
  every stack while measuring nothing — it would invite reading refactor's *cumulative top edge*
  against the refactor threshold, which is a different and wrong number. Refactor carries its
  `BenchmarkTier` and its needs-focus boundary in the note instead.

- **The churn stack is ordered rework, refactor, new code — benchmarked bands against the axis.**
  Discovered while rendering D5: with the original order the rework band began around 70% and the
  threshold rule at 9% sat under every bucket, comparable to nothing. The rule exists so a bucket's
  height can be read against it, so the band it judges has to start at zero. New code, which
  carries no benchmark and is usually the largest share, moves to the top of the stack.

- **Both chart kinds carry gridlines and thinned bucket labels.** A plot labelled only with its
  maximum and zero gives a point nothing to be read against — the isolated-value fix made a lone
  marker visible but left it floating in an empty frame. Four gridlines with their values in the
  gutter, and up to six bucket labels along the axis, are what make the marker locatable. Bounded
  by the same element budget as the markers.

## Open Questions

None outstanding.
