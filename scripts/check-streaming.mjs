import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const worker = readFileSync('src/index.js', 'utf8');
const watch = readFileSync('public/watch.html', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');

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
  worker.includes('VIDEO_CHUNK_SIZE = 4 * 1024 * 1024') &&
  worker.includes('videoChunkStartForOffset(offset, fragmented)') &&
  worker.includes('videoChunkSizeAt(chunkStart, fragmented)'),
  'Fragmented MP4 must use a small first segment and 4 MiB follow-up segments');
assert(worker.includes('prefetched.set(starts[i], chunkPromises[i])') &&
  worker.includes('ctx.waitUntil(Promise.allSettled(chunkPromises))') &&
  worker.includes("cacheStatus = 'PREFETCH'"),
  'Startup and next-segment cache fills must run concurrently in the background');
assert(worker.includes('const pending = prefetched.get(expectedChunkStart)') &&
  worker.includes('? await pending') && worker.includes('prefetched.delete(expectedChunkStart)') &&
  worker.includes('const nextChunkStart = chunk.end + 1') &&
  worker.includes('ctx.waitUntil(Promise.allSettled([nextPromise]))'),
  'The stream must await only the needed chunk, release consumed buffers, and warm the next segment in the background');
assert(worker.includes("'x-moviwatch-stream-profile': fragmented ? 'single-file-fmp4' : 'range-stream'"),
  'The Worker must expose whether the served source is a V6 single-file fMP4');
assert(worker.includes("'x-moviwatch-fragmented': String(fragmented)") &&
  worker.includes("'x-moviwatch-startup-chunk-size': String(videoChunkSizeAt(0, fragmented))"),
  'Streaming diagnostics must disclose the detected format and startup segment size');
assert(worker.includes("ctx.exports.VideoHeader().invalidate(movieId)"),
  'Video header cache must be purged when a movie is edited or deleted');
const invalidationBody = worker.slice(
  worker.indexOf('async function invalidateContentCaches('),
  worker.indexOf('\nfunction allowedSourceHost', worker.indexOf('async function invalidateContentCaches('))
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
assert(worker.includes("host === 'archive.org' || host.endsWith('.archive.org')") &&
  worker.includes('function videoSourceFetch') && worker.includes('sourceKind(host)'),
  'Public Archive.org direct-download URLs and redirects must use the same range-streaming proxy');
assert(worker.includes('function sourceProvider(input)') && worker.includes("provider: sourceProvider(sourceUrl)") &&
  worker.includes("return 'doodstream'") && worker.includes("url.pathname = '/e/' + parts[1]") &&
  worker.includes("'playmogo.com'"),
  'Doodstream /e/, /d/, and PlayMogo embed links must be validated and normalized');
assert(admin.includes('Archive.org direct download') && admin.includes('Doodstream embed URL') &&
  admin.includes('doodCount') && admin.includes('Doodstream)'),
  'Admin must document Doodstream embed links and show source counts');
assert(worker.includes("'embed_url', CASE WHEN item.value->>'provider'='doodstream' THEN item.value->>'url' ELSE NULL END") &&
  worker.includes("source.provider === 'doodstream'"),
  'Only Doodstream embed URLs may be exposed publicly, and Doodstream must bypass MP4 range/download proxying');
assert(worker.includes("provider: source.provider || 'google-drive'") &&
  worker.includes("embed_url: source.provider === 'doodstream' ? source.embed_url : null"),
  'The public catalogue must retain provider metadata and only expose hosted-player embed URLs, otherwise the watch page misroutes embeds to /api/watch');
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
assert(watch.includes('id="sourceSelect"') && watch.includes("'/api/watch/'+encodeURIComponent(movieId)+'/'+index") &&
  watch.includes("$('#sourceSelect').addEventListener('change'") &&
  watch.indexOf('<movi-player id="video"') < watch.indexOf('id="playerToolbar"') &&
  watch.includes("$('#playerToolbar').hidden=availableSources.length<2;"),
  'The playback quality selector must appear below the player only when multiple sources exist, preserving source switching');
assert(watch.includes('id="doodstreamStage"') && watch.includes("source?.provider==='doodstream'") &&
  watch.includes("frame.src=source.embed_url") && watch.includes("video.style.visibility='hidden'") &&
  watch.includes("doodstreamStage.hidden=true") && watch.includes("if(!doodstreamStage.hidden)return"),
  'Doodstream must render as an overlay inside the existing Movi Player stage and switch cleanly back to native playback');
assert(watch.includes('Connecting to the V6 stream and loading the first media fragment…') &&
  watch.includes('},30000);') && watch.includes('supports byte ranges'),
  'The player must use metadata-first V6 playback and a bounded startup watchdog');
assert(worker.includes('function playMogoDownloadUrl(input)') &&
  worker.includes("return url.origin + '/d/' + match[1]") &&
  worker.includes("download_url: source.provider === 'doodstream' ? playMogoDownloadUrl(source.embed_url) : null"),
  'A validated PlayMogo /e/ embed URL must generate the matching /d/ URL for the same video ID');
assert(watch.includes('function playMogoDownloadUrlFromEmbed(input)') &&
  watch.includes("const playMogoDownloadUrl=source.provider==='doodstream'") &&
  watch.includes("playMogoDownloadUrlFromEmbed(source.embed_url)") &&
  watch.includes("link.href=playMogoDownloadUrl;"),
  'The watch page must safely derive a PlayMogo /d/ download URL from the embed URL even when a cached catalogue lacks download_url');
assert(watch.includes('id="downloadNowPanel"') && watch.includes('id="downloadNow"') &&
  watch.includes("source.download_url") &&
  watch.includes("source.provider==='doodstream'") &&
  watch.includes("source.download_url") &&
  watch.includes("link.target='_blank'") &&
  watch.includes("Download Dual Audio Movie English + Hindi") &&
  watch.includes("Opens PlayMogo’s download page for this exact video."),
  'Download Now must open the matching PlayMogo download route when a validated PlayMogo embed is selected');
assert(watch.includes("'/api/download/'+encodeURIComponent(movieId)+'/'+index") &&
  watch.includes("['google-drive','archive.org'].includes(source.provider)"),
  'Google Drive and Archive.org must keep their existing download route');
assert(!watch.includes('id="doodstreamFallback"') && !watch.includes('id="playerToolbar"') &&
  !watch.includes('id="sourceSelect"') && !watch.includes('id="downloads"') &&
  !watch.includes('Open hosted player directly') && !watch.includes('Choose playback quality'),
  'The watch page must hide the hosted-player shortcut, quality picker, and legacy download list');
assert(!/method\s*:\s*['"]HEAD['"]/.test(watch),
  'Watch page must not make eager HEAD requests on page load');
assert(!watch.includes("Range:'bytes=0-1'") && watch.includes('preload="metadata"') &&
  watch.includes("video.preload='metadata'") && watch.includes("streamUrl='/api/watch/'") &&
  watch.includes('encodeURIComponent(movieId)') && watch.includes('video.load()'),
  'The player must use metadata-only startup and native byte-range seeking without a redundant probe');
assert(worker.includes('const startupPrefetch = req.method === \'GET\' && !parsed.suffix && parsed.start === 0') &&
  worker.includes('const firstStart = videoChunkStartForOffset(start, fragmented)') &&
  worker.includes('const nextChunkStart = chunk.end + 1'),
  'Startup prefetch must be limited to initial playback; seeks must fetch the target segment and warm only its immediate successor');

console.log('Validated adaptive fMP4 startup, 4 MiB continuation, seek-range diagnostics, next-segment prefetch, range-seek mapping, and cache entrypoints.');
