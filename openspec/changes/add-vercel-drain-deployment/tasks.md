## 1. Shared execution operation

- [x] 1.1 Add `src/jobs/drain.ts` exporting `runDrain(database, options)` performing, in fixed order:
      reclaim stale jobs, run due scheduled tasks, then claim-and-execute until the budget is spent
      or the queue is empty (design D1)
- [x] 1.2 Return counts from `runDrain`: jobs claimed, succeeded, retried, failed, and scheduled
      tasks fired
- [x] 1.3 Implement the budget as wall-clock checked between jobs, with a reserve so a pass never
      starts a job it cannot finish inside the budget, and never interrupts a job in flight (D3)
- [x] 1.4 Accept an unbounded budget so the resident worker is the same operation in a loop
- [x] 1.5 Resolve `Worker.drain()` per D2 — either give it the reclaim and tick responsibilities or
      remove it from the public surface, so no entrypoint exists that silently omits recovery
- [x] 1.6 Tests: a pass recovers a job abandoned in the running state and executes it; a pass alone
      causes due scheduled work to be enqueued; a budget-limited pass stops claiming with jobs
      remaining and leaves them runnable; two concurrent passes never execute the same job; a pass
      over an empty queue reports zero counts without failing

## 2. Refactor existing entrypoints onto it

- [x] 2.1 Rewrite `src/jobs/worker-main.ts` to call `runDrain` in a loop with no budget, preserving
      the existing SIGINT/SIGTERM behaviour of finishing the current job before exiting
- [x] 2.2 Rewrite `src/jobs/scheduler-main.ts` onto the shared tick, keeping its entrypoint and its
      once-a-minute cadence for Paths A and B
- [x] 2.3 Verify no behaviour change: the existing job, worker, and scheduler test suites pass
      unmodified, and a resident worker still reclaims, ticks, and executes exactly as before

## 3. Database connection

- [x] 3.1 Add optional `DATABASE_URL_DIRECT` to `src/config/env.ts`; when unset, job execution uses
      `DATABASE_URL` so every existing deployment is unaffected (D5)
- [x] 3.2 Give the execution path a way to build its own database handle from the direct URL rather
      than reusing the process-wide `db()` singleton
- [x] 3.3 Test: with `DATABASE_URL_DIRECT` unset, execution uses the same handle as today

## 4. Execution trigger

- [x] 4.1 Add `app/api/jobs/drain/route.ts` calling `runDrain` with the configured budget
- [x] 4.2 Authenticate with a shared secret compared in constant time; refuse every request when the
      secret is unset, so the route is inert until deliberately configured (D6)
- [x] 4.3 Accept no workspace, repository, or job selector — the route must not be usable to make the
      server act on a caller-chosen target (D6)
- [x] 4.4 Return the counts from `runDrain` as the response body so the cron log distinguishes "ran
      and did nothing" from "did not run"
- [x] 4.5 Ensure the route is excluded from session and workspace access middleware, and that its
      failure modes never leak whether a workspace or repository exists
- [x] 4.6 Tests: unauthenticated request claims no job and is refused; a request carrying a selector
      has no effect on which work runs; an authenticated request against an empty queue reports zero
      counts; the route is unreachable with the secret unset

## 5. Configuration and deployment wiring

- [x] 5.1 Add `vercel.json` with the migration build step, and **no** `crons` block — Vercel Hobby
      caps cron at once per day, so a committed sub-daily schedule fails the deploy outright. The
      trigger is plan-dependent and documented in `docs/deploy.md` instead
- [x] 5.2 Add the drain secret and `DATABASE_URL_DIRECT` to `.env.example` with comments stating that
      both are only needed for a drain-based deployment
- [x] 5.3 Confirm the build command runs migrations before the deployment goes live, and that
      `ANTHROPIC_API_KEY` is set on the deployment when classification is enabled — the drain runs in
      the web deployment, so Path A's advice to keep that key off it does not apply

## 6. Verification

- [x] 6.1 Add a test asserting the three correctness rules hold for a bounded-pass-only deployment:
      stale jobs are recovered, periodic sync is enqueued with no user action, and no job type is
      executable by only one mechanism
- [ ] 6.2 Deploy to a preview environment, drive it only by cron, and confirm a repository connects,
      backfills across multiple passes, and produces analysis rows
- [ ] 6.3 Confirm `scheduled_tasks.last_run_at` advances under cron-only operation — the check that
      catches a drain which forgot to tick
- [ ] 6.4 Confirm queue depth returns to zero between ticks at the chosen cron interval and budget;
      record the observed job durations and set the reserve from them (design Open Questions)
- [ ] 6.5 Verify rollback: disable the cron, confirm work accumulates without loss, re-enable and
      confirm the queue drains
- [x] 6.6 Run `npm run lint`, `npm run typecheck`, and `npm test`

## 7. Documentation

- [x] 7.1 Update `docs/deploy.md` Path C from design to procedure: remove the "does not exist"
      warning, name the real route, secret, and cron configuration
- [x] 7.2 Update `docs/architecture.md` to describe job execution as one operation with two
      triggers, rather than a worker process and a scheduler process
- [x] 7.3 Add the drain endpoint's counts to the health-check section of `docs/deploy.md` as the
      first-line signal for a drain-based deployment
