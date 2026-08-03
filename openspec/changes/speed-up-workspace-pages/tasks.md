## 1. Batch the access check

- [ ] 1.1 Replace the per-repository loop in `resolveWorkspaceAccess` (`src/auth/access.ts:126`)
      with one read of cached decisions for the whole repository set, keyed on the same
      (workspace, user, repository) triple and applying the same expiry rule as `cachedDecision`
      (D1)
- [ ] 1.2 Write newly-decided rows back in one statement rather than one per repository
- [ ] 1.3 Resolve cache misses against GitHub concurrently under a fixed bound, keeping the existing
      per-installation rate limiting inside the path
- [ ] 1.4 Keep `resolveWorkspaceAccess`'s signature and return shape unchanged, so no caller is
      touched by this
- [ ] 1.5 Tests: a mixed-permission fixture yields the same visible set through the batched path as
      through a one-at-a-time check; a user permitted none of the repositories gets an empty set;
      an all-expired cache re-resolves and returns the same set; the round trip count does not rise
      with repository count

## 2. Parallelise independent page reads

- [ ] 2.1 Issue the four independent reads on `app/w/[workspaceId]/pulls/page.tsx` (`syncStatus`,
      `listTeams`, `listRoster`, `listPullRequests`) together rather than in sequence (D2)
- [ ] 2.2 Do the same on the dashboard (`app/w/[workspaceId]/page.tsx`), teams, and the personal
      view, where the reads are genuinely independent — leave anything with a real dependency
      sequential and obvious
- [ ] 2.3 Verify no page changes what it renders: the existing page tests pass unmodified

## 3. Acknowledge navigations

- [ ] 3.1 Add `loading.tsx` to the workspace route segments under `app/w/[workspaceId]/` (D3)
- [ ] 3.2 Shape each skeleton like the page it precedes, so the transition is not a flash of
      unrelated layout
- [ ] 3.3 Confirm a click produces visible feedback before the server render completes

## 4. Verification

- [ ] 4.1 Count the database round trips for one dashboard render before and after, and record both
      — the spec's claim is that the count no longer scales with workspace size, and a number is
      what makes that checkable later
- [ ] 4.2 Measure a navigation on the deployed application before and after, with the function
      region already matched to the database (`add-vercel-drain-deployment` task 5.4), so this
      change is measured on its own rather than on top of the region fix
- [ ] 4.3 Confirm the permission cache still expires and re-resolves on schedule, and that revoking
      a user's GitHub access to a repository still removes it from their view within the cache
      lifetime
- [ ] 4.4 Run `npm run lint`, `npm run typecheck`, and `npm test`

## 5. Decisions left open

- [ ] 5.1 Set the concurrency bound for the GitHub fan-out from observed installation rate limits
      (design Open Questions)
- [ ] 5.2 Decide whether `PERMISSION_CACHE_SECONDS` should rise now that a miss is cheap, weighing
      it as a freshness question — a longer lifetime lengthens the window in which revoked GitHub
      access still reads here
