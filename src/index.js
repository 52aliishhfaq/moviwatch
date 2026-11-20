import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { videoSourceUrl, sourceProvider, archiveDownloadUrl } from './video-sources.js';

const COOKIE = 'moviwatch_admin';
const SESSION = 8 * 60 * 60;
const CATEGORIES = new Set(['Action', 'Romantic']);
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers }
});
const sqlFor = (env) => {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
  return neon(env.DATABASE_URL);
};
const redisFor = (env) => new Redis({ url: env.REDIS_REST_URL, token: env.REDIS_REST_TOKEN, enableTelemetry: false });
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value) => {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]+$/i.test(value)) throw new Error('Invalid secret');
  return new Uint8Array(value.match(/.{2}/g).map((x) => parseInt(x, 16)));
};
const b64 = (value) => {
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};
const unb64 = (value) => {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
async function makeToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ sub: 'admin', iat: now, exp: now + SESSION }));
  const unsigned = head + '.' + payload;
  return unsigned + '.' + b64(await hmac(enc.encode(env.JWT_SECRET), enc.encode(unsigned)));
}
async function validToken(env, token) {
  try {
    const p = token.split('.');
    if (p.length !== 3) return false;
    const head = JSON.parse(new TextDecoder().decode(unb64(p[0])));
    const body = JSON.parse(new TextDecoder().decode(unb64(p[1])));
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== 'HS256' || body.sub !== 'admin' || !Number.isInteger(body.exp) || body.exp <= now || body.iat > now + 60) return false;
    const sig = await hmac(enc.encode(env.JWT_SECRET), enc.encode(p[0] + '.' + p[1]));
    const got = unb64(p[2]);
    if (got.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig[i] ^ got[i];
    return diff === 0;
  } catch { return false; }
}
function getCookie(req) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
async function isAdmin(req, env) {
  const value = getCookie(req);
  return Boolean(value && env.JWT_SECRET && await validToken(env, value));
}
function sameOrigin(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) throw new Error('Origin header is required');
  let incoming;
  try { incoming = new URL(origin).origin; } catch { throw new Error('Invalid Origin header'); }
  const trusted = new Set([new URL(req.url).origin]);
  for (const candidate of (env.APP_ORIGINS || '').split(',')) {
    const value = candidate.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:') trusted.add(parsed.origin);
    } catch { /* Ignore malformed allowlist entries. */ }
  }
  if (!trusted.has(incoming)) throw new Error('Cross-origin request blocked');
}
async function readBody(req) {
  if (!(req.headers.get('content-type') || '').toLowerCase().includes('application/json')) throw new Error('Content-Type must be application/json');
  const raw = await req.text();
  if (enc.encode(raw).byteLength > 32000) throw new Error('Request body too large');
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}
async function loginLimit(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(ip));
  const key = 'moviwatch:login:' + hex(new Uint8Array(digest));
  const r = redisFor(env);
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, 600);
  return count <= 10;
}
function movieInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Movie details are required');
  const title=typeof body.title==='string'?body.title.trim():'';
  if(!title||title.length>200)throw new Error('Movie name is required (max 200 characters)');
  if(!CATEGORIES.has(body.category))throw new Error('Category must be Action or Romantic');
  let poster;try{poster=new URL(body.posterUrl)}catch{throw new Error('Poster must be an HTTPS URL')}
  if(poster.protocol!=='https:'||poster.href.length>2048||poster.username||poster.password)throw new Error('Poster must be an HTTPS URL');
  if(!Array.isArray(body.videoSources)||body.videoSources.length<1||body.videoSources.length>8)throw new Error('Add between 1 and 8 Google Drive or Archive.org video links');
  const sources=body.videoSources.map((item,index)=>{const url=videoSourceUrl(item?.url);const provider=sourceProvider(url);const fallback=provider==='archive.org'?'Archive.org':'Google Drive';return{label:(typeof item?.label==='string'&&item.label.trim()?item.label.trim():fallback+' '+(index+1)).slice(0,60),url,provider}});
  return{title,poster:poster.href,category:body.category,sources,published:body.isPublished!==false};
}
function storedVideoSource(movie,optionIndex){
  if(!movie||!Number.isInteger(optionIndex)||optionIndex<0||optionIndex>7)return null;
  const raw=movie.video_sources?.[optionIndex];if(!raw||typeof raw.url!=='string')return null;
  try{const url=videoSourceUrl(raw.url);return{...raw,url,provider:sourceProvider(url)}}catch{return null}
}
const CATALOGUE_CACHE_TTL = 30;
const MOVIE_METADATA_CACHE_TTL = 30;

async function publicMovies(env,category,query){
 const sql=sqlFor(env);
 return await sql`SELECT id,title,poster_url,category,created_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('label',COALESCE(NULLIF(item.value->>'label',''),'Video'),'url',item.value->>'url','source_index',item.ordinality-1) ORDER BY item.ordinality)
  FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) WITH ORDINALITY AS item(value,ordinality)),'[]'::jsonb) AS video_sources
 FROM movies WHERE is_published=TRUE
 AND (${category||null}::text IS NULL OR category=${category||null})
 AND (${query||null}::text IS NULL OR title ILIKE ${query?'%'+query+'%':null})
 ORDER BY created_at DESC LIMIT 100`;
}
export class PublicCatalogue extends WorkerEntrypoint {
 async fetch(request){
  if(request.method!=='GET')return new Response(null,{status:405,headers:{allow:'GET','cache-control':'no-store'}});
  const{category='',query=''}=this.ctx.props||{};
  const rows=await publicMovies(this.env,category,query);
  const movies=rows.flatMap(({video_sources,...movie})=>{
   const playable=(video_sources||[]).flatMap(source=>{try{const url=videoSourceUrl(source.url);const index=Number(source.source_index);if(!Number.isInteger(index)||index<0||index>7)return[];return[{label:source.label||(sourceProvider(url)==='archive.org'?'Archive.org':'Google Drive'),provider:sourceProvider(url),source_index:index}]}catch{return[]}});
   return playable.length?[{...movie,video_sources:playable}]:[];
  });
  return json({movies},200,{'cache-control':'public, max-age='+CATALOGUE_CACHE_TTL+', stale-while-revalidate=120','cache-tag':'public-catalogue'});
 }
 async invalidate(){return this.ctx.cache.purge({tags:['public-catalogue']})}
}
export class MovieMetadata extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
    const movieId = this.ctx.props?.movieId;
    if (typeof movieId !== 'string' || !/^[0-9a-f-]{36}$/i.test(movieId)) {
      return json({ movie: null }, 200, { 'cache-control': 'public, max-age=5' });
    }
    const rows = await sqlFor(this.env)`SELECT id,title,videos AS video_sources,updated_at
      FROM movies WHERE id=${movieId} AND is_published=TRUE LIMIT 1`;
    return json({ movie: rows[0] || null }, 200, {
      'cache-control': 'public, max-age=' + MOVIE_METADATA_CACHE_TTL + ', stale-while-revalidate=90',
      'cache-tag': 'movie-meta-' + movieId
    });
  }

  async invalidate(movieId) {
    if (typeof movieId !== 'string' || !/^[0-9a-f-]{36}$/i.test(movieId)) return { success: false };
    return this.ctx.cache.purge({ tags: ['movie-meta-' + movieId] });
  }
}

