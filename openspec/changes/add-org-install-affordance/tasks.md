## 1. Settings: install on another account

- [x] 1.1 In `app/w/[workspaceId]/settings/page.tsx`, build the install-on-another-account URL from
      `loadConfig().github.appSlug` as `https://github.com/apps/<slug>/installations/new`, kept
      separate from the existing `configureUrl` so the two links never collapse into one when an
      installation is absent (D2).
- [x] 1.2 Render the action inside the existing "GitHub App installation" `Section`, below the
      manage-repositories link, as a plain `<a target="_blank" rel="noreferrer">` matching its
      neighbour rather than a `next/link` (D1, D6).
- [x] 1.3 Add the disclosure copy above the action: installing on another account creates a
      separate workspace and does not add repositories to this one (spec: "The consequence of
      installing on another account is disclosed").
- [x] 1.4 Add the precondition copy naming the two conditions that hide an organization from
      GitHub's install picker — the App being installable on one account only, and lacking
      organization owner rights — stated as conditions, not click paths (D5).
- [x] 1.5 When `appSlug` is unset, render the explanation and preconditions with no link, matching
      how the dashboard and workspace cold starts already degrade (D7, spec: "The App slug is not
      configured").
- [x] 1.6 Verify the section renders correctly in all three states: installation present, absent,
      and `GITHUB_APP_SLUG` unset.

## 2. Dashboard: keep the workspace list reachable

- [x] 2.1 In `app/dashboard/page.tsx`, make the `workspaces.length === 1` redirect conditional on
      the absence of an explicit list request (`?list=1`), leaving the zero-workspace and
      multi-workspace paths as they are (D3).
- [x] 2.2 Render the workspace list for a single-workspace user when the list is requested,
      reusing the existing list markup rather than adding a second layout.
- [x] 2.3 Show the install call to action beneath the list on every rendered list, not only on the
      empty state, so a member who owns no workspace settings can still reach it (spec:
      "Creating an additional workspace stays reachable").
- [x] 2.4 Confirm the default `/dashboard` entry still redirects straight through for a
      single-workspace user, so sign-in gains no extra click.

## 3. Topbar entry point

- [x] 3.1 In `app/w/[workspaceId]/layout.tsx`, add a permanent "Workspaces" link to
      `/dashboard?list=1`, leaving the existing conditional "Switch to X" links in place (D4).
- [x] 3.2 Check the topbar with one workspace and with two — the new link is present in both, and
      the switch links still appear only in the second.

## 4. Documentation

- [x] 4.1 In `docs/github-app.md` section 1, record the "Where can this GitHub App be installed?"
      setting: choose **Any account** if the App will ever be installed on an organization, and
      note that a single-account App silently omits organizations from the install picker.
- [x] 4.2 In section 3, state that an installation covers one account and that organization
      repositories require a separate installation on the organization, which yields its own
      workspace.

## 5. Verification

- [x] 5.1 Add a case to `tests/installations/lifecycle.test.ts` covering the spec scenario "An
      owner installs on an organization while holding a personal workspace": record a personal
      installation, then an organization one for the same installing user, and assert two
      workspaces exist, the user owns both, and the personal workspace's repository scope is
      unchanged.
- [x] 5.2 Run `npm run lint` and `npm test`.
- [ ] 5.3 Walk the flow manually against a real App: from a personal workspace's settings, follow
      the new action, install on an organization, and confirm the setup callback lands on the new
      organization workspace with its repositories in scope and the topbar offering both.
