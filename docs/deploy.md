# Deploy

Three supported paths:

- **[A — Vercel + a worker host](#path-a--vercel--a-worker-host)**: the web application on Vercel,
  the worker and scheduler on a container host. No code changes; two vendors.
- **[B — Containers everywhere](#path-b--containers-everywhere)**: one image, three commands, on
  Azure Container Apps / App Service / any container platform. One place to operate.
- **[C — Everything on Vercel](#path-c--everything-on-vercel)**: the web application plus a
  cron-driven drain endpoint replacing both background processes. One vendor; requires code that
  does not exist yet.

All three need the same things: a Postgres database, a registered GitHub App
(`docs/github-app.md`), and migrations run before the new code starts.

Read [Topology](#topology) first — it explains why A is split and what C has to replace.

---

## Topology

```
                ┌──────────┐        ┌──────────────┐
   browser ────▶│   web    │        │  scheduler   │   ← ticks every 60s, enqueues only
                └────┬─────┘        └──────┬───────┘
                     │                     │
                     ▼                     ▼
              ┌──────────────────────────────────┐
              │      Postgres  (jobs table)      │
              └──────────────┬───────────────────┘
                             │ claim
                             ▼
                       ┌──────────┐
                       │  worker  │──▶ GitHub API
                       └──────────┘──▶ Anthropic API (optional)
```

| Process | Command | Shape |
| --- | --- | --- |
| web | `npm run start` | HTTP, stateless, scales horizontally |
| worker | `npm run worker` | long-lived loop, no HTTP port |
| scheduler | `npm run scheduler` | long-lived loop, one tick a minute |

Multiple workers and multiple schedulers are safe — jobs are claimed with
`FOR UPDATE SKIP LOCKED`, scheduled ticks with a row lock.

**The constraint that shapes Path A:** the worker and scheduler are resident Node processes with
no HTTP surface. Vercel runs request-scoped functions and cannot host them. So Vercel gets the web
process, and the worker and scheduler go somewhere that runs a container.

Losing the worker is not data loss — it is staleness. Jobs accumulate in `jobs` and drain when a
worker returns. A missed scheduler tick delays freshness by one `SYNC_INTERVAL_MINUTES` and loses
nothing.

---

## Environment

Everything is read once at startup in `src/config/env.ts`, so a missing secret fails immediately
with its name rather than at the first GitHub request. `.env.example` is the full list.

### Required — all three processes

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | `postgres://…`; managed providers usually need `?sslmode=require` |
| `GITHUB_APP_ID` | |
| `GITHUB_APP_PRIVATE_KEY` | PEM contents **or** the same PEM base64-encoded — see below |
| `GITHUB_OAUTH_CLIENT_ID` | |
| `GITHUB_OAUTH_CLIENT_SECRET` | |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `APP_BASE_URL` | public origin, no trailing slash; must match the GitHub App's callback URLs |

`GITHUB_APP_PRIVATE_KEY` accepts base64, because a multi-line PEM survives almost no secret store
intact. Use it:

```bash
base64 -i tracker.private-key.pem | tr -d '\n'
```

Literal `\n` escapes inside a PEM are also normalized, so either form works.

### Optional, with defaults

| Variable | Default | |
| --- | --- | --- |
| `BACKFILL_WINDOW_DAYS` | `90` | how far back a repo is ingested **when connected** — a starting point, not a ceiling |
| `HISTORY_PAGES_PER_RUN` | `5` | pages one history sync walks before yielding the worker |
| `SYNC_INTERVAL_MINUTES` | `15` | |
| `SYNC_OVERLAP_MINUTES` | `30` | overlap so nothing falls between two syncs |
| `RATE_LIMIT_SAFETY_THRESHOLD` | `200` | pause non-urgent work below this many API points |
| `ON_DEMAND_SYNC_DEBOUNCE_SECONDS` | `120` | |
| `PERMISSION_CACHE_SECONDS` | `300` | |
| `SESSION_INACTIVITY_MINUTES` | `10080` | |
| `GITHUB_APP_SLUG` | — | used to build install links |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub Enterprise |
| `GITHUB_GRAPHQL_URL` | `https://api.github.com/graphql` | GitHub Enterprise |

Changing `BACKFILL_WINDOW_DAYS` does not alter what has already been ingested — coverage depth is
recorded per repository.

`GITHUB_WEBHOOK_SECRET` is reserved for the deferred webhook path and currently unused.

### Worker only

| Variable | Notes |
| --- | --- |
| `ANTHROPIC_API_KEY` | read by the SDK directly, not through `src/config/env.ts` |

Only needed if work classification is enabled for a workspace. It is **off by default**. Never set
it on the web process — nothing there imports the SDK, and a lint rule keeps it that way.

---

## Migrations

```bash
npm run db:migrate
```

Ordered SQL files, applied once each inside a transaction, recorded in `schema_migrations`.
Re-running is a no-op. Run it **before** new web and worker processes start.

All migrations in the current release are additive, so a rolling deploy where old and new
processes overlap is safe.

Rehearse against a copy of production before a schema release:

```bash
DATABASE_URL=postgres://…copy npx tsx scripts/rollout-check.ts
```

It asserts migrations apply additively, the recompute stamps the new revision, and the rollback
path actually restores the previous numbers.

> `npm run db:migrate` runs through `tsx`, which is a **devDependency**. It works during a build
> step and inside the Docker image (which installs dev dependencies deliberately), but not in an
> environment where dev dependencies were pruned.

---

## Path A — Vercel + a worker host

### A1. Database

Any Postgres 14+. With Vercel's serverless functions, **use a pooled connection string** —
Neon's pooled endpoint, Supabase's pgBouncer port, RDS Proxy, or equivalent. Each function
instance opens its own `pg.Pool` (max 10 connections, set in `src/db/pg.ts`; not configurable by
environment), and instance count is not something you control. A direct connection string will
exhaust `max_connections` under load.

Give the worker host a **direct** (unpooled) connection string. Not for correctness — the job
claim is a single `UPDATE … FOR UPDATE SKIP LOCKED` statement and the normalizer's transactions
are ordinary short transactions, both of which a transaction-mode pooler handles. The reason is
shape: the worker is one long-lived process that wants one stable connection, and routing it
through a pooler adds a hop and a failure mode for no benefit.

### A2. Deploy the web process

Import the repository into Vercel. The Next.js defaults are correct — `next.config.ts` already
sets `serverExternalPackages: ['pg']` so the driver is not bundled.

Set the build command so migrations run before the deployment goes live:

```
npm run db:migrate && npm run build
```

Set all **required** variables in Vercel's environment settings, plus any optional ones you are
overriding. Do not set `ANTHROPIC_API_KEY` here.

Set `APP_BASE_URL` to your production domain, not the generated `*.vercel.app` URL.

> **Preview deployments.** Each preview gets a fresh URL, which will not match the GitHub App's
> registered callback URLs, so OAuth fails there. Either restrict Tracker to the production
> environment, or register a second GitHub App for previews on a stable preview domain.

### A3. Deploy the worker and scheduler

They are ordinary containers. Fly.io, Railway, Render, ECS, Azure Container Apps — anything that
runs a long-lived process. Build the repository's `Dockerfile` and run two services from the one
image:

```bash
docker build -t tracker .

docker run --env-file .env.worker    tracker npm run worker
docker run --env-file .env.scheduler tracker npm run scheduler
```

Neither needs an inbound port. Both need `DATABASE_URL` and the GitHub App credentials; the worker
additionally needs `ANTHROPIC_API_KEY` if classification is on.

Size the worker first, then scale: one worker is enough for a handful of repositories; add copies
when queue depth stops returning to zero between syncs.

### A4. Point GitHub at the deployment

In the GitHub App settings (`docs/github-app.md`), set both callbacks against `APP_BASE_URL`:

```
OAuth callback     https://your-domain/api/auth/github/callback
Setup URL          https://your-domain/api/github/setup
```

### If you truly cannot run a container

See [Path C](#path-c--everything-on-vercel), which replaces the worker and scheduler with a
cron-driven drain endpoint hosted alongside the web application.

---

## Path B — Containers everywhere

One image, three commands. The `Dockerfile` at the repository root builds it.

```bash
docker build -t tracker .

docker run --env-file .env -p 3000:3000 tracker                 # web (default CMD)
docker run --env-file .env                tracker npm run worker
docker run --env-file .env                tracker npm run scheduler
```

> The image installs **dev dependencies on purpose** — the worker and scheduler run TypeScript
> source through `tsx`. Adding `--omit=dev` to the `npm ci` will break both, and the web process
> will keep working, so the breakage is quiet. Don't.

Run migrations as a release step before rolling the new image:

```bash
docker run --env-file .env tracker npm run db:migrate
```

### Azure Container Apps (recommended)

Closest fit: three apps from one image, no VM to manage, scale-to-zero available on the workers.

```bash
RG=tracker-rg
ENV=tracker-env
ACR=trackeracr

az group create -n $RG -l westeurope
az acr create -n $ACR -g $RG --sku Basic --admin-enabled true
az acr build -r $ACR -t tracker:latest .

az postgres flexible-server create \
  -g $RG -n tracker-db --tier Burstable --sku-name Standard_B1ms \
  --version 16 --database-name tracker

az containerapp env create -n $ENV -g $RG -l westeurope
```

Web — the only app with ingress:

```bash
az containerapp create -n tracker-web -g $RG --environment $ENV \
  --image $ACR.azurecr.io/tracker:latest \
  --target-port 3000 --ingress external \
  --min-replicas 1 --max-replicas 3 \
  --secrets db-url=… app-key=… session-secret=… oauth-secret=… \
  --env-vars DATABASE_URL=secretref:db-url \
             GITHUB_APP_PRIVATE_KEY=secretref:app-key \
             SESSION_SECRET=secretref:session-secret \
             GITHUB_OAUTH_CLIENT_SECRET=secretref:oauth-secret \
             GITHUB_APP_ID=… GITHUB_OAUTH_CLIENT_ID=… APP_BASE_URL=https://…
```

Worker and scheduler — same image, no ingress, overridden command:

```bash
az containerapp create -n tracker-worker -g $RG --environment $ENV \
  --image $ACR.azurecr.io/tracker:latest --ingress disabled \
  --min-replicas 1 --max-replicas 4 \
  --command npm --args run,worker \
  --secrets … --env-vars …

az containerapp create -n tracker-scheduler -g $RG --environment $ENV \
  --image $ACR.azurecr.io/tracker:latest --ingress disabled \
  --min-replicas 1 --max-replicas 1 \
  --command npm --args run,scheduler \
  --secrets … --env-vars …
```

Keep the scheduler at `min-replicas 1`, `max-replicas 1`. More than one is *safe* — ticks are
claimed with a row lock — but there is nothing to gain. **Do not** let either background app
scale to zero on HTTP traffic; they have none. Scale the worker on queue depth if you wire up a
custom KEDA Postgres scaler, otherwise fix the replica count.

Migrations as a one-off job:

```bash
az containerapp job create -n tracker-migrate -g $RG --environment $ENV \
  --image $ACR.azurecr.io/tracker:latest --trigger-type Manual \
  --replica-timeout 600 --command npm --args run,db:migrate \
  --secrets … --env-vars …

az containerapp job start -n tracker-migrate -g $RG
```

### Azure App Service for Containers

Workable, with one caveat: App Service is built around a single HTTP-serving container per app,
so the worker and scheduler each need their own Web App with **Always On** enabled — without it
the platform idles out a container that receives no requests, which is exactly what a background
process looks like.

```bash
az appservice plan create -g $RG -n tracker-plan --is-linux --sku B1

az webapp create -g $RG -p tracker-plan -n tracker-web \
  --deployment-container-image-name $ACR.azurecr.io/tracker:latest
az webapp config appsettings set -g $RG -n tracker-web \
  --settings WEBSITES_PORT=3000 DATABASE_URL=… SESSION_SECRET=… …

az webapp create -g $RG -p tracker-plan -n tracker-worker \
  --deployment-container-image-name $ACR.azurecr.io/tracker:latest
az webapp config appsettings set -g $RG -n tracker-worker \
  --settings WEBSITES_STARTUP_COMMAND="npm run worker" DATABASE_URL=… …
az webapp config set -g $RG -n tracker-worker --always-on true
```

`WEBSITES_PORT=3000` is required on the web app — App Service does not infer the port.

If you would rather not pay for two idle web apps, run the scheduler as an App Service **WebJob**
on a timer trigger instead. It only enqueues, so a one-shot invocation on the sync cadence is
equivalent to the resident process.

Prefer Container Apps if you have the choice. App Service's model fights this shape.

### Other container platforms

Nothing here is Azure-specific: three services from one image, one with ingress, one Postgres, one
release-step migration. ECS/Fargate, Cloud Run (with the workers as always-on instances, not
request-scaled), Kubernetes (one Deployment each), and docker-compose on a single VM all map
directly.

`docker-compose.yml` in the repository provides **only Postgres for local development**. It is not
a production topology.

---

## Path C — Everything on Vercel

One vendor, no container host. The web application deploys natively; the worker and scheduler are
replaced by a **drain endpoint** that Vercel Cron calls on a timer.

The endpoint is `POST /api/jobs/drain` (it also answers `GET`, which is what Vercel's scheduler
issues). It is closed until a secret is configured, so a deployment that does not use it carries an
inert route rather than an open one.

### Why the worker cannot simply be a container image

Vercel's Container Images run *as functions*, not as processes. Two documented constraints rule
out `npm run worker`:

- a container image is expected to **open an HTTP server** to receive traffic; the worker opens
  none, and
- a function **scales down after 5 minutes without traffic** (30 seconds in preview); the worker
  receives no traffic by design.

So the process must become an endpoint. Do not attempt to keep a resident loop alive by pinging
the container inside the scale-down window — a function instance is not promised to keep executing
between requests, autoscaling gives you an unpredictable number of concurrent loops, and a
one-second poll loop is ~86,400 database queries a day that also defeats Neon's scale-to-zero.

### Why this fits anyway

Two properties make it work here that would not hold for a typical worker:

**Every job is already checkpointed.** No handler runs unbounded. `repository.backfill` stops
after `PAGES_PER_RUN = 5` pages, records its cursor, and re-enqueues (`src/ingest/backfill.ts:29`).
`repository.history_sync` does the same at `HISTORY_PAGES_PER_RUN`. `repository.file_fill_in` is a
resumable backwards pass. Classification is an async batch whose collect job re-enqueues itself.
The unit of work is already "a few pages, then commit progress", which is exactly what a bounded
invocation needs.

**Active CPU pricing matches the workload.** A sync job is almost entirely waiting on GitHub and
Postgres — five GraphQL round-trips and up to 125 short transactions, against milliseconds of
actual computation. Billing only for active CPU rather than wall-clock is a structural advantage
over renting a container that is blocked on a socket most of its life.

### Shape

```
   Vercel Cron ──every minute──▶ /api/jobs/drain
                                       │
                                       ├─ verify the bearer secret
                                       │
                                       └─ runDrain()  (src/jobs/drain.ts)
                                             ├─ 1. reclaim abandoned jobs
                                             ├─ 2. fire due scheduled tasks
                                             └─ 3. execute until the budget
                                                   is spent or the queue empties
                                                        │
                                                        ▼
                                                Postgres jobs table
                                                (still the queue)
```

`runDrain` is the same operation the resident worker runs — `npm run worker` is `runDrain` in a
loop with no budget. There is one implementation rather than two that could drift, and the three
steps are in a fixed order the caller cannot reorder or skip.

A container image is **not required**. Reach for `Dockerfile.vercel` and the `services` config only
if you want the drain isolated from the web application so a heavy backfill cannot affect page
latency — a legitimate reason, not a required one.

### Configuration

`vercel.json` is committed and carries the migration step:

```json
{
  "buildCommand": "npm run db:migrate && npm run build"
}
```

It deliberately carries **no `crons` block** — see [Driving the drain](#driving-the-drain) below,
because the right answer depends on your plan.

**Add your database's region to it.** This is not tuning; skipping it makes the application feel
broken:

```json
{
  "buildCommand": "npm run db:migrate && npm run build",
  "regions": ["fra1"]
}
```

Vercel defaults to `iad1` (Washington DC). A managed Postgres provisioned in Europe therefore sits
an ocean away from every function by default, and an authenticated page issues roughly ten
sequential queries — a workspace access check per repository, then the page's own reads. At ~1 ms
per round trip they are invisible; at ~90 ms they are seconds of blank screen on every click. Paths
A and B never expose this because the application and its database are neighbours there.

Match the region to wherever your database actually lives (`fra1` Frankfurt, `iad1` US East,
`arn1` Stockholm, …). If you use Neon's free tier, also check whether **scale-to-zero** is enabled:
compute suspends after five minutes idle, and the first query afterwards waits seconds for it to
wake — which reads as "slow when I come back, fine while I'm clicking".

Set these in the Vercel project, on top of the [required variables](#required--all-three-processes):

| Variable | Notes |
| --- | --- |
| `JOBS_DRAIN_SECRET` | presented as `Authorization: Bearer …`. **Until this is set the endpoint refuses every request**, which is how a non-Path-C deployment stays closed. `CRON_SECRET` is read as a fallback, since Vercel's scheduler already sends it |
| `JOBS_DRAIN_BUDGET_MS` | wall-clock budget for one pass; default `60000`. **Raise it** — the route declares `maxDuration = 300`, so the default uses a fifth of the ceiling. Go up in steps and confirm each pass still returns, because the real ceiling is plan-dependent (60 s on Hobby without Fluid Compute) |
| `JOBS_DRAIN_RESERVE_MS` | held back so a pass never starts a job it cannot finish; default `30000`. **Leave it alone.** It must cover the *longest* job, not the average one — measured jobs run 1–2 s but one backfill page took ~40 s |
| `DATABASE_URL_DIRECT` | direct (unpooled) string used by job execution and migrations; pages keep using the pooled `DATABASE_URL`. **Set automatically** if you connected Neon through Vercel's integration — it provisions `DATABASE_URL_UNPOOLED`, which is read as a fallback |
| `ANTHROPIC_API_KEY` | **only if classification is enabled** — see below |

Set these on **Preview** as well as Production if you want preview deployments to work at all. Vercel
scopes environment variables per environment, and a preview without them fails with
`Missing required environment variable GITHUB_APP_ID` — which looks like a code fault and isn't.

### Driving the drain

The trigger interval is the floor on how long a member waits after pressing **Sync now** — the
button only enqueues (`app/api/workspaces/[workspaceId]/sync/route.ts`). It also bounds how quickly
a retry is picked up (backoff starts at 10s) and how long a finished classification batch sits
uncollected (that job re-enqueues itself every 5 minutes). **One minute is the target; anything
slower than about five degrades the product.**

**On Vercel Pro**, add the schedule to `vercel.json`:

```json
"crons": [{ "path": "/api/jobs/drain", "schedule": "* * * * *" }]
```

**On Vercel Hobby, you cannot use Vercel Cron for this.** Hobby's minimum interval is once per day
with ±59 minutes of scheduling precision. A daily drain would leave the product permanently stale,
and committing a sub-daily schedule makes the deploy itself fail.

This costs nothing to work around, because the endpoint is an ordinary authenticated HTTP call —
any scheduler can drive it:

```bash
curl -X POST https://<your-domain>/api/jobs/drain \
     -H "Authorization: Bearer $JOBS_DRAIN_SECRET"
```

| Driver | Interval | Notes |
| --- | --- | --- |
| **Cloudflare Worker** on a cron trigger | 1 min | free tier; ~10 lines, the sturdiest option — **recommended** |
| **cron-job.org** | 1 min | free, supports custom headers, nothing to deploy, but lives outside version control |
| **Vercel Pro** `crons` block | 1 min | no second vendor, config in the repository; costs a plan upgrade |
| **GitHub Actions** — `.github/workflows/drain.yml` | 15–30 min in practice | committed and ready, but **not adequate as the only driver** — see below |

#### About the GitHub Actions workflow

`.github/workflows/drain.yml` is committed because a version-controlled schedule and a
`workflow_dispatch` button are genuinely useful. It needs an `APP_URL` repository **variable** and a
`JOBS_DRAIN_SECRET` repository **secret**, and can be fired by hand from the Actions tab.

**Do not rely on it as your only trigger.** It requests `*/5`, but GitHub's `schedule:` event is
best-effort and sheds load: a first deployment observed **one run in twenty-five minutes**, and
15–30 minutes is the realistic figure rather than the documented five. At that cadence Sync-now
stops being a button — a member presses it and nothing visible happens for a third of an hour.

Three further limits compound it. Actions bills **a whole minute per run, rounded up**, so a private
repository's 2,000 free minutes cap the interval near 30 minutes anyway. Scheduled workflows only
fire from the **default branch**, so a drain that works on a feature branch runs never until merged.
And they are **disabled automatically after 60 days of repository inactivity** — a quiet way for a
deployment to stop syncing.

Nothing is lost while the driver is slow: jobs accumulate durably and a later pass clears the whole
backlog, which is the rollback property working. The cost is staleness, and staleness is the
product.

If you are stuck on a slow driver temporarily, raise `JOBS_DRAIN_BUDGET_MS` so each rare pass gets
through far more work. That trades away Sync-now latency, which a bigger budget cannot fix.

**Raise the driver's own timeout with it.** The budget is bounded by whatever the caller allows,
not only by `maxDuration`: the committed workflow holds the connection for `--max-time` seconds
inside `timeout-minutes`, and a budget above that gets cut mid-pass. The pass still finishes
server-side — jobs are claimed and completed either way — but the run is reported as a failure and
the counts are lost, so the driver looks broken while the queue is draining normally. The two
values ship at 290s and 6 minutes, leaving room for a budget up to the route's 300s ceiling.

A Cloudflare Worker is the sturdiest free option:

```js
export default {
  async scheduled(event, env) {
    await fetch(`${env.APP_URL}/api/jobs/drain`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.DRAIN_SECRET}` },
    });
  },
};
```

with `[triggers] crons = ["* * * * *"]` in `wrangler.toml`, and both values set as secrets.

Whichever you choose, overlapping invocations are safe — `FOR UPDATE SKIP LOCKED` means a second
pass steps over rows the first is holding.

Environment differs from Path A in one important way: the drain runs inside the web deployment, so
**`ANTHROPIC_API_KEY` must be set on it** if classification is enabled for any workspace. Path A's
advice to keep that key off the web deployment does not apply here.

Concurrent invocations are safe: `FOR UPDATE SKIP LOCKED` means a second pass steps over rows the
first is holding. Overlap is wasteful, not dangerous.

### Gotchas

**1. Abandoned jobs must be reclaimed, and this is why.** A job whose executor was killed stays
`running` forever without a sweep — and because `enqueue` treats a `dedupeKey` as colliding while a
job is `pending` **or** `running` (`src/jobs/queue.ts`), the next sync enqueued for that repository
is then silently dropped. One stuck job quietly wedges a repository with no error anywhere.

`runDrain` reclaims before it claims, so this is handled — but it is the reason `Worker` deliberately
offers no way to run more than one job. If you find yourself looping `Worker.runOnce()` somewhere
new, you are rebuilding this bug. The default stale threshold is 300 seconds.

**2. Keep Postgres as the queue.** Vercel Queues can trigger a drain, but must not replace the
`jobs` table. `persistPullRequest` enqueues `pull_request.analyze` in the *same transaction* as the
rows that justify it (`src/ingest/normalize.ts`), so data and its analysis job commit together. An
external queue reintroduces the dual-write it was built to avoid: transaction commits, enqueue
fails, and that pull request is never analyzed — with no error and nothing to detect it.

**3. A timer is mandatory, not just events.** Work becomes runnable through the passage of time
with no event attached: retries back off `10s → 1h` (`src/jobs/queue.ts`), the classification
collect job re-enqueues itself `now + 5 minutes` for as long as a batch runs
(`src/classification/service.ts`), and rate-limit pauses resume when GitHub's window resets. A
queue message can improve button latency; only the cron makes the system correct.

**4. Scale-down is safe.** A pass interrupted by scale-down receives SIGTERM with a 30-second grace
period, and a pass stops between jobs rather than abandoning the one in flight. Nothing is lost —
but this is exactly the case gotcha 1 is about, so the reclaim sweep is what makes it true when the
grace period is not enough.

**5. Long single jobs are the ceiling.** Individual handlers are bounded, but a bulk
`workspace.recompute_analysis` is one job that runs as long as it runs. Run bulk
recomputes from a machine with a shell (`npm run recompute -- --workspace <id>`) rather than
through the drain.

### When to prefer Path A instead

Path A runs a real process with no timeout ceiling, for a few dollars a month. Path C keeps
everything on one vendor and bills only for active CPU. The trade is narrow: Path C puts the drain
endpoint on your incident surface; Path A puts a second vendor on your bill.

---

## Post-deploy checklist

1. `npm run db:migrate` reports up to date.
2. Web responds; `/signin` completes GitHub OAuth end to end.
3. Install the GitHub App on a repository; confirm a `repository.backfill` job appears and
   succeeds.
4. Worker logs show jobs claimed and completed (JSON lines on stdout). On Path C, the cron log
   shows a drain returning non-zero counts.
5. After one `SYNC_INTERVAL_MINUTES`, `scheduled_tasks.last_run_at` has advanced. This holds on
   Path C too — the drain endpoint ticks the same table — and it is the check that catches a drain
   which forgot to call `runDueScheduledTasks`.
6. The team view renders pull requests.

---

## Health checks

```sql
-- queue depth: growth without bound means workers are down or under-provisioned
SELECT count(*) FROM jobs WHERE state = 'pending' AND run_after <= now();

-- terminal failures: should be near zero
SELECT count(*) FROM jobs WHERE state = 'failed';

-- sync freshness: within a couple of SYNC_INTERVAL_MINUTES
SELECT max(last_success_at) FROM repositories;

-- scheduler alive
SELECT name, last_run_at, next_run_at FROM scheduled_tasks;

-- history syncs stuck: 'paused' is rate limits and clears itself; 'failed' does not
SELECT full_name, history_state, history_covered_from FROM repositories
 WHERE history_state IN ('running', 'paused', 'failed');

-- installations needing attention: credentials GitHub rejected; owners must reconnect
SELECT count(*) FROM installations WHERE status = 'needs_attention';
```

All three processes log JSON lines to stdout. Ship them wherever your platform ships stdout.

### On a drain-based deployment (Path C)

The endpoint's response body is the first-line signal, and it distinguishes states the queries
above cannot tell apart on their own:

```json
{
  "reclaimed": 0,
  "scheduledTasksFired": 1,
  "claimed": 12,
  "succeeded": 12,
  "retried": 0,
  "failed": 0,
  "budgetExhausted": false
}
```

| What you see | What it means |
| --- | --- |
| no cron log at all | the trigger is not firing — check the schedule and the secret |
| `claimed: 0` while queue depth is non-zero | the pass is running but claiming nothing; suspect a `run_after` in the future, or jobs stuck `running` awaiting reclaim |
| `budgetExhausted: true` every pass | the budget or cron interval is too small for the arrival rate; raise `JOBS_DRAIN_BUDGET_MS` or shorten the interval |
| `reclaimed` persistently non-zero | passes are being killed mid-job — the budget reserve is too small for your slowest job |
| `scheduledTasksFired` always 0 | periodic sync is not being enqueued; confirm against `scheduled_tasks.last_run_at` |

---

## Rollback

**Code.** Roll back the image or deployment. Migrations are additive, so old code runs against the
new schema.

**Schema.** There are no down-migrations by design. Additive migrations do not need one; a
genuinely bad migration is fixed forward.

**A metric definition.** Revert `COMPUTED_VERSION` in `src/analysis/metrics.ts`, deploy, and
re-run:

```bash
npm run recompute -- --workspace <id>
```

`scripts/rollout-check.ts` asserts this path restores the previous numbers.

**Normalized data.** Rebuild from retained raw payloads without touching GitHub:

```bash
npm run reprocess -- --workspace <id>   # raw → normalized
npm run recompute  -- --workspace <id>  # normalized → pr_analysis
```

---

## Backups

Back up Postgres normally. The derived and normalized layers are rebuildable from
`github_raw_events`, so **raw retention determines how far back the product can be rebuilt without
GitHub**. Nothing is purged today; a retention policy is an open question, so plan for
`github_raw_events` to be the largest table and to keep growing.

---

## Cost notes

- **File-level diff ingestion** is materially more expensive in GitHub API quota than the pull
  request record itself. It runs as a low-priority backwards fill-in for exactly this reason.
  Below `RATE_LIMIT_SAFETY_THRESHOLD` remaining points, non-urgent work pauses rather than fails.
- **Classification** is off by default per workspace, runs through Anthropic Message Batches at
  half the standard price, is content-hashed so unchanged pull requests cost nothing on a re-run,
  and is bounded by a per-workspace spend limit checked *before* a batch is enqueued. Exceeding it
  pauses the run with a reason visible to owners.

---

## See also

- `docs/architecture.md` — components, data flow, invariants
- `docs/github-app.md` — registering the App and its permissions
- `docs/runbook.md` — rerun a sync, recompute analysis, reconnect a failed installation
