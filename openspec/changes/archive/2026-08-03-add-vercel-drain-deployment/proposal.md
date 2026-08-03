## Why

Every deployment path the product supports today requires a host that will run a resident process.
The worker and scheduler are long-lived loops with no HTTP surface, so Vercel — the most convenient
host for the Next.js half of the product — cannot run them, and any deployment there is split
across two vendors.

The obstacle is smaller than it looks. Every job handler is already checkpointed: backfill stops
after `PAGES_PER_RUN` pages and re-enqueues, history sync does the same, file fill-in is a
resumable backwards pass, and classification is an async batch whose collect job re-enqueues
itself. Nothing needs to run for an hour. What the deployment actually needs is something that
periodically claims and runs bounded units of work — which an HTTP endpoint on a timer can do as
well as a loop can.

This change adds that endpoint, so the whole product can run on one platform, without removing the
resident processes that local development and container deployments depend on.

## What Changes

**Job execution becomes a capability with two interchangeable implementations**

- Extract the work currently performed by the worker loop and the scheduler loop into a single
  reusable `runDrain(...)` operation: reclaim stale jobs, fire due scheduled tasks, then claim and
  execute jobs until a caller-supplied time budget is exhausted.
- `npm run worker` and `npm run scheduler` keep working exactly as they do now. They are how local
  development, Path A, and Path B run, and they remain the reference behaviour that the endpoint
  must match.
- Establish as a requirement that the two implementations are equivalent: the same job, executed
  either way, produces the same result, and no job type is executable by only one of them.

**A new authenticated drain endpoint**

- `POST /api/jobs/drain` runs one drain pass and returns counts — jobs claimed, succeeded, retried,
  failed, and scheduled tasks fired — so the cron log is an operational signal rather than a bare
  200.
- Authenticated by a shared secret. Unauthenticated it would be a public job-execution endpoint,
  and it deliberately sits outside the workspace access model that guards every other route,
  because it acts on behalf of no user.
- Bounded by a time budget rather than a job count, stopping before the platform's maximum function
  duration rather than being killed at it.

**Three correctness rules the endpoint must carry that the loop gets for free**

- **Stale-job reclaim.** `Worker.drain()` today never calls `reclaimStaleJobs()` — that sweep lives
  only in `Worker.start()`. Without it a job whose invocation was killed stays `running` forever,
  and because `enqueue` treats a `dedupeKey` as colliding while a job is `pending` *or* `running`,
  the next sync enqueued for that repository is silently dropped. One interrupted job wedges a
  repository with no error anywhere.
- **Scheduled-task ticking.** `src/jobs/scheduler.ts` is the only thing that enqueues
  `workspace.schedule_syncs`. A deployment with no scheduler and no tick never runs periodic sync at
  all — while the Sync-now button keeps working, which is what makes the omission easy to miss.
- **The queue stays in Postgres.** Analysis jobs are enqueued in the same transaction as the rows
  that justify them. Moving the queue to an external service would reintroduce the dual-write that
  design decision D11 exists to prevent.

**Configuration for a serverless database connection**

- Support a separate direct (unpooled) connection string for job execution, distinct from the
  pooled connection the request path uses, without changing the single-`DATABASE_URL` behaviour
  that every existing deployment relies on.

**Not in scope**: removing the worker or scheduler entrypoints; running the drain as a Vercel
Container Image (a plain route carries the same limits and pricing with one fewer build); replacing
the Postgres queue with a managed queue service; any change to what a job does.

## Capabilities

### New Capabilities

- `job-execution`: How queued work gets executed, independent of deployment topology. Covers the
  guarantees that hold however jobs are run — at most one executor per job, recovery of jobs whose
  executor vanished, due scheduled tasks firing, retry and backoff behaviour, bounded execution
  that yields rather than being killed — and the requirement that a resident worker and a
  timer-driven endpoint are interchangeable. These rules exist today in `design.md` D11 and in the
  worker's implementation; giving them a spec is what makes a second implementation verifiable
  rather than hopeful.

### Modified Capabilities

None. No user-visible behaviour changes. `github-data-sync` already states incremental sync as a
recurring obligation without prescribing what drives it, which is the requirement a drain-based
deployment has to keep meeting.

## Impact

- **New code**: `src/jobs/drain.ts` (the shared operation), `app/api/jobs/drain/route.ts` (the HTTP
  wrapper), `vercel.json` (cron schedule).
- **Modified**: `src/config/env.ts` gains the drain secret and the optional direct connection
  string; `src/jobs/worker-main.ts` and `src/jobs/scheduler-main.ts` may be refactored onto the
  shared operation but must not change behaviour.
- **Schema**: none. No migration.
- **Dependencies**: none added.
- **Security**: a new unauthenticated-by-session HTTP route exists and must be secret-authenticated.
  It is the only route in the product that acts outside the workspace access model, which makes it
  the one worth reviewing carefully.
- **Operations**: on a drain-based deployment `scheduled_tasks.last_run_at` is still the check that
  periodic sync is alive, and queue depth returning to zero between ticks is the signal that the
  budget and cron interval are adequate. Cron interval becomes the floor on Sync-now latency.
- **Docs**: `docs/deploy.md` Path C already describes this deployment and marks the endpoint as not
  yet built; it becomes a procedure rather than a design once this ships.
- **Cost**: on Active CPU pricing the workload is favourable — a sync job is mostly waiting on
  GitHub and Postgres, and waiting is not billed.
