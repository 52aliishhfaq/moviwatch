import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const worker = readFileSync('src/index.js', 'utf8');
const watch = readFileSync('public/watch.html', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert((config.compatibility_flags || []).includes('enable_ctx_exports'),
  'wrangler.jsonc must enable ctx.exports');
assert(config.cache?.enabled === true, 'Workers Cache must be enabled');
assert(config.exports?.default?.cache?.enabled === false,
  'The gateway entrypoint must bypass cache lookups');
for (const name of ['PublicCatalogue', 'MovieMetadata', 'VideoChunk', 'VideoHeader']) {
  assert(config.exports?.[name]?.type === 'worker' && config.exports?.[name]?.cache?.enabled === true,
    name + ' must use a cached Worker entrypoint');
  assert(worker.includes('export class ' + name + ' extends WorkerEntrypoint'),
    name + ' class is missing from src/index.js');
}
assert(worker.includes('ctx.exports.VideoHeader({') && worker.includes('await headerEntry.fetch('),
  'MP4 headers must be fetched through the tiered cached VideoHeader entrypoint');
assert(worker.includes("Range: 'bytes=0-' + (VIDEO_HEADER_PROBE_SIZE - 1)") &&
  worker.includes('VIDEO_HEADER_PROBE_SIZE = 16 * 1024') &&
  worker.includes('mp4MoovEnd(bytes)') && worker.includes('mp4HasMvex(bytes)'),
  'The header probe must detect moov size and fragmented MP4 metadata');
assert(worker.includes('VIDEO_FRAGMENT_START_CHUNK_SIZE = 512 * 1024') &&
  worker.includes('videoChunkStartForOffset(offset, fragmented)') &&
  worker.includes('videoChunkSizeAt(chunkStart, fragmented)'),
  'Fragmented MP4 must use a small first segment and 4 MiB follow-up segments');
assert(worker.includes('prefetched.set(starts[i], chunkPromises[i])') &&
  worker.includes('ctx.waitUntil(Promise.allSettled(chunkPromises))') &&
  worker.includes("cacheStatus = 'PREFETCH'"),
  'Startup and next-segment cache fills must run concurrently in the background');
assert(worker.includes('const pending = prefetched.get(expectedChunkStart)') &&
  worker.includes('? await pending'),
  'The stream must await only the chunk currently needed by the browser');
assert(worker.includes("'x-moviwatch-stream-profile': fragmented ? 'single-file-fmp4' : 'range-stream'"),
  'The Worker must expose whether the served source is a V6 single-file fMP4');
assert(worker.includes("'x-moviwatch-fragmented': String(fragmented)") &&
  worker.includes("'x-moviwatch-startup-chunk-size': String(videoChunkSizeAt(0, fragmented))"),
  'Streaming diagnostics must disclose the detected format and startup segment size');
assert(worker.includes("ctx.exports.VideoHeader().invalidate(movieId)"),
  'Video header cache must be purged when a movie is edited or deleted');
const invalidationBody = worker.slice(
  worker.indexOf('async function invalidateContentCaches('),
  worker.indexOf('\nfunction allowedDriveHost', worker.indexOf('async function invalidateContentCaches('))
);
assert(invalidationBody.includes('operations.map((operation) => Promise.resolve().then(operation))'),
  'Cache invalidation must capture synchronous entrypoint-factory errors so committed movie edits do not return HTTP 500');
assert(worker.includes('ctx.exports.VideoChunk({') && worker.includes('await videoEntry.fetch('),
  'Video chunks must be fetched through the tiered cached entrypoint');
const videoFetchBody = worker.slice(worker.indexOf('async function getVideoChunk('), worker.indexOf('async function getVideoHeader('));
assert(videoFetchBody.includes('sourceVersion: normalizedSourceVersion') &&
  videoFetchBody.includes("chunkStart + '/' + chunkSize"),
  'Video cache entrypoint must receive normalized source metadata and chunk-size-aware cache keys');
assert(worker.includes('fetchAndCacheVideoChunk({ url: sourceUrl }, chunkStart, chunkSize)'),
  'Chunk fill must use the requested adaptive segment size');
assert(worker.includes('ctx.exports.MovieMetadata({ props: { movieId } })') &&
  worker.includes('ctx.exports.PublicCatalogue({ props: { category, query } })'),
  'Loopback entrypoints must receive props using the documented binding factory');
assert(worker.includes("catalogueUrl.searchParams.set('category', category)") &&
  worker.includes("catalogueUrl.searchParams.set('q', query)"),
  'Catalogue cache keys must vary by category and search query');
const catalogueGateway = worker.slice(worker.indexOf("if (path === '/api/movies'"), worker.indexOf("const download = path.split('/');"));
assert(catalogueGateway.includes("'cache-control': 'private, no-store, max-age=0'") &&
  catalogueGateway.includes("'vercel-cdn-cache-control': 'no-store'"),
  'Catalogue gateway must bypass outer Vercel CDN caching and expose Cloudflare cache status');
assert(worker.includes("host === 'accounts.google.com'") &&
  worker.includes('Google Drive file requires sign-in'),
  'Private Google Drive redirects must return a clear sharing-permission error');
assert(worker.includes('sourceVersion instanceof Date') && worker.includes('normalizedSourceVersion'),
  'Source version must be normalized before it crosses the entrypoint boundary');
assert(worker.includes("const expectedChunkStart = videoChunkStartForOffset(cursor, fragmented)") &&
  worker.includes("videoChunkSizeAt(expectedChunkStart, fragmented)"),
  'Every byte range, including a seek or suffix range, must map to the correct adaptive segment');
assert(!worker.includes('const response = await cachedVideoRange(req, source, watch[3]'),
  'Unreachable duplicate watch streaming code must be removed');
assert(worker.includes("'cache-tag': 'video-chunks-' + movieId"),
  'Video chunks must be tagged for movie-level purging');
assert(!worker.includes('caches.default') && !worker.includes('inflightVideoChunks'),
  'The old local-only Cache API chunk cache must be removed');
assert(watch.includes('id="sourceSelect"') && watch.includes("'/api/watch/'+encodeURIComponent(movieId)+'/'+activeOptionIndex") &&
  watch.includes("sourceSelect.addEventListener") === false && watch.includes("$('#sourceSelect').addEventListener('change'"),
  'The V6 player must expose video source selection and request the selected Worker stream');
assert(watch.includes('Filmio V6 output is a single-file fragmented MP4') &&
  watch.includes('},30000);') && watch.includes('validated Filmio V6 single-file fMP4'),
  'The player must identify V6 fMP4 and use a bounded startup watchdog');
assert(!/method\s*:\s*['"]HEAD['"]/.test(watch),
  'Watch page must not make eager HEAD requests on page load');
assert(!watch.includes("Range:'bytes=0-1'") && watch.includes('preload="auto"'),
  'The player must use browser-managed eager preload without a redundant probe');

console.log('Validated adaptive fMP4 startup, 4 MiB continuation, range-seek mapping, and cache entrypoints.');
