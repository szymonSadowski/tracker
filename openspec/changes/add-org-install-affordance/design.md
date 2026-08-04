## Context

See proposal.md — Why. The relevant current state:

- Repository scope is derived wholly from the installation. `recordInstallation` upserts a
  workspace keyed by `account_node_id` (`src/workspaces/store.ts:58`), and
  `github-sync.ts:80` already maps a non-`User` account to `Organization`. An organization
  install therefore works today and produces its own workspace — nothing in the write path needs
  to change.
- The install URL the product already uses is `https://github.com/apps/<slug>/installations/new`
  (`app/dashboard/page.tsx:43`, `app/w/[workspaceId]/page.tsx:104`). GitHub's own page at that URL
  is where the target account is chosen.
- Settings only builds `https://github.com/settings/installations/<id>` once an installation
  exists (`app/w/[workspaceId]/settings/page.tsx:28`) — that page manages one account's
  repositories and cannot reach another account.
- `/dashboard` redirects unconditionally at `workspaces.length === 1`
  (`app/dashboard/page.tsx:13`), so its install call to action is unreachable for exactly the
  operator who needs it.
- The topbar renders "Switch to X" links only when a second workspace already exists
  (`app/w/[workspaceId]/layout.tsx:42`).

## Goals / Non-Goals

**Goals:**

- An owner can start an installation on another account without being told where to go by a human.
- The operator learns, before leaving, that this produces a second workspace — the outcome is
  otherwise easy to read as a failure.
- A non-owner holding one workspace can still reach an install action; settings is owner-only.

**Non-Goals:**

- Selecting repositories in-product. Repository selection stays on GitHub.
- Enumerating an organization's repositories, or calling
  `PUT /user/installations/{id}/repositories/{id}`.
- Detecting whether the App is actually installable on organizations. That is a property of the
  App registration, not of a workspace, and is not readable per-request.
- Reconciling selection changes made on GitHub outside the setup redirect — that is the webhook
  work, deliberately deferred.
- Merging two accounts' repositories into one workspace. One workspace per account is a tenancy
  invariant, not an incidental limit.

## Decisions

**D1 — The action lives in the existing "GitHub App installation" section of settings, not a new
surface.** That section already carries installation identity and the manage-repositories link, so
the two actions sit side by side and read as what they are: manage *this* account, or add
*another*. Alternative considered: a dedicated "Add an organization" page. Rejected — it would hold
one link and a paragraph, and would itself need to be discovered.

**D2 — Link to `https://github.com/apps/<slug>/installations/new`, unparameterised.** GitHub's
account chooser on that page is the correct place to pick the target, and it lists exactly the
accounts the operator may install on. Alternative considered:
`/installations/new/permissions?target_id=<org_id>` to preselect an organization. Rejected — it
requires enumerating the user's organizations through a token we would have to request and store
scope for, to save one click, and it silently fails for organizations the operator cannot install
on.

**D3 — The dashboard renders its list when asked explicitly (`/dashboard?list=1`) and keeps the
redirect otherwise.** Sign-in is the overwhelmingly common entry, and a one-workspace operator
should not click through a list of one on every visit. Making the list a deliberate destination
preserves that while satisfying the reachability requirement. Alternative considered: removing the
redirect entirely. Rejected — it taxes every sign-in to serve a rare action.

**D4 — The topbar always exposes a "Workspaces" link to `/dashboard?list=1`.** Without it D3's
destination has no entry point and is reachable only by typing a URL. The existing conditional
"Switch to X" links stay, because one click beats two for the case they cover.

**D5 — The GitHub-side preconditions are stated as static copy, not probed.** The surface names
the two conditions that hide an organization from the picker — App visibility restricted to a
single account, and lacking organization owner rights — without asserting which one applies.
Alternative considered: calling `GET /app` with the App JWT to read the registration's visibility
and show the warning conditionally. Rejected — it adds a network call to a page render to refine
advice the operator can check faster than we can.

**D6 — The new action is a plain `<a target="_blank" rel="noreferrer">`, matching the
manage-repositories link beside it** (`settings/page.tsx:53`), rather than the `next/link` that
`ColdStart` uses for its action. The destination is external and the operator is expected to come
back; both neighbours in that section already behave this way.

**D7 — Absent `GITHUB_APP_SLUG`, the section renders the explanation without a link.** This
mirrors what the dashboard and workspace cold starts already do, and keeps the surface from
offering a destination it cannot build.

## Risks / Trade-offs

- **Copy describing GitHub's own UI drifts as GitHub changes it.** → State conditions ("the App
  must be installable on any account"), not click paths ("click Advanced, then…"), so the text
  stays true across GitHub redesigns. Point at `docs/github-app.md` for the setting itself.
- **The operator installs on the organization and lands in a workspace with no data yet.** →
  The new workspace's surfaces already render cold-start states while the backfill runs
  (`app/w/[workspaceId]/page.tsx:95`); no new handling is needed, but the disclosure copy should
  say a new workspace appears rather than implying repositories arrive in the current one.
- **`?list=1` is an unguessable URL.** → D4 gives it a permanent entry point; the query parameter
  is an implementation detail of the redirect, never something an operator types.
- **A second topbar link on a bar that already holds up to seven.** → Accepted. The alternative,
  hiding workspace navigation until a second workspace exists, is the bug being fixed.

## Migration Plan

No schema, job, or API change; nothing to migrate. Deployment is the two page edits, the layout
link, and the docs section. Rollback is a revert — no state is written that a rollback would
strand, and any organization workspace created while it was deployed keeps working, since the
installation path it used is the one that already existed.
