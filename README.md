# Moviwatch

A lightweight movie catalogue and streaming backend built with Cloudflare Workers, Neon PostgreSQL, and Upstash Redis.

## Features
- Public movie catalogue; visitors browse and play without accounts or passwords.
- Password-protected admin dashboard at `/admin`.
- Exactly one application table: `movies`. Multiple video options are stored in one JSONB array.
- Action and Romantic categories, poster URLs, publish/unpublish, create/edit/delete, search and filtering.
- Google Drive public-link proxy with HTTP Range forwarding for video seeking.
- Upstash Redis provides short-lived catalogue caching and login rate limiting.
- Admin secrets stay in Worker Secrets. Google OAuth Client ID/Secret is not needed for public Drive share links.

## Database and Redis
1. Create a Neon project and run [schema.sql](./schema.sql) in the Neon SQL Editor.
2. Use Neon's pooled connection string as `DATABASE_URL`.
3. Create an Upstash Redis database and note its REST URL and token.

## Local setup
Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run hash:password
```

Use a random passphrase with at least 20 characters. Add the generated `ADMIN_PASSWORD_HASH` and `ADMIN_PASSWORD_PEPPER` values to `.dev.vars`; then fill the Neon and Redis values. Create a random `JWT_SECRET` of at least 32 characters.

```bash
npm run dev
```

Open `http://localhost:8787/` for the public catalogue and `http://localhost:8787/admin` for the admin login.

## Cloudflare deployment
For manual deployment with Wrangler:

```bash
npx wrangler login
npx wrangler secret put DATABASE_URL
npx wrangler secret put REDIS_REST_URL
npx wrangler secret put REDIS_REST_TOKEN
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put ADMIN_PASSWORD_PEPPER
npx wrangler secret put JWT_SECRET
npm run deploy
```

### Deploy through GitHub Actions
The workflow at `.github/workflows/deploy.yml` can deploy the Worker when manually started from the **Actions** tab. Before running it, add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — permission to edit Workers Scripts and read the account
- `CLOUDFLARE_ACCOUNT_ID`
- `DATABASE_URL`
- `REDIS_REST_URL`
- `REDIS_REST_TOKEN`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_PASSWORD_PEPPER`
- `JWT_SECRET`

The workflow installs dependencies, checks JavaScript syntax, uploads runtime secrets to Cloudflare, and deploys the Worker plus static assets. A successful GitHub commit is not proof of deployment: verify a green Actions run and visit `/api/health`.

## API
| Method | Route | Access |
|---|---|---|
| GET | `/api/health` | Public health check |
| POST | `/api/auth/login` | Admin password |
| POST | `/api/auth/logout` | Session cookie |
| GET | `/api/auth/me` | Session status |
| GET | `/api/movies?q=&category=` | Public catalogue |
| GET/HEAD | `/api/watch/:movieId/:optionIndex` | Public Range-aware stream |
| GET | `/api/admin/movies` | Admin |
| POST/PUT/DELETE | `/api/admin/movies[/:id]` | Admin |
| GET | `/api/admin/stats` | Admin |

## Google Drive quota note
A Cloudflare Worker proxy does **not** bypass Google's Drive bandwidth limits, view/download restrictions, or API quotas. The Worker forwards Range requests and keeps original Drive URLs out of the public catalogue response, but video bytes still come from Drive. For reliable high-volume streaming, use media storage/CDN (such as Cloudflare R2) and distribute only content you have rights to share.

## Security and scope
- Only directly playable public Google Drive links are supported. Drive interstitials, permissions, or quota restrictions can still block playback.
- The admin password verifier, pepper, JWT secret, Neon URL, and Redis token must be configured as Worker secrets, never committed.
- A keyed HMAC verifier is used instead of a high-iteration password KDF to fit Workers Free CPU limits; use a long random password and keep the pepper secret.
- This is a focused implementation, not a complete copy of Haru Stream: OAuth Drive sync, folder management, subtitle rendering, uploads, and watch analytics are not included.