async function movieById(ctx, env, movieId) {
  if (!/^[0-9a-f-]{36}$/i.test(movieId)) return { movie: null, cacheStatus: 'BYPASS' };
  const metadataEntry = ctx.exports.MovieMetadata({ props: { movieId } });
  const response = await metadataEntry.fetch(
    new Request('https://moviwatch.internal/__movie_metadata__v2/' + encodeURIComponent(movieId))
  );
  if (!response.ok) throw new Error('Movie metadata lookup failed (HTTP ' + response.status + ')');
  const payload = await response.json();
  return {
    movie: payload.movie || null,
    cacheStatus: response.headers.get('cf-cache-status') || 'UNKNOWN'
  };
}

async function invalidateContentCaches(ctx, movieId) {
  // Defer each entrypoint factory call into its own promise. Promise.allSettled()
  // cannot catch a synchronous throw that happens while building an eager array.
  // A cache-purge problem must never turn an already-committed movie edit into
  // an HTTP 500 response.
  const operations = [() => ctx.exports.PublicCatalogue().invalidate()];
  if (movieId) {
    operations.push(
      () => ctx.exports.MovieMetadata({ props: { movieId } }).invalidate(movieId),
      () => ctx.exports.VideoChunk().invalidate(movieId),
      () => ctx.exports.VideoHeader().invalidate(movieId)
    );
  }
  const results = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation))
  );
  for (const result of results) {
    if (result.status === 'rejected') console.warn('Workers Cache invalidation failed:', result.reason?.message || result.reason);
  }
}

function allowedSourceHost(host) {
  host = host.toLowerCase();
  return host === 'drive.google.com' || host === 'drive.usercontent.google.com' || host.endsWith('.googleusercontent.com') || host === 'archive.org' || host.endsWith('.archive.org');
}
function sourceKind(host) {
  host = host.toLowerCase();
  return host === 'archive.org' || host.endsWith('.archive.org') ? 'Archive.org' : 'Google Drive';
}
async function videoSourceFetch(source, method, headers, signal) {
  let url = new URL(source);
  // Normalize legacy database URLs to Google's direct download endpoint.
  if (url.hostname.toLowerCase() === 'drive.google.com' && url.pathname === '/uc') {
    const id = url.searchParams.get('id');
    if (id) url = new URL('https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t');
  }
  let currentMethod = method;
  for (let hop = 0; hop <= 5; hop++) {
    if (url.protocol !== 'https:') throw new Error('Video-source redirect must use HTTPS');
    const host = url.hostname.toLowerCase();
    if ((host === 'accounts.google.com' || host.endsWith('.accounts.google.com')) && sourceKind(new URL(source).hostname) === 'Google Drive') {
      throw new Error('Google Drive file requires sign-in. In Google Drive, set General access to Anyone with the link (Viewer), save, and try again.');
    }
    if (!allowedSourceHost(host)) throw new Error('Unsupported video-source redirect');
    const options = { method: currentMethod, headers, redirect: 'manual' };
    if (signal) options.signal = signal;
    const res = await fetch(url.toString(), options);
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('Location');
    if (!location || hop === 5) throw new Error('Video-source redirect limit reached');
    try { await res.body?.cancel(); } catch {}
    url = new URL(location, url);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod !== 'HEAD')) currentMethod = 'GET';
  }
  throw new Error('Video-source redirect limit reached');
}

// Video edge cache: store complete 8 MiB continuation chunks as cacheable 200 responses.
// The public response is reconstructed as a standards-compliant 206 response.
const VIDEO_CHUNK_SIZE = 8 * 1024 * 1024;
// Fragmented MP4 keeps its initial moov + first media fragments compact.
// Fetch a smaller first block so playback does not wait for a large initial transfer.
const VIDEO_FRAGMENT_START_CHUNK_SIZE = 512 * 1024;
const VIDEO_HEADER_PROBE_SIZE = 16 * 1024;
const VIDEO_CACHE_TTL = 24 * 60 * 60;

function parseByteRange(value) {
  if (typeof value !== 'string' || !value.startsWith('bytes=')) return null;
  const spec = value.slice(6).trim();
  if (spec.includes(',')) return { invalid: true };
  const match = /^([0-9]*)-([0-9]*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : { invalid: true };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || start < 0 ||
      (end !== null && (!Number.isSafeInteger(end) || end < start))) return { invalid: true };
  return { start, end };
}

function sniffVideoContainer(bytes) {
  // ISO-BMFF files can place free/wide boxes before the ftyp signature.
  const scanLimit = Math.min(bytes.length - 4, 65536);
  for (let i = 4; i <= scanLimit; i++) {
    if (bytes[i] === 0x66 && bytes[i + 1] === 0x74 &&
        bytes[i + 2] === 0x79 && bytes[i + 3] === 0x70) return 'mp4';
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'AVI ') return 'avi';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 &&
      bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536))).toLowerCase();
    return header.includes('webm') ? 'webm' : header.includes('matroska') ? 'mkv' : 'ebml';
  }
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'OggS') return 'ogg';
  if (bytes.length >= 3 && String.fromCharCode(...bytes.subarray(0, 3)) === 'FLV') return 'flv';
  if (bytes.length >= 1 && bytes[0] === 0x47) return 'mpeg-ts-or-unknown';
  return 'unknown';
}

function parseContentRange(value) {
  const match = new RegExp('^bytes ([0-9]+)-([0-9]+)/([0-9]+)$').exec(value || '');
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || end < start || total <= end) return null;
  return { start, end, total };
}

async function getVideoChunk(ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash, chunkStart, chunkSize = VIDEO_CHUNK_SIZE) {
  const internalUrl = new URL(
    '/__video_chunk__/' + encodeURIComponent(movieId) + '/' + optionIndex + '/' + sourceHash + '/' + chunkStart + '/' + chunkSize,
    'https://moviwatch.internal'
  );
  const videoEntry = ctx.exports.VideoChunk({
    props: { sourceUrl: source.url, sourceVersion: normalizedSourceVersion }
  });
  const response = await videoEntry.fetch(new Request(internalUrl));
  const cacheStatus = response.headers.get('cf-cache-status') || 'UNKNOWN';

  if (response.status === 416) {
    const total = Number((response.headers.get('content-range') || '').split('/')[1]);
    return { unsatisfiedTotal: Number.isSafeInteger(total) ? total : 0, cacheStatus };
  }
  if (!response.ok) {
    let detail = 'Video chunk fetch failed (HTTP ' + response.status + ')';
    try {
      const payload = await response.json();
      if (typeof payload.error === 'string') detail = payload.error;
    } catch {}
    throw new Error(detail);
  }

  const start = Number(response.headers.get('x-moviwatch-start'));
  const end = Number(response.headers.get('x-moviwatch-end'));
  const total = Number(response.headers.get('x-moviwatch-total'));
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const container = response.headers.get('x-moviwatch-container') || 'unknown';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) || start !== chunkStart || end < start ||
      total <= end || end > chunkStart + chunkSize - 1 || bytes.byteLength !== end - start + 1) {
    throw new Error('Cloudflare returned an invalid cached video chunk');
  }
  return { bytes, start, end, total, contentType, container, cacheStatus };
}

