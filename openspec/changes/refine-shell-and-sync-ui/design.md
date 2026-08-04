## Context

See proposal.md — Why. The state that shapes the approach:

- The brand slot renders `workspace?.accountLogin ?? 'Tracker'`
  (`app/w/[workspaceId]/layout.tsx:31`), so the product name only ever appears as a fallback when
  the workspace read fails. `.brand` is three declarations (`globals.css:90`).
- `app/layout.tsx` sets `metadata.title` but no icon, and there is no `app/icon.*` file, so Next
  emits no icon link.
- `.button` carries `margin-top: 0.75rem` (`globals.css:248`). `.inline-form` is a flex row with
  `align-items: center` (`globals.css:346`), which centres each item's *margin box* — so a button
  with top margin and no bottom margin lands half that margin below the row's centre. Every
  screenshot shows the same ~6px offset from the same rule.
- `.stack` already spaces its children with `gap: 0.75rem` (`globals.css:361`), so inside a stack
  the button's own margin is additive and unwanted — `sync-now.tsx` sits in exactly that case.
- The two sync controls are separate `Section`s in `settings/page.tsx:63` and `:71`. The endpoints
  behind them are unrelated in shape: `/sync` takes no body and is debounced
  (`ingest/incremental.ts`), `/history-sync` takes `{ from }` and reports per repository
  (`ingest/history.ts`). Only their presentation is merging.

## Goals / Non-Goals

**Goals:**

- One rule change fixes button alignment everywhere, rather than per-surface patches.
- The wordmark is real text, so the accessible name and the link target are unchanged.
- The sync surface answers "which one do I want?" without the operator opening the docs.

**Non-Goals:**

- Redesigning the topbar's navigation, or introducing an icon mark beside the wordmark. The
  favicon is a mark; the topbar stays typographic.
- Any change to sync behaviour, debounce windows, endpoint contracts, or the outcome payloads.
- A general design-token system. This adds the two brand greens it needs and no more.
- Changing the workspace switcher.

## Decisions

**D1 — The wordmark is letter-spaced uppercase text with a gradient fill, keeping a solid-colour
fallback.** `background-clip: text` with a transparent fill, preceded by `color: var(--accent)`, so
a browser that does not apply the clip renders solid green rather than invisible text. The element
keeps its text content, so nothing about the link's accessible name changes.

```css
.brand {
  letter-spacing: 0.14em;
  color: var(--accent);          /* fallback — must precede the clip */
  background: linear-gradient(95deg, var(--brand-from), var(--brand-to));
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

Alternative considered: an inline SVG wordmark. Rejected — it would need an `aria-label` to carry
the name it already spells, and would not inherit the type scale.

**D2 — The two greens become tokens (`--brand-from`, `--brand-to`) beside `--accent`.** The
gradient's dark end is the existing `--accent` (`#2f5d50`); the light end is a brighter green of
the same family. Hardcoding them at the use site would let the wordmark and the favicon drift
apart from the accent that the buttons and the active-tab underline already use.

**D3 — The gradient's light end stays dark enough to read, and the contrast exemption is
deliberate.** WCAG 1.4.3 exempts text that is part of a brand name, which is what this is — but a
wordmark that dissolves into the background is still a defect. The light end is chosen to stay
legible against `--bg` (`#fbfbfa`) on its own, so the exemption is never load-bearing.

**D4 — The favicon is a static `app/icon.svg`, not a generated `app/icon.tsx`.** Next's file
convention picks it up and emits the link tag with no code, no `next/og` dependency, and no
per-request render. Alternative considered: `ImageResponse` in `app/icon.tsx`. Rejected — it adds
a runtime dependency and a render path to produce a shape that never varies.

**D5 — The favicon's gradient duplicates the two hex values as an SVG `linearGradient`.** An SVG
served as a file cannot read the stylesheet's custom properties. The duplication is real and
unavoidable; it is confined to one file and carries a comment naming `--brand-from` /
`--brand-to` as its source of truth, so a future colour change has a visible second site.

**D6 — `margin-top` is removed from `.button` and reapplied only where a button stands alone.**
The rule is the defect: it applies spacing meant for a standalone call to action to every button
in the product, including those inside centred rows. It is reapplied scoped to `.coldstart .button`,
which is the standalone case that genuinely wants it. Every other current use is either inside an
`.inline-form` row (where it is the bug) or inside a `.stack` (where `gap` already provides the
spacing and the margin was double-counting). Alternative considered: `align-self: center` on
buttons inside rows. Rejected — it treats the symptom and leaves the bad rule in place to
resurface on the next row that is built.

**D7 — One "Sync" section, two rows, each naming its direction.** The rows share a layout class
carrying label, control, and a one-line explanation. The first row fetches what changed since the
last sync and completes promptly; the second walks backwards and may run for hours. The existing
`HistorySyncControl` radio group and date input stay, laid out within the second row.

**D8 — The labels become "Sync recent" and "Sync older".** They are parallel, each names a
direction in time, and neither needs the other to be understood — which is what the spec requires
of the labels read alone. Alternatives considered: "Sync now" / "Sync history" (the current pair —
"now" and "history" name a *time of request* and a *kind of data*, which is why they read as
duplicates); "Update" / "Load older" (loses the shared verb that marks them as two shapes of one
operation).

**D9 — Each row keeps its own outcome notice, rendered beneath the row that produced it.** The two
responses have different shapes — one sentence versus a per-repository list — and a shared notice
slot would leave the operator guessing which request an outcome answered.

## Risks / Trade-offs

- **Removing a product-wide rule changes surfaces no screenshot covered.** → Treat it as a visual
  audit, not an edit: walk every surface carrying a button (dashboard, cold starts, settings,
  teams, pulls, people) before calling it done. The failure mode is cramped spacing, which is
  visible immediately.
- **The gradient wordmark can render invisible if `background-clip: text` is applied but the fill
  is not.** → The fallback `color` is declared first, and the check is "does the wordmark read
  with the gradient declarations removed", which is directly testable in a browser.
- **Renaming the buttons invalidates three documents** that name **Sync now** by label
  (`docs/deploy.md:460`, `docs/architecture.md:236`, `docs/runbook.md:39`). → Update all three in
  the same change; a runbook that names a button that no longer exists is worse than the old
  label.
- **Two colour definitions for one gradient** (D5). → Accepted, with the comment as mitigation.
  The alternative is generating the icon at runtime, which costs more than the duplication does.

## Migration Plan

Presentation only — no schema, endpoint, job, or payload change, so nothing to migrate and no
state a rollback could strand. Deployment is the stylesheet, the shell markup, the new icon file,
the settings surface, and the three documentation references. Rollback is a revert.
