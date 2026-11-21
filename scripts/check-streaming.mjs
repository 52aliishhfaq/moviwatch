import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { archiveDownloadUrl, sourceProvider, videoSourceUrl } from '../src/video-sources.js';
import { getVideoRangeWindow } from '../src/video-range-window.js';
import { createRangeRelayStream } from '../src/video-stream.js';

const worker = readFileSync('src/index.js', 'utf8');
const videoStream = readFileSync('src/video-stream.js', 'utf8');
const sourceModule = readFileSync('src/video-sources.js', 'utf8');
const watch = readFileSync('public/watch.html', 'utf8');
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

// Seek windows: preserve the exact requested start but stop at the current cache chunk.
// Open-ended bytes=N- requests must not create one response covering the whole tail.
const MiB = 1024 * 1024;
const seekConfig = {
  total: 64 * MiB,
  fragmented: false,
  continuationChunkSize: 4 * MiB,
  startupChunkSize: 1 * MiB,
  fragmentStartupChunkSize: 512 * 1024
};
assert.deepEqual(getVideoRangeWindow({ ...seekConfig, start: 0, requestedEnd: seekConfig.total - 1 }),
  { chunkStart: 0, chunkEnd: MiB - 1, end: MiB - 1 });
const seekStart = 20 * MiB + 123;
const seekWindow = getVideoRangeWindow({ ...seekConfig, start: seekStart, requestedEnd: seekConfig.total - 1 });
assert.equal(seekWindow.chunkStart, 17 * MiB);
assert.equal(seekWindow.end, 21 * MiB - 1);
assert.ok(seekWindow.end < seekConfig.total - 1);
assert.equal(getVideoRangeWindow({ ...seekConfig, start: seekStart, requestedEnd: seekStart + 777 }).end, seekStart + 777);
const fmp4Window = getVideoRangeWindow({ ...seekConfig, fragmented: true, start: 400 * 1024, requestedEnd: seekConfig.total - 1 });
assert.equal(fmp4Window.end, 512 * 1024 - 1);
const finalWindow = getVideoRangeWindow({ ...seekConfig, start: 63 * MiB + 900, requestedEnd: seekConfig.total - 1 });
assert.equal(finalWindow.end, seekConfig.total - 1);
assert.throws(() => getVideoRangeWindow({ ...seekConfig, start: -1, requestedEnd: 12, total: 20 }), RangeError);

// Worker source policy and safe provider redirects.
assertIncludes(worker, "host === 'drive.google.com' || host === 'drive.usercontent.google.com'", 'Drive host allowlist missing');
assertIncludes(worker, "host === 'archive.org' || host.endsWith('.archive.org')", 'Archive.org host allowlist missing');
assertIncludes(worker, "redirect: 'manual'", 'Upstream redirects must be validated hop by hop');
assertIncludes(worker, 'sourceKind(new URL(source).hostname)', 'Google sign-in redirects must be detected');
assertIncludes(worker, 'Anyone with the link (Viewer)', 'Private Drive guidance missing');

// Edge streaming retains fMP4 startup detection, small initial chunks and on-demand seeking.
assertIncludes(worker, 'const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024', '4 MiB continuation chunks missing');
assertIncludes(worker, 'const responseWindow = getVideoRangeWindow({', 'Open-ended byte ranges must be bounded to the active cache chunk');
assertIncludes(worker, 'end = responseWindow.end;', 'The 206 response end must use the bounded cache window');
assert.ok(!worker.includes('const nextChunkStart = chunk.end + 1'), 'Worker must not speculatively fetch a successor chunk during a seek');
assertIncludes(worker, 'const VIDEO_STARTUP_CHUNK_SIZE = 1024 * 1024', '1 MiB conventional MP4 startup segment missing');
assertIncludes(worker, 'const VIDEO_FRAGMENT_START_CHUNK_SIZE = 512 * 1024', '512 KiB fMP4 startup segment missing');
assertIncludes(worker, "import { createRangeRelayStream } from './video-stream.js'", 'Progressive range relay must be wired into the Worker');
assertIncludes(worker, 'createRangeRelayStream({', 'Cache chunks must be relayed without a whole-chunk arrayBuffer');
assertIncludes(worker, 'const VIDEO_DIRECT_SEEK_THRESHOLD = 256 * 1024', 'Cold seeks must bypass large aligned-prefix waits');
assertIncludes(worker, "['MISS', 'EXPIRED', 'REVALIDATED', 'UPDATING', 'STALE', 'BYPASS'].includes(firstChunk.cacheStatus)", 'Direct cold seek must require an explicit cache miss/bypass status');
assertIncludes(worker, 'fetchConfiguredVideoRange(source, responseStart, responseEnd, env, 0, true, req.signal)', 'Cold cache misses must request the exact seek byte range for immediate playback');
assertIncludes(worker, "x-moviwatch-cold-seek-direct': String(directSeek)", 'Cold-seek direct-path diagnostics missing');
assertIncludes(worker, "x-moviwatch-cache-acquire-ms': String(cacheAcquireMs)", 'Cache acquisition timing diagnostics missing');
assertIncludes(worker, "x-moviwatch-direct-seek-setup-ms': String(directSeekSetupMs)", 'Direct range setup timing diagnostics missing');
assertIncludes(worker, "ctx.waitUntil(branches[1].pipeTo(new WritableStream({ write() {} }))", 'A separate background branch must finish filling the shared cache segment');

