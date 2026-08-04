## 1. Brand tokens and wordmark

- [x] 1.1 Add `--brand-from` (the existing accent `#2f5d50`) and `--brand-to` (a brighter green of
      the same family) to `:root` in `app/globals.css`, beside `--accent` (D2).
- [x] 1.2 Check `--brand-to` reads legibly against `--bg` on its own, so the wordmark never relies
      on the brand-name contrast exemption to be readable (D3). Darken it if it does not.
- [x] 1.3 Rewrite `.brand` per D1: uppercase letter-spacing, `color: var(--accent)` declared
      first as the fallback, then the gradient with `background-clip: text` and a transparent
      fill.
- [x] 1.4 In `app/w/[workspaceId]/layout.tsx`, make the brand link render the literal text
      `TRACKER` instead of `workspace?.accountLogin ?? 'Tracker'`, keeping its `href` on the
      workspace root (spec: "The product identifies itself in its chrome").
- [x] 1.5 Render the workspace login beside the wordmark as muted secondary text, sourced from the
      `workspace` already read in the layout — no extra query (spec: "The workspace in view is
      named in the chrome"). Handle the undefined-workspace case without printing "undefined".
- [x] 1.6 Verify the wordmark still reads as solid green with the three gradient declarations
      commented out, confirming the fallback (D1 risk).

## 2. Favicon

- [x] 2.1 Create `app/icon.svg`: a `T` mark filled with an SVG `linearGradient` using the same two
      hex values as `--brand-from` / `--brand-to` (D4, D5).
- [x] 2.2 Add a comment in `app/icon.svg` naming `--brand-from` / `--brand-to` in
      `app/globals.css` as the source of truth for those two values (D5).
- [x] 2.3 Confirm the mark is legible at 16px, not just at full size — a `T` with a thin stem
      disappears at favicon scale.
- [x] 2.4 Load any surface and confirm Next emits the icon link and the tab shows the mark (spec:
      "The product is identifiable in the browser tab").

## 3. Button alignment

- [x] 3.1 Remove `margin-top: 0.75rem` from `.button` in `app/globals.css` (D6).
- [x] 3.2 Add `.coldstart .button { margin-top: 0.75rem; }` to restore spacing for the standalone
      call-to-action case (D6).
- [x] 3.3 Confirm the four reported rows now align on their centre line: team creation
      (`teams/page.tsx:30`), team rename (`:57`), contributor team assignment (`:113`), and the
      history control (`settings/history-sync.tsx:67`).
- [x] 3.4 Audit every remaining surface carrying a button — dashboard, workspace cold starts,
      settings, pulls, people, sign-in — for spacing that was silently depending on the removed
      margin (D6 risk).
- [x] 3.5 Check the topbar sign-out button, which sits in an `.inline-form` and was subject to the
      same offset.

## 4. One sync section

- [x] 4.1 In `app/w/[workspaceId]/settings/page.tsx`, merge the "Sync" and "History" sections into
      a single `Section title="Sync"` holding both controls (D7).
- [x] 4.2 Write the section's one-line framing: the two requests differ in direction along the
      timeline, not in what they fetch (spec: "The two sync requests are presented together and
      distinguished by direction").
- [x] 4.3 Add a row layout class to `app/globals.css` carrying label, control, and a one-line
      explanation per row, reusing the existing `.inline-form` for the controls themselves.
- [x] 4.4 Relabel the on-demand button to **Sync recent** in `sync-now.tsx`, with a one-line
      description: fetches what changed since the last sync (D8).
- [x] 4.5 Relabel the history button to **Sync older** in `history-sync.tsx`, and shorten its
      description — keep that it may run for hours and continues after the page is closed, drop
      the rest (D8, spec: "An owner weighs the cost of each request").
- [x] 4.6 Lay the radio group and date input out within the "Sync older" row rather than as a
      free-standing inline form (D7).
- [x] 4.7 Keep each control's outcome notice beneath its own row (D9); confirm both still render
      their success, already-covered, debounced, and error states.

## 5. Documentation

- [x] 5.1 Update the three references to the old button label: `docs/deploy.md:460`,
      `docs/architecture.md:236`, `docs/runbook.md:39`.

## 6. Verification

- [x] 6.1 Run `npm run lint` and `npm test`.
- [x] 6.2 Walk the app: topbar wordmark and workspace name on two workspaces, favicon in the tab,
      every button row aligned, and both sync requests exercised end to end from the merged
      section.
