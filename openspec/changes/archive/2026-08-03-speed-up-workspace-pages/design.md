## Context

Measured on the production Vercel deployment, 2026-08-03:

- Static routes (`/signin`) return in ~250 ms cold and warm. The platform, the domain, and the build
  are not the problem.
- Authenticated workspace pages take seconds, and every in-app navigation does too.
- `find app -name "loading.tsx"` and `grep -rl "Suspense" app src` both return nothing.

The relevant code, all current:

- `resolveWorkspaceAccess` (`src/auth/access.ts:113-143`) loads the workspace's in-scope
  repositories, then loops: `await cachedDecision(...)` per repository, and on a miss
  `await options.checker.canRead(repository)` followed by `await cacheDecision(...)`. Serial, one
  repository at a time.
- The permission cache lives in Postgres, not in process memory, so it survives cold starts — this
  is why the pages are slow rather than catastrophic. The cost is round trips, not GitHub calls, in
  the common case.
- `PERMISSION_CACHE_SECONDS` defaults to 300 (`src/config/env.ts:135`). Every five minutes the loop
  degrades from `N` queries to `N` queries plus `N` sequential GitHub calls plus `N` writes.
- `app/w/[workspaceId]/pulls/page.tsx` awaits `loadWorkspacePage`, then `syncStatus`, `listTeams`,
  `listRoster`, and `listPullRequests` in sequence. None of the last four depends on another.
- The dashboard (`app/w/[workspaceId]/page.tsx`) has the same shape.

## Goals / Non-Goals

**Goals:**

- Round trips per page render do not scale with the size of the workspace.
- A navigation produces visible feedback immediately.
- The access decision is provably unchanged — same inputs, same visible repository set.

**Non-Goals:**

- Caching rendered output or query results. The permission cache is the only cache this change
  touches, and only in how it is read.
- Making individual queries faster. They are fast; there are simply too many, taken one at a time.
- Client-side data fetching or a router change. This stays server-rendered.
- Removing the access check from the render path. It belongs there — see D3.

## Decisions

### D1 — Batch the access check into set operations, keep the decision identical

Replace the per-repository loop with:

1. one read of cached decisions for the whole repository set,
2. a concurrent, bounded resolution of the misses against GitHub,
3. one write of the newly-decided rows.

*Why*: the loop's shape is the entire cost. Nothing about deciding whether a user may read a
repository requires asking one repository at a time; it was written that way because it reads
clearly and, next to its database, cost nothing.

*Constraint*: the batched read must be keyed on the same triple the serial one was —
workspace, user, repository — and must treat "absent" and "expired" identically to `cachedDecision`.
A batched query that drops a predicate widens visibility silently, and silent over-permission is the
worst failure this codebase has. The tests carry this: a fixture where the user may read some
repositories and not others must produce the same visible set through either path.

*Consequence*: the miss path fans out to GitHub concurrently. Bound the concurrency — a workspace
with fifty repositories must not open fifty simultaneous requests, both for GitHub's sake and for
the connection budget of a serverless function.

### D2 — Concurrency at the page, not a data-loading framework

Where a page awaits independent queries, issue them with `Promise.all`. Nothing more elaborate.

*Why*: there are four such reads on the heaviest page. A loader abstraction, a request-scoped cache,
or a dataloader layer would each cost more to understand than the four `await`s cost to run in
parallel. The problem is small and the fix should stay small enough to see at a glance.

*Consequence*: a page that later grows a dependency between two of its reads must split them back
apart deliberately. That is a readable local change, not a hidden constraint.

### D3 — Feedback is a route-segment concern, not a per-component one

Add `loading.tsx` at the workspace route segments rather than wrapping individual components in
`<Suspense>`.

*Why*: the wait being fixed is the whole server render, which is what a segment-level loading file
covers. Component-level streaming would let parts of the page arrive early, which is a better
experience in principle — but it also means every page grows suspense boundaries and every boundary
is a decision about what may appear without the rest. That is a larger design question, and this
change should not be the one that answers it while the page is still making ten round trips.

*Consequence*: the whole page still arrives at once; it just says so while you wait. If per-section
streaming is wanted later, these files are not in its way.

*Alternative considered*: skip loading states and rely on the latency fix alone. Rejected — the
region fix and the batching together still leave a server round trip per navigation, and an
unacknowledged click feels broken at any duration above a couple of hundred milliseconds.

### D4 — State the round-trip property as a requirement, not a review habit

The spec gains the property that resolving access costs a bounded number of round trips regardless
of workspace size.

*Why*: this regression was not a mistake anyone made. The loop was correct, clear, and cheap where
it was written; a deployment topology changed underneath it. A requirement is what makes "does this
scale with N?" a question the next reviewer is obliged to ask, rather than one that depends on
someone happening to picture the network.

## Risks / Trade-offs

- **A batched access query drops a scoping predicate and widens visibility** → the one genuinely
  dangerous change here. Guarded by tests that compare the batched result to the serial result on a
  mixed-permission fixture, including a user with access to none of the repositories, which must
  still yield an empty set rather than everything.
- **Concurrent GitHub calls on a cache miss trip secondary rate limits** → bound the fan-out, and
  keep the existing per-installation rate limiting in the path rather than around it.
- **`Promise.all` masks which query was slow** → acceptable; the counts and timings that matter are
  visible in the platform's traces, and the number of queries is now small enough to reason about.
- **Loading states hide the remaining slowness rather than fixing it** → true, and the reason this
  change also does D1 and D2 rather than only D3. The feedback is not the fix; it is what the fix
  should have had all along.

## Migration Plan

Additive and behaviour-preserving; nothing to roll back in the database.

1. Batch the access check behind its existing signature, with the equivalence tests as the gate.
2. Parallelise the page reads.
3. Add the loading states.

Each step is independently revertable, and none changes what any page displays.

**Rollback**: revert the commits. There is no persisted state that differs.

## Open Questions

- **The right concurrency bound for the GitHub fan-out on a cache miss.** Depends on installation
  rate limits and on the largest realistic repository count in one workspace. Start low.
- **Whether `PERMISSION_CACHE_SECONDS` should rise once the miss path is cheap.** A five-minute
  lifetime was chosen when a miss cost `N` sequential GitHub calls; if a miss becomes one batched
  round trip and a bounded fan-out, the lifetime is a freshness decision rather than a cost one.
  Decide after measuring, and note that raising it lengthens the window in which revoked GitHub
  access still reads here.
