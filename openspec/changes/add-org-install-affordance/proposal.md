## Why

A GitHub App installation targets exactly one account, so an operator who installed on their
personal account sees only personal repositories in GitHub's repository picker and has no way to
reach organization repositories. Adding an organization requires a second installation on the
organization account, but the product offers no path to start one: settings links only to managing
the installation that already exists, and the dashboard — the only surface carrying an install
call to action — redirects away as soon as the operator has one workspace.

## What Changes

- Settings gains a persistent action to install the App on another GitHub account, alongside the
  existing "Manage repositories on GitHub" link, so a second installation can be started from a
  workspace that already has one.
- The dashboard stops being a dead end for single-workspace operators: it remains reachable and
  keeps its install call to action rather than redirecting unconditionally.
- Both surfaces state the consequence before the operator leaves: installing on an organization
  creates a separate workspace, it does not add repositories to the current one.
- Settings names the two GitHub-side preconditions that silently hide an organization from the
  install picker — App visibility set to "Any account", and organization owner rights or the
  organization's approval flow.
- `docs/github-app.md` records the visibility setting as part of App creation, so a newly created
  App is installable on organizations from the start.

## Capabilities

### New Capabilities

None. This change adds no capability; it makes an existing one reachable.

### Modified Capabilities

- `github-app-installation`: adds a requirement that the product offers a path to install on an
  additional account from within an existing workspace, and discloses that a new account yields a
  new workspace.
- `tenancy-and-teams`: adds a requirement that an operator holding exactly one workspace can still
  reach the surface that creates another.

## Impact

- `app/w/[workspaceId]/settings/page.tsx` — new install-on-another-account action and the
  precondition copy.
- `app/dashboard/page.tsx` — the single-workspace redirect becomes conditional so the install call
  to action stays reachable.
- `docs/github-app.md` — App visibility step.
- No database, API, job, or sync changes. `recordInstallation` and `reconcileRepositoriesIn`
  already handle organization accounts and one-workspace-per-account; the workspace switcher in
  `app/w/[workspaceId]/layout.tsx` already appears once a second workspace exists.
- Requires `GITHUB_APP_SLUG` to be configured, as the existing install links already do; surfaces
  degrade to explanatory copy without it.
