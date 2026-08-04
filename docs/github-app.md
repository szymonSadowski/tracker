# Registering the GitHub App

The product connects to GitHub through a GitHub App installed on a customer account with a
**selected-repositories** grant. Nothing here requires an all-repositories installation.

## 1. Create the App

GitHub → *Settings* → *Developer settings* → *GitHub Apps* → **New GitHub App**.

| Field | Value |
| --- | --- |
| GitHub App name | `Tracker` (any unique name; note the slug it produces) |
| Homepage URL | `https://<your-host>` |
| Callback URL | `https://<your-host>/api/auth/github/callback` |
| Expire user authorization tokens | **disabled** — see below |
| Request user authorization (OAuth) during installation | **disabled** — see below |
| Setup URL | `https://<your-host>/api/github/setup` |
| Redirect on update | **enabled** — so repository-selection changes come back to us |
| Webhook | **inactive** for this release (see design.md D3) |
| Where can this GitHub App be installed? | **Any account** if the App will ever be installed on an organization |

The install-target setting is quiet about its consequence: an App left at *Only on this account*
still installs fine on the account that owns it, and organizations are simply absent from the
account chooser at install time — with no error explaining why. Choose **Any account** up front
unless you are certain the App will only ever serve its owner's personal repositories.

Two more are easy to get wrong, and GitHub's form does not explain either:

- **OAuth during installation must stay off**, because GitHub disables the Setup URL field when it
  is on ("Unavailable when requesting OAuth during installation") and sends the installation back
  to the Callback URL instead. This release keeps the two callbacks separate: sign-in at
  `/api/auth/github/callback`, installation at `/api/github/setup`. With the box off, an
  installation lands on the setup route, which bounces an unauthenticated installer through
  sign-in and back — one extra redirect, same result.
- **Expiring user authorization tokens must stay off** until refresh handling exists. The user's
  OAuth token is stored on the session and used for repository permission checks; with expiry on,
  GitHub issues an 8-hour token plus a `refresh_token`, and nothing here redeems that refresh
  token yet.

### Repository permissions

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read-only | mandatory; `/installation/repositories` and the per-user `/repos/{owner}/{repo}` visibility check |
| Pull requests | Read-only | `/pulls`, `/pulls/{n}`, `/pulls/{n}/reviews`, and the GraphQL backfill query |
| Contents | Read-only | `/pulls/{n}/commits` and GraphQL commit objects — metadata and diff statistics only |
| Issues | Read-only | `/issues/{n}/timeline`, which supplies ready-for-review, draft conversions, and force pushes to the REST sync path |

No organization permissions, no account permissions, and no write access anywhere. The App reads
no file contents — only diff statistics (design.md non-goals).

The Issues permission is the surprising one: GitHub files the timeline endpoint under Issues even
when the issue in question is a pull request. If a permission is missing, GitHub answers 403,
which the worker reads as rejected credentials and marks the installation **needs attention** —
so check `installations.status_reason` before assuming the App key is wrong.

Users authorize with the `read:user` scope during sign-in so we can identify them; repository
visibility is then resolved against GitHub per repository.

## 2. Collect the credentials

After creating the App:

- **App ID** → `GITHUB_APP_ID`
- **Client ID** → `GITHUB_OAUTH_CLIENT_ID`
- **Client secret** (generate) → `GITHUB_OAUTH_CLIENT_SECRET`
- **Private key** (generate; downloads a `.pem`) → `GITHUB_APP_PRIVATE_KEY`, either the PEM text
  or the same file base64-encoded (`base64 -i key.pem`)
- **App slug** from the public page URL → `GITHUB_APP_SLUG` (used to build the install link)

Copy `.env.example` to `.env` and fill these in.

## 3. Install it

Visit `https://github.com/apps/<slug>/installations/new`, choose the account, and select the
repositories to track. GitHub redirects to the Setup URL with `installation_id`, at which point
the product creates the workspace, records the selected repositories, makes the installing user
an owner, and enqueues a backfill per repository.

Changing the selection later (GitHub → the installation's *Configure* page) redirects back to the
same URL; added repositories are backfilled, removed ones stop syncing and keep their data.

An installation covers exactly one account, so an organization's repositories require a separate
installation on that organization — which yields its own workspace, rather than adding repositories
to an existing one. Start it from a workspace's *Settings* → *GitHub App installation*, or from the
workspace list. Installing on an organization needs owner rights there (or approval from an owner),
and the App's install-target setting from section 1 must be **Any account**.

## 4. Local development

```bash
docker compose up -d db
npm run db:migrate
npm run dev       # web
npm run worker    # sync and analysis jobs
npm run scheduler # enqueues the periodic sync
```

For a local install, GitHub must be able to reach the Setup URL, so expose port 3000 through a
tunnel and set `APP_BASE_URL` (and the App's Callback/Setup URLs) to the tunnel hostname.

## Rate limits

An installation token is limited per hour based on the size of the installation. Backfill is the
expensive path: it is chunked, records progress after each page, and pauses when the remaining
quota falls below `RATE_LIMIT_SAFETY_THRESHOLD`, resuming after the reset. Nothing is lost when it
pauses — the next run resumes at the recorded cursor.
