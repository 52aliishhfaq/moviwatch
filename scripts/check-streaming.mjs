import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { archiveDownloadUrl, sourceProvider, videoSourceUrl } from '../src/video-sources.js';

const worker = readFileSync('src/index.js', 'utf8');
const sourceModule = readFileSync('src/video-sources.js', 'utf8');
const watch = readFileSync('public/watch.html', 'utf8');
const rangeSource = readFileSync('public/player-range-source.js', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const readme = readFileSync('README.md', 'utf8');

function assertIncludes(source, value, message) {
  assert.ok(source.includes(value), message);
}

// Google Drive share URL formats normalize to a single HTTPS byte-source URL.
const driveId = '1AbCdEfGhIjKlMnOpQrStUvWxYz';
const expectedDrive = 'https://drive.usercontent.google.com/download?id=' + driveId + '&export=download&confirm=t';
assert.equal(videoSourceUrl('https://drive.google.com/file/d/' + driveId + '/view?usp=sharing'), expectedDrive);
assert.equal(videoSourceUrl('https://drive.google.com/open?id=' + driveId), expectedDrive);
assert.equal(videoSourceUrl(driveId), expectedDrive);
assert.equal(sourceProvider(expectedDrive), 'google-drive');
assert.equal(sourceProvider('https://doc-0-0-sheets.googleusercontent.com/export/abc'), 'google-drive');

// Archive.org accepts public /download URLs and canonical item-server file URLs.
const archiveDownload = 'https://archive.org/download/sample-item/movie.mp4';
assert.equal(videoSourceUrl(archiveDownload), archiveDownload);
assert.equal(sourceProvider(archiveDownload), 'archive.org');
const archiveItemServer = 'https://ia801.us.archive.org/0/items/sample-item/movie.mp4';
assert.equal(videoSourceUrl(archiveItemServer), archiveItemServer);
assert.equal(sourceProvider(archiveItemServer), 'archive.org');
assert.equal(archiveDownloadUrl(archiveItemServer), archiveDownload);
assert.equal(archiveDownloadUrl(archiveDownload), archiveDownload);

// Invalid links, folder URLs, metadata pages, and non-HTTPS sources are rejected.
for (const bad of [
  'http://archive.org/download/sample-item/movie.mp4',
  'https://drive.google.com/drive/folders/' + driveId,
  'https://archive.org/details/sample-item',
  'https://example.com/video.mp4',
  'https://voe.sx/e/af7mpped9rwa',
  'https://doodstream.com/e/abc123',
  'javascript:alert(1)',
  'not a url'
]) {
  assert.throws(() => videoSourceUrl(bad), undefined, 'Expected invalid source to be rejected: ' + bad);
}

// Worker source policy and safe provider redirects.
assertIncludes(worker, "host === 'drive.google.com' || host === 'drive.usercontent.google.com'", 'Drive host allowlist missing');
assertIncludes(worker, "host === 'archive.org' || host.endsWith('.archive.org')", 'Archive.org host allowlist missing');
assertIncludes(worker, "redirect: 'manual'", 'Upstream redirects must be validated hop by hop');
assertIncludes(worker, 'sourceKind(new URL(source).hostname)', 'Google sign-in redirects must be detected');
assertIncludes(worker, 'Anyone with the link (Viewer)', 'Private Drive guidance missing');

// Edge streaming retains fMP4 startup detection, small initial chunks, range seeking,
// and a prefetch of the immediate successor segment.
assertIncludes(worker, 'const VIDEO_CHUNK_SIZE = 8 * 1024 * 1024', '8 MiB continuation chunks missing');
assertIncludes(worker, 'const VIDEO_FRAGMENT_START_CHUNK_SIZE = 512 * 1024', '512 KiB fMP4 startup segment missing');
assertIncludes(worker, 'const VIDEO_CACHE_TTL = 24 * 60 * 60', '24-hour shared video cache TTL missing');
assertIncludes(worker, "'cache-control': 'public, max-age=' + VIDEO_CACHE_TTL + ', stale-if-error=3600'", 'Complete video chunks must remain cacheable for 24 hours');
assertIncludes(worker, 'props: cachedSourceProps(source, normalizedSourceVersion)', 'Video cache keys must use source identity and version, not viewer identity');
assertIncludes(worker, 'function cachedSourceProps(source, normalizedSourceVersion)', 'Typed private Drive sources must participate in stable shared cache keys');
assertIncludes(worker, 'https://archive.org/metadata/', 'Archive.org metadata discovery missing');
assertIncludes(worker, 'metadata.d1', 'Archive.org d1 mirror missing');
assertIncludes(worker, 'metadata.d2', 'Archive.org d2 mirror missing');
assertIncludes(worker, 'archiveScores', 'Archive.org throughput scoring missing');
assertIncludes(worker, 'ARCHIVE_COOLDOWN', 'Archive.org failure cooldown missing');
assertIncludes(worker, 'ARCHIVE_FAST_MIRROR_BPS', 'Archive.org mirror health threshold missing');
assertIncludes(worker, 'fetchVideoRangeFromMirrors', 'Archive.org per-range failover missing');
assertIncludes(worker, 'const VIDEO_HEADER_PROBE_SIZE = 16 * 1024', 'Compact video header probe missing');
assertIncludes(worker, 'mp4MoovEnd(bytes)', 'MP4 moov atom size detection missing');
assertIncludes(worker, 'mp4HasMvex(bytes)', 'Fragmented MP4 detection missing');
assertIncludes(worker, 'videoChunkStartForOffset(offset, fragmented)', 'Seek offset mapping missing');
assertIncludes(worker, 'videoChunkSizeAt(chunkStart, fragmented)', 'Adaptive chunk sizing missing');
assertIncludes(worker, 'const nextChunkStart = chunk.end + 1', 'Next-segment prefetch missing');
assertIncludes(worker, 'ctx.waitUntil(Promise.allSettled([nextPromise]))', 'Next-segment prefetch must not block playback');
assertIncludes(worker, "'cache-tag': 'video-chunks-' + movieId", 'Video chunks need a movie-level cache purge tag');
assertIncludes(worker, "ctx.exports.VideoChunk({", 'Cached chunk entrypoint not used');
assertIncludes(worker, "ctx.exports.VideoHeader({", 'Cached header entrypoint not used');
assertIncludes(worker, "'x-moviwatch-cache': cacheStatus", 'Cache diagnostics header missing');
assertIncludes(worker, "'accept-ranges': 'bytes'", 'Range support header missing');

// Public source metadata carries an original array index, never an upstream URL.
// That index is shared by playback and download so options cannot accidentally drift.
assertIncludes(worker, "'source_index',item.ordinality-1", 'Original video source index is not retained');
assertIncludes(worker, 'storedVideoSource(movie, optionIndex)', 'Watch/download source index resolution missing');
const catalogueStart = worker.indexOf('export class PublicCatalogue');
const catalogueEnd = worker.indexOf('export class MovieMetadata', catalogueStart);
const catalogue = worker.slice(catalogueStart, catalogueEnd);
assertIncludes(catalogue, 'source_index:index', 'Public player source index missing');
assert.ok(!catalogue.includes("download_url:") && !catalogue.includes("url:source.url"),
  'Public catalogue must not expose raw provider or direct download URLs');

assertIncludes(worker, "const watch = path.split('/')", 'Watch proxy route missing');
assertIncludes(worker, "const download = path.split('/')", 'Download proxy route missing');
const downloadStart = worker.indexOf("const download = path.split('/')");
const downloadEnd = worker.indexOf("const watch = path.split('/')", downloadStart);
const downloadRoute = worker.slice(downloadStart, downloadEnd);
assertIncludes(downloadRoute, 'new FixedLengthStream(contentLength)', 'Downloads must expose a runtime-enforced Content-Length');
assertIncludes(downloadRoute, 'response.body.pipeTo(fixedLength.writable)', 'Downloads must remain streamed through the fixed-length body');
assertIncludes(downloadRoute, "headers.set('content-length', String(contentLength))", 'Download Content-Length header must match the enforced stream size');
assertIncludes(worker, 'cachedVideoRange(', 'Proxy must use the edge chunk cache');
assertIncludes(worker, 'content-disposition', 'Google Drive Worker download attachment header missing');
assert.ok(!worker.includes("Response.redirect(archiveDownloadUrl("), 'Protected downloads must not redirect users to provider URLs');
assertIncludes(worker, "const PLAYBACK_COOKIE = 'moviwatch_playback'", 'HttpOnly playback session cookie missing');
assertIncludes(worker, "playbackCookieName(movieId) + '=' + token", 'Playback sessions must use a separate cookie per movie so open tabs do not overwrite each other');
assertIncludes(worker, 'async function makePlaybackToken(env, movieId)', 'Playback ticket must be cryptographically signed and movie-bound');
assertIncludes(worker, 'async function validPlaybackToken(env, token)', 'Playback ticket verifier missing');
assertIncludes(worker, 'claims.mid.toLowerCase() === movieId.toLowerCase()', 'Playback ticket must be bound to the requested movie');
assertIncludes(worker, 'playbackContextAllowed(req, env, movieId)', 'Media endpoints must verify same-origin watch page context');
assertIncludes(worker, 'cross-origin|must ', 'Cross-origin session attempts must be rejected as client errors');
assertIncludes(worker, "path === '/api/playback/session'", 'Playback session endpoint missing');
assertIncludes(worker, "HttpOnly; Secure; SameSite=Strict; Path=/api/", 'Playback session cookie must be HttpOnly, Secure and SameSite=Strict');
assertIncludes(worker, "if (!await hasPlaybackAccess(req, env, download[3]))", 'Download endpoint must reject unbound requests');
assertIncludes(worker, "if (!await hasPlaybackAccess(req, env, watch[3]))", 'Watch endpoint must reject unbound requests');
assertIncludes(worker, "'cross-origin-resource-policy': 'same-origin'", 'Media responses must block cross-origin embedding');
assert.ok(vercel.headers?.some((entry) => entry.source === '/(.*)' &&
  entry.headers?.some((header) => header.key === 'Referrer-Policy' && header.value === 'same-origin') &&
  entry.headers?.some((header) => header.key === 'X-Frame-Options' && header.value === 'DENY') &&
  entry.headers?.some((header) => header.key === 'Content-Security-Policy' && header.value.includes("frame-ancestors 'none'"))),
  'Vercel must preserve same-origin referrers and block cross-site framing');
assertIncludes(worker, 'content-range', 'HTTP content-range support missing');
assertIncludes(sourceModule, "return host==='archive.org'||host.endsWith('.archive.org')?'archive.org':'google-drive'", 'Archive provider detection missing');
assert.ok(!/doodstream|playmogo|voe\.sx/i.test(worker), 'Legacy hosts must not remain in the Worker');

// Vercel / Cloudflare routing and responsive player controls.
assertIncludes(watch, 'id="video"', 'Movi Player element missing');
assertIncludes(watch, "const streamUrl='/api/watch/'", 'Player source must use the Worker range endpoint');
assertIncludes(watch, 'new window.MoviwatchRangeSource(streamUrl', 'Player must use the controlled range adapter');
assertIncludes(watch, 'video.sourceAdapter=activeRangeSource', 'Movi Player must receive the custom range source');
assert.ok(!watch.includes('downloadNow') && !watch.includes('Download Now'), 'The lightweight watch page should not show a download UI');
assertIncludes(watch, "body:JSON.stringify({movieId})", 'Watch page must request a movie-bound playback session');
assertIncludes(watch, "credentials:'same-origin'", 'Watch page must send the HttpOnly session cookie on same-origin requests');

assert.ok(!watch.includes('source.download_url') && !watch.includes('directUrl.toString()'), 'Watch page must not expose direct provider URLs');
assertIncludes(watch, "select.hidden=availableSources.length<2", 'Single-source selector must be hidden');
assertIncludes(watch, "$('#sourceBar').hidden=availableSources.length<2", 'Only show source switching when there are multiple sources');
assert.ok(!watch.includes('class="hint"'), 'Remove the verbose player helper paragraph');
assertIncludes(watch, 'id="sourceSelect"', 'Multiple source selector missing');
assertIncludes(watch, 'const PLAYER_BUFFER_SIZE_MB=12', '12 MiB lightweight player memory limit missing');
assertIncludes(watch, 'const PLAYER_RANGE_CHUNK_SIZE=1024*1024', '1 MiB player request size missing');
assertIncludes(watch, 'const PLAYER_PREFETCH_AHEAD=1', 'Lightweight player should prefetch only one range ahead');
assertIncludes(watch, 'preload="none" buffersize="12"', 'Video data must remain unloaded until the viewer presses Play, with a 12 MiB buffer cap');
assertIncludes(watch, 'sw="auto"', 'Player must silently fall back from hardware to software decoding');
assert.ok(!watch.includes('Loading video…') && !watch.includes('id="loading"'), 'Do not show the duplicate loading-video label');
assertIncludes(watch, "We could not start this video. Please try again.", 'Player failures must use a concise customer-facing message');
assertIncludes(watch, 'movi-player::part(error-screen)', 'Hide raw internal decoder error overlay in favour of app recovery UI');
assertIncludes(watch, 'element.slim.global.js', 'Use the smaller Movi-Player slim bundle');
assertIncludes(watch, 'persist="volume audiolang"', 'Remember volume and selected audio language');
assertIncludes(watch, 'id="bigPlay"', 'Minimal custom play button missing');
assertIncludes(watch, 'id="audioSelect"', 'Conditional audio language selector missing');
assertIncludes(watch, 'video.getAudioLangs()', 'Use the supported language-keyed audio track API');
assertIncludes(watch, 'video.selectAudioLang(lang)', 'Use the supported audio language switch API');
assertIncludes(watch, 'currentAudioTracks.length<2', 'Hide audio selector when the source is not dual-audio');
assertIncludes(watch, 'const PLAYER_BUFFER_SIZE_MB=12', 'Custom player browser cache and engine memory cap missing');
assert.ok(!watch.includes('wasmurl='), 'Allow the slim build to use its built-in native fallback');
assert.ok(!watch.includes(' id="video" controls'), 'Do not render the heavy built-in settings/control UI');
assertIncludes(watch, "video.preload='none'", 'Player source must keep native preload disabled until the user plays');
assertIncludes(watch, "video.setAttribute('buffersize',String(PLAYER_BUFFER_SIZE_MB))", 'Player fallback buffer cap must be applied on every source selection');
assertIncludes(watch, "activeRangeSource.setPlaybackActive(true)", 'Player must enable prefetch while playing');
assertIncludes(watch, "activeRangeSource.setPlaybackActive(false)", 'Player must stop speculative prefetch when paused or stopped');
assertIncludes(rangeSource, 'const CHUNK_SIZE = 1024 * 1024', 'Range adapter must request at most 1 MiB per piece');
assertIncludes(rangeSource, 'const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024', 'Range adapter must retain a bounded 32 MiB LRU cache');
assertIncludes(rangeSource, 'const DEFAULT_PREFETCH_AHEAD = 2', 'Range adapter must prefetch two chunks ahead');
assertIncludes(rangeSource, "Range: 'bytes=' + start + '-' + end", 'Range adapter must issue explicit HTTP byte ranges');
assertIncludes(rangeSource, 'this._prefetchAfter(lastIndex)', 'Range adapter must warm upcoming segments after active reads');
assertIncludes(rangeSource, 'this._cancelSpeculative()', 'Range adapter must cancel speculative reads on pause/seek');
assertIncludes(watch, "video.addEventListener('statechange'", 'Buffering state must use Movi Player statechange events');
assertIncludes(watch, "video.addEventListener('loadeddata'", 'Player startup must use its supported loadeddata event');
assert.ok(!watch.includes('video.load();'), 'Movi Player loads on src assignment; avoid redundant native load() calls');
assertIncludes(watch, 'aspect-ratio:16/9', 'Responsive 16:9 player shell missing');
assertIncludes(watch, '/manifest.webmanifest', 'Watch page PWA manifest missing');
assert.ok(!/doodstream|playmogo|voe\.sx/i.test(watch), 'Legacy providers must not remain on the watch page');

assertIncludes(admin, 'id="sources"', 'Admin source editor missing');
assertIncludes(admin, 'Google Drive / Archive.org video links', 'Admin must describe supported providers');
assertIncludes(admin, 'drive.google.com/file/d/', 'Admin Drive example missing');
assertIncludes(admin, 'archive.org/download/', 'Admin Archive example missing');
assertIncludes(admin, "source.provider==='google-drive'", 'Admin Drive summary missing');
assertIncludes(admin, "source.provider==='archive.org'", 'Admin Archive summary missing');
assert.ok(!/doodstream|playmogo|voe\.sx/i.test(admin), 'Legacy providers must not remain in the admin page');

// All four Worker entrypoints must be cache-enabled independently of the uncached gateway.
assert.equal(config.exports?.default?.cache?.enabled, false, 'Gateway must bypass cache');
for (const name of ['PublicCatalogue', 'MovieMetadata', 'VideoChunk', 'VideoHeader']) {
  assert.equal(config.exports?.[name]?.type, 'worker', name + ' Worker entrypoint missing');
  assert.equal(config.exports?.[name]?.cache?.enabled, true, name + ' edge cache must be enabled');
}

// Browser inline scripts in all pages are syntactically valid.
new Script(rangeSource, { filename: 'public/player-range-source.js' });
for (const file of ['public/index.html', 'public/watch.html', 'public/admin.html']) {
  const html = readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'No inline scripts found in ' + file);
  scripts.forEach((match, index) => {
    if (match[1].trim()) new Script(match[1], { filename: file + '#inline-' + (index + 1) });
  });
}