assertIncludes(worker, 'fetchConfiguredVideoRange(source, chunkStart, requestedEnd, env, 0, true)', 'Cold chunk fills must stream directly from the upstream provider');
assertIncludes(worker, "'x-moviwatch-stream-mode': streamMode", 'Progressive stream diagnostics missing');
assertIncludes(worker, "'x-moviwatch-cache': firstChunk.cacheStatus", 'Cache status must survive the progressive relay');
const chunkFillStart = worker.indexOf('async function fetchAndCacheVideoChunk');
const chunkFillEnd = worker.indexOf('export class VideoHeader', chunkFillStart);
assert.ok(chunkFillStart >= 0 && chunkFillEnd > chunkFillStart &&
  !worker.slice(chunkFillStart, chunkFillEnd).includes('arrayBuffer()'),
  'Cache segment fill must stream, not buffer, the entire upstream segment');
assertIncludes(worker, 'const startupSize = fragmented ? VIDEO_FRAGMENT_START_CHUNK_SIZE : VIDEO_STARTUP_CHUNK_SIZE', 'Startup/continuation byte-range alignment missing');
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
assertIncludes(worker, 'const requestedEnd = end;', 'Original browser range end must be retained for diagnostics');
assertIncludes(worker, "'cache-tag': 'video-chunks-' + movieId", 'Video chunks need a movie-level cache purge tag');
assertIncludes(worker, "ctx.exports.VideoChunk({", 'Cached chunk entrypoint not used');
assertIncludes(worker, "ctx.exports.VideoHeader({", 'Cached header entrypoint not used');
assertIncludes(worker, "'x-moviwatch-cache': firstChunk.cacheStatus", 'Cache diagnostics header missing');
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
assertIncludes(worker, "if (req.headers.has('If-Range') && source.provider !== 'google-drive-private')", 'Private Drive If-Range requests must stay on the authenticated shared-cache path');
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

// Native HTML5 player: no custom player library, WASM, or browser range adapter.
assertIncludes(watch, '<video id="video" controls playsinline preload="none"', 'Native HTML5 video element with controls and lazy preload missing');
assertIncludes(watch, "video.src='/api/watch/'", 'Native video must use the protected same-origin Worker range endpoint');
assertIncludes(watch, "video.src='/api/watch/'+encodeURIComponent(movieId)+'/'+encodeURIComponent(source.source_index)", 'Native video source must be bound to the selected movie/source');
assertIncludes(watch, "body:JSON.stringify({movieId})", 'Watch page must request a movie-bound playback session');
assertIncludes(watch, "credentials:'same-origin'", 'Watch page must send the HttpOnly session cookie on same-origin requests');
assertIncludes(watch, 'id="downloadNow"', 'Protected Download Now action missing');
assertIncludes(watch, "'/api/download/'+encodeURIComponent(movieId)+'/'+encodeURIComponent(source.source_index)", 'Download Now must use protected Worker attachment route');
assertIncludes(worker.slice(downloadStart, downloadEnd), 'content-disposition', 'Download should remain an attachment served by Worker');
assert.ok(!watch.includes('movi-player') && !watch.includes('MoviwatchRangeSource') &&
  !watch.includes('player-range-source.js') && !watch.includes('element.slim.global.js') &&
  !watch.includes('movi.wasm'), 'The watch page must not load or depend on Movi-Player or its range adapter');
