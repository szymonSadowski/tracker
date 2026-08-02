## Context

Greenfield. The repo contains only the `zest/` reference map and OpenSpec scaffolding — no
application code, no chosen stack. See `proposal.md` for motivation and scope.

Three constraints shape everything below:

1. **The distinctive metrics are not buildable yet.** Everything interesting in the reference map
   (AI Tasks, Agents Ran, Plan-vs-Impl, AI Stack) comes from editor sessions, which this change
   does not collect. What GitHub can supply is throughput and latency. The design's job is to make
   that useful *and* to leave a clean seam for the session and LLM layers.
2. **Rate limits are the binding resource.** Rework and churn require per-PR commits and file
   diffs. A 90-day backfill of an active org is the single most expensive thing this system does.
3. **Every metric here is per-person throughput.** That is precisely the class of number the
   reference map's dignity rules say must not be ranked across individuals. The design has to make
   the safe presentation the easy one.

## Goals / Non-Goals

**Goals:**

- One ingestion code path shared by backfill, incremental sync, and (later) webhooks.
- A derived layer that is recomputable from raw data without re-hitting the GitHub API.
- Forward compatibility: the LLM layer and the session layer add to `pr_analysis` rather than
  replacing it.
- Multi-tenant isolation enforced structurally, not by convention.
- No second permission model alongside GitHub's.

