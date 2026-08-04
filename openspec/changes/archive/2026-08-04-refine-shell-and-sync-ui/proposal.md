## Why

The application chrome does not identify the product. The topbar's brand slot renders the
workspace's GitHub login, so the product reads as "szymonSadowski", and the browser tab carries no
icon at all. Separately, every button in the product sits a few pixels below the control it is
paired with, because `.button` carries an unconditional top margin that a centred flex row honours
as part of the item's margin box — visible on team creation, team rename, contributor assignment,
and the history control. And the settings surface presents two sync actions in two sections
without ever saying that one pulls data forward from the last sync and the other walks backward
into the past, leaving the operator to guess which button they want.

## What Changes

- The topbar brand becomes the product wordmark **TRACKER**, letter-spaced, filled with a green
  gradient, and still linking to the workspace root.
- The workspace's GitHub login moves beside the wordmark as muted secondary text, so the operator
  can still tell which workspace they are in — which matters more once a second workspace exists.
- The product gains a favicon: a **T** mark in the same green, shown in the browser tab.
- `.button` loses its unconditional top margin; standalone spacing is applied where it is actually
  wanted rather than to every button in the product. Buttons paired with an input, a select, or a
  radio group align on their shared centre line.
- The settings surface merges its "Sync" and "History" sections into one, presenting the two
  requests as two rows of one control: bring data up to date, and load older history. Each row
  states its direction and the labels are shortened.

## Capabilities

### New Capabilities

- `product-shell`: the application chrome — product identity in the topbar and browser tab,
  workspace orientation within it, and the alignment contract for a control paired with a button.

### Modified Capabilities

- `github-data-sync`: adds a requirement that the two sync requests are presented as one surface
  and that each states which direction in time it moves, so they are not read as duplicates.

## Impact

- `app/globals.css` — `.button` margin, brand styling, the gradient wordmark, and the sync row
  layout.
- `app/w/[workspaceId]/layout.tsx` — brand markup and the workspace login beside it.
- `app/icon.svg` (new) — the favicon mark, picked up by Next's file convention.
- `app/w/[workspaceId]/settings/page.tsx` — the two sync sections become one.
- `app/w/[workspaceId]/settings/history-sync.tsx`, `sync-now.tsx` — labels and row layout.
- No database, API, job, or sync-behaviour changes; both endpoints keep their current contracts.
- The `.button` margin removal is product-wide, so every surface carrying a button is touched
  visually even where no file changes.