assert.ok(!watch.includes('download_url') && !watch.includes('directUrl.toString()'), 'Watch page must not expose provider URLs');
assertIncludes(watch, 'id="sourceSelect"', 'Multiple source selector missing');
assertIncludes(watch, 'select.hidden=availableSources.length<2', 'Single-source selector must be hidden');
assertIncludes(watch, 'getNativeAudioTracks()', 'Native audio track feature detection missing');
assertIncludes(watch, 'list[index].enabled=index===selected', 'Audio selector must switch native AudioTrack.enabled state');
assertIncludes(watch, "if(!list||list.length<2)", 'Audio selector must be hidden unless native video exposes multiple tracks');
assertIncludes(watch, "video.addEventListener('loadedmetadata',bindNativeAudioTrackEvents)", 'Native audio tracks must be discovered after metadata loads');
assertIncludes(watch, 'preload="none"', 'Native video must not preload media before the viewer plays');
assertIncludes(watch, 'controlslist="nodownload"', 'Use native browser controls without a duplicate browser download action');
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
assertIncludes(readme, '4 MiB continuation chunks', 'README must document 4 MiB chunks');
assertIncludes(readme, 'Native HTML5', 'README must document native HTML5 playback');
assertIncludes(readme, '24 hours', 'README must document the shared edge cache TTL');
assertIncludes(readme, 'browser decides its own buffering', 'README must document native browser-controlled buffering');
assertIncludes(readme, 'current cache-chunk boundary', 'README must explain bounded on-demand seek responses');
assertIncludes(readme, 'https://archive.org/download/IDENTIFIER/FILENAME', 'README must document canonical direct Archive.org downloads');
assertIncludes(readme, 'd1', 'README must document mirror failover');

assertIncludes(readme, 'A watch page obtains a short-lived signed playback session', 'README must describe the new playback authorization');
console.log('Drive/Archive URL, provider, cache, native HTML5 playback, protected Range/download, native audio-track selection, admin and inline-script checks passed.');

// Google Drive Manager: OAuth, private references and management routes stay server-side.
assertIncludes(worker, "provider:'google-drive-private'", 'Private Drive sources must use an internal provider marker');
assertIncludes(worker, 'googleDriveApiRequest(sqlFor(env), env, mediaUrl', 'Private Drive video ranges must be authorized by the Worker');
assertIncludes(worker, 'fetchConfiguredVideoRange(source, nextStart, nextEnd, env, 0, true, signal)', 'Private Drive continuation ranges must enter the progressive shared chunk cache');
assertIncludes(worker, 'recordArchiveFailure(details.identifier, candidate.host)', 'Archive.org stream failures must cool down the failed mirror');
assertIncludes(worker, 'AbortSignal.any([timeoutSignal, externalSignal])', 'Viewer cancellation must abort pending provider range requests');
assertIncludes(worker, 'fetchConfiguredVideoRange(source, responseStart, responseEnd, env, 0, true, req.signal)', 'Direct cold seeks must be tied to the browser request cancellation signal');
assertIncludes(videoStream, "maxRetries = 2", 'Stream relay retries must be bounded');
assertIncludes(videoStream, "abortController.abort(reason)", 'Cancelled playback must abort a pending continuation fetch');
assertIncludes(videoStream, "currentRange.start + currentBytes", 'A failed upstream stream must resume at the first missing byte');
assertIncludes(worker, "pathname === '/api/google-drive/oauth/callback'", 'OAuth callback route missing');
assertIncludes(worker, "path.startsWith('/api/admin/google-drive/')", 'Google Drive management must stay under the admin API gate');
assertIncludes(worker, 'refresh_token_ciphertext', 'Google refresh tokens must be encrypted at rest');
assertIncludes(worker, 'session_ciphertext', 'Resumable upload session URLs must be encrypted at rest');
assertIncludes(worker, 'new FixedLengthStream', 'Download size regression guard must remain in place');
assertIncludes(admin, 'id="googleDrivePanel"', 'Admin Google Drive Manager UI missing');
assertIncludes(worker, 'drive-private://', 'Admin API must preserve private Drive references without exposing them publicly');
assertIncludes(admin, "'Content-Range':'bytes '+offset+'-'+end+'/'+file.size", 'Admin uploads must send explicit byte ranges');
assert.ok(!/GOOGLE_CLIENT_SECRET|GOOGLE_DRIVE_ENCRYPTION_KEY|refresh_token=/.test(admin), 'Google OAuth secrets must never be embedded in the browser UI');


