## Context

See proposal.md — Why.

The constraints that shape the approach, all verified against the current code:

- `Worker.start()` (`src/jobs/worker.ts`) is a loop that reclaims stale jobs every ~30 passes, then
  claims and runs one job at a time. `Worker.drain()` exists beside it and runs jobs until the queue
  is empty — but **does not reclaim**. It was written for tests and one-shot invocations, and it is
  the obvious thing an implementer would reach for.
- `src/jobs/scheduler.ts` holds the only code that enqueues `workspace.schedule_syncs`, and
  `scheduler-main.ts` is the only caller. `runDueScheduledTasks` already claims a due task with a
  row lock inside the transaction that advances `next_run_at`, so it is concurrency-safe as-is.
- `enqueue` dedupes on `(workspace_id, dedupe_key)` while a job is `pending` **or** `running`
  (`src/jobs/queue.ts`), which is what turns a stuck running job into silent suppression of that
  subject's future work.
- `db()` (`src/db/client.ts`) is a process-wide singleton reading `process.env.DATABASE_URL`, with
  `setDatabase()` as a test seam. A serverless deployment wants two connection strings for two
  access patterns in one process.
- Vercel's platform constraints that rule out hosting the resident worker, and the Active CPU
  pricing that makes a drain attractive, are recorded in `docs/deploy.md` Path C rather than here.

## Goals / Non-Goals

**Goals:**

- One code path executes jobs. The endpoint and the resident worker must not be able to drift.
- The three correctness rules from the proposal (reclaim, tick, atomic enqueue) are enforced by
  structure, not by remembering to call them.
- Existing deployments are unaffected by default: no new required environment variable, no
  behaviour change to `npm run worker` or `npm run scheduler`.

**Non-Goals:**

- Concurrency inside a pass. Jobs run sequentially, as they do now. Parallelism comes from more
  passes, exactly as it comes from more workers today.
- Adaptive budgeting or queue-depth-driven scheduling. A fixed cron interval and a fixed budget are
  enough until measurement says otherwise.
- A UI for queue state.

## Decisions

### D1 — One shared operation, three callers

Extract `runDrain(db, options)` into `src/jobs/drain.ts`. It performs, in order: reclaim stale jobs,
run due scheduled tasks, then claim-and-execute until the budget is spent or the queue is empty.
Returns counts.

`worker-main.ts`, `scheduler-main.ts`, and the route all call it. The resident worker becomes
`runDrain` in a loop with no budget; the scheduler keeps its own entrypoint for Paths A and B but is
no longer the only thing that can tick tasks.

*Why*: the spec requires the two mechanisms to be equivalent. The cheapest way to guarantee
equivalence is for there to be nothing to compare — one implementation, called differently. The
alternative, letting the route assemble `reclaimStaleJobs` + `runDueScheduledTasks` + `drain`
itself, is precisely how the reclaim call goes missing.

*Consequence*: the ordering is fixed inside `runDrain` and cannot be omitted by a caller. Reclaim
runs before claiming so a pass picks up work its predecessor was holding — the same ordering
`Worker.start()` already uses and for the same reason.

### D2 — `Worker.drain()` is not the entrypoint

`runDrain` does not delegate to `Worker.drain()`. Either `Worker.drain()` gains the reclaim and tick
responsibilities, or it stops being reachable as a way to run production work.

*Why*: leaving a public method that looks like the right entrypoint but silently omits recovery is a
trap for the next implementer, not just this one. The bug is invisible in testing — a queue that is
never interrupted never produces a stuck job.

*Alternative considered*: document the caveat and leave the method alone. Rejected: the failure mode
is silent suppression of a repository's syncs with no error anywhere, which is too quiet to protect
with a comment.

### D3 — Budget is wall-clock, checked between jobs, with a reserve

The pass stops claiming when elapsed time exceeds `budget − reserve`, where the reserve is a
conservative estimate of the longest single job. It never interrupts a job in flight.

*Why*: jobs are already bounded — backfill at `PAGES_PER_RUN`, history sync at
`HISTORY_PAGES_PER_RUN` — so "don't start another one" is sufficient and needs no cancellation
machinery. Interrupting a job mid-flight would mean relying on stale-job recovery for routine
operation rather than for failures.

*Trade-off*: a pass can overrun its nominal budget by up to one job. The reserve is what keeps that
inside the platform's ceiling, and SIGTERM handling is the backstop.

### D4 — The queue stays in Postgres; a trigger is only a trigger

