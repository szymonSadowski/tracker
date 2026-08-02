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
| Request user authorization (OAuth) during installation | **enabled** |
| Setup URL | `https://<your-host>/api/github/setup` |
| Redirect on update | **enabled** — so repository-selection changes come back to us |
| Webhook | **inactive** for this release (see design.md D3) |

### Repository permissions

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read-only | commit metadata on a pull request |
| Metadata | Read-only | mandatory; repository identity, names, visibility |
| Pull requests | Read-only | pull requests, reviews, review comments, timeline events |

No organization permissions and no account permissions are needed. The App reads no file
contents — only diff statistics (design.md non-goals).

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
