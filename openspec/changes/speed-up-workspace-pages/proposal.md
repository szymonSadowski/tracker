## Why

Every authenticated workspace page takes seconds to appear on the Vercel deployment, and clicking
anything — a repository filter, a period, a team — looks like nothing happened until it finally
swaps. The same code on a container next to its database feels instant.

Nothing changed in the code. What changed is the distance between a query and its answer.

Three things compound, and none of them is visible on Paths A and B:

- **The access check is a serial loop over repositories.** `resolveWorkspaceAccess`
  (`src/auth/access.ts:126`) reads a cached permission decision per repository, one `await` at a
  time, and on a cache miss writes each one back the same way. That is `N` sequential round trips
  before the page has read anything of its own — plus, every 300 seconds when the cache lapses,
  `N` sequential GitHub API calls.
- **The page's own reads are sequential too.** `syncStatus`, `listTeams`, `listRoster`, and
  `listPullRequests` are four independent queries awaited one after another
  (`app/w/[workspaceId]/pulls/page.tsx:57-76`).
- **There is no loading state anywhere.** No `loading.tsx`, no `<Suspense>` in the repository. In
  the App Router that means a navigation blocks silently: the browser holds the old page, renders no
  spinner, and swaps only when the server has finished everything. The wait is not just long, it is
  unacknowledged.

Roughly `N + 7` sequential round trips, then, with no feedback while they happen. At a millisecond
each this is a rounding error, which is why it survived to production. At the tens of milliseconds a
serverless function pays to reach a managed database it is seconds of blank screen per click.

Co-locating the function with the database (`add-vercel-drain-deployment` D7) is the other half of
this and lands separately. It shrinks the constant; it does not fix the pattern. A page should not
need its database to be in the next rack to feel responsive.

## What Changes

**The access check becomes two queries instead of `N`**

- Read every cached permission decision for the (workspace, user, repository set) in one statement,
  and write the misses back in one statement.
- Resolve the misses against GitHub concurrently rather than one at a time, bounded so a workspace
  with many repositories cannot open an unbounded number of connections at once.
- No change to what is decided or to the cache's lifetime — only to how many round trips deciding
  it costs. Repository visibility still mirrors GitHub, and a decision is still cached with a
  bounded lifetime.

**Independent page reads run concurrently**

- Where a page awaits several queries that do not depend on each other, issue them together.
- Applies to the workspace pages that carry the most: the dashboard, the pull request list, teams,
  and the personal view.

**Navigations acknowledge themselves**

- Add loading states to the workspace route segments, so a click produces visible feedback
  immediately rather than after the server finishes.
- The skeleton reflects the page's actual shape, so the transition is not a flash of unrelated
  layout.

**A ceiling on how bad this can get again**

- Establish that the number of database round trips a page makes does not grow with the number of
  repositories, teams, or members in a workspace. This is the property that was quietly lost; it is
  worth stating so a future loop is caught in review rather than in production.

**Not in scope**: caching rendered pages or query results beyond the existing permission cache;
changing the permission model, the cache lifetime, or what a page displays; pagination or virtual
scrolling of long lists; the function-region setting, which belongs to
`add-vercel-drain-deployment` task 5.4.

## Capabilities

### Modified Capabilities

- `auth-and-access-control`: the requirement that permission decisions are cached gains the
  companion property that resolving them costs a bounded number of round trips rather than one per
  repository. The decision itself is unchanged — this is about the cost of arriving at it, which
  the existing requirement is silent on and which turned out to matter.

### New Capabilities

None. No new surface, no new user-visible behaviour. Every page shows what it shows today, sooner.

## Impact

- **Modified**: `src/auth/access.ts` (batch the decision loop), the workspace page components under
  `app/w/[workspaceId]/` (concurrent reads), and new `loading.tsx` files beside them.
- **Schema**: none. The permission cache table is read and written differently, not reshaped.
- **Dependencies**: none added.
- **Risk**: low and contained. The access check is the one piece where a mistake matters — a batched
  query that drops a `workspace_id` or a `user_id` predicate would widen visibility, which is the
  failure this codebase most wants to avoid. It is guarded by tests asserting the batched path
  returns exactly what the serial path returned, including for a user who may read some of a
  workspace's repositories and not others.
- **Performance**: expected `N + 7` sequential round trips per page down to about three, plus
  immediate visual feedback on navigation.
- **Docs**: none required. `docs/deploy.md` already carries the region guidance this complements.