async function getVideoHeader(ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash) {
  const internalUrl = new URL(
    '/__video_header__/' + encodeURIComponent(movieId) + '/' + optionIndex + '/' + sourceHash,
    'https://moviwatch.internal'
  );
  const headerEntry = ctx.exports.VideoHeader({
    props: { sourceUrl: source.url, sourceVersion: normalizedSourceVersion }
  });
  const response = await headerEntry.fetch(new Request(internalUrl));
  if (!response.ok) {
    let detail = 'Video metadata probe failed (HTTP ' + response.status + ')';
    try {
      const payload = await response.json();
      if (typeof payload.error === 'string') detail = payload.error;
    } catch {}
    throw new Error(detail);
  }
  const payload = await response.json();
  if (!Number.isSafeInteger(payload.total) || payload.total < 1 ||
      (payload.moovEnd !== null && (!Number.isSafeInteger(payload.moovEnd) || payload.moovEnd < 0))) {
    throw new Error('Video source returned invalid MP4 metadata');
  }
  return {
    total: payload.total,
    moovEnd: payload.moovEnd,
    container: payload.container || 'unknown',
    contentType: payload.contentType || 'video/mp4',
    fragmented: payload.fragmented === true,
    cacheStatus: response.headers.get('cf-cache-status') || 'UNKNOWN'
  };
}

function mp4MoovEnd(bytes) {
  // Parse top-level ISO-BMFF boxes from the small cached file-header probe.
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let count = 0; count < 16 && offset + 8 <= bytes.byteLength; count++) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) return null;
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      return null;
    }
    if (size < headerSize) return null;
    if (type === 'moov') {
      const end = offset + size;
      return Number.isSafeInteger(end) && end <= 64 * 1024 * 1024 ? end : null;
    }
    if (offset + size > bytes.byteLength) return null;
    offset += size;
  }
  return null;
}

function mp4HasMvex(bytes) {
  // A fragmented MP4 has an mvex box as a direct child of its initial moov.
  // Return false when the complete moov is not present in the tiny probe.
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let count = 0; count < 16 && offset + 8 <= bytes.byteLength; count++) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) return false;
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) return false;
    if (size < headerSize || offset + size > bytes.byteLength) return false;
    if (type === 'moov') {
      const moovEnd = offset + size;
      let child = offset + headerSize;
      while (child + 8 <= moovEnd) {
        let childSize = view.getUint32(child);
        const childType = String.fromCharCode(bytes[child + 4], bytes[child + 5], bytes[child + 6], bytes[child + 7]);
        let childHeader = 8;
        if (childSize === 1) {
          if (child + 16 > moovEnd) return false;
          const largeSize = view.getBigUint64(child + 8);
          if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
          childSize = Number(largeSize);
          childHeader = 16;
        } else if (childSize === 0) return false;
        if (childSize < childHeader || child + childSize > moovEnd) return false;
        if (childType === 'mvex') return true;
        child += childSize;
      }
      return false;
    }
    offset += size;
  }
  return false;
}

function videoChunkStartForOffset(offset, fragmented) {
  if (fragmented) {
    if (offset < VIDEO_FRAGMENT_START_CHUNK_SIZE) return 0;
    return VIDEO_FRAGMENT_START_CHUNK_SIZE +
      Math.floor((offset - VIDEO_FRAGMENT_START_CHUNK_SIZE) / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
  }
  return Math.floor(offset / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
}

function videoChunkSizeAt(chunkStart, fragmented) {
  return fragmented && chunkStart === 0 ? VIDEO_FRAGMENT_START_CHUNK_SIZE : VIDEO_CHUNK_SIZE;
}

async function fetchAndCacheVideoChunk(source, chunkStart, chunkSize = VIDEO_CHUNK_SIZE) {
  // Fill one complete cache chunk; keep requesting if the upstream caps its Range size.
  const requestedEnd = chunkStart + chunkSize - 1;
  const pieces = [];
  let cursor = chunkStart;
  let total = null;
  let upstreamType = '';
  let expectedEnd = requestedEnd;
  let requests = 0;

  while (cursor <= expectedEnd) {
    if (++requests > 128) throw new Error('Video source returned too many small byte ranges');
    const part = await fetchVideoRangeFromMirrors(source.url, cursor, requestedEnd);
    if (part.unsatisfiedTotal !== undefined) {
      if (cursor === chunkStart) return { unsatisfiedTotal: part.unsatisfiedTotal };
      throw new Error('Video source ended before the cached chunk was complete');
    }
    const { range, bytes } = part;
    if (!range || (total !== null && range.total !== total)) throw new Error('Inconsistent upstream byte-range metadata');
    total = range.total;
    expectedEnd = Math.min(requestedEnd, total - 1);
    if (cursor > expectedEnd) break;
    if (range.end < cursor || range.end > expectedEnd) throw new Error('Non-contiguous upstream byte range');
    if (!upstreamType) upstreamType = part.upstreamType;
    pieces.push(bytes);
    cursor = range.end + 1;
  }

  if (total === null || cursor !== expectedEnd + 1) throw new Error('Video source did not provide a complete contiguous cache chunk');
  const expectedLength = expectedEnd - chunkStart + 1;
  const bytes = new Uint8Array(expectedLength);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  if (offset !== expectedLength) throw new Error('Assembled video chunk has an invalid length');

  const container = sniffVideoContainer(bytes);
  const contentType = container === 'mp4' ? 'video/mp4' :
    container === 'webm' ? 'video/webm' :
    container === 'mkv' ? 'video/x-matroska' :
    (!upstreamType || upstreamType === 'application/octet-stream' || upstreamType === 'binary/octet-stream')
      ? 'video/mp4' : upstreamType;
  return { bytes, start: chunkStart, end: expectedEnd, total, contentType, container };
}
export class VideoHeader extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
    const match = /^\/__video_header__\/([0-9a-f-]{36})\/(\d+)\/([0-9a-f]{32})$/.exec(new URL(request.url).pathname);
    if (!match) return json({ error: 'Invalid internal video header request' }, 404);
    const movieId = match[1];
    const optionIndex = Number(match[2]);
    const sourceHash = match[3];
    const props = this.ctx.props || {};
    const sourceUrl = props.sourceUrl;
    const sourceVersion = String(props.sourceVersion || '');
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 7 ||
        typeof sourceUrl !== 'string' || sourceUrl.length > 2048) {
      return json({ error: 'Invalid internal video header parameters' }, 400);
    }
    try {
      const parsedSource = new URL(sourceUrl);
      if (parsedSource.protocol !== 'https:' || !allowedSourceHost(parsedSource.hostname)) {
        return json({ error: 'Unsupported video source' }, 400);
      }
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(sourceUrl + '|' + sourceVersion));
      const expectedHash = hex(new Uint8Array(digest)).slice(0, 32);
      if (expectedHash !== sourceHash) return json({ error: 'Video header cache key did not match its source' }, 400);
      const probe = await fetchVideoRangeFromMirrors(sourceUrl, 0, VIDEO_HEADER_PROBE_SIZE - 1, 20000);
      const range = probe.range;
      if (!range || probe.unsatisfiedTotal !== undefined || range.start !== 0 || range.end < 39) {
        throw new Error('Video source did not return a valid video header');
      }
      const bytes = probe.bytes;
      const container = sniffVideoContainer(bytes);
      const moovEnd = container === 'mp4' ? mp4MoovEnd(bytes) : null;
      const fragmented = container === 'mp4' && mp4HasMvex(bytes);
      const upstreamType = probe.upstreamType || '';
      const contentType = container === 'mp4' ? 'video/mp4' :
        container === 'webm' ? 'video/webm' :
        container === 'mkv' ? 'video/x-matroska' :
        (!upstreamType || upstreamType === 'application/octet-stream' || upstreamType === 'binary/octet-stream')
          ? 'video/mp4' : upstreamType;
      return json({ total: range.total, moovEnd, container, contentType, fragmented }, 200, {
        'cache-control': 'public, max-age=' + VIDEO_CACHE_TTL,
        'cache-tag': 'video-headers-' + movieId
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown video header error';
      console.error('Video header probe failed:', detail);
      return json({ error: detail.slice(0, 300) }, 502);
    }
  }
  async invalidate(movieId) {
    if (typeof movieId !== 'string' || !/^[0-9a-f-]{36}$/i.test(movieId)) return { success: false };
    return this.ctx.cache.purge({ tags: ['video-headers-' + movieId] });
  }
}

