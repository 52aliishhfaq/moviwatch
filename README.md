# Moviwatch

A lightweight movie catalogue and streaming backend built with Cloudflare Workers, Neon PostgreSQL, and Upstash Redis.

## Features
- Public catalogue; visitors do not need accounts or passwords.
- Password-protected admin dashboard at `/admin`.
- Exactly one application table: `movies`. Multiple video options live in a JSONB array.
- Action and Romantic categories, poster URLs, publish/unpublish, CRUD, search, and category filtering.
- Worker-proxied Google Drive public links with HTTP Range forwarding for seeking.
- Redis caches public catalogue responses and rate-limits admin login.
- Admin secrets remain in Cloudflare Worker Secrets; no Google OAuth client secret is needed for public Drive share links.

## Setup
1. Create a Neon project and run [schema.sql](./schema.sql).
2. Create an Upstash Redis database and collect its REST URL and token.
3. Install Node.js 20+, then run `npm install`.
4. Copy `.dev.vars.example` to `.dev.vars`, fill Neon/Redis values, and generate the admin password verifier with `npm run hash:password`.
5. Generate a long random `JWT_SECRET`.
6. Run `npm run dev` to test locally.
7. Deploy using `npx wrangler login`, set the secrets listed in `.dev.vars.example` with `wrangler secret put`, then run `npm run deploy`.

## GitHub Actions deployment
The workflow in `.github/workflows/deploy.yml` deploys on pushes to `main`. Add these repository Actions secrets:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL`, `REDIS_REST_URL`, `REDIS_REST_TOKEN`, `ADMIN_PASSWORD_HASH`, `ADMIN_PASSWORD_PEPPER`, and `JWT_SECRET`.

A green workflow and a successful `/api/health` response are required to confirm deployment. Pushing source to GitHub alone does not deploy the Worker.

## Google Drive limits
A Worker proxy does not bypass Google's Drive quotas or bandwidth restrictions. This implementation forwards Range requests and hides the stored source URL from the catalogue API, but video bytes still come from Drive. For dependable high-volume streaming, use media storage/CDN (such as Cloudflare R2) and distribute only content you have rights to share.

## Notes
- Only directly playable public Google Drive file links are supported.
- Admin password verifier, pepper, JWT secret, database URL, and Redis token must be configured as Worker secrets.
- This is a focused implementation, not a complete copy of the original Haru Stream project. It omits OAuth Drive sync, folder manager, and watch analytics.
