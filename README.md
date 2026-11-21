# Moviwatch

A movie catalogue with Google Drive and Archive.org byte-range streaming. The frontend is served by Vercel; Cloudflare Workers provide the same-origin API, Range-aware media proxy, and edge chunk cache. Neon PostgreSQL stores movie metadata and video source arrays. Upstash Redis is used only for admin-login rate limiting.

## Features

- Public movie and web-series catalogue with Action and Romantic categories; visitors can browse and play without accounts.
- Web series with one shared poster, multiple seasons, episode numbering, individual episode streams, and previous/next navigation.
- Multiple Google Drive accounts connected simultaneously; every private source and resumable upload remains attached to its originating account.
- Password-protected admin dashboard at \`/admin\`.
- Add up to 8 labeled source links per movie from Google Drive and Archive.org.
- Native HTML5 `<video controls>` playback with no third-party player bundle or custom browser range adapter.
- Native browser controls support play/pause, seeking, volume and fullscreen; `preload=none` delays media reads until playback is requested.
- Protected **Download Now** link uses the same-origin Worker attachment endpoint and short-lived playback authorization.
- Audio-track switching is shown only when the browser exposes multiple native `audioTracks`; browser support varies, and Chromium-based browsers may not expose this API.
- HTTP Range support for playback, browser seeking, and HEAD metadata requests. Both playback and downloads stay behind the same-origin Cloudflare Worker; neither provider's raw media URL is returned to public clients.
- Cloudflare Workers Cache stores 1 MiB (conventional MP4) or 512 KiB (fragmented MP4) startup segments, followed by complete 4 MiB continuation chunks, for 24 hours through separately cached Worker entrypoints. Chunk keys include the source URL hash, movie, option index, source version, range start, and chunk size—not a viewer or browser ID—so the same cached bytes can be reused by other viewers.
- Fragmented MP4 detection uses a compact header probe, a 512 KiB initial Worker segment, and 4 MiB continuation chunks in Cloudflare's shared cache; conventional MP4 starts with 1 MiB. After the current segment, the Worker does not speculatively prefetch the successor: later ranges are fetched on demand as the browser consumes the active range.
- Public catalogue responses expose only labels, providers, and source indexes. Raw Google Drive and Archive.org source URLs remain in the internal metadata path and are never sent to public watch pages.
- Admin secrets stay in Cloudflare Worker Secrets.

## Adding video sources

In \`/admin\`, add one source per line using this format:

\`\`\`text
Google Drive 1080p | https://drive.google.com/file/d/FILE_ID/view
Archive.org 720p | https://archive.org/download/IDENTIFIER/video.mp4
\`\`\`

The first source is selected by default. When multiple options exist, the watch page shows a source selector. The native video `src` points only to the same-origin `/api/watch/:movieId/:sourceIndex` Worker route. **Download Now** uses the protected `/api/download/:movieId/:sourceIndex` attachment endpoint, including for Archive.org sources; the browser never receives a provider URL.

**Google Drive:** Set General access to **Anyone with the link – Viewer**. Private files, sign-in redirects, malware confirmation screens, and quota pages cannot be converted into video by the proxy. Use a file URL, not a folder URL.

**Archive.org:** Use a public direct file URL, preferably \`https://archive.org/download/IDENTIFIER/FILENAME\`. Archive.org metadata/item pages are not direct video streams. The Worker validates redirects to Archive.org item servers and forwards HTTP Range requests.

Only publish videos for which you have the rights and permissions required to distribute them.


## Secure Google Drive Manager

The admin dashboard includes an optional Google Drive Manager. It uses the connected administrator's Google OAuth account through the Cloudflare Worker; Google OAuth credentials and the refresh token never enter the browser.

Features:
- Browse My Drive and Shared Drives, open folders, search within the current folder, and create folders.
- Upload new files to the selected folder using resumable 8 MiB chunks.
- Replace the contents of an existing file without changing its Drive file ID.
- Rename files, move My Drive files to Trash, and delete Shared Drive files (Shared Drive deletion is permanent).
- Connect multiple Google accounts and switch between their My Drive and Shared Drives from the Admin selector; adding another account does not replace the first.
- Attach a selected Drive video to a movie or episode as a private source. Public catalogue responses include only the source label, provider and index; the Drive file ID, account ID and URL remain server-side.
- Each private video stores its Drive connection ID; playback uses the correct account's OAuth token and authenticated Google Drive byte-range requests, then the same Cloudflare shared 24-hour cache (small startup segment plus 4 MiB continuation chunks) and protected content-bound playback sessions.
- Resumable uploads keep their connection ID so switching accounts does not resume an upload with the wrong Gmail.
- Refresh or replace operations update attached movie source versions and purge related video cache tags.

The Worker creates the `google_drive_connections` and `google_drive_uploads` PostgreSQL tables automatically on the first Admin Drive Manager request. Refresh tokens are encrypted with AES-256-GCM using an account-specific additional-authenticated-data value (the existing `primary` token retains its legacy context); resumable upload session URLs are encrypted with a separate context. The `GOOGLE_DRIVE_ENCRYPTION_KEY` secret is shared by all connected accounts. Do not store OAuth credentials in Neon plaintext, GitHub, or browser storage.

### Google Cloud setup

1. Create or select a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen and create a **Web application** OAuth client.
3. Add this exact Authorized redirect URI:
   `https://moviwatch.vercel.app/api/google-drive/oauth/callback`
