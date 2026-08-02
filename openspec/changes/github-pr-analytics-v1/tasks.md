Stack per design.md D11: Next.js + Postgres, database-backed job queue with a worker.

Order is dependency-driven. Groups 1–5 build the pipeline with no user interface; group 6 adds
access control; groups 7–9 are the read surfaces. The team view lands before the personal view
deliberately (design.md D10).

## 1. Foundation

- [x] 1.1 Initialize the Next.js application, TypeScript config, linting, and formatting
- [x] 1.2 Set up Postgres, the migration tool, and local development database bootstrap
- [x] 1.3 Establish the workspace-scoped data access convention: every table carries
      `workspace_id`, and reads go through a helper that requires a workspace scope (D9)
- [x] 1.4 Add a test harness with database fixtures and a factory for seeding pull request data
- [x] 1.5 Add configuration and secret loading for GitHub App credentials, OAuth credentials, and
      database connection

## 2. Job queue and worker

- [x] 2.1 Migration for a `jobs` table with type, payload, workspace, state, attempts, scheduled
      time, and last error
- [x] 2.2 Enqueue API that participates in the caller's transaction (D11)
- [x] 2.3 Worker loop with claim-and-lock semantics, so concurrent workers do not double-process
- [x] 2.4 Retry with exponential backoff, attempt cap, and a terminal failed state
- [x] 2.5 Scheduled trigger that enqueues due periodic work rather than executing it
- [x] 2.6 Tests: concurrent claim safety, retry escalation, job survives worker restart

## 3. GitHub App installation

- [x] 3.1 Migrations for `installations`, `repositories`, and `workspaces`, keyed on GitHub node
      identifiers (spec: github-app-installation)
- [x] 3.2 Register the GitHub App and document the required permissions and setup steps in the repo
- [x] 3.3 Installation callback: persist the installation, its account, and its selected
      repositories; create the workspace and make the installing user an owner
- [x] 3.4 Installation token minting with automatic refresh before expiry; never persist a live
      token beyond validity
- [x] 3.5 Handle re-installation against an existing account without creating a duplicate
- [x] 3.6 Reconcile repository selection changes: add repositories and enqueue their backfill,
      deselect repositories and stop their sync while retaining data
- [x] 3.7 Handle uninstall: mark inactive, drain pending jobs, discard credentials, keep data
      readable
- [x] 3.8 Mark an installation as needing attention when GitHub rejects its credentials, and stop
      scheduling its work
- [x] 3.9 Tests: duplicate install, rename of a tracked repository, deselection, uninstall

## 4. Ingestion

- [x] 4.1 Migrations for `github_raw_events`, `pull_requests`, `pr_reviews`, `pr_commits`, and
      `contributors`, all workspace-scoped and keyed by GitHub node id (spec: github-data-sync)
- [x] 4.2 Define the internal normalized representation that both API clients map into (D2)
- [x] 4.3 Normalizer: pure function from the internal representation to upserts keyed by node id,
      idempotent on replay (D4)
- [x] 4.4 GraphQL client for backfill, fetching pull requests with reviews, commits, and diff
      statistics in one paginated query
- [x] 4.5 REST client for incremental sync, fetching pull requests changed since a cursor
- [x] 4.6 Rate limit accounting: track remaining quota, pause below a safety threshold, honor
      retry-after, resume after reset
- [x] 4.7 Backfill job: chunked per repository, records progress so interruption resumes rather
      than restarts, bounded by a configurable window defaulting to 90 days
- [x] 4.8 Incremental sync job with deliberately overlapping windows, enqueued per repository on a
      schedule
- [x] 4.9 Persist raw payloads so normalized data can be rebuilt without calling GitHub
- [x] 4.10 Reprocess command that rebuilds normalized records from retained raw payloads
- [x] 4.11 Sync run bookkeeping per repository: last success, last failure and reason, backfill
      progress
- [x] 4.12 On-demand sync endpoint with debouncing so repeated requests do not enqueue redundant
      work
- [x] 4.13 Classify contributors as human or bot at ingest, from GitHub's account type (D7)
- [x] 4.14 Tests: replay produces no duplicates or changed values; both clients produce identical
      normalized records for the same pull request; interrupted backfill resumes

## 5. Deterministic analysis

- [x] 5.1 Migration for `pr_analysis`: one row per pull request, computed columns non-null only
      where computable, generated columns nullable and unused for now, plus `computed_version` (D5)