// Progressive cache relay tests: first bytes are delivered before later ranges
// are requested, partial upstream windows are stitched safely, and corrupt
// Content-Range/body combinations fail closed.
function byteStream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(Uint8Array.from(part));
      controller.close();
    }
  });
}
async function readAll(reader) {
  const output = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output;
    output.push(...value);
  }
}
{
  let continuationCalls = 0;
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 1, total: 4 }, body: byteStream([[0], [1]]) },
    end: 3,
    total: 4,
    fetchPart: async (start, end) => {
      continuationCalls++;
      assert.equal(start, 2);
      assert.equal(end, 3);
      return { range: { start: 2, end: 3, total: 4 }, body: byteStream([[2, 3]]) };
    }
  });
  const reader = relay.getReader();
  assert.deepEqual([...((await reader.read()).value)], [0]);
  assert.equal(continuationCalls, 0, 'First upstream bytes should reach the consumer before requesting the next range');
  assert.deepEqual([...((await reader.read()).value)], [1]);
  const last = await reader.read();
  assert.deepEqual([...last.value], [2, 3]);
  assert.equal(continuationCalls, 1);
  assert.equal((await reader.read()).done, true);
}
{
  let continuationCalls = 0;
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 0, total: 3 }, body: byteStream([[0]]) },
    end: 2,
    total: 3,
    fetchPart: async (start) => {
      continuationCalls++;
      return { range: { start, end: 2, total: 3 }, body: byteStream([[1, 2]]) };
    }
  });
  const reader = relay.getReader();
  const first = await readAll(reader);
  assert.deepEqual(first, [0, 1, 2]);
  assert.equal(continuationCalls, 1);
}
{
  let continuationCalls = 0;
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 1, total: 4 }, body: byteStream([[0]]) },
    end: 1,
    total: 4,
    fetchPart: async (start, end) => {
      continuationCalls++;
      assert.equal(start, 1);
      assert.equal(end, 1);
      return { range: { start: 1, end: 1, total: 4 }, body: byteStream([[1]]) };
    }
  });
  const reader = relay.getReader();
  assert.deepEqual(await readAll(reader), [0, 1]);
  assert.equal(continuationCalls, 1, 'A truncated upstream body must resume at the first missing byte');
}
{
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 0, total: 3 }, body: byteStream([[0]]) },
    end: 2,
    total: 3,
    fetchPart: async () => ({
      range: { start: 2, end: 2, total: 3 },
      body: byteStream([[2]])
    })
  });
  const reader = relay.getReader();
  assert.deepEqual([...((await reader.read()).value)], [0]);
  await assert.rejects(() => reader.read(), /non-contiguous or inconsistent byte range/);
}
{
  let continuationCalls = 0;
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 1, total: 4 }, body: byteStream([[0], [1]]) },
    end: 3,
    total: 4,
    fetchPart: async () => { continuationCalls++; throw new Error('cancelled relay fetched extra bytes'); }
  });
  const reader = relay.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(continuationCalls, 0, 'Cancelled playback must not trigger an extra upstream range');
}

// A source can fail after sending part of a declared range. The relay resumes
// from the first missing byte, so it never repeats or skips already-emitted data.
{
  let continuationCalls = 0;
  const interrupted = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0]));
      controller.error(new Error('simulated upstream connection reset'));
    }
  });
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 2, total: 3 }, body: interrupted },
    end: 2,
    total: 3,
    fetchPart: async (start, end) => {
      continuationCalls++;
      assert.equal(start, 1, 'Resume must start at the first byte not already delivered');
      assert.equal(end, 2);
      return { range: { start: 1, end: 2, total: 3 }, body: byteStream([[1, 2]]) };
    }
  });
  const reader = relay.getReader();
  const output = await readAll(reader);
  assert.deepEqual(output, [0, 1, 2]);
  assert.equal(continuationCalls, 1);
}
{
  const interrupted = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0]));
      controller.error(new Error('simulated permanent reset'));
    }
  });
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 2, total: 3 }, body: interrupted },
    end: 2,
    total: 3,
    maxRetries: 0,
    fetchPart: async () => { throw new Error('maxRetries=0 must not retry'); }
  });
  const reader = relay.getReader();
  assert.deepEqual([...((await reader.read()).value)], [0]);
  await assert.rejects(() => reader.read(), /simulated upstream connection reset/);
}


// When a viewer cancels during an upstream continuation request, the relay
// abort signal must reach that fetch so a discarded seek does not waste bytes.
{
  let continuationSignal = null;
  const relay = createRangeRelayStream({
    firstPart: { range: { start: 0, end: 0, total: 2 }, body: byteStream([[0]]) },
    end: 1,
    total: 2,
    fetchPart: async (_start, _end, signal) => {
      continuationSignal = signal;
      return await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('upstream continuation aborted')), { once: true });
      });
    }
  });
  const reader = relay.getReader();
  assert.deepEqual([...((await reader.read()).value)], [0]);
  const pending = reader.read();
  await Promise.resolve();
  await reader.cancel('viewer seeked elsewhere');
  assert.ok(continuationSignal?.aborted, 'Cancel must abort the pending upstream Range fetch');
  await pending.catch(() => {});
}

console.log('Progressive range relay, upstream continuation, truncation, discontinuity and cancellation checks passed.');