export class VideoChunk extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
    const match = /^\/__video_chunk__\/([0-9a-f-]{36})\/(\d+)\/([0-9a-f]{32})\/(\d+)\/(\d+)$/.exec(new URL(request.url).pathname);
    if (!match) return json({ error: 'Invalid internal video chunk request' }, 404);
    const movieId = match[1];
    const optionIndex = Number(match[2]);
    const sourceHash = match[3];
    const chunkStart = Number(match[4]);
    const chunkSize = Number(match[5]);
    const props = this.ctx.props || {};
    const sourceUrl = props.sourceUrl;
    const sourceVersion = String(props.sourceVersion || '');

    const alignedStandardChunk = chunkSize === VIDEO_CHUNK_SIZE &&
      (chunkStart % VIDEO_CHUNK_SIZE === 0 ||
        (chunkStart >= VIDEO_FRAGMENT_START_CHUNK_SIZE &&
          (chunkStart - VIDEO_FRAGMENT_START_CHUNK_SIZE) % VIDEO_CHUNK_SIZE === 0));
    const initialFragmentChunk = chunkStart === 0 && chunkSize === VIDEO_FRAGMENT_START_CHUNK_SIZE;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 7 ||
        !Number.isSafeInteger(chunkStart) || chunkStart < 0 ||
        !(alignedStandardChunk || initialFragmentChunk) ||
        typeof sourceUrl !== 'string' || sourceUrl.length > 2048) {
      return json({ error: 'Invalid internal video chunk parameters' }, 400);
    }

    try {
      const parsedSource = new URL(sourceUrl);
      if (parsedSource.protocol !== 'https:' || !allowedSourceHost(parsedSource.hostname)) {
        return json({ error: 'Unsupported video source' }, 400);
      }
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(sourceUrl + '|' + sourceVersion));
      const expectedHash = hex(new Uint8Array(digest)).slice(0, 32);
      if (expectedHash !== sourceHash) return json({ error: 'Video cache key did not match its source' }, 400);

      const result = await fetchAndCacheVideoChunk({ url: sourceUrl }, chunkStart, chunkSize);
      if (result.unsatisfiedTotal !== undefined) {
        return new Response(null, {
          status: 416,
          headers: {
            'content-range': 'bytes */' + result.unsatisfiedTotal,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store'
          }
        });
      }

      return new Response(result.bytes, {
        status: 200,
        headers: {
          'content-type': result.contentType,
          'content-length': String(result.bytes.byteLength),
          'cache-control': 'public, max-age=' + VIDEO_CACHE_TTL + ', stale-if-error=3600',
          'cache-tag': 'video-chunks-' + movieId,
          'x-moviwatch-start': String(result.start),
          'x-moviwatch-end': String(result.end),
          'x-moviwatch-total': String(result.total),
          'x-moviwatch-container': result.container
        }
      });
    } catch (error) {
      console.error('Tiered video chunk fill failed:', error?.message || error);
      const detail = error instanceof Error ? error.message : 'Unknown video chunk error';
      return json({ error: detail.slice(0, 300) }, 502);
    }
  }

  async invalidate(movieId) {
    if (typeof movieId !== 'string' || !/^[0-9a-f-]{36}$/i.test(movieId)) return { success: false };
    return this.ctx.cache.purge({ tags: ['video-chunks-' + movieId] });
  }
}


const ARCHIVE_META_TTL = 60 * 60 * 1000;
const ARCHIVE_META_FAIL_TTL = 30000;
const ARCHIVE_SCORE_TTL = 30 * 60 * 1000;
const ARCHIVE_COOLDOWN = 60000;
const ARCHIVE_FAST_MIRROR_BPS = 512 * 1024;
const archiveMeta = new Map();
const archiveMetaPending = new Map();
const archiveScores = new Map();

function archiveSourceParts(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== 'archive.org' && !url.hostname.endsWith('.archive.org')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts[0] === 'download' ? 0 : parts.indexOf('items');
    if (at < 0 || parts.length < at + 3) return null;
    const identifier = decodeURIComponent(parts[at + 1]);
    const file = parts.slice(at + 2).join('/');
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(identifier) || !file || file.length > 1600) return null;
    for (const part of file.split('/')) {
      const decoded = decodeURIComponent(part);
      if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') ||
          decoded.includes('\\') || /[\x00-\x1f\x7f]/.test(decoded)) return null;
    }
    return { identifier, file, search: url.search, original: url.toString() };
  } catch { return null; }
}

function archiveHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (/^https?:\/\//.test(host)) {
    try { host = new URL(host).hostname.toLowerCase(); } catch { return null; }
  }
  return /^[a-z0-9][a-z0-9.-]*\.archive\.org$/.test(host) &&
    host !== 'archive.org' && !host.includes('..') ? host : null;
}

async function archiveRouting(identifier) {
  const cached = archiveMeta.get(identifier);
  if (cached && cached.until > Date.now()) return cached.value;
  if (archiveMetaPending.has(identifier)) return archiveMetaPending.get(identifier);

  const pending = (async () => {
    let value = null;
    try {
      const response = await fetch('https://archive.org/metadata/' + encodeURIComponent(identifier), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error('Archive.org metadata HTTP ' + response.status);
      const metadata = await response.json();
      const dir = String(metadata.dir || '');
      if (!/^\/[0-9]+\/items\/[A-Za-z0-9._-]{1,200}$/.test(dir) ||
          dir.split('/').filter(Boolean)[2] !== identifier) throw new Error('Invalid Archive.org item routing metadata');
      const hosts = [...new Set([
        metadata.server,
        ...(Array.isArray(metadata.workable_servers) ? metadata.workable_servers : []),
        metadata.d1, metadata.d2
      ].map(archiveHost).filter(Boolean))];
      if (hosts.length) value = { dir, hosts };
    } catch (error) {
      console.warn('Archive.org mirror discovery failed:', error?.message || error);
    }
    archiveMeta.set(identifier, {
      value,
      until: Date.now() + (value ? ARCHIVE_META_TTL : ARCHIVE_META_FAIL_TTL)
    });
    while (archiveMeta.size > 128) archiveMeta.delete(archiveMeta.keys().next().value);
    return value;
  })();
  archiveMetaPending.set(identifier, pending);
  try { return await pending; }
  finally { archiveMetaPending.delete(identifier); }
}

function archiveScore(identifier, host) {
  const value = archiveScores.get(identifier + '|' + host);
  return !value || Date.now() - value.at > ARCHIVE_SCORE_TTL ? null : value;
}

function recordArchiveSuccess(identifier, host, bytes, elapsed) {
  if (!host || bytes < 64 * 1024) return;
  const key = identifier + '|' + host;
  const previous = archiveScore(identifier, host);
  const sample = bytes / Math.max(0.05, elapsed / 1000);
  archiveScores.set(key, {
    rate: previous?.rate ? previous.rate * 0.7 + sample * 0.3 : sample,
    failures: 0, until: 0, at: Date.now()
  });
  while (archiveScores.size > 256) archiveScores.delete(archiveScores.keys().next().value);
}

function recordArchiveFailure(identifier, host) {
  if (!host) return;
  const key = identifier + '|' + host;
  const previous = archiveScores.get(key);
  const failures = (previous?.failures || 0) + 1;
  archiveScores.set(key, {
    rate: previous?.rate || 0,
    failures,
    until: Date.now() + Math.min(5 * 60 * 1000, ARCHIVE_COOLDOWN * failures),
    at: Date.now()
  });
}

async function archiveCandidates(sourceUrl) {
  const details = archiveSourceParts(sourceUrl);
  if (!details) return [{ url: sourceUrl, host: '', identifier: '' }];
  const route = await archiveRouting(details.identifier);
  if (!route?.hosts?.length) return [{ url: details.original, host: '', identifier: details.identifier }];
  const ranked = route.hosts.map((host, order) => ({
    host, order, score: archiveScore(details.identifier, host)
  })).sort((a, b) => {
    const aBad = (a.score?.until || 0) > Date.now();
    const bBad = (b.score?.until || 0) > Date.now();
    if (aBad !== bBad) return aBad ? 1 : -1;
    const aFast = (a.score?.rate || 0) >= ARCHIVE_FAST_MIRROR_BPS;
    const bFast = (b.score?.rate || 0) >= ARCHIVE_FAST_MIRROR_BPS;
    if (aFast !== bFast) return aFast ? -1 : 1;
    const aUntested = !a.score?.rate;
    const bUntested = !b.score?.rate;
    if (aUntested !== bUntested) return aUntested ? -1 : 1;
    if (a.score?.rate && b.score?.rate && a.score.rate !== b.score.rate) return b.score.rate - a.score.rate;
    return a.order - b.order;
  });
  return [
    ...ranked.map(({ host }) => ({
      url: 'https://' + host + route.dir + '/' + details.file + details.search,
      host, identifier: details.identifier
    })),
    { url: details.original, host: '', identifier: details.identifier }
  ];
}

function archiveTimeout(size, score) {
  const rate = score?.rate || (192 * 1024);
  return Math.max(45000, Math.min(5 * 60 * 1000, 30000 + size / rate * 2000));
}

async function fetchVideoRangeFromMirrors(sourceUrl, start, requestedEnd, timeoutOverride = 0) {
  const details = archiveSourceParts(sourceUrl);
  const candidates = details ? await archiveCandidates(sourceUrl) : [{ url: sourceUrl, host: '', identifier: '' }];
  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const began = Date.now();
    try {
      const score = details && candidate.host ? archiveScore(details.identifier, candidate.host) : null;
      const signal = AbortSignal.timeout(timeoutOverride || archiveTimeout(requestedEnd - start + 1, score));
      const upstream = await videoSourceFetch(candidate.url, 'GET', new Headers({
        Range: 'bytes=' + start + '-' + requestedEnd,
        'Accept-Encoding': 'identity'
      }), signal);
      if (upstream.status === 416) {
        const unsatisfied = /^bytes \*\/([0-9]+)$/.exec(upstream.headers.get('content-range') || '');
        try { await upstream.body?.cancel(); } catch {}
        if (unsatisfied) return { unsatisfiedTotal: Number(unsatisfied[1]) };
      }
      const range = parseContentRange(upstream.headers.get('content-range'));
      if (upstream.status !== 206 || !range || range.start !== start ||
          range.end < start || range.end > requestedEnd) {
        const status = upstream.status;
        const contentRange = upstream.headers.get('content-range') || 'none';
        try { await upstream.body?.cancel(); } catch {}
        throw new Error('Invalid upstream byte range (HTTP ' + status + ', Content-Range: ' + contentRange + ')');
      }
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      if (bytes.byteLength !== range.end - range.start + 1) throw new Error('Incomplete upstream byte range');
      if (details && candidate.host) recordArchiveSuccess(details.identifier, candidate.host, bytes.byteLength, Date.now() - began);
      return { range, bytes, upstreamType: (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Video range request failed');
      if (details && candidate.host) recordArchiveFailure(details.identifier, candidate.host);
      if (i === candidates.length - 1) throw lastError;
      console.warn('Archive.org mirror failed; switching storage host:', candidate.host || 'archive.org router', lastError.message);
    }
  }
  throw lastError || new Error('No storage host returned the requested video range');
}

async function cachedVideoRange(req, ctx, source, movieId, optionIndex, rangeHeader, sourceVersion = '') {
  const parsed = parseByteRange(rangeHeader);
  if (!parsed || parsed.invalid) {
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */*', 'accept-ranges': 'bytes' } });
  }

  const normalizedSourceVersion = sourceVersion instanceof Date
    ? sourceVersion.toISOString()
    : String(sourceVersion || '');
  const sourceDigest = await crypto.subtle.digest('SHA-256', enc.encode(source.url + '|' + normalizedSourceVersion));
  const sourceHash = hex(new Uint8Array(sourceDigest)).slice(0, 32);

  // The cached header probe identifies fragmented MP4 for every range request,
  // including seeks. Keep a compact first segment and 8 MiB continuation chunks
  // so cold seeks do not have to wait for a 8 MiB Archive.org/Drive transfer.
  const header = await getVideoHeader(ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash);
  const fragmented = header.fragmented === true;
  const total = header.total;
  const container = header.container || 'unknown';
  const contentType = header.contentType || 'video/mp4';
  const headerCacheStatus = header.cacheStatus;
  const startupPrefetch = req.method === 'GET' && !parsed.suffix && parsed.start === 0;
  const prefetched = new Map();
  let startupPrefetchCount = 0;
  let startupPrefetchMs = 0;
  let cacheStatus = 'BYPASS';

  let start, end;
  if (parsed.suffix) {
    start = Math.max(0, total - parsed.suffix);
    end = total - 1;
  } else {
    start = parsed.start;
    end = parsed.end === null ? total - 1 : Math.min(parsed.end, total - 1);
  }
  if (start >= total || end < start) {
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + total, 'accept-ranges': 'bytes' } });
  }

  if (startupPrefetch) {
    const prefetchStarted = Date.now();
    // Load the compact fMP4 first segment and the following 8 MiB media
    // segment concurrently. For conventional MP4, retain 8 MiB-aligned chunks
    // and prefetch every chunk required to reach the moov index.
    const starts = [];
    let nextStart = 0;
    const moovEnd = header.moovEnd || VIDEO_CHUNK_SIZE;
    while (nextStart < moovEnd && starts.length < 8) {
      starts.push(nextStart);
      nextStart += videoChunkSizeAt(nextStart, fragmented);
    }
    if (!starts.length) starts.push(0);
    if (fragmented && starts.length < 9 && VIDEO_FRAGMENT_START_CHUNK_SIZE < total) {
      starts.push(VIDEO_FRAGMENT_START_CHUNK_SIZE);
    }

    const chunkPromises = starts.map((chunkStart) =>
      getVideoChunk(
        ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash,
        chunkStart, videoChunkSizeAt(chunkStart, fragmented)
      )
    );
    for (let i = 0; i < starts.length; i++) prefetched.set(starts[i], chunkPromises[i]);
    ctx.waitUntil(Promise.allSettled(chunkPromises));
    startupPrefetchCount = starts.length;
    startupPrefetchMs = Date.now() - prefetchStarted;
    cacheStatus = 'PREFETCH';
  } else {
    const firstStart = videoChunkStartForOffset(start, fragmented);
    const firstChunk = await getVideoChunk(
      ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash,
      firstStart, videoChunkSizeAt(firstStart, fragmented)
    );
    if (firstChunk.unsatisfiedTotal !== undefined) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': 'bytes */' + firstChunk.unsatisfiedTotal, 'accept-ranges': 'bytes' }
      });
    }
    if (firstChunk.total !== total) throw new Error('Video source size changed during streaming');
    cacheStatus = firstChunk.cacheStatus;
    prefetched.set(firstStart, Promise.resolve(firstChunk));
  }

  const responseStart = start;
  const responseEnd = end;
  const contentLength = responseEnd - responseStart + 1;
  let cursor = responseStart;
  let chunk = null;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (cursor > responseEnd) {
          controller.close();
          return;
        }
        const expectedChunkStart = videoChunkStartForOffset(cursor, fragmented);
        if (!chunk || chunk.start !== expectedChunkStart) {
          const pending = prefetched.get(expectedChunkStart);
          chunk = pending
            ? await pending
            : await getVideoChunk(
                ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash,
                expectedChunkStart, videoChunkSizeAt(expectedChunkStart, fragmented)
              );
          prefetched.delete(expectedChunkStart);
          if (chunk.unsatisfiedTotal !== undefined || chunk.total !== total) {
            throw new Error('Video source size changed during streaming');
          }
        }

        // Keep one segment ahead warm while the browser consumes the current
        // range. This is especially useful after a seek: the target segment is
        // fetched immediately, and its successor starts filling in parallel.
        const nextChunkStart = chunk.end + 1;
        if (nextChunkStart < total && !prefetched.has(nextChunkStart)) {
          const nextPromise = getVideoChunk(
            ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash,
            nextChunkStart, videoChunkSizeAt(nextChunkStart, fragmented)
          );
          prefetched.set(nextChunkStart, nextPromise);
          ctx.waitUntil(Promise.allSettled([nextPromise]));
        }

        const from = cursor - chunk.start;
        const through = Math.min(responseEnd, chunk.end) - chunk.start + 1;
        if (through <= from) throw new Error('Invalid cached video chunk boundary');
        const output = chunk.bytes.subarray(from, through);
        cursor += output.byteLength;
        controller.enqueue(output);
        if (cursor > responseEnd) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      chunk = null;
    }
  });

  return new Response(body, {
    status: 206,
    headers: {
      'content-type': contentType,
      'x-moviwatch-container': container,
      'x-moviwatch-fragmented': String(fragmented),
      'x-moviwatch-stream-profile': fragmented ? 'single-file-fmp4' : 'range-stream',
      'content-length': String(contentLength),
      'content-range': 'bytes ' + responseStart + '-' + responseEnd + '/' + total,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store, max-age=0',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
      'surrogate-control': 'no-store',
      'vary': 'Range',
      'x-moviwatch-cache': cacheStatus,
      'x-moviwatch-seek-range-start': String(responseStart),
      'x-moviwatch-seek-range-end': String(responseEnd),
      'x-moviwatch-seek-first-chunk-start': String(videoChunkStartForOffset(responseStart, fragmented)),
      'x-moviwatch-seek-first-chunk-size': String(videoChunkSizeAt(videoChunkStartForOffset(responseStart, fragmented), fragmented)),
      'x-moviwatch-chunk-size': String(VIDEO_CHUNK_SIZE),
      'x-moviwatch-startup-chunk-size': String(videoChunkSizeAt(0, fragmented)),
      'x-moviwatch-header-cache': headerCacheStatus,
      'x-moviwatch-startup-prefetch-chunks': String(startupPrefetchCount),
      'x-moviwatch-startup-prefetch-ms': String(startupPrefetchMs)
    }
  });
}