4. For an External app in Testing, add the Google account that will own the Drive connection as a test user. For a single Google Workspace organization, an Internal consent-screen app may be suitable if the organization permits it.
5. The Manager currently requests `openid`, `email`, and `https://www.googleapis.com/auth/drive` because it needs to list, upload, replace, rename and delete files across the connected account's Drives.

Configure these **Cloudflare Worker Secrets** (never paste their values into chat or commit them):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI
npx wrangler secret put GOOGLE_DRIVE_ENCRYPTION_KEY
```

- `GOOGLE_CLIENT_ID`: OAuth client ID ending in `.apps.googleusercontent.com`.
- `GOOGLE_CLIENT_SECRET`: OAuth client secret.
- `GOOGLE_REDIRECT_URI`: exactly `https://moviwatch.vercel.app/api/google-drive/oauth/callback`.
- `GOOGLE_DRIVE_ENCRYPTION_KEY`: 32 random bytes represented as 64 hexadecimal characters. Generate it with a cryptographically secure random generator and keep a protected backup. Losing it makes stored refresh tokens and upload sessions undecryptable; rotating it requires re-encrypting stored records first.

The same names can be placed in local `.dev.vars` for local Worker testing; see `.dev.vars.example`.

### Google OAuth verification note

The full `drive` scope is a **Restricted** Google OAuth scope. Google may require OAuth app verification and, where restricted-scope data is stored or transmitted by a server, a security assessment before a public production app can use it. An External app left in Testing is limited to configured test users, and Google refresh tokens issued while the consent screen is in Testing generally expire after 7 days for these Drive scopes. Plan verification and consent-screen publication before opening this manager to the public. The integration cannot bypass the connected account's Drive permissions, Google quotas, or file download restrictions.

### Safe operation

- Only logged-in administrators can call Drive management routes; write requests also require a trusted same-origin request.
- OAuth state is signed, short-lived and bound to an HttpOnly SameSite=Lax cookie; the authorization code exchange uses PKCE.
- Refresh tokens and resumable upload session URLs are encrypted at rest. Session URLs are never returned to the browser.
- File IDs are validated, Google API destinations are allowlisted, media redirects are restricted to trusted Google hosts, and byte ranges flow through the existing cache.
- Deleting a file detaches it from any Moviwatch movie sources. For My Drive it is moved to Trash; Shared Drive deletion is permanent and requires an explicit confirmation.
- A private Drive source means the original Drive file need not be public. The connected account must have access, and a movie attached and published on Moviwatch is then playable by Moviwatch visitors through its existing protected playback flow.

## Web Series