**Non-Goals (design level, beyond the proposal's scope cuts):**

- Real-time freshness. Minutes of lag is acceptable; this is a reflective tool, not a monitor.
- Storing file contents or full diffs. Diff *statistics* only.
- Cross-installation aggregation or benchmarking between workspaces.

## Decisions

### D1. Storage is three layers: raw → normalized → derived

```
github_raw_events        pull_requests / reviews / commits      pr_analysis
verbatim payload         normalized entities                    computed metrics
keyed by node id     ──▶ keyed by node id                   ──▶ one row per PR
append-only              current state                          recomputable
```

**Why:** the derived layer can be recomputed from normalized data, and normalized data rebuilt
from raw, without touching the GitHub API. When a metric definition changes — and it will, cycle
time especially — that is a batch job, not a re-backfill. The reference map calls this out as the
move that keeps read surfaces cheap and raw data deletable; it holds even without an LLM.

**Alternative rejected:** computing metrics on read from normalized tables. Simpler at first, but
every dashboard query becomes a multi-table aggregate over commit history, and metric definitions
end up duplicated across queries.

### D2. Backfill uses GraphQL, incremental sync uses REST, both write through one normalizer

**Why:** GraphQL fetches a PR with its reviews, commits, and file stats in one paginated query.
The REST equivalent is 3–4 requests per PR, which does not survive a backfill. Conversely the
incremental path fetches few PRs and benefits from REST's simpler conditional-request and
pagination semantics.

The normalizer is a pure function from provider payload to normalized rows, upserting by GitHub
node id. Both paths call it. Webhooks later become a third caller with no new write logic.

**Trade-off accepted:** two API clients to maintain, and two payload shapes to map. Contained by
mapping each into a shared internal representation immediately at the boundary.

### D3. Incremental freshness comes from a cron poll, not webhooks

**Why:** polling reuses the backfill query with a narrower window, so the code already exists.
Webhooks add an endpoint, a signature secret, delivery replay handling, and an at-least-once
ordering problem — for a product whose surfaces are 7-to-30-day windows. Poll cadence on the order
of 15 minutes is well within acceptable lag.

**Revisit when:** a surface needs sub-minute freshness, or poll volume approaches the rate limit.
Because of D2 that is an additive change, not a rewrite.

### D4. Idempotency by GitHub node id, everywhere

Every ingest write is an upsert keyed by the entity's GitHub node id (plus workspace). Backfill
and poll windows deliberately overlap; replaying a window must be a no-op. This is what makes
"just re-run the sync" a safe operator response to almost any ingestion bug.

### D5. `pr_analysis` is one row per PR with a reserved generated half

```
pr_analysis
  workspace_id, pull_request_id
  ── computed (this change, NOT NULL where the PR is complete) ──
     time_to_first_review, time_to_approval, time_to_merge,
     cycle_time, draft_duration, review_cycles, rework_commits,
     additions, deletions, files_changed, size_bucket
  ── generated (later, all NULLABLE) ──
     summary, pr_type, risk_flags, analysis_skill_version
  computed_at, computed_version
```

`computed_version` records which revision of the metric definitions produced the row, so a
definition change can recompute selectively and so historical numbers remain explainable — the
same reason the reference map versions its skills.

**Why one table rather than two:** the future LLM layer annotates the same unit of work. Splitting
now means every read surface joins two tables forever to answer one question.

### D6. Metrics are defined against explicit event anchors, and incompleteness is representable

Cycle time has at least three defensible definitions (first commit → merge, opened → merge, ready
-for-review → merge). This design fixes **ready-for-review → merged** as `cycle_time`, and stores
`draft_duration` separately so the other reading is derivable. Rationale: time in draft is the
author's own working time, and including it makes "cycle time" measure two different things at
once.

Metrics that cannot be computed are **NULL, never zero**. A PR with no review has a NULL
`time_to_first_review`; rendering that as `0` would make an unreviewed PR look maximally fast.
Aggregates exclude NULLs and report their own coverage.

### D7. Contributors are discovered from PR activity; teams are product-owned

The roster is the set of GitHub accounts that authored or reviewed a PR in a selected repo, not
org membership. Org membership over selected repos produces a long tail of zero-activity rows,
which is what makes a dashboard read as a scoreboard.

Teams are created in the product and members assigned to them. Chosen over mirroring GitHub teams
for flexibility; the cost is drift, mitigated by surfacing unassigned contributors prominently
rather than hiding them.

Bot accounts are classified at ingest (GitHub types them) and excluded from all aggregates by
default, with an explicit toggle. The reference map's rule is *separate bots before ranking*; doing
it at ingest means no downstream surface can forget.

### D8. GitHub OAuth is the only identity, and authorization mirrors GitHub repo permissions

`github_id` is the join between the person logging in and the person appearing in PR data, so the
author-mapping problem does not exist. Access checks ask GitHub whether this user can see this
repo, cached with a short TTL.

**Trade-offs accepted:**
- Nobody without a GitHub account can ever log in — including non-coding managers. Acceptable for
  v1; revisit alongside any org-scope tier.
- A permission cache means revoked access can persist for the cache TTL. TTL is therefore short,
  and the cache is invalidated on installation change.

### D9. Multi-tenancy is a column on every table, from the first migration

`workspace_id` on every row, including raw events. Enforced at the query layer (or by row-level
security if the datastore supports it) rather than trusted to application code. Retrofitting
tenancy onto a live schema is among the more painful migrations available; the cost of carrying it
from migration one is close to zero.

Workspace ↔ installation is 1:1 in this change. The column, not the constraint, is what matters —
the 1:1 can relax later without a schema rewrite.

### D10. Team scope ships before personal scope; no cross-person ranking

Team aggregates (medians, distributions, throughput) are honest with these metrics. A per-person
ranking of cycle time is exactly what the reference map's §7 forbids. Personal scope exists as a
*self* view — your own PRs, your own trend — not as your position in a list.

This is a product decision expressed in the read API: there is no endpoint that returns members
sorted by a throughput metric. Absence of the endpoint is the enforcement.

### D11. Next.js + Postgres, with a database-backed job queue

The dashboard, the read API, the OAuth callback, and the GitHub App callbacks live in one Next.js
application over Postgres. Sync and analysis run as a worker against a `jobs` table in the same
database; a scheduled trigger enqueues rather than executes.

**Why a database-backed queue rather than a managed service:** the specs already require resumable
backfill progress, retry counts, and per-repository sync outcome to be *queryable* — that is a
table either way. Putting the queue in the same transaction as the data being written also makes
"enqueue analysis when normalization commits" atomic, which removes an entire class of lost-job
bug. The cost is that throughput ceilings arrive earlier than with a managed queue; at the volume
of one poll per repository per 15 minutes, that ceiling is far away.

**Alternative rejected:** running sync inline in a scheduled function with no queue. Chunked
resumable backfill and retry bookkeeping become awkward to express, and both are spec requirements
rather than nice-to-haves.

## Risks / Trade-offs

- **Backfill exhausts the installation rate limit on a large org** → window is configurable and
  defaults to 90 days; backfill is chunked, resumable, and records progress per repo; the
  dashboard shows backfill state rather than pretending the data is complete.
- **Polling lag makes the dashboard look stale after a merge** → show last-sync time on every
  surface, and offer a manual "sync now" that respects rate limits.
- **Force-pushes and rebases rewrite commit history, corrupting rework counts** → rework is
  computed from *review events and pushes after first review*, not from commit SHAs surviving,
  which degrades gracefully under history rewriting.
- **Repos are renamed, transferred, or removed from the selection** → entities key on node id, not
  name; deselected repos retain their data but are excluded from aggregates.
- **Product-owned teams drift from reality** → unassigned contributors are surfaced on the team
  view rather than silently omitted.
- **The product becomes a surveillance tool** → no cross-person ranking endpoint (D10), NULLs not
  zeros (D6), bots excluded at ingest (D7). This is the risk most likely to be realized by
  accident, because every metric available in v1 invites it.
- **Metric definitions turn out wrong** → `computed_version` plus full recomputability from raw
  (D1) makes redefinition a batch job rather than a data loss.

## Migration Plan

Greenfield; no data migration. Rollout is per-workspace and gated on install:

1. Install App → repo selection persisted → workspace created.
2. Backfill enqueued; dashboard renders an explicit in-progress state with per-repo coverage.
3. Analysis worker runs as normalized data lands; surfaces populate progressively.
4. Cron sync begins once backfill for a repo completes.

Rollback is per-workspace uninstall: revoke tokens, stop sync, retain or purge data per the
uninstall requirement in `github-app-installation`.

## Open Questions

- Retention policy for raw events — the reference map defaults to 90 days per data class. Deferred
  because D1 makes raw data purgeable without emptying the product.
- Whether the backfill window should be user-configurable at install time or fixed at 90 days.
