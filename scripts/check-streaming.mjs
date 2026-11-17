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
assert(worker.includes("Range: 'bytes=0-255'") && worker.includes('mp4MoovEnd(bytes)'),
  'Startup metadata discovery must use a small byte-range header probe');
assert(worker.includes('Promise.all(starts.map((chunkStart)') &&
  worker.includes('startupPrefetchCount'),
  'MP4 metadata chunks must be prefetched concurrently before playback');
assert(worker.includes("ctx.exports.VideoHeader().invalidate(movieId)"),
  'Video header cache must be purged when a movie is edited or deleted');
assert(worker.includes('ctx.exports.VideoChunk({') && worker.includes('await videoEntry.fetch('),
  'Video chunks must be fetched through the tiered cached entrypoint');
const videoFetchBody = worker.slice(worker.indexOf('async function getVideoChunk('), worker.indexOf('async function fetchAndCacheVideoChunk('));
assert(videoFetchBody.includes('sourceVersion: normalizedSourceVersion') && !videoFetchBody.includes('String(sourceVersion'),
  'Video cache entrypoint must receive the normalized source version without an undefined variable');
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
assert(/getVideoChunk\(\s*ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash, firstChunkStart/.test(worker),
  'Suffix ranges must fetch their second chunk with the correct cache context');
assert(!worker.includes('const response = await cachedVideoRange(req, source, watch[3]'),
  'Unreachable duplicate watch streaming code must be removed');
assert(worker.includes("'cache-tag': 'video-chunks-' + movieId"),
  'Video chunks must be tagged for movie-level purging');
assert(!worker.includes('caches.default') && !worker.includes('inflightVideoChunks'),
  'The old local-only Cache API chunk cache must be removed');
assert(!/method\s*:\s*['"]HEAD['"]/.test(watch),
  'Watch page must not make eager HEAD requests on page load');
assert(watch.includes("Range:'bytes=0-1'"),
  'Watch page must retain the small stream readiness probe');

console.log('Validated tiered cache entrypoints, cache purging, and lazy download metadata.');