async function api(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'moviwatch' });

  if (path === '/api/auth/login' && method === 'POST') {
    sameOrigin(req, env);
    if (!env.ADMIN_PASSWORD_HASH || !env.ADMIN_PASSWORD_PEPPER || !env.JWT_SECRET) return json({ error: 'Admin authentication is not configured' }, 503);
    let allowed;
    try { allowed = await loginLimit(req, env); } catch { return json({ error: 'Login rate limiter unavailable' }, 503); }
    if (!allowed) return json({ error: 'Too many login attempts. Try again in 10 minutes.' }, 429);
    const body = await readBody(req);
    if (typeof body.password !== 'string' || body.password.length > 1024) return json({ error: 'Invalid password' }, 400);
    let valid = false;
    try {
      const expected = unhex(env.ADMIN_PASSWORD_HASH);
      const pepper = unhex(env.ADMIN_PASSWORD_PEPPER);
      if (expected.length === 32 && pepper.length >= 32) {
        const actual = await hmac(pepper, enc.encode(body.password));
        let diff = 0;
        for (let i = 0; i < 32; i++) diff |= actual[i] ^ expected[i];
        valid = diff === 0;
      }
    } catch { valid = false; }
    if (!valid) return json({ error: 'Incorrect password' }, 401);
    const token = await makeToken(env);
    return json({ ok: true }, 200, { 'set-cookie': COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + SESSION });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    sameOrigin(req, env);
    return json({ ok: true }, 200, { 'set-cookie': COOKIE + '=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (path === '/api/auth/me' && method === 'GET') return await isAdmin(req, env) ? json({ authenticated: true }) : json({ authenticated: false }, 401);

  if (path === '/api/movies' && method === 'GET') {
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (category && !CATEGORIES.has(category)) return json({ error: 'Unknown category' }, 400);

    const catalogueUrl = new URL('https://moviwatch.internal/__public_catalogue__v2');
    if (category) catalogueUrl.searchParams.set('category', category);
    if (query) catalogueUrl.searchParams.set('q', query);
    const catalogueEntry = ctx.exports.PublicCatalogue({ props: { category, query } });
    const cachedCatalogue = await catalogueEntry.fetch(new Request(catalogueUrl));
    if (!cachedCatalogue.ok) return json({ error: 'Could not load the public catalogue' }, 502);
    const payload = await cachedCatalogue.json();
    // Cloudflare's cached PublicCatalogue entrypoint is the authoritative cache.
    // Do not let Vercel cache this gateway response: doing so hides the current
    // Cloudflare HIT/MISS state and can serve stale catalogue data after tag purges.
    return json(payload, 200, {
      'cache-control': 'private, no-store, max-age=0',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
      'surrogate-control': 'no-store',
      'x-moviwatch-catalog-cache': cachedCatalogue.headers.get('cf-cache-status') || 'UNKNOWN'
    });
  }

  const download = path.split('/');
  if (download.length === 5 && download[1] === 'api' && download[2] === 'download' &&
      (method === 'GET' || method === 'HEAD')) {
    const metadata = await movieById(ctx, env, download[3]);
    const movie = metadata.movie;
    if (!movie) return method === 'HEAD'
      ? new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
      : json({ error: 'Movie not found' }, 404);

    const optionIndex = Number(download[4]);
    const source = storedVideoSource(movie, optionIndex);
    if (!source) {
      return method === 'HEAD'
        ? new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
        : json({ error: 'Google Drive or Archive.org video source not found' }, 404);
    }

    // Archive.org downloads are redirected to the original file endpoint.
    if (source.provider === 'archive.org') {
      return Response.redirect(archiveDownloadUrl(source.url), 302);
    }

    const cleanPart = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    const baseName = cleanPart(movie.title) || 'Moviwatch';
    const optionName = cleanPart(source.label || ('Option ' + (optionIndex + 1)));

    try {
      // HEAD discovers total bytes from one cached byte-range probe. It warms
      // chunk zero so an immediate GET can reuse it without a second Drive read.
      if (method === 'HEAD') {
        const probe = await cachedVideoRange(
          req, ctx, source, download[3], optionIndex, 'bytes=0-0', movie.updated_at
        );
        if (probe.status !== 206) {
          try { await probe.body?.cancel(); } catch {}
          return new Response(null, { status: probe.status, headers: probe.headers });
        }

        const contentRange = probe.headers.get('content-range') || '';
        const total = Number(contentRange.split('/')[1]);
        const container = probe.headers.get('x-moviwatch-container') || 'mp4';
        const extension = ({
          mp4: 'mp4', webm: 'webm', mkv: 'mkv', avi: 'avi',
          flv: 'flv', ogg: 'ogg'
        })[container] || 'mp4';
        const filename = baseName + (optionName ? ' - ' + optionName : '') + '.' + extension;
        const fallback = filename.normalize('NFKD')
          .replace(/[^\x20-\x7E]/g, '')
          .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
          .replace(/[\r\n]/g, '')
          .trim() || 'Moviwatch-download.' + extension;
        const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
          (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());

        try { await probe.body?.cancel(); } catch {}
        const headers = new Headers(probe.headers);
        headers.delete('content-range');
        headers.set('content-length', String(Number.isSafeInteger(total) && total >= 0 ? total : 0));
        headers.set('content-disposition',
          'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded);
        headers.set('accept-ranges', 'bytes');
        headers.set('x-moviwatch-file-size', String(total));
        headers.set('x-moviwatch-file-name', encoded);
        headers.set('cache-control', 'private, no-store, max-age=0');
        headers.set('x-moviwatch-metadata-cache', metadata.cacheStatus);
        return new Response(null, { status: 200, headers });
      }

      // GET streams the full file by default. Explicit Range requests preserve
      // resumable downloads and standard HTTP 206 responses.
      const requestedRange = req.headers.get('Range');
      const response = await cachedVideoRange(
        req, ctx, source, download[3], optionIndex,
        requestedRange || 'bytes=0-', movie.updated_at
      );
      if (response.status === 416) return response;

      const container = response.headers.get('x-moviwatch-container') || 'mp4';
      const extension = ({
        mp4: 'mp4', webm: 'webm', mkv: 'mkv', avi: 'avi',
        flv: 'flv', ogg: 'ogg'
      })[container] || 'mp4';
      const filename = baseName + (optionName ? ' - ' + optionName : '') + '.' + extension;
      const fallback = filename.normalize('NFKD')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
        .replace(/[\r\n]/g, '')
        .trim() || 'Moviwatch-download.' + extension;
      const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());

      const headers = new Headers(response.headers);
      headers.set('content-disposition',
        'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded);
      headers.set('accept-ranges', 'bytes');
      headers.set('cache-control', 'private, no-store, max-age=0');
      headers.set('x-content-type-options', 'nosniff');
      headers.set('x-moviwatch-metadata-cache', metadata.cacheStatus);
      if (!requestedRange) headers.delete('content-range');

      return new Response(response.body, {
        status: requestedRange ? response.status : 200,
        statusText: requestedRange ? response.statusText : 'OK',
        headers
      });
    } catch (error) {
      console.error('Video download failed:', error?.message || error);
      const detail = error instanceof Error ? error.message : 'Unknown download error';
      return method === 'HEAD'
        ? new Response(null, { status: 502, headers: { 'cache-control': 'no-store', 'x-moviwatch-error': detail.slice(0, 200) } })
        : json({ error: detail.slice(0, 300) }, 502);
    }
  }

    const watch = path.split('/');
  if (watch.length === 5 && watch[1] === 'api' && watch[2] === 'watch' && (method === 'GET' || method === 'HEAD')) {
    const metadata = await movieById(ctx, env, watch[3]);
    const movie = metadata.movie;
    if (!movie) return json({ error: 'Movie not found' }, 404);
    const optionIndex = Number(watch[4]);
    const source = storedVideoSource(movie, optionIndex);
    if (!source) return json({ error: 'Google Drive or Archive.org video source not found' }, 404);

    // Serve HEAD and ordinary full-file GET through the same 8 MiB edge cache.
    // Only If-Range stays on the origin path because it depends on origin validators.
    if (req.headers.has('If-Range')) {
      const headers = new Headers();
      for (const name of ['Range', 'If-Range']) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
      }
      let upstream;
      try { upstream = await videoSourceFetch(source.url, method, headers); }
      catch { return json({ error: 'Video source could not be reached' }, 502); }
      if (![200, 206, 416].includes(upstream.status) ||
          (upstream.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
        return json({ error: 'Video source did not return a playable file. Check that the source is public and available.' }, 502);
      }
      const out = new Headers({
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes'
      });
      for (const name of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) out.set(name, value);
      }
      out.set('x-moviwatch-metadata-cache', metadata.cacheStatus);
      return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
    }

    try {
      if (method === 'HEAD') {
        const probe = await cachedVideoRange(
          req, ctx, source, watch[3], optionIndex, 'bytes=0-0', movie.updated_at
        );
        if (probe.status !== 206) {
          try { await probe.body?.cancel(); } catch {}
          return new Response(null, { status: probe.status, headers: probe.headers });
        }
        const total = Number((probe.headers.get('content-range') || '').split('/')[1]);
        const headers = new Headers(probe.headers);
        headers.delete('content-range');
        headers.set('content-length', String(Number.isSafeInteger(total) && total >= 0 ? total : 0));
        headers.set('cache-control', 'private, no-store, max-age=0');
        headers.set('x-moviwatch-metadata-cache', metadata.cacheStatus);
        try { await probe.body?.cancel(); } catch {}
        return new Response(null, { status: 200, headers });
      }

      const response = await cachedVideoRange(
        req, ctx, source, watch[3], optionIndex,
        req.headers.get('Range') || 'bytes=0-', movie.updated_at
      );
      if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
        return json({ error: 'Video source returned an HTML page instead of video. Check that the source is public and available.' }, 502);
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('x-moviwatch-metadata-cache', metadata.cacheStatus);
      if (!req.headers.has('Range')) responseHeaders.delete('content-range');
      return new Response(response.body, {
        status: req.headers.has('Range') ? response.status : 200,
        statusText: req.headers.has('Range') ? response.statusText : 'OK',
        headers: responseHeaders
      });
    } catch (error) {
      console.error('Video proxy failed:', error?.message || error);
      const detail = error instanceof Error ? error.message : 'Unknown upstream video error';
      return json({ error: detail.slice(0, 300) }, 502);
    }

  }

  if (path.startsWith('/api/admin/')) {
    if (!await isAdmin(req, env)) return json({ error: 'Admin login required' }, 401);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) sameOrigin(req, env);
    const sql = sqlFor(env);
    if (path === '/api/admin/movies' && method === 'GET') {
      const rows = await sql`SELECT id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at
        FROM movies ORDER BY updated_at DESC LIMIT 500`;
      const movies = rows.map((movie) => ({
        ...movie,
        video_sources: (Array.isArray(movie.video_sources) ? movie.video_sources : []).flatMap((source) => {
          try {
            const url = videoSourceUrl(source.url);
            const provider = sourceProvider(url);
            return [{ label: (source.label || (provider === 'archive.org' ? 'Archive.org' : 'Google Drive')).slice(0, 60), url, provider }];
          } catch { return []; }
        })
      }));
      return json({ movies });
    }
    if (path === '/api/admin/stats' && method === 'GET') {
      const rows = await sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_published)::int AS published,
        COUNT(*) FILTER (WHERE category='Action')::int AS action, COUNT(*) FILTER (WHERE category='Romantic')::int AS romantic FROM movies`;
      return json({ stats: rows[0] });
    }
    if (path === '/api/admin/movies' && method === 'POST') {
      const v = movieInput(await readBody(req));
      const rows = await sql`INSERT INTO movies(id,title,poster_url,category,videos,is_published)
        VALUES(${crypto.randomUUID()},${v.title},${v.poster},${v.category},${JSON.stringify(v.sources)}::jsonb,${v.published})
        RETURNING id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at`;
      await invalidateContentCaches(ctx);
      return json({ movie: rows[0] }, 201);
    }
    const id = path.split('/')[4];
    if (path.startsWith('/api/admin/movies/') && id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Invalid movie ID' }, 400);
      if (method === 'PUT') {
        const v = movieInput(await readBody(req));
        const rows = await sql`UPDATE movies SET title=${v.title},poster_url=${v.poster},category=${v.category},
          videos=${JSON.stringify(v.sources)}::jsonb,is_published=${v.published},updated_at=NOW()
          WHERE id=${id} RETURNING id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at`;
        if (!rows[0]) return json({ error: 'Movie not found' }, 404);
        await invalidateContentCaches(ctx, id);
        return json({ movie: rows[0] });
      }
      if (method === 'DELETE') {
        const rows = await sql`DELETE FROM movies WHERE id=${id} RETURNING id`;
        if (!rows[0]) return json({ error: 'Movie not found' }, 404);
        await invalidateContentCaches(ctx, id);
        return json({ ok: true });
      }
    }
    return json({ error: 'Admin endpoint not found' }, 404);
  }
  return json({ error: 'API route not found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/')) return await api(req, env, ctx);
      if (url.pathname === '/admin.html') return Response.redirect(new URL('/admin', url), 302);
      if (url.pathname === '/admin') return env.ASSETS.fetch(new Request(new URL('/admin.html', url), req));
      return env.ASSETS.fetch(req);
    } catch (error) {
      console.error('Request failed:', error?.stack || error?.message || error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      const client = /required|invalid|must |between |only |unknown category|too large|HTTPS|Google Drive|Archive\.org|video link/i.test(message);
      return json({ error: client ? message : 'Internal server error' }, client ? 400 : 500);
    }
  }
};
