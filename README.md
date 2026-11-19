# Moviwatch

A movie catalogue with Google Drive and Archive.org byte-range streaming. The frontend is served by Vercel; Cloudflare Workers provide the same-origin API, Range-aware media proxy, and edge chunk cache. Neon PostgreSQL stores movie metadata and video source arrays. Upstash Redis is used only for admin-login rate limiting.

## Features

- Public movie catalogue with Action and Romantic categories; visitors can browse and play without accounts.
- Password-protected admin dashboard at \`/admin\`.
- Add up to 8 labeled source links per movie from Google Drive and Archive.org.
- Responsive Movi Player with a source selector and a Download selected source button.
- HTTP Range support for playback, browser seeking, resumable download, and HEAD metadata requests.
- Cloudflare Workers Cache stores complete video chunks through separately cached Worker entrypoints. Chunk keys include the source URL hash, movie, option index, source version, range start, and chunk size.
- Fragmented MP4 detection uses a compact header probe, a 512 KiB initial segment, 4 MiB continuation chunks, and parallel startup/next-segment prefetch.
- Public catalogue responses expose labels, providers, and source indexes—not raw Drive/Archive URLs. Actual upstream URLs stay in the cached internal metadata entrypoint.
- Admin secrets stay in Cloudflare Worker Secrets.

## Adding video sources

In \`/admin\`, add one source per line using this format:

\`\`\`text
Google Drive 1080p | https://drive.google.com/file/d/FILE_ID/view
Archive.org 720p | https://archive.org/download/IDENTIFIER/video.mp4
\`\`\`

The first source is selected by default. Other options appear in the watch-page source selector. The download button always downloads the currently selected source through the same Worker endpoint used for streaming.

**Google Drive:** Set General access to **Anyone with the link – Viewer**. Private files, sign-in redirects, malware confirmation screens, and quota pages cannot be converted into video by the proxy. Use a file URL, not a folder URL.

**Archive.org:** Use a public direct file URL, preferably \`https://archive.org/download/IDENTIFIER/FILENAME\`. Archive.org metadata/item pages are not direct video streams. The Worker validates redirects to Archive.org item servers and forwards HTTP Range requests.

Only publish videos for which you have the rights and permissions required to distribute them.

## Pakistan/mobile streaming behavior

The browser requests byte ranges from the Moviwatch API. Cloudflare Workers fetches a small video header first, detects MP4 fragmentation, then reads/cache-warms the relevant chunks. Seeking asks for the segment matching the requested byte offset, while the next segment is fetched in the background. Later requests can reuse complete chunks from Cloudflare's edge cache rather than re-reading the same bytes from Drive or Archive.org.

For fragmented MP4, the initial segment is 512 KiB; continuation segments are 4 MiB. Conventional MP4 and other supported files use 4 MiB segments. The first playback request may still have to fetch bytes from the original host before the cache is warm.

**This reduces repeat reads and improves startup/seek behavior; it cannot guarantee zero buffering.** Google Drive and Archive.org still control access permissions, upstream throughput, quotas, throttling, availability, and source-file quality. Cloudflare cache misses still depend on the upstream host. For best compatibility, use MP4 with H.264 video and AAC audio. Unsupported containers/codecs need conversion by the rights holder before upload.

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

Use a random passphrase with at least 20 characters. Add the generated \`ADMIN_PASSWORD_HASH\` and \`ADMIN_PASSWORD_PEPPER\` values to \`.dev.vars\`; then fill the Neon and Redis values. Create a random \`JWT_SECRET\` of at least 32 random characters.

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

The workflow at \`.github/workflows/deploy.yml\` deploys the Worker when started from the **Actions** tab or when a change is merged to \`main\`. It requires these repository secrets under **Settings → Secrets and variables → Actions**:

- \`CLOUDFLARE_API_TOKEN\` — permission to edit Workers Scripts and read the account
- \`CLOUDFLARE_ACCOUNT_ID\`
- \`DATABASE_URL\`
- \`REDIS_REST_URL\`
- \`REDIS_REST_TOKEN\`
- \`ADMIN_PASSWORD_HASH\`
- \`ADMIN_PASSWORD_PEPPER\`
- \`JWT_SECRET\`

The workflow installs dependencies, runs the regression checks, uploads runtime secrets to Cloudflare, and deploys the Worker plus static assets. Verify a green Actions run and visit \`/api/health\`.

## Vercel frontend + Cloudflare API

The root \`vercel.json\` proxies same-origin \`/api/*\` requests to the Worker and maps \`/watch/:id\` and \`/admin\` to their static pages. Do not deploy Wrangler from Vercel; Cloudflare is the video API backend.

Vercel project settings:

- Root Directory: repository root (\`./\`)
- Framework Preset: Other
- Build Command: blank / disabled
- Output Directory: \`public\`
- Install Command: default / automatic

The production Vercel domain must be present in the Cloudflare Worker \`APP_ORIGINS\` allowlist (comma-separated exact HTTPS origins). Do not use wildcard origins. Keep browser API calls relative so Vercel proxies them to Cloudflare, preserving first-party session cookies.

## API

| Method | Route | Access |
|---|---|---|
| GET | \`/api/health\` | Public health check |
| POST | \`/api/auth/login\` | Admin password |
| POST | \`/api/auth/logout\` | Session cookie |
| GET | \`/api/auth/me\` | Session status |
| GET | \`/api/movies?q=&category=\` | Public catalogue (source labels/provider/index only) |
| GET/HEAD | \`/api/watch/:movieId/:optionIndex\` | Range-aware streaming |
| GET/HEAD | \`/api/download/:movieId/:optionIndex\` | Attachment download |
| GET | \`/api/admin/movies\` | Admin |
| POST/PUT/DELETE | \`/api/admin/movies[/:id]\` | Admin |
| GET | \`/api/admin/stats\` | Admin |

## Security and operational notes

- Only HTTPS Google Drive and Archive.org source hosts are accepted. Upstream redirects are validated hop by hop; arbitrary URLs are not fetched.
- Google Drive and Archive.org source URLs are not included in public catalogue JSON.
- The proxy does not bypass upstream access controls, quotas, copyright restrictions, or host throttling.
- Admin password verifier, pepper, JWT secret, Neon URL, and Redis token must be configured as Worker secrets, never committed.
- A keyed HMAC verifier is used instead of a high-iteration password KDF to fit Workers Free CPU limits; use a long random password and keep the pepper secret.