assertIncludes(readme, 'Drive and Archive.org byte-range streaming', 'README must describe the restored providers');
assertIncludes(readme, 'cannot guarantee zero buffering', 'README must document realistic buffering limits');
assertIncludes(readme, '8 MiB continuation chunks', 'README must document 8 MiB chunks');
assertIncludes(readme, '32 MiB', 'README must document the bounded player memory buffer');
assertIncludes(readme, '24 hours', 'README must document the shared edge cache TTL');
assertIncludes(readme, 'not shared between browsers', 'README must distinguish private player memory from shared edge caching');
assertIncludes(readme, 'https://archive.org/download/IDENTIFIER/FILENAME', 'README must document canonical direct Archive.org downloads');
assertIncludes(readme, 'd1', 'README must document mirror failover');

assertIncludes(readme, 'A watch page obtains a short-lived signed playback session', 'README must describe the new playback authorization');
console.log('Drive/Archive URL, provider, cache, range, protected playback/download, admin, watch and inline-script checks passed.');

// Google Drive Manager: OAuth, private references and management routes stay server-side.
assertIncludes(worker, "provider:'google-drive-private'", 'Private Drive sources must use an internal provider marker');
assertIncludes(worker, 'googleDriveApiRequest(sqlFor(env), env, mediaUrl', 'Private Drive video ranges must be authorized by the Worker');
assertIncludes(worker, 'fetchConfiguredVideoRange(source, cursor, requestedEnd, env)', 'Private Drive bytes must enter the existing shared chunk cache');
assertIncludes(worker, "pathname === '/api/google-drive/oauth/callback'", 'OAuth callback route missing');
assertIncludes(worker, "path.startsWith('/api/admin/google-drive/')", 'Google Drive management must stay under the admin API gate');
assertIncludes(worker, 'refresh_token_ciphertext', 'Google refresh tokens must be encrypted at rest');
assertIncludes(worker, 'session_ciphertext', 'Resumable upload session URLs must be encrypted at rest');
assertIncludes(worker, 'new FixedLengthStream', 'Download size regression guard must remain in place');
assertIncludes(admin, 'id="googleDrivePanel"', 'Admin Google Drive Manager UI missing');
assertIncludes(worker, 'drive-private://', 'Admin API must preserve private Drive references without exposing them publicly');
assertIncludes(admin, "'Content-Range':'bytes '+offset+'-'+end+'/'+file.size", 'Admin uploads must send explicit byte ranges');
assert.ok(!/GOOGLE_CLIENT_SECRET|GOOGLE_DRIVE_ENCRYPTION_KEY|refresh_token=/.test(admin), 'Google OAuth secrets must never be embedded in the browser UI');