The endpoint is a way to *start* a pass. It is not a queue, and no external queue replaces the
`jobs` table.

*Why*: design decision D11 — analysis jobs commit with the rows that justify them. An external queue
reintroduces the dual-write, and the failure is invisible: rows present, analysis absent, no error.

*Consequence*: a message-queue trigger may be added later purely to reduce Sync-now latency, without
changing anything here. A timer remains mandatory regardless, because retries, classification
collection, and rate-limit resumption become runnable through the passage of time with no event
attached.

### D5 — Two connection strings, one process, opt-in

Add an optional `DATABASE_URL_DIRECT`. When set, job execution uses it; everything else keeps using
`DATABASE_URL`. When unset — every existing deployment — both use `DATABASE_URL` and nothing
changes.

*Why*: on Vercel the request path wants Neon's pooled endpoint, while a drain is a burst of
sequential work better served by a direct connection. Note this is a shape preference, not a
correctness requirement: the job claim is a single `UPDATE … FOR UPDATE SKIP LOCKED` statement and
the normalizer's transactions are short, both of which a transaction-mode pooler handles correctly.

*Alternative considered*: always require both. Rejected — it would break Paths A and B for no gain.

### D6 — Secret authentication, no caller-supplied selectors

The route compares a bearer secret in constant time and accepts no request body that influences
which work runs.

*Why*: it is the only route that acts outside the workspace access model, because it acts on behalf
of no user. Accepting a workspace or job selector would turn it into a way to make the server act on
a chosen target with no user identity attached. Refusing selectors keeps the blast radius of a
leaked secret at "someone can make the queue drain sooner".

*Consequence*: the route cannot be used operationally to drain one workspace. That is what
`npm run worker` with a shell is for.

## Risks / Trade-offs

- **An implementer uses `Worker.drain()` anyway, and stuck jobs silently wedge repositories** → D2
  removes or fixes the method rather than documenting around it; a test asserts a pass recovers a
  job abandoned in the running state.
- **The route ships without the scheduled-task tick; periodic sync never runs while the button keeps
  working** → the tick is inside `runDrain` (D1), and a test asserts a bounded pass alone causes
  periodic sync work to be enqueued. `scheduled_tasks.last_run_at` is the operational check.
- **Cron interval sets the floor on Sync-now latency** → accepted; it is a documented property of
  Path C, not a defect. One-minute cron keeps it acceptable.
- **The platform's own scheduler may not be able to meet that interval** — Vercel Hobby caps cron
  at once per day with ±59 minutes of precision, which would leave the product permanently stale,
  and a committed sub-daily schedule fails the deploy → the trigger is deliberately *not* part of
  the application. Because D6 made it an ordinary authenticated HTTP call, any scheduler can drive
  it, so the plan constrains which driver to pick rather than whether the deployment works.
- **A single bulk job exceeds any budget** — a workspace-wide recompute is one job that runs as long
  as it runs → run bulk recomputes from a shell (`npm run recompute`), documented in Path C.
- **Overlapping passes waste invocations** → harmless by construction (`SKIP LOCKED`), and cheap
  under Active CPU pricing since a pass with nothing to claim is almost entirely idle.
- **The secret leaks** → the blast radius is early draining, not data access (D6). Rotate by
  changing one environment variable.

## Migration Plan

Additive; no schema change, no data migration, nothing to roll back in the database.

1. Land `runDrain` and refactor `worker-main` and `scheduler-main` onto it. Verify Paths A and B are
   byte-for-byte unchanged in behaviour — the existing job and worker test suites are the check.
2. Land the route and `vercel.json`. Without the secret set it refuses every request, so it is inert
   until deliberately configured.
3. On a Vercel deployment: set the secret and the cron, confirm `scheduled_tasks.last_run_at`
   advances and queue depth returns to zero between ticks.
4. Update `docs/deploy.md` Path C from design to procedure.

**Rollback**: unset the cron. The endpoint stops being called; a resident worker elsewhere, or a
later re-enable, drains the accumulated queue with nothing lost. Jobs are durable and idempotent by
GitHub node id, so an outage of the executor is staleness, never data loss.

## Open Questions

- **Budget and reserve values.** Both depend on the platform's maximum function duration and on
  observed job durations, neither of which needs to be settled before the code is written. Start
  conservative and tune from the counts the endpoint reports.
- **Whether to add a message-queue trigger for Sync-now latency.** Deferred by D4 — it composes with
  this design rather than changing it, so it can be decided after measuring how a one-minute cron
  actually feels.
