## Why

The team view answers "how much did the team merge" but not "who merged it". Every existing
surface either aggregates people away (the team view) or narrows to exactly one (the personal
view), so a lead reading the team view cannot see that one person carried three quarters of a
release, or that a new joiner's output never started.

Design D10 forbade this deliberately. `aggregate.ts` states the absence of any per-contributor
ordering function *is* the enforcement of D10, and `analytics-dashboard` requires that no ordering
of team members by a productivity metric is available from the system.

The workspace owner has asked for per-person throughput lines with a selector. That is a direct
request to relax D10, so this change relaxes it in the open rather than working around it — the
alternative is code that contradicts a spec still claiming the opposite, which makes every later
reader of that spec wrong.

## What changes

- The team view gains a **merged pull requests by author** chart: one line per author, over the
  same buckets and granularity as the other trend charts.
- A URL-driven selector chooses which authors are drawn, capped at four.
- D10 is amended from "no per-person comparison exists" to "one per-person comparison exists, it
  counts merged pull requests only, and it is never ordered by the metric".

## What does not change

- No ranking. The series come back in name order, and no API sorts people by output.
- No per-person latency, size, churn, or review metric. A count is inspectable and disputable by
  the person it describes; a median cycle time computed over four pull requests is not.
- The personal view still presents no benchmark tier for the viewer's own metrics.
- The team view's existing aggregates are untouched.

## Why the cap is four

There are four series encodings, so a fifth line repeats a dash pattern already in use and the
chart stops satisfying "readable without relying on colour alone". The cap is what keeps that
guarantee true rather than nominally declared; it is not a UI preference.

## Capabilities

- `analytics-dashboard`