Create a series in the Admin dashboard with one title, poster, category and description. Then select its episodes from the Google Drive Manager using the **Episode** action, assign a season and episode number, and publish. One series poster is reused on the public catalogue card and all of its episode pages. Episodes are stored separately from movies, sorted by season and episode number, and use the same private Worker streaming, playback authorization and edge cache. The series page lists published seasons/episodes; an episode page links back to its series and exposes previous/next episode navigation. Deleting a series also deletes its episodes; deleting a Drive file detaches it from both movie and episode sources.

The Worker creates `public.series` and `public.episodes` additively when the Admin first loads the Series Manager (or when the public catalogue is first requested). Existing `public.movies` rows are not migrated or overwritten. The same tables are included in `schema.sql` for new installations.

## Native HTML5 playback

The watch page has no external player library. It uses a standard `<video controls playsinline preload="none">`, a protected Worker video URL and a separate **Download Now** attachment link. A source is attached only after the page loads metadata and obtains a movie-bound playback session. Switching sources updates the native video's `src` to another protected Worker route. Seeking and buffering are performed by the browser using HTTP Range requests; the Worker continues to provide private Google Drive/Archive.org access and shared 24-hour caching (1 MiB startup for conventional MP4, 512 KiB for fragmented MP4, then 4 MiB continuation chunks).

Audio selection is progressive enhancement: the page detects `HTMLMediaElement.audioTracks` and displays a language selector only when the browser exposes two or more tracks. This API is not available in every browser, including many Chromium-based environments, so embedded dual-audio switching cannot be guaranteed there with native `<video>` alone. Native browser codec/container support also applies; MP4 with H.264 video and AAC audio is the safest cross-browser choice. MKV and other less-supported containers may require conversion or another playback engine.

## Pakistan/mobile streaming behavior

The watch page uses the browser's native HTML5 `<video>` element with `controls`, `playsinline` and `preload=none`. The browser requests byte ranges directly from the same-origin Cloudflare Worker `/api/watch/:movieId/:sourceIndex` route; the Worker validates the short-lived, movie-bound playback session and serves proper HTTP 206 Range responses through its shared edge cache (1 MiB conventional MP4 startup, 512 KiB fragmented MP4 startup, then 4 MiB continuation chunks). There is no Movi-Player bundle, FFmpeg WASM, or custom browser range adapter. Browser-native decoder and container support now determines which formats play.

The native media element controls range requests and buffering. The Worker still streams only the requested byte ranges and can reuse its shared cache; the browser decides its own buffering and seek strategy. When a browser sends an open-ended bytes=N- request, the Worker returns only through the current cache-chunk boundary and the browser requests the next range on demand.

Cloudflare Workers continue to store video chunks for 24 hours: the first conventional MP4 segment is 1 MiB, the first fragmented MP4 segment is 512 KiB, and later continuation chunks are 4 MiB. The native browser sends HTTP Range requests, and the Worker assembles those requested bytes from shared 4 MiB edge-cache chunks. Cache keys use the movie, source/version and byte position—not a viewer or browser ID—so later visitors can reuse the cached bytes instead of re-reading the same content from Drive or Archive.org. The first cold request in a Cloudflare cache location can still need an upstream fetch.

For fragmented MP4, the Worker's first cached segment is 512 KiB; conventional MP4 starts with 1 MiB. Both formats use 4 MiB continuation chunks after the initial segment. Each 206 response ends at the current cache-chunk boundary, even for an open-ended bytes=N- request. The browser asks for later ranges only when its media pipeline needs more bytes; the Worker does not stream the remainder of the file or prefetch a successor chunk.

## Progressive two-proxy streaming

Vercel's /api/* external rewrite stays a thin same-origin gateway. It preserves the browser-facing URL and playback-cookie security; Vercel CDN rewrite caching is intentionally not enabled for private media responses. The Cloudflare Worker is the streaming and shared-cache layer. It forwards upstream response bodies as ReadableStreams and no longer builds a whole 4 MiB Uint8Array before returning video bytes. A bounded relay validates each upstream Content-Range, forwards each received body chunk immediately, and requests a contiguous continuation only if Google Drive or an Archive.org mirror caps the requested range.

### Cold-seek fast path

