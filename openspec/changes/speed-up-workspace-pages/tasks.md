## 1. Batch the access check

- [x] 1.1 Replace the per-repository loop in `resolveWorkspaceAccess` (`src/auth/access.ts:126`)
      with one read of cached decisions for the whole repository set, keyed on the same
      (workspace, user, repository) triple and applying the same expiry rule as `cachedDecision`
      (D1)
- [x] 1.2 Write newly-decided rows back in one statement rather than one per repository
- [x] 1.3 Resolve cache misses against GitHub concurrently under a fixed bound, keeping the existing
      per-installation rate limiting inside the path
- [x] 1.4 Keep `resolveWorkspaceAccess`'s signature and return shape unchanged, so no caller is
      touched by this
- [x] 1.5 Tests: a mixed-permission fixture yields the same visible set through the batched path as
      through a one-at-a-time check; a user permitted none of the repositories gets an empty set;
      an all-expired cache re-resolves and returns the same set; the round trip count does not rise
      with repository count

## 2. Parallelise independent page reads

- [x] 2.1 Issue the four independent reads on `app/w/[workspaceId]/pulls/page.tsx` (`syncStatus`,
      `listTeams`, `listRoster`, `listPullRequests`) together rather than in sequence (D2)
- [x] 2.2 Do the same on the dashboard (`app/w/[workspaceId]/page.tsx`), teams, and the personal
      view, where the reads are genuinely independent — leave anything with a real dependency
      sequential and obvious
- [x] 2.3 Verify no page changes what it renders: the existing page tests pass unmodified

## 3. Acknowledge navigations

- [x] 3.1 Add `loading.tsx` to the workspace route segments under `app/w/[workspaceId]/` (D3) —
      dashboard, pulls, me, teams, settings, and people/[contributorId]
- [x] 3.2 Shape each skeleton like the page it precedes, so the transition is not a flash of
      unrelated layout — shared pieces in `src/ui/skeletons.tsx`, styles in `app/globals.css`
      (animation dropped under `prefers-reduced-motion`)
- [x] 3.3 Confirm a click produces visible feedback before the server render completes — on a cold
      dashboard render the skeleton is in the stream at byte ~1.5k and React's replacement marker
      only at ~66.8k; every segment's fallback appears in its own stream, which is the same
      boundary the router renders on a client navigation

## 4. Verification

- [x] 4.1 Count the database round trips for one dashboard render before and after, and record both
      — the spec's claim is that the count no longer scales with workspace size, and a number is
      what makes that checkable later. Measured with a counting `Database` wrapper:

      | repositories | access before | access after | access after, all expired | page reads | total before | total after |
      | ------------ | ------------- | ------------ | ------------------------- | ---------- | ------------ | ----------- |
      | 1            | 3             | 3            | 4                         | 7          | 10           | 10          |
      | 10           | 12            | 3            | 4                         | 7          | 19           | 10          |
      | 40           | 42            | 3            | 4                         | 7          | 49           | 10          |

      The page's own reads are unchanged in count — parallel, not fewer — so the whole difference
      is the access check, which is now flat. `tests/auth/access.test.ts` keeps the flatness
      asserted ("costs the same number of round trips for one repository as for many").
- [ ] 4.2 Measure a navigation on the deployed application before and after, with the function
      region already matched to the database (`add-vercel-drain-deployment` task 5.4), so this
      change is measured on its own rather than on top of the region fix
      — **not done**: needs the region fix deployed and a before/after run against production.
- [x] 4.3 Confirm the permission cache still expires and re-resolves on schedule, and that revoking
      a user's GitHub access to a repository still removes it from their view within the cache
      lifetime — covered by "stops showing a repository once GitHub revokes access and the cache
      expires", "re-resolves an entirely expired cache and returns the same set", and "answers
      repeated checks from cache, and re-asks after an installation change"
- [x] 4.4 Run `npm run lint`, `npm run typecheck`, and `npm test` — all clean; 210 passed, 1 skipped

## 5. Decisions left open

- [x] 5.1 Set the concurrency bound for the GitHub fan-out from observed installation rate limits
      (design Open Questions) — `PERMISSION_CHECK_CONCURRENCY = 5` in `src/auth/access.ts`. These
      are user-token reads (5000/hour per user, and GitHub's secondary limit is documented at no
      more than 100 concurrent requests), so 5 is well inside both: the largest workspace here has
      40 repositories, which is 8 waves on a full miss. Retry-after and rate limit accounting stay
      inside the path, in `githubRequest`, so each call still backs off on its own.
- [x] 5.2 Decide whether `PERMISSION_CACHE_SECONDS` should rise now that a miss is cheap, weighing
      it as a freshness question — a longer lifetime lengthens the window in which revoked GitHub
      access still reads here. **Left at 300.** A miss now costs one read, a bounded fan-out, and
      one write, so cost no longer argues for a long lifetime; what remains is only the revocation
      window, and shorter is better there.
