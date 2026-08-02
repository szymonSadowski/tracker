## Why

Connecting a GitHub account only brings in the last 90 days of pull requests (`BACKFILL_WINDOW_DAYS`),
so workspaces open with almost no history and metrics have nothing to trend against. Members also
have no way to act on either problem from the product: deepening history is impossible at any price,
and refreshing current data means waiting out the 15-minute sync cadence even though an on-demand
sync endpoint already exists behind no UI.

## What Changes

- Members can request a **history sync** for a workspace over a chosen range — the repository's
  full history, or a specific start date — which pages backwards beyond whatever has already been
  ingested rather than re-fetching what is present.
- Repositories already backfilled under the bounded window can be **deepened** by that same request:
  the existing 90-day data stays, and only the older gap is fetched. Existing installations reach
  full history without being removed and re-added.
- A history sync reports progress per repository (requested range, how far back it has reached,
  whether it is still running) and is safe to interrupt and resume, like the existing backfill.
- Members can trigger an **immediate incremental sync** from the workspace UI, wired to the
  on-demand endpoint that already exists, with the debounce window surfaced rather than silently
  swallowing the request.
- A repository's backfill state stops meaning "the last 90 days are present" and starts recording
  *how far back* coverage actually extends, so surfaces can distinguish "no PRs in that period"
  from "not synced that far back".

## Capabilities

### New Capabilities

None. Both features extend behavior already owned by `github-data-sync`, and the controls
themselves are surfaces over that capability rather than a new one.

### Modified Capabilities

- `github-data-sync`: the backfill requirement stops being a fixed bounded window and gains a
  member-requested range (including unbounded); a new requirement covers deepening coverage of an
  already-backfilled repository without refetching or duplicating; sync-state observability extends
  to reporting coverage depth and history-sync progress; the on-demand sync requirement gains the
  member-visible outcome (enqueued vs. debounced).
- `analytics-dashboard`: surfaces must distinguish a genuinely empty period from one outside the
  synced range, so charts and metrics do not read as zero where data was simply never fetched.

## Impact

- **Ingest**: `src/ingest/backfill.ts` — window edge becomes a requested range with an unbounded
  case; paging must continue past the current stop condition and record how far back it reached.
- **Config**: `src/config/env.ts` — `BACKFILL_WINDOW_DAYS` becomes the default for automatic
  backfill only, not a ceiling on requested syncs.
- **Jobs**: `src/jobs/types.ts` — `repository.backfill` payload carries a requested range; a
  deepening pass needs its own cursor, since the existing `backfill_cursor` tracks a forward page
  walk that has already completed.
- **Storage**: `src/repositories/store.ts` and a migration — repositories need coverage-depth and
  history-sync progress columns alongside `backfill_state` / `backfill_window_start`.
- **API**: new history-sync route under `app/api/workspaces/[workspaceId]/`; existing
  `app/api/workspaces/[workspaceId]/sync/route.ts` gains a client caller, and its
  `{ enqueued, debounced }` result becomes user-visible.
- **UI**: `app/w/[workspaceId]/settings/page.tsx` and `src/ui/components.tsx` — two controls plus
  per-repository coverage and progress display; both need client interactivity in what is currently
  a server component.
- **Rate limits**: a full-history backfill across an org is far more API traffic than a 90-day one;
  it must run under the existing `RATE_LIMIT_SAFETY_THRESHOLD` pause-and-resume path and must not
  starve incremental sync of quota.
