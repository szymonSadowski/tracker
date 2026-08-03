# Dignity review of every surface

Reviewed against design.md D10 and the reference map's §7 policy (`zest/architecture.md`), which
this change adopts as a product constraint rather than a prompt convention: every metric available
in this release is per-person throughput, which is exactly the class of number that turns a
team-productivity tool into a surveillance tool by default.

The reference product enforces this **in prompt text**, because its analysis is generated. This
release has no LLM layer, so the same policy is enforced in code and in the shape of the data —
the harder version to bypass.

## The rules, and where each is enforced

| Reference rule | How this release honours it |
| --- | --- |
| Individual cycle time is never ranked | No read path orders contributors by a metric. `tests/surfaces/dignity.test.ts` scans `src/` and `app/` for `ORDER BY` over metric columns and for exported names suggesting a leaderboard, and fails if either appears. The roster is alphabetical by login. |
| Quiet members are never presented as failing | The personal view's empty state reads "You have no merged pull requests in this period. Work happens in different shapes at different times; this is a record, not a target." No target, streak, or comparison to others appears anywhere. |
| Struggles are described as friction, not attributed to a person | Team metrics are aggregates over a team's pull requests. Review effort is named "review rounds" and "post-review pushes" — iteration on a change, not blame — and the metric module says so at the definition site. |
| Gaps are framed as practices, not deficits | The only comparison offered is a person against **their own** previous period (`trend()` in `src/ui/format.ts`), phrased as "higher/lower than last period", never against a colleague or a team norm. |
| Bots separated before any ranking | Bots are classified at ingest from GitHub's account type, marked on `pr_analysis.author_is_bot`, excluded from every aggregate by default, and kept out of the roster and team assignment. A bot's review does not count as review, so it cannot make an unreviewed pull request look reviewed. |
| Pull requests credited to authors only | `pr_analysis` carries `author_contributor_id` and nothing else attributive; reviewers and mergers are never credited with a pull request. |

## Surface-by-surface

- **Team view** (`/w/[id]`) — aggregates for one team and period: merged count, median cycle time,
  median time to first review, median time to approval, median review rounds, size distribution.
  No per-member table. States plainly when unassigned contributors have activity that the totals
  exclude, and closes with a line explaining that individuals are not ranked.
- **Pull request list** (`/w/[id]/pulls`) — filterable by repository, author, team, and state. It
  is ordered by merge/open time, never by cycle time, so scanning it cannot produce an implicit
  ranking. Absent metrics render as "Not available" in a muted style, never as `0`.
- **Personal view** (`/w/[id]/me`) — one's own work only, with a trend against one's own previous
  period. Reachable only for oneself. Its charts **withhold benchmark tiers, benchmark bands, and
  the needs-focus thresholds by rule**: a published tier is an industry norm, and the only
  comparison offered to an individual is against their own previous period. The same metrics carry
  their tiers on the team view, where the subject is a team rather than a person. The withholding
  is not an omission to be tidied up later — `tests/surfaces/dignity.test.ts` fails if a personal
  surface passes a `benchmark`, `reworkThreshold`, or `refactorThreshold` into a chart, or renders
  a `BenchmarkTier`. Everything neutral the team view shows, the personal view does show:
  drill-through to one's own pull requests, the churn coverage statement, and the shares/lines
  toggle.
- **Contributor detail** (`/w/[id]/people/[contributorId]`) — restricted to workspace owners and
  the contributor themselves; a member requesting a colleague's page gets the same 404 as for a
  contributor that does not exist.
- **Teams** (`/w/[id]/teams`) — owner-only management. The contributor table shows authored and
  reviewed counts as context for assignment, alphabetically ordered, with no metric columns and no
  sorting control.
- **Settings** (`/w/[id]/settings`) — installation and sync health. Contains no person-level data
  beyond workspace membership and its rights.

## Honesty about the data

- Uncomputable metrics are `NULL` in storage, excluded from aggregates, and rendered as
  "Not available" — never zero (design.md D6).
- Every aggregate states its own coverage ("covers 12 of 30 pull requests"), so a median over a
  handful of pull requests cannot be read as a median over all of them.
- Incompleteness is visible: backfill in progress names the repositories affected, repeated sync
  failures say the data may be stale and when it last succeeded.

## What would break this

The most likely regression is a well-meant "top contributors" widget or a sortable metric column
in the pull request list. The automated check catches the query-level version; the review at the
top of this document is the reason it exists. Anyone adding a per-person surface should read
design.md D10 first.
