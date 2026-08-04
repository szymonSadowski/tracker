## D10, amended

The original: *no function orders contributors by a throughput or latency metric; that absence is
the enforcement.* An absence is a strong guarantee — there is nothing to misuse — but it is only
available while nobody needs the capability. The workspace owner does.

The amendment keeps the part that was load-bearing and drops the part that was incidental.

**Load-bearing, kept:** the system does not rank people. `contributorThroughputSeries` returns
series in `lower(COALESCE(name, login))` order, and that `ORDER BY` is the guarantee. A caller who
wants people sorted by output has to sort them, in its own code, where a reader can see it happen.

**Load-bearing, kept:** only a count is exposed per person. Latency, size, churn, and review
metrics stay aggregate-only on team-scoped surfaces. A count is a fact the person it describes can
check and argue with. A median cycle time over their four pull requests is an inference presented
with the authority of a number, and the smaller the sample the more confidently wrong it reads.

**Incidental, dropped:** that no per-person series exists at all. Nothing about D10's purpose
required the aggregate layer to be incapable of grouping by author; it required the product not to
rank. Those were conflated because conflating them was free until now.

## Why the selector is server-rendered

Charts here are server-rendered SVG with no hydration and no client bundle (D7). A client-side
legend toggle would be the first exception, and it would put chart state somewhere a link cannot
reach. The selection lives in `?authors=` instead: same mechanism as the period, team, granularity,
and churn-unit controls, and a configured chart stays shareable.

## Why four

`SERIES_ENCODINGS` has four entries and `seriesEncoding` wraps. A fifth line silently reuses the
first dash pattern, at which point the legend no longer identifies a mark and the chart violates
"readable without relying on colour alone" while appearing to satisfy it — the same class of bug
`fix-chart-rendering-and-churn-judgment` fixed in the stacked bar legend.

The cap is enforced where the selection is built, and a chip that would exceed it renders as
disabled text rather than a link, so the limit is visible before it is reached rather than as a
click that does nothing.

## Zero versus gap

The two are different measurements and the chart draws them differently.

- **Zero**: the author was a member of the workspace during the bucket and merged nothing. Real,
  and drawn.
- **Gap**: the bucket ended before the author's earliest `workspace_memberships.started_at`. Not a
  measurement of them at all.

A contributor with no membership row yields a null join date and is masked nowhere. The failure
mode worth avoiding is the other one: treating "unknown tenure" as "never a member" would blank a
person's entire line and read as though they had done nothing.

## What this does not open the door to

Per-person latency on the team view. If that is ever wanted it needs its own change and its own
argument, because the sample-size objection above is not addressed by anything here.
