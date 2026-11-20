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
assertIncludes(worker, 'props: { sourceUrl: source.url, sourceVersion: normalizedSourceVersion }', 'Video cache key must use source identity and version, not viewer identity');
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
assert.ok(!catalogue.includes("'url':") && !catalogue.includes("url:source.url"),
  'Public catalogue must not expose provider URLs');

assertIncludes(worker, "const watch = path.split('/')", 'Watch proxy route missing');
assertIncludes(worker, "const download = path.split('/')", 'Download proxy route missing');
assertIncludes(worker, 'cachedVideoRange(', 'Proxy must use the edge chunk cache');
assertIncludes(worker, 'content-disposition', 'Google Drive Worker download attachment header missing');
assertIncludes(worker, "Response.redirect(archiveDownloadUrl(source.url), 302)", 'Archive.org downloads must redirect directly to Archive.org');
assertIncludes(worker, 'content-range', 'HTTP content-range support missing');
assertIncludes(sourceModule, "return host==='archive.org'||host.endsWith('.archive.org')?'archive.org':'google-drive'", 'Archive provider detection missing');
assert.ok(!/doodstream|playmogo|voe\.sx/i.test(worker), 'Legacy hosts must not remain in the Worker');

// Vercel / Cloudflare routing and responsive player controls.
assertIncludes(watch, 'id="video"', 'Movi Player element missing');
assertIncludes(watch, "const streamUrl='/api/watch/'", 'Player source must use the Worker range endpoint');
assertIncludes(watch, 'new window.MoviwatchRangeSource(streamUrl', 'Player must use the controlled range adapter');
assertIncludes(watch, 'video.sourceAdapter=activeRangeSource', 'Movi Player must receive the custom range source');
assertIncludes(watch, "'/api/download/'+encodeURIComponent(movieId)+'/'+source.source_index", 'Download action must use the same selected source');
assertIncludes(watch, 'id="sourceSelect"', 'Multiple source selector missing');
assertIncludes(watch, 'const PLAYER_BUFFER_SIZE_MB=32', '32 MiB player memory limit missing');
assertIncludes(watch, 'const PLAYER_RANGE_CHUNK_SIZE=1024*1024', '1 MiB player request size missing');
assertIncludes(watch, 'const PLAYER_PREFETCH_AHEAD=2', 'Two-range player prefetch setting missing');
assertIncludes(watch, 'preload="metadata" buffersize="32"', 'Player must keep metadata preload while applying the bounded 32 MiB range buffer');
assertIncludes(watch, "video.preload='metadata'", 'Player source switch must preserve conservative native fallback preload');
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
assertIncludes(readme, 'directly to Internet Archive', 'README must document direct Archive.org downloads');
assertIncludes(readme, 'd1', 'README must document mirror failover');

console.log('Drive/Archive URL, provider, cache, range, download, admin, watch and inline-script checks passed.');