- [x] 5.2 Implement latency metrics against the anchors fixed in design.md D6: cycle time, draft
      duration, time to first review, time to approval, time to merge after approval
- [x] 5.3 Implement volume metrics: additions, deletions, files changed, size classification
- [x] 5.4 Implement review effort metrics from review and push events, not commit identifiers, so
      force-pushes degrade gracefully
- [x] 5.5 Represent uncomputable metrics as absent, never zero, throughout the computation and its
      storage (spec: pr-metrics)
- [x] 5.6 Exclude bot-authored pull requests and bot reviews from metric inputs by default
- [x] 5.7 Analysis job enqueued transactionally when normalization commits; recompute on pull
      request update
- [x] 5.8 Bulk recompute command scoped by workspace, repository, or time range, sourcing only
      stored data
- [x] 5.9 Aggregate query layer: medians and distributions that exclude absent values and report
      their own coverage
- [x] 5.10 Tests: draft-then-merged timing, merged-without-review absence, open pull request,
      force-pushed branch, bot exclusion, recompute changes `computed_version`

## 6. Authentication and access control

- [x] 6.1 GitHub OAuth sign-in, session issue, sign-out, and inactivity expiry (spec:
      auth-and-access-control)
- [x] 6.2 Identify users by GitHub account identifier so username changes preserve history
- [x] 6.3 Link the signed-in user to their contributor record by account identifier, with no manual
      mapping step
- [x] 6.4 Migration and management for workspace membership with owner and member rights
- [x] 6.5 Repository permission check against GitHub, with a short-TTL cache invalidated on
      installation change (D8)
- [x] 6.6 Server-side enforcement on every read path: workspace scope, repository visibility, and
      owner-only configuration actions
- [x] 6.7 Reject unauthorized requests without disclosing whether the resource exists
- [x] 6.8 Tests: member without repository access sees filtered aggregates; non-owner cannot manage
      teams; direct API request bypassing the UI is rejected

## 7. Teams and roster

- [x] 7.1 Migrations for `teams` and contributor-to-team assignment, one team per contributor
      (spec: tenancy-and-teams)
- [x] 7.2 Roster derived from authorship and review activity in in-scope repositories, excluding
      bots
- [x] 7.3 Team create, rename, and delete; deleting a team unassigns its members and deletes no
      pull request data
- [x] 7.4 Assign, reassign, and unassign contributors
- [x] 7.5 Surface unassigned contributors with an assignment action, and flag when team totals
      exclude unassigned activity
- [x] 7.6 Tests: new contributor appears unassigned on ingest; reassignment moves subsequent
      aggregates; team deletion preserves data

## 8. Team view

- [x] 8.1 Application shell, navigation, and workspace switching
- [x] 8.2 Team metrics surface: merged count, median cycle time, median time to first review,
      change size distribution (spec: analytics-dashboard)
- [x] 8.3 Period selector applied across the surface, with the active period labelled
- [x] 8.4 Render absent metrics as unavailable and show aggregate coverage
- [x] 8.5 Data completeness indicators: backfill in progress with affected repositories, last
      successful sync, stale-data warning on repeated failures
- [x] 8.6 Cold start states naming the specific missing prerequisite with the action that resolves
      it: no installation, no repositories selected, no teams
- [x] 8.7 Verify no read endpoint returns members ordered by a throughput or latency metric (D10),
      and add a test asserting its absence

## 9. Pull request list and personal view

- [x] 9.1 Pull request list filterable by repository, author, team, and state, linking each entry
      to GitHub
- [x] 9.2 Drill-through from any team metric to exactly the pull requests it was computed from
- [x] 9.3 Personal view: own pull requests, own metrics, trend against own previous period
- [x] 9.4 No-activity state phrased without implying underperformance
- [x] 9.5 Restrict per-contributor detail to workspace owners and the contributor themselves
- [x] 9.6 Tests: drill-through set matches the aggregate's input set; non-owner cannot open a
      colleague's detail

## 10. Release readiness

- [x] 10.1 End-to-end test: install against a fixture organization, backfill, analyze, and render
      the team view
- [x] 10.2 Backfill load check against a repository with a large pull request history, confirming
      rate limit handling and resumability
- [x] 10.3 Operational runbook: rerun a sync, recompute analysis, reconnect a failed installation
- [x] 10.4 Deployment: environment configuration, migrations on deploy, worker process, scheduled
      trigger
- [x] 10.5 Review every surface against the dignity constraints in design.md D10 and the `zest/`
      reference map before release