When a cache miss occurs and a seek begins more than 256 KiB into a 4 MiB cache segment, the Worker starts an exact byte-range request at the browser's requested offset while a separate branch completes the aligned shared-cache fill. This avoids downloading the unused prefix before playback can begin. The trade-off is intentional: a cold deep seek can temporarily read overlapping bytes from the provider twice. Once the segment is cached, later viewers use the shared edge object and do not need that duplicate upstream request. Cache hits never use the direct cold-seek path. The response exposes x-moviwatch-stream-mode, x-moviwatch-cold-seek-direct, and x-moviwatch-cache for diagnosis. The threshold is kept small to bound cold-miss duplication while avoiding most aligned-prefix wait.

**Archive.org mirror handling:** the Worker reads Internet Archive item metadata (`server`, `workable_servers`, `d1`, and `d2`), tries available storage hosts for each byte range, measures successful transfer throughput, prefers previously faster mirrors, and temporarily cools down hosts after failed or timed-out requests. If item metadata is unavailable, the original public Archive.org URL remains the fallback.

**Downloads:** Both Archive.org and Google Drive downloads are streamed through the Worker attachment endpoint after the same playback authorization checks. Provider URLs are not placed in the page, catalogue response, or redirect Location header. File bytes can still be saved by a visitor who is legitimately allowed to download them; this design prevents simple link reuse and third-party hotlinking, not copying captured media bytes after an authorized download.

**This reduces repeat reads and improves resilience; it cannot guarantee zero buffering.** Internet Archive still controls mirror availability, source bandwidth, throttling, and item permissions. If every storage mirror is slow or unavailable, playback can still buffer or fail. Cache misses still depend on an Internet Archive server. For best compatibility, use MP4 with H.264 video and AAC audio. Unsupported containers/codecs need conversion by the rights holder before upload.

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
| POST | \\`/api/playback/session\\` | Same-origin watch page; issues a movie-bound HttpOnly session cookie |
| POST | \`/api/auth/logout\` | Session cookie |
| GET | \`/api/auth/me\` | Session status |
| GET | \`/api/movies?q=&category=\` | Public catalogue (source labels/provider/index only) |
| GET/HEAD | \\`/api/watch/:movieId/:optionIndex\\` | Valid movie-bound HttpOnly session + matching same-origin watch-page referrer |
| GET/HEAD | \\`/api/download/:movieId/:optionIndex\\` | Same playback authorization as watch; Worker attachment download |
| GET | \`/api/admin/movies\` | Admin |
| POST/PUT/DELETE | \`/api/admin/movies[/:id]\` | Admin |
| GET | \`/api/admin/stats\` | Admin |

## Security and operational notes

- Only HTTPS Google Drive and Archive.org source hosts are accepted. Upstream redirects are validated hop by hop; arbitrary URLs are not fetched.
- A watch page obtains a short-lived signed playback session in a \\`Secure\\`, \\`HttpOnly\\`, \\`SameSite=Strict\\` cookie, bound to that movie ID. The token is never exposed to JavaScript or query strings.
- \\`/api/watch\\` and \\`/api/download\\` require that session cookie and a matching same-origin \\`Referer\\` for \\`/watch/:movieId\\`; cross-site requests and copied media URLs without the browser session are rejected.
- Both providers' downloads are proxied; Archive.org does not redirect the browser to its public source URL. Media responses use \\`Cross-Origin-Resource-Policy: same-origin\\`.
- Vercel sends \\`Referrer-Policy: same-origin\\`, \\`X-Frame-Options: DENY\\`, \\`Content-Security-Policy: frame-ancestors 'none'\\`, and \\`X-Content-Type-Options: nosniff\\` to prevent third-party framing and preserve same-origin watch-page context.
- Google Drive and Archive.org source URLs are not included in public catalogue JSON.
- The proxy does not bypass upstream access controls, quotas, copyright restrictions, or host throttling.
- Admin password verifier, pepper, JWT secret, Neon URL, and Redis token must be configured as Worker secrets, never committed.
- A keyed HMAC verifier is used instead of a high-iteration password KDF to fit Workers Free CPU limits; use a long random password and keep the pepper secret.
