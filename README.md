# Moviwatch

A lightweight movie catalogue with a VOE-hosted video player. The application UI and API run on Vercel + Cloudflare Workers, with Neon PostgreSQL for movie metadata and Upstash Redis for admin-login rate limiting. Video bytes are delivered by VOE directly to the user's browser; Moviwatch does not proxy or extract the hosted media.

## Features

- Public movie catalogue; visitors browse and play without accounts.
- Password-protected admin dashboard at \`/admin\`.
- Action and Romantic categories, poster URLs, publish/unpublish, create/edit/delete, search and filtering.
- VOE-only video source validation: only HTTPS \`https://voe.sx/e/VIDEO_CODE\` embed URLs are accepted.
- Responsive, full-screen-capable VOE iframe with a 16:9 mobile layout and a direct link to the official VOE page.
- The watch page provides a VOE download-options link. VOE determines whether a download is available for that file and account; Moviwatch does not scrape media URLs or bypass host restrictions.
- VOE connections are preconnected from the watch page to reduce avoidable connection setup delay. Actual startup time, quality selection, buffering, and download speed remain controlled by VOE and the viewer's network.
- The public catalogue is cached through Cloudflare Workers Cache. Upstash Redis is used only for admin-login rate limiting.
- Admin secrets stay in Worker Secrets.

## Video source setup

In the admin dashboard, add one VOE embed link per movie, such as:

\`\`\`text
https://voe.sx/e/af7mpped9rwa
\`\`\`

The application validates the exact VOE hostname and embed path before saving. Only VOE entries are returned by the public catalogue. Old non-VOE source records are not exposed or played; edit each movie and save its replacement VOE link. This avoids assigning the sample embed to the wrong movie.

VOE's terms require linked/integrated pages to keep the service visible and not block or alter its advertisements. Only publish videos for which you have the necessary rights and permissions. Review the [VOE Terms](https://voe.sx/tos) and [VOE API reference](https://voe.sx/api-1-reference-index) before adding any account-level API integration.

## Pakistan/mobile playback guidance

The watch page opens VOE directly rather than routing large media files through Vercel or a Worker. This avoids an unnecessary application proxy hop, but cannot improve VOE's own delivery capacity or bypass its account-level speed limits. On mobile data or a slower connection, choose a lower rendition (for example 360p/480p) in VOE's quality menu when offered. The selected quality and available downloads are controlled by VOE.

## Database and Redis

1. Create a Neon project and run [schema.sql](./schema.sql) in the Neon SQL Editor.
2. Use Neon's pooled connection string as \`DATABASE_URL\`.
3. Create an Upstash Redis database and note its REST URL and token.

## Local setup

Requires Node.js 20+.

\`\`\`bash
npm install
cp .dev.vars.example .dev.vars
npm run hash:password
\`\`\`

Use a random passphrase with at least 20 characters. Add the generated \`ADMIN_PASSWORD_HASH\` and \`ADMIN_PASSWORD_PEPPER\` values to \`.dev.vars\`; then fill the Neon and Redis values. Create a random \`JWT_SECRET\` of at least 32 characters.

\`\`\`bash
npm run dev
\`\`\`

Open \`http://localhost:8787/\` for the public catalogue and \`http://localhost:8787/admin\` for the admin login.

## Cloudflare deployment

For manual deployment with Wrangler:

\`\`\`bash
npx wrangler login
npx wrangler secret put DATABASE_URL
npx wrangler secret put REDIS_REST_URL
npx wrangler secret put REDIS_REST_TOKEN
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put ADMIN_PASSWORD_PEPPER
npx wrangler secret put JWT_SECRET
npm run deploy
\`\`\`

### Deploy through GitHub Actions

The workflow at \`.github/workflows/deploy.yml\` can deploy the Worker when manually started from the **Actions** tab. Before running it, add these repository secrets under **Settings → Secrets and variables → Actions**:

- \`CLOUDFLARE_API_TOKEN\` — permission to edit Workers Scripts and read the account
- \`CLOUDFLARE_ACCOUNT_ID\`
- \`DATABASE_URL\`
- \`REDIS_REST_URL\`
- \`REDIS_REST_TOKEN\`
- \`ADMIN_PASSWORD_HASH\`
- \`ADMIN_PASSWORD_PEPPER\`
- \`JWT_SECRET\`

The workflow installs dependencies, checks JavaScript syntax, uploads runtime secrets to Cloudflare, and deploys the Worker plus static assets. A successful GitHub commit is not proof of deployment: verify a green Actions run and visit \`/api/health\`.

## Vercel frontend + Cloudflare API

The frontend can stay on Vercel while the API runs on Cloudflare Workers. The root \`vercel.json\` proxies same-origin \`/api/*\` requests to the Worker and maps \`/admin\` to the static admin page. The video iframe is loaded directly from VOE; it does not pass through the API proxy. Do not run \`wrangler deploy\` from Vercel; Cloudflare remains a separate backend deployment.

Vercel project settings:

- Root Directory: repository root (\`./\`)
- Framework Preset: Other
- Build Command: blank / disabled
- Output Directory: \`public\`
- Install Command: default / automatic

After the Vercel project is created, copy its production domain (for example, \`https://<project>.vercel.app\`). Add that exact origin to the Cloudflare Worker variable \`APP_ORIGINS\` (comma-separated for more than one origin). Include your production custom domain too, if one is added. The Worker uses this allowlist for admin login/logout and admin mutations; do not use a wildcard origin. Redeploy the Worker after changing a Wrangler-managed variable, or save the variable in the Cloudflare dashboard.

Keep API calls relative (such as \`/api/movies\`) so the browser talks to the Vercel origin and Vercel proxies them to Cloudflare. Verify \`/api/health\`, the public catalogue, admin login, and a create/edit/delete test after deployment.

## API

| Method | Route | Access |
|---|---|---|
| GET | \`/api/health\` | Public health check |
| POST | \`/api/auth/login\` | Admin password |
| POST | \`/api/auth/logout\` | Session cookie |
| GET | \`/api/auth/me\` | Session status |
| GET | \`/api/movies?q=&category=\` | Public VOE-only catalogue |
| GET | \`/api/admin/movies\` | Admin |
| POST/PUT/DELETE | \`/api/admin/movies[/:id]\` | Admin |
| GET | \`/api/admin/stats\` | Admin |

Legacy application-level media proxy endpoints are retired. Playback and any download option stay on the official VOE page.

## Security and scope

- Only exact HTTPS VOE embed links on \`voe.sx/e/{code}\` are accepted by the admin API.
- Old source records for other hosts are filtered out of both the public catalogue and admin editor response.
- Admin password verifier, pepper, JWT secret, Neon URL, and Redis token must be configured as Worker secrets, never committed.
- A keyed HMAC verifier is used instead of a high-iteration password KDF to fit Workers Free CPU limits; use a long random password and keep the pepper secret.
- Users are responsible for having the rights and permissions required to publish any linked video.
