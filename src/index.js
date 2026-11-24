import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { videoSourceUrl, sourceProvider } from './video-sources.js';
import { getVideoRangeWindow } from './video-range-window.js';
import { createRangeRelayStream } from './video-stream.js';
import { searchArchiveItems, getArchiveItem, probeArchiveFile } from './archive-catalogue.js';
import {
  clearGoogleDriveAccessTokenCache,
  decryptGoogleDriveSecret,
  encryptGoogleDriveSecret,
  ensureGoogleDriveSchema,
  googleDriveAccessToken,
  googleDriveApiRequest,
  googleDriveConnection,
  googleDriveConnections,
  googleDriveTokenAad,
  googleDriveConfigurationIssues,
  googleDriveFileIdFromMediaUrl,
  googleDriveMediaUrl,
  googleDrivePublicFileSummary,
  isGoogleDriveConfigured,
  isGoogleDriveFileId
} from './google-drive.js';

const COOKIE = 'moviwatch_admin';
const SESSION = 8 * 60 * 60;
const PLAYBACK_COOKIE = 'moviwatch_playback';
const PLAYBACK_SESSION = 12 * 60 * 60;
const playbackCookieName = (movieId) => PLAYBACK_COOKIE + '_' + movieId.toLowerCase();
const CATEGORIES = new Set(['Action', 'Romantic']);
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers }
});
let seriesSchemaPromise = null;
async function ensureSeriesSchema(sql) {
  if (!seriesSchemaPromise) {
    seriesSchemaPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS public.series (
        id UUID PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        poster_url TEXT NOT NULL,
        category TEXT NOT NULL,
        is_published BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS public.episodes (
        id UUID PRIMARY KEY,
        series_id UUID NOT NULL REFERENCES public.series(id) ON DELETE CASCADE,
        season_number INTEGER NOT NULL CHECK (season_number BETWEEN 1 AND 999),
        episode_number INTEGER NOT NULL CHECK (episode_number BETWEEN 1 AND 9999),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        videos JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(videos) = 'array'),
        is_published BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(series_id, season_number, episode_number)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_episodes_series_order ON public.episodes(series_id, season_number, episode_number)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_episodes_public_order ON public.episodes(is_published, series_id, season_number, episode_number)`;
    })().catch((error) => { seriesSchemaPromise = null; throw error; });
  }
  await seriesSchemaPromise;
}

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
function getCookieValue(req, name) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function getCookie(req) {
  return getCookieValue(req, COOKIE);
}
async function isAdmin(req, env) {
  const value = getCookie(req);
  return Boolean(value && env.JWT_SECRET && await validToken(env, value));
}
async function makePlaybackToken(env, movieId) {
  if (!env.JWT_SECRET) throw new Error('Playback signing secret is not configured');
  const now = Math.floor(Date.now() / 1000);
  const sid = new Uint8Array(32);
  crypto.getRandomValues(sid);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ sub: 'playback', mid: movieId, sid: b64(sid), iat: now, exp: now + PLAYBACK_SESSION }));
  const unsigned = head + '.' + payload;
  return unsigned + '.' + b64(await hmac(enc.encode(env.JWT_SECRET), enc.encode(unsigned)));
}
async function validPlaybackToken(env, token) {
  try {
    if (!env.JWT_SECRET || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const head = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    const body = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== 'HS256' || body.sub !== 'playback' ||
        typeof body.mid !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.mid) ||
        typeof body.sid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.sid) ||
        !Number.isInteger(body.exp) || body.exp <= now ||
        !Number.isInteger(body.iat) || body.iat > now + 60 ||
        body.exp - body.iat > PLAYBACK_SESSION) return false;
    const expected = await hmac(enc.encode(env.JWT_SECRET), enc.encode(parts[0] + '.' + parts[1]));
    const received = unb64(parts[2]);
    if (received.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ received[i];
    return diff === 0 ? body : null;
  } catch { return null; }
}
function isTrustedAppOrigin(req, env, value) {
  try {
    const origin = new URL(value).origin;
    if (origin === new URL(req.url).origin) return true;
    for (const candidate of (env.APP_ORIGINS || '').split(',')) {
      const item = candidate.trim();
      if (!item) continue;
      try {
        const parsed = new URL(item);
        if (parsed.protocol === 'https:' && parsed.origin === origin) return true;
      } catch { /* Ignore malformed allowlist entries. */ }
    }
  } catch { /* Invalid or absent origin. */ }
  return false;
}
function playbackContextAllowed(req, env, movieId) {
  const fetchSite = req.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin') return false;
  const referer = req.headers.get('Referer');
  if (!referer || !isTrustedAppOrigin(req, env, referer)) return false;
  let page;
  try { page = new URL(referer); } catch { return false; }
  const segments = page.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'watch') return false;
  let pageMovieId;
  try { pageMovieId = decodeURIComponent(segments[1]); } catch { return false; }
  if (pageMovieId.toLowerCase() !== movieId.toLowerCase()) return false;
  const origin = req.headers.get('Origin');
  if (origin && !isTrustedAppOrigin(req, env, origin)) return false;
  return true;
}
async function hasPlaybackAccess(req, env, movieId) {
  const session = getCookieValue(req, playbackCookieName(movieId));
  if (!session) return false;
  const claims = await validPlaybackToken(env, session);
  return Boolean(claims && claims.mid.toLowerCase() === movieId.toLowerCase() &&
    playbackContextAllowed(req, env, movieId));
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
  const sources=body.videoSources.map((item,index)=>{
    const label=(typeof item?.label==='string'&&item.label.trim()?item.label.trim():'Google Drive '+(index+1)).slice(0,60);
    const privateId=item?.provider==='google-drive-private'?item.fileId:
      (typeof item?.url==='string'&&item.url.startsWith('drive-private://')?item.url.slice('drive-private://'.length):'');
    if(privateId){
      if(!isGoogleDriveFileId(privateId))throw new Error('Invalid private Google Drive file reference');
      const accountId = typeof item.accountId === 'string' && /^(primary|[0-9a-f-]{36})$/i.test(item.accountId) ? item.accountId : 'primary';
      return {label,provider:'google-drive-private',file_id:privateId,account_id:accountId,
        drive_id:isGoogleDriveFileId(item.driveId)?item.driveId:null,
        modified_time:typeof item.modifiedTime==='string'?item.modifiedTime:null};
    }
    const url=videoSourceUrl(item?.url);
    const provider=sourceProvider(url);
    const fallback=provider==='archive.org'?'Archive.org':'Google Drive';
    return {label:(typeof item?.label==='string'&&item.label.trim()?item.label.trim():fallback+' '+(index+1)).slice(0,60),url,provider};
  });
  return{title,poster:poster.href,category:body.category,sources,published:body.isPublished!==false};
}
function safePosterUrl(value) {
  let poster; try { poster = new URL(value); } catch { throw new Error('Poster must be an HTTPS URL'); }
  if (poster.protocol !== 'https:' || poster.href.length > 2048 || poster.username || poster.password) throw new Error('Poster must be an HTTPS URL');
  return poster.href;
}
function seriesInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Series details are required');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) throw new Error('Series name is required (max 200 characters)');
  if (!CATEGORIES.has(body.category)) throw new Error('Category must be Action or Romantic');
  const poster = safePosterUrl(body.posterUrl);
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 5000) : '';
  return { title, poster, category: body.category, description, published: body.isPublished !== false };
}
function episodeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Episode details are required');
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '';
  if (!title || title.length > 200) throw new Error('Episode name is required (max 200 characters)');
  const season = Number(body.seasonNumber), episode = Number(body.episodeNumber);
  if (!Number.isInteger(season) || season < 1 || season > 999) throw new Error('Season number must be between 1 and 999');
  if (!Number.isInteger(episode) || episode < 1 || episode > 9999) throw new Error('Episode number must be between 1 and 9999');
  if (!Array.isArray(body.videoSources) || body.videoSources.length < 1 || body.videoSources.length > 8) throw new Error('Add 1 to 8 episode video sources');
  const sources = body.videoSources.map((item,index) => {
    const label = (typeof item?.label === 'string' && item.label.trim() ? item.label.trim() : 'Video ' + (index + 1)).slice(0,60);
    const privateId = item?.provider === 'google-drive-private' ? item.fileId : (typeof item?.url === 'string' && item.url.startsWith('drive-private://') ? item.url.slice('drive-private://'.length) : '');
    if (privateId) {
      if (!isGoogleDriveFileId(privateId)) throw new Error('Invalid private Google Drive file reference');
      const accountId = typeof item.accountId === 'string' && /^(primary|[0-9a-f-]{36})$/i.test(item.accountId) ? item.accountId : 'primary';
      return { label, provider: 'google-drive-private', file_id: privateId, account_id: accountId,
        drive_id: isGoogleDriveFileId(item.driveId) ? item.driveId : null,
        modified_time: typeof item.modifiedTime === 'string' ? item.modifiedTime : null };
    }
    const url = videoSourceUrl(item?.url);
    return { label, url, provider: sourceProvider(url) };
  });
  return { title, season, episode, description: typeof body.description === 'string' ? body.description.trim().slice(0,5000) : '', sources, published: body.isPublished !== false };
}
function publicVideoSources(videoSources) {
  return (Array.isArray(videoSources) ? videoSources : []).flatMap((source, index) => {
    try {
      if (source?.provider === 'google-drive-private' && isGoogleDriveFileId(source.file_id)) {
        return [{ label: (source.label || 'Google Drive').slice(0,60), provider: source.provider, source_index: index }];
      }
      const url = videoSourceUrl(source.url), provider = sourceProvider(url);
      return [{ label: (source.label || provider).slice(0,60), provider, source_index: index }];
    } catch { return []; }
  });
}
function storedVideoSource(movie,optionIndex){
  if(!movie||!Number.isInteger(optionIndex)||optionIndex<0||optionIndex>7)return null;
  const raw=movie.video_sources?.[optionIndex];
  if(!raw||typeof raw!=='object')return null;
  if(raw.provider==='google-drive-private'&&isGoogleDriveFileId(raw.file_id)){
    try{return{...raw,fileId:raw.file_id,accountId:raw.account_id||'primary',url:googleDriveMediaUrl(raw.file_id),provider:'google-drive-private'}}catch{return null}
  }
  if(typeof raw.url!=='string')return null;
  try{const url=videoSourceUrl(raw.url);return{...raw,url,provider:sourceProvider(url)}}catch{return null}
}
const CATALOGUE_CACHE_TTL = 30;
const MOVIE_METADATA_CACHE_TTL = 30;

async function publicMovies(env,category,query){
 const sql=sqlFor(env);
 // Series support is additive. A missing table, failed index migration, or a
 // restricted DB role must never hide the pre-existing movie catalogue.
 try {
  // Public catalogue reads are read-only. Admin initializes optional series tables.
  return await sql`WITH movie_rows AS (
    SELECT id,title,poster_url,category,created_at,'movie'::text AS content_type,
     NULL::integer AS episode_count,
     COALESCE((SELECT jsonb_agg(jsonb_build_object('label',COALESCE(NULLIF(item.value->>'label',''),'Video'),'url',item.value->>'url',
      'provider',item.value->>'provider','file_id',item.value->>'file_id','account_id',item.value->>'account_id','source_index',item.ordinality-1) ORDER BY item.ordinality)
     FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) WITH ORDINALITY AS item(value,ordinality)),'[]'::jsonb) AS video_sources
    FROM public.movies WHERE is_published=TRUE
     AND (${category||null}::text IS NULL OR category=${category||null})
     AND (${query||null}::text IS NULL OR title ILIKE ${query?'%'+query+'%':null})
  ), series_rows AS (
    SELECT s.id,s.title,s.poster_url,s.category,s.created_at,'series'::text AS content_type,
      (SELECT COUNT(*)::int FROM public.episodes e WHERE e.series_id=s.id AND e.is_published=TRUE) AS episode_count,
      '[]'::jsonb AS video_sources
    FROM public.series s WHERE s.is_published=TRUE
     AND (${category||null}::text IS NULL OR s.category=${category||null})
     AND (${query||null}::text IS NULL OR s.title ILIKE ${query?'%'+query+'%':null})
  )
  SELECT * FROM (SELECT * FROM movie_rows UNION ALL SELECT * FROM series_rows) catalogue
  ORDER BY created_at DESC LIMIT 100`;
 } catch(error) {
  console.error('Series catalogue unavailable; using movie-only fallback:', error?.message || error);
  // This query uses only the original movies table, so a series migration
  // failure cannot make already-published movies disappear from the homepage.
  return await sql`SELECT id,title,poster_url,category,created_at,'movie'::text AS content_type,
    NULL::integer AS episode_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('label',COALESCE(NULLIF(item.value->>'label',''),'Video'),'url',item.value->>'url',
      'provider',item.value->>'provider','file_id',item.value->>'file_id','account_id',item.value->>'account_id','source_index',item.ordinality-1) ORDER BY item.ordinality)
    FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) WITH ORDINALITY AS item(value,ordinality)),'[]'::jsonb) AS video_sources
   FROM public.movies WHERE is_published=TRUE
    AND (${category||null}::text IS NULL OR category=${category||null})
    AND (${query||null}::text IS NULL OR title ILIKE ${query?'%'+query+'%':null})
   ORDER BY created_at DESC LIMIT 100`;
 }
}

export class PublicCatalogue extends WorkerEntrypoint {
 async fetch(request){
  if(request.method!=='GET')return new Response(null,{status:405,headers:{allow:'GET','cache-control':'no-store'}});
  const{category='',query=''}=this.ctx.props||{};
  const rows=await publicMovies(this.env,category,query);
  const movies=rows.flatMap(({video_sources,...movie})=>{
   if (movie.content_type === 'series') return [{...movie,video_sources:[]}];
   const playable=(video_sources||[]).flatMap(source=>{try{
    const index=Number(source.source_index);
    if(!Number.isInteger(index)||index<0||index>7)return[];
    if(source.provider==='google-drive-private'&&isGoogleDriveFileId(source.file_id)){
      return [{label:source.label||'Google Drive',provider:'google-drive-private',source_index:index}];
    }
    const url=videoSourceUrl(source.url);
    const provider=sourceProvider(url);
    return [{label:source.label||(provider==='archive.org'?'Archive.org':'Google Drive'),provider,source_index:index}];
   }catch{return[]}});
   return playable.length?[{...movie,video_sources:playable}]:[];
  });
  return json({movies},200,{'cache-control':'public, max-age='+CATALOGUE_CACHE_TTL+', stale-while-revalidate=120','cache-tag':'public-catalogue'});
 }
 async invalidate(){return this.ctx.cache.purge({tags:['public-catalogue']})}
}
export class MovieMetadata extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
    const contentId = this.ctx.props?.movieId;
    if (typeof contentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(contentId)) {
      return json({ movie: null }, 200, { 'cache-control': 'public, max-age=5' });
    }
    const sql = sqlFor(this.env);
    try {
      // Series tables are optional for legacy movies. Never run DDL or let
      // missing episode tables block metadata reads for existing movies.
      const rows = await sql`SELECT id,title,poster_url,category,videos AS video_sources,updated_at,'movie'::text AS content_type,
          NULL::uuid AS series_id,NULL::integer AS season_number,NULL::integer AS episode_number,NULL::text AS series_title
        FROM public.movies WHERE id=${contentId} AND is_published=TRUE
        UNION ALL
        SELECT e.id,e.title,s.poster_url,s.category,e.videos AS video_sources,e.updated_at,'episode'::text AS content_type,
          e.series_id,e.season_number,e.episode_number,s.title AS series_title
        FROM public.episodes e JOIN public.series s ON s.id=e.series_id
        WHERE e.id=${contentId} AND e.is_published=TRUE AND s.is_published=TRUE
        LIMIT 1`;
      return json({ movie: rows[0] || null }, 200, {
        'cache-control': 'public, max-age=' + MOVIE_METADATA_CACHE_TTL + ', stale-while-revalidate=90',
        'cache-tag': 'movie-meta-' + contentId
      });
    } catch (error) {
      console.error('Series metadata unavailable; returning legacy movie metadata:', error?.message || error);
      const rows = await sql`SELECT id,title,poster_url,category,videos AS video_sources,updated_at,'movie'::text AS content_type,
          NULL::uuid AS series_id,NULL::integer AS season_number,NULL::integer AS episode_number,NULL::text AS series_title
        FROM public.movies WHERE id=${contentId} AND is_published=TRUE LIMIT 1`;
      return json({ movie: rows[0] || null }, 200, {
        'cache-control': 'public, max-age=' + MOVIE_METADATA_CACHE_TTL + ', stale-while-revalidate=90',
        'cache-tag': 'movie-meta-' + contentId
      });
    }
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
    new Request('https://moviwatch.internal/__movie_metadata__v3/' + encodeURIComponent(movieId))
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

function driveOAuthStateCookie(nonce, verifier, env, connectionId = 'primary') {
  if (!env.JWT_SECRET) throw new Error('OAuth signing secret is not configured.');
  return (async () => {
    const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const body = b64(JSON.stringify({ sub: 'google-drive-oauth', nonce, verifier, connectionId, iat: now, exp: now + 600 }));
    const unsigned = head + '.' + body;
    return unsigned + '.' + b64(await hmac(enc.encode(env.JWT_SECRET), enc.encode(unsigned)));
  })();
}

async function verifyDriveOAuthState(token, env, expectedNonce) {
  try {
    if (!env.JWT_SECRET || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const head = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    const body = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== 'HS256' || body.sub !== 'google-drive-oauth' ||
        typeof body.nonce !== 'string' || body.nonce !== expectedNonce ||
        typeof body.verifier !== 'string' || body.verifier.length < 43 ||
        typeof body.connectionId !== 'string' || !/^(primary|[0-9a-f-]{36})$/i.test(body.connectionId) ||
        !Number.isInteger(body.iat) || body.iat > now + 60 ||
        !Number.isInteger(body.exp) || body.exp <= now || body.exp - body.iat > 600) return null;
    const expected = await hmac(enc.encode(env.JWT_SECRET), enc.encode(parts[0] + '.' + parts[1]));
    const received = unb64(parts[2]);
    if (received.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ received[i];
    return diff === 0 ? body : null;
  } catch { return null; }
}

function googleDriveAdminRedirect(env, result, clearCookie = '', accountId = '') {
  let origin = 'https://moviwatch.vercel.app';
  try { origin = new URL(env.GOOGLE_REDIRECT_URI).origin; } catch {}
  const headers = new Headers({
    location: new URL('/admin?drive=' + encodeURIComponent(result) + (accountId ? '&accountId=' + encodeURIComponent(accountId) : ''), origin).toString(),
    'cache-control': 'no-store'
  });
  if (clearCookie) headers.append('set-cookie', clearCookie);
  return new Response(null, { status: 302, headers });
}

async function startGoogleDriveOAuth(env, sql, connectionId = 'primary') {
  if (!isGoogleDriveConfigured(env)) {
    throw new Error('Google Drive is not configured. Add the four Google OAuth/encryption secrets in Cloudflare first.');
  }
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET must be configured before connecting Google Drive.');
  if (typeof connectionId !== 'string' || !/^(primary|[0-9a-f-]{36})$/i.test(connectionId)) throw new Error('Invalid Google Drive account ID.');
  await ensureGoogleDriveSchema(sql);
  const random = new Uint8Array(48);
  crypto.getRandomValues(random);
  const verifier = b64(random);
  const nonceBytes = new Uint8Array(24);
  crypto.getRandomValues(nonceBytes);
  const nonce = b64(nonceBytes);
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const stateCookie = await driveOAuthStateCookie(nonce, verifier, env, connectionId);
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state: nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();
  return {
    authorizationUrl: authorization.toString(),
    cookie: 'moviwatch_google_oauth=' + stateCookie + '; HttpOnly; Secure; SameSite=Lax; Path=/api/google-drive/oauth/callback; Max-Age=600'
  };
}

async function completeGoogleDriveOAuth(req, env) {
  const url = new URL(req.url);
  const clearCookie = 'moviwatch_google_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/google-drive/oauth/callback; Max-Age=0';
  const state = url.searchParams.get('state') || '';
  const cookie = getCookieValue(req, 'moviwatch_google_oauth');
  const stateBody = await verifyDriveOAuthState(cookie, env, state);
  if (!stateBody) {
    return googleDriveAdminRedirect(env, 'error', clearCookie);
  }
  if (url.searchParams.has('error')) {
    return googleDriveAdminRedirect(env, 'cancelled', clearCookie);
  }
  const code = url.searchParams.get('code') || '';
  if (!code || code.length > 4096 || !isGoogleDriveConfigured(env)) {
    return googleDriveAdminRedirect(env, 'error', clearCookie);
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: stateBody.verifier
      })
    });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokenPayload.access_token !== 'string') {
      console.warn('Google OAuth token exchange rejected:', tokenPayload.error || tokenResponse.status);
      throw new Error('Google did not complete authorization.');
    }

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenPayload.access_token }
    });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || typeof profile.email !== 'string' || profile.email_verified !== true) {
      throw new Error('Google account email could not be verified.');
    }

    const sql = sqlFor(env);
    await ensureGoogleDriveSchema(sql);
    // One verified Google email maps to one connection. Adding an account that
    // is already connected refreshes its existing slot instead of duplicating it.
    const existingAccount = await sql`SELECT id FROM public.google_drive_connections
      WHERE LOWER(account_email)=LOWER(${profile.email}) LIMIT 1`;
    const connectionId = existingAccount[0]?.id || stateBody.connectionId;
    let refreshToken = tokenPayload.refresh_token;
    if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
      const previous = await sql`SELECT refresh_token_ciphertext, refresh_token_iv
        FROM public.google_drive_connections WHERE id=${connectionId} LIMIT 1`;
      if (previous[0]) {
        refreshToken = await decryptGoogleDriveSecret(
          env, previous[0].refresh_token_ciphertext, previous[0].refresh_token_iv,
          googleDriveTokenAad(connectionId)
        );
      }
    }
    if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
      throw new Error('Google did not return an offline refresh token. Disconnect the app from your Google Account and reconnect with consent.');
    }
    const encrypted = await encryptGoogleDriveSecret(
      env, refreshToken, googleDriveTokenAad(connectionId)
    );
    await sql`INSERT INTO public.google_drive_connections
      (id,account_email,refresh_token_ciphertext,refresh_token_iv,scopes,connected_at,updated_at)
      VALUES(${connectionId},${profile.email},${encrypted.ciphertext},${encrypted.iv},${tokenPayload.scope || ''},NOW(),NOW())
      ON CONFLICT(id) DO UPDATE SET account_email=EXCLUDED.account_email,
      refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
      refresh_token_iv=EXCLUDED.refresh_token_iv,scopes=EXCLUDED.scopes,updated_at=NOW()`;
    clearGoogleDriveAccessTokenCache();
    return googleDriveAdminRedirect(env, 'connected', clearCookie, connectionId);
  } catch (error) {
    console.error('Google Drive OAuth callback failed:', error?.message || error);
    return googleDriveAdminRedirect(env, 'error', clearCookie);
  }
}

async function googleDriveJson(sql, env, path, options = {}, connectionId = 'primary') {
  const url = new URL(path, 'https://www.googleapis.com');
  const response = await googleDriveApiRequest(sql, env, url.toString(), options, connectionId);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.error?.message === 'string' ? payload.error.message : 'Google Drive request failed.';
    throw new Error(detail.slice(0, 240));
  }
  return payload;
}

function driveSafeName(value) {
  if (typeof value !== 'string') throw new Error('File or folder name is required.');
  const name = value.normalize('NFC').replace(/[\\/:*\x00-\x1f\x7f]/g, '').trim();
  if (!name || name === '.' || name === '..' || name.length > 240) throw new Error('Use a valid name (1–240 characters).');
  return name;
}

function driveQueryEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isDriveVideoFile(file) {
  if (!file || file.mimeType === 'application/vnd.google-apps.folder') return false;
  if (typeof file.mimeType === 'string' && file.mimeType.toLowerCase().startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg|mpe|3gp|3g2|ts|ogv|flv)$/i.test(file.name || '');
}

async function driveFileMetadata(sql, env, fileId, connectionId = 'primary') {
  if (!isGoogleDriveFileId(fileId)) throw new Error('Invalid Google Drive file ID.');
  const fields = 'id,name,mimeType,size,modifiedTime,parents,driveId,trashed,webViewLink,capabilities(canEdit,canDelete,canDownload,canRename)';
  const data = await googleDriveJson(sql, env, '/drive/v3/files/' + encodeURIComponent(fileId) +
    '?supportsAllDrives=true&fields=' + encodeURIComponent(fields), {}, connectionId);
  const summary = googleDrivePublicFileSummary(data);
  if (!summary) throw new Error('Google Drive returned invalid file metadata.');
  if (data.trashed) throw new Error('This Google Drive file is in the trash.');
  return summary;
}

async function startGoogleDriveUpload(sql, env, body, connectionId = 'primary') {
  const fileName = driveSafeName(body.fileName);
  const parentId = body.parentId === 'root' || !body.parentId ? 'root' : body.parentId;
  if (parentId !== 'root' && !isGoogleDriveFileId(parentId)) throw new Error('Invalid destination folder.');
  const driveId = body.driveId ? String(body.driveId) : '';
  if (driveId && !isGoogleDriveFileId(driveId)) throw new Error('Invalid Shared Drive ID.');
  const total = Number(body.totalBytes);
  if (!Number.isSafeInteger(total) || total < 1 || total > 100 * 1024 * 1024 * 1024) {
    throw new Error('File must be between 1 byte and 100 GB.');
  }
  const mimeType = typeof body.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(body.mimeType)
    ? body.mimeType : 'application/octet-stream';
  const replaceFileId = body.replaceFileId ? String(body.replaceFileId) : '';
  let targetPath = '/upload/drive/v3/files';
  let method = 'POST';
  const params = new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true',
    fields: 'id,name,mimeType,size,modifiedTime,parents,driveId,capabilities(canEdit,canDelete,canDownload,canRename)' });
  let metadata = { name: fileName, mimeType };
  if (replaceFileId) {
    if (!isGoogleDriveFileId(replaceFileId)) throw new Error('Invalid file selected for replacement.');
    const existing = await driveFileMetadata(sql, env, replaceFileId, connectionId);
    if (!existing.capabilities.canEdit) throw new Error('You do not have permission to replace this Drive file.');
    targetPath += '/' + encodeURIComponent(replaceFileId);
    method = 'PATCH';
    delete metadata.name;
  } else {
    metadata.parents = [parentId];
  }
  const headers = new Headers({
    'content-type': 'application/json; charset=UTF-8',
    'x-upload-content-type': mimeType,
    'x-upload-content-length': String(total)
  });
  const response = await googleDriveApiRequest(sql, env,
    'https://www.googleapis.com' + targetPath + '?' + params.toString(),
    { method, headers, body: JSON.stringify(metadata) }, connectionId);
  const sessionUrl = response.headers.get('location');
  if (!response.ok || !sessionUrl) {
    try { await response.body?.cancel(); } catch {}
    throw new Error('Google Drive could not start a resumable upload (HTTP ' + response.status + ').');
  }
  const parsedSession = new URL(sessionUrl);
  if (parsedSession.protocol !== 'https:' || parsedSession.origin !== 'https://www.googleapis.com' ||
      !parsedSession.pathname.startsWith('/upload/drive/v3/')) {
    throw new Error('Google Drive returned an unexpected upload session URL.');
  }

  const uploadId = crypto.randomUUID();
  const aad = 'moviwatch-google-drive-upload:' + uploadId;
  const encryptedSession = await encryptGoogleDriveSecret(env, sessionUrl, aad);
  await ensureGoogleDriveSchema(sql);
  await sql`INSERT INTO public.google_drive_uploads
    (id,file_name,parent_id,drive_id,mime_type,total_bytes,next_byte,
     session_ciphertext,session_iv,expires_at,connection_id,state,file_id)
    VALUES(${uploadId},${fileName},${parentId},${driveId || null},${mimeType},
      ${total},0,${encryptedSession.ciphertext},${encryptedSession.iv},
      NOW()+INTERVAL '7 days',${connectionId},'active',${replaceFileId || null})`;
  return { uploadId, chunkSize: 8 * 1024 * 1024, totalBytes: total, nextByte: 0 };
}

async function googleDriveUploadStatus(sql, env, uploadId) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error('Invalid upload ID.');
  await ensureGoogleDriveSchema(sql);
  const rows = await sql`SELECT id,file_name,total_bytes,next_byte,session_ciphertext,session_iv,
      expires_at,connection_id,state,file_id
    FROM public.google_drive_uploads WHERE id=${uploadId} LIMIT 1`;
  const upload = rows[0];
  if (!upload) throw new Error('Upload not found.');
  const total = Number(upload.total_bytes);
  if (upload.state === 'complete') {
    return { uploadId, state: 'complete', fileId: upload.file_id, totalBytes: total, nextByte: total };
  }
  if (upload.state !== 'active') {
    return { uploadId, state: upload.state, totalBytes: total, nextByte: Number(upload.next_byte) };
  }
  if (new Date(upload.expires_at).getTime() <= Date.now()) {
    await sql`UPDATE public.google_drive_uploads SET state='expired',updated_at=NOW() WHERE id=${uploadId}`;
    return { uploadId, state: 'expired', totalBytes: total, nextByte: Number(upload.next_byte) };
  }
  const sessionUrl = await decryptGoogleDriveSecret(
    env, upload.session_ciphertext, upload.session_iv, 'moviwatch-google-drive-upload:' + uploadId
  );
  const target = new URL(sessionUrl);
  if (target.protocol !== 'https:' || target.origin !== 'https://www.googleapis.com' ||
      !target.pathname.startsWith('/upload/drive/v3/')) throw new Error('Stored Google Drive upload session is invalid.');
  const response = await googleDriveApiRequest(sql, env, sessionUrl, {
    method: 'PUT',
    headers: { 'content-length': '0', 'content-range': 'bytes */' + total }
  }, upload.connection_id || 'primary');
  if (response.status === 308) {
    const received = /^bytes=0-([0-9]+)$/.exec(response.headers.get('range') || '');
    const nextByte = received ? Number(received[1]) + 1 : 0;
    await response.body?.cancel();
    if (!Number.isSafeInteger(nextByte) || nextByte < 0 || nextByte > total) {
      throw new Error('Google Drive returned an invalid resumable upload offset.');
    }
    await sql`UPDATE public.google_drive_uploads SET next_byte=${nextByte},updated_at=NOW()
      WHERE id=${uploadId} AND state='active'`;
    return { uploadId, state: 'active', totalBytes: total, nextByte };
  }
  if (response.status === 200 || response.status === 201) {
    const payload = await response.json().catch(() => ({}));
    const file = googleDrivePublicFileSummary(payload);
    if (!file?.id) throw new Error('Google Drive completed the upload but returned invalid file metadata.');
    await sql`UPDATE public.google_drive_uploads SET next_byte=${total},state='complete',file_id=${file.id},updated_at=NOW()
      WHERE id=${uploadId}`;
    return { uploadId, state: 'complete', totalBytes: total, nextByte: total, file };
  }
  if (response.status === 404 || response.status === 410) {
    await sql`UPDATE public.google_drive_uploads SET state='expired',updated_at=NOW()
      WHERE id=${uploadId} AND state='active'`;
    return { uploadId, state: 'expired', totalBytes: total, nextByte: Number(upload.next_byte) };
  }
  const detail = await response.text().catch(() => '');
  throw new Error('Google Drive upload status check failed (HTTP ' + response.status + '). ' + detail.slice(0, 160));
}

async function googleDriveUploadChunk(req, sql, env, uploadId) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error('Invalid upload ID.');
  await ensureGoogleDriveSchema(sql);
  const rows = await sql`SELECT id,file_name,mime_type,total_bytes,next_byte,session_ciphertext,session_iv,
      expires_at,connection_id,state,file_id
    FROM public.google_drive_uploads WHERE id=${uploadId} LIMIT 1`;
  const upload = rows[0];
  if (!upload || upload.state !== 'active') throw new Error('Upload is not active.');
  if (new Date(upload.expires_at).getTime() <= Date.now()) throw new Error('Upload session expired. Start the upload again.');

  const total = Number(upload.total_bytes);
  const nextByte = Number(upload.next_byte);
  const contentRange = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(req.headers.get('Content-Range') || '');
  if (!contentRange) throw new Error('A valid Content-Range header is required.');
  const start = Number(contentRange[1]), end = Number(contentRange[2]), announcedTotal = Number(contentRange[3]);
  const chunkLength = end - start + 1;
  if (![start,end,announcedTotal,chunkLength].every(Number.isSafeInteger) ||
      start !== nextByte || announcedTotal !== total || end < start ||
      chunkLength < 1 || chunkLength > 8 * 1024 * 1024 || end >= total ||
      (end + 1 < total && chunkLength % (256 * 1024) !== 0)) {
    throw new Error('Upload chunk range is invalid or out of order.');
  }
  const announcedLength = req.headers.get('Content-Length');
  if (announcedLength && Number(announcedLength) !== chunkLength) throw new Error('Upload chunk size does not match Content-Range.');
  if (!req.body) throw new Error('Upload chunk body is empty.');

  const sessionUrl = await decryptGoogleDriveSecret(
    env, upload.session_ciphertext, upload.session_iv, 'moviwatch-google-drive-upload:' + uploadId
  );
  const target = new URL(sessionUrl);
  if (target.protocol !== 'https:' || target.origin !== 'https://www.googleapis.com' ||
      !target.pathname.startsWith('/upload/drive/v3/')) throw new Error('Stored Google Drive upload session is invalid.');

  const response = await googleDriveApiRequest(sql, env, sessionUrl, {
    method: 'PUT',
    headers: {
      'content-type': upload.mime_type,
      'content-length': String(chunkLength),
      'content-range': 'bytes ' + start + '-' + end + '/' + total
    },
    body: req.body
  }, upload.connection_id || 'primary');

  if (response.status === 308) {
    const received = /^bytes=0-([0-9]+)$/.exec(response.headers.get('range') || '');
    const actualNextByte = received ? Number(received[1]) + 1 : start;
    await response.body?.cancel();
    if (!Number.isSafeInteger(actualNextByte) || actualNextByte < start || actualNextByte > end + 1) {
      throw new Error('Google Drive returned an invalid upload offset.');
    }
    await sql`UPDATE public.google_drive_uploads SET next_byte=${actualNextByte},updated_at=NOW()
      WHERE id=${uploadId} AND state='active'`;
    return { complete: false, nextByte: actualNextByte, totalBytes: total };
  }

  if (response.status === 200 || response.status === 201) {
    const data = await response.json().catch(() => ({}));
    const file = googleDrivePublicFileSummary(data);
    if (!file || !file.id) throw new Error('Google Drive completed the upload but returned invalid file metadata.');
    await sql`UPDATE public.google_drive_uploads SET next_byte=${total},state='complete',file_id=${file.id},updated_at=NOW()
      WHERE id=${uploadId}`;
    return { complete: true, nextByte: total, totalBytes: total, file };
  }

  const details = await response.text().catch(() => '');
  throw new Error('Google Drive upload chunk failed (HTTP ' + response.status + '). ' + details.slice(0, 160));
}

async function refreshAttachedGoogleDriveReferences(ctx, sql, env, fileId, connectionId = 'primary') {
  if (!isGoogleDriveFileId(fileId)) return;
  const metadata = await driveFileMetadata(sql, env, fileId, connectionId);
  const affected = await sql`SELECT id FROM public.movies
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) AS item
      WHERE item->>'provider'='google-drive-private' AND item->>'file_id'=${fileId}
        AND COALESCE(item->>'account_id','primary')=${connectionId})`;
  for (const movie of affected) {
    const rows = await sql`SELECT videos FROM public.movies WHERE id=${movie.id} LIMIT 1`;
    const sources = Array.isArray(rows[0]?.videos) ? rows[0].videos : [];
    const updated = sources.map((source) => {
      if (source?.provider !== 'google-drive-private' || source?.file_id !== fileId ||
          (source?.account_id || 'primary') !== connectionId) return source;
      return { ...source, modified_time: metadata.modifiedTime, drive_id: metadata.driveId || null };
    });
    await sql`UPDATE public.movies SET videos=${JSON.stringify(updated)}::jsonb,updated_at=NOW()
      WHERE id=${movie.id}`;
    await invalidateContentCaches(ctx, movie.id);
  }
  await ensureSeriesSchema(sql);
  const affectedEpisodes = await sql`SELECT id FROM public.episodes
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) AS item
      WHERE item->>'provider'='google-drive-private' AND item->>'file_id'=${fileId}
        AND COALESCE(item->>'account_id','primary')=${connectionId})`;
  for (const episode of affectedEpisodes) {
    const rows = await sql`SELECT videos FROM public.episodes WHERE id=${episode.id} LIMIT 1`;
    const sources = Array.isArray(rows[0]?.videos) ? rows[0].videos : [];
    const updated = sources.map((source) => {
      if (source?.provider !== 'google-drive-private' || source?.file_id !== fileId ||
          (source?.account_id || 'primary') !== connectionId) return source;
      return { ...source, modified_time: metadata.modifiedTime, drive_id: metadata.driveId || null };
    });
    await sql`UPDATE public.episodes SET videos=${JSON.stringify(updated)}::jsonb,updated_at=NOW()
      WHERE id=${episode.id}`;
    await invalidateContentCaches(ctx, episode.id);
  }
  return { updatedMovies: affected.length, updatedEpisodes: affectedEpisodes.length, modifiedTime: metadata.modifiedTime };
}

async function handleGoogleDriveAdmin(req, env, ctx, path, method) {
  const sql = sqlFor(env);
  const requestUrl = new URL(req.url);
  const body = ['POST','PUT','PATCH'].includes(method) && (req.headers.get('content-type') || '').toLowerCase().includes('application/json') ? await readBody(req) : {};
  const connectionId = String(requestUrl.searchParams.get('accountId') || body.accountId || 'primary');
  if (!/^(primary|[0-9a-f-]{36})$/i.test(connectionId)) throw new Error('Invalid Google Drive account ID.');
  if (path === '/api/admin/google-drive/accounts' && method === 'GET') {
    const accounts = await googleDriveConnections(sql);
    return json({ accounts: accounts.map(({id,account_email,scopes,connected_at}) => ({id,email:account_email,scopes,connectedAt:connected_at})) });
  }

  if (path === '/api/admin/google-drive/status' && method === 'GET') {
    const connection = await googleDriveConnection(sql, connectionId);
    return json({
      configured: isGoogleDriveConfigured(env),
      configurationIssues: googleDriveConfigurationIssues(env),
      connected: Boolean(connection),
      accountId: connection?.id || connectionId,
      accountEmail: connection?.account_email || null,
      scopes: connection?.scopes || '',
      connectedAt: connection?.connected_at || null
    });
  }

  if (path === '/api/admin/google-drive/oauth/start' && method === 'POST') {
    const requestedId = body.accountId;
    const existingAccounts = await googleDriveConnections(sql);
    const nextId = body.addAccount === true ? (existingAccounts.length ? crypto.randomUUID() : 'primary') : (requestedId || (existingAccounts.length ? 'primary' : 'primary'));
    const flow = await startGoogleDriveOAuth(env, sql, nextId);
    return json({ authorizationUrl: flow.authorizationUrl, accountId: nextId }, 200, { 'set-cookie': flow.cookie });
  }

  // An authenticated admin can clear a stale connection even if OAuth
  // settings are missing or the previous encryption key has been rotated.
  if (path === '/api/admin/google-drive/disconnect' && method === 'DELETE') {
    await ensureGoogleDriveSchema(sql);
    await sql`DELETE FROM public.google_drive_connections WHERE id=${connectionId}`;
    await sql`UPDATE public.google_drive_uploads SET state='cancelled',updated_at=NOW() WHERE state='active' AND connection_id=${connectionId}`;
    clearGoogleDriveAccessTokenCache(connectionId);
    return json({ ok: true });
  }

  if (path === '/api/admin/google-drive/diagnostics' && method === 'GET') {
    const connection = await googleDriveConnection(sql, connectionId);
    const configurationIssues = googleDriveConfigurationIssues(env);
    const dbRows = await sql`SELECT current_database() AS database_name,
      current_schema() AS schema_name,
      (SELECT COUNT(*)::int FROM public.movies) AS movie_count`;
    const result = {
      configured: configurationIssues.length === 0,
      configurationIssues,
      connected: Boolean(connection),
      accountEmail: connection?.account_email || null,
      grantedScopes: connection?.scopes || '',
      connectedAt: connection?.connected_at || null,
      database: {
        name: dbRows[0]?.database_name || null,
        schema: dbRows[0]?.schema_name || null,
        movieCount: Number(dbRows[0]?.movie_count || 0)
      }
    };
    if (configurationIssues.length || !connection) {
      return json({ ...result, ok: false, stage: 'configuration_or_connection' });
    }
    let token;
    try {
      token = await googleDriveAccessToken(sql, env, connectionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown token error';
      const stage = /cannot be decrypted/i.test(message) ? 'refresh_token_decryption' :
        /expired or was revoked|invalid_grant/i.test(message) ? 'refresh_token_rejected' :
        /could not refresh/i.test(message) ? 'oauth_token_refresh' : 'refresh_token_access';
      return json({ ...result, ok: false, stage, diagnosticError: message.slice(0, 260) });
    }
    let response;
    try {
      response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
        headers: { Authorization: 'Bearer ' + token }
      });
    } catch {
      return json({ ...result, ok: false, stage: 'google_api_network', diagnosticError: 'Could not reach Google Drive API.' });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errors = Array.isArray(payload.error?.errors) ? payload.error.errors : [];
      return json({
        ...result,
        ok: false,
        stage: 'google_drive_api',
        googleHttpStatus: response.status,
        googleStatus: payload.error?.status || null,
        googleReason: errors[0]?.reason || null,
        diagnosticError: (payload.error?.message || 'Google Drive API rejected the request.').slice(0, 260)
      });
    }
    return json({
      ...result,
      ok: true,
      stage: 'ready',
      googleAccountEmail: payload.user?.emailAddress || null
    });
  }

  if (!isGoogleDriveConfigured(env)) {
    return json({ error: 'Google Drive is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and GOOGLE_DRIVE_ENCRYPTION_KEY to Cloudflare Worker Secrets.' }, 503);
  }
  await ensureGoogleDriveSchema(sql);
  await googleDriveAccessToken(sql, env, connectionId);

  if (path === '/api/admin/google-drive/drives' && method === 'GET') {
    const data = await googleDriveJson(sql, env,
      '/drive/v3/drives?pageSize=100&fields=' + encodeURIComponent('drives(id,name),nextPageToken'), {}, connectionId);
    return json({ drives: [{ id: 'root', name: 'My Drive', kind: 'user' }, ...(data.drives || []).map((drive) => ({
      id: drive.id, name: drive.name || 'Shared Drive', kind: 'shared'
    }))], nextPageToken: data.nextPageToken || null });
  }
  if (path === '/api/admin/google-drive/files' && method === 'GET') {
    const url = new URL(req.url);
    const parentId = url.searchParams.get('parentId') || 'root';
    const driveId = url.searchParams.get('driveId') || '';
    const search = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const pageToken = url.searchParams.get('pageToken') || '';
    if (parentId !== 'root' && !isGoogleDriveFileId(parentId)) throw new Error('Invalid Drive folder ID.');
    if (driveId && !isGoogleDriveFileId(driveId)) throw new Error('Invalid Shared Drive ID.');
    if (pageToken.length > 3000) throw new Error('Invalid Drive page token.');
    const q = ["trashed = false", "'" + driveQueryEscape(parentId) + "' in parents"];
    if (search) q.push("name contains '" + driveQueryEscape(search) + "'");
    const params = new URLSearchParams({
      q: q.join(' and '),
      pageSize: '100',
      orderBy: 'folder,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,driveId,capabilities(canEdit,canDelete,canDownload,canRename))'
    });
    if (driveId) {
      params.set('corpora', 'drive');
      params.set('driveId', driveId);
    } else {
      params.set('corpora', 'user');
    }
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleDriveJson(sql, env, '/drive/v3/files?' + params.toString(), {}, connectionId);
    const files = (data.files || []).map(googleDrivePublicFileSummary).filter(Boolean);
    return json({ files, nextPageToken: data.nextPageToken || null, parentId, driveId });
  }

  if (path === '/api/admin/google-drive/folders' && method === 'POST') {
    const name = driveSafeName(body.name);
    const parentId = body.parentId || 'root';
    if (parentId !== 'root' && !isGoogleDriveFileId(parentId)) throw new Error('Invalid parent folder ID.');
    const metadata = { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] };
    const data = await googleDriveJson(sql, env, '/drive/v3/files?supportsAllDrives=true&fields=' +
      encodeURIComponent('id,name,mimeType,modifiedTime,parents,driveId,capabilities(canEdit,canDelete,canDownload,canRename)'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata)
    }, connectionId);
    return json({ folder: googleDrivePublicFileSummary(data) }, 201);
  }

  if (path === '/api/admin/google-drive/uploads' && method === 'POST') {
    const upload = await startGoogleDriveUpload(sql, env, body, connectionId);
    return json(upload, 201);
  }

  const uploadMatch = /^\/api\/admin\/google-drive\/uploads\/([0-9a-f-]{36})$/.exec(path);
  if (uploadMatch && method === 'GET') {
    const status = await googleDriveUploadStatus(sql, env, uploadMatch[1]);
    if (status.state === 'complete' && status.fileId) {
      const cacheUpdate = await refreshAttachedGoogleDriveReferences(ctx, sql, env, status.fileId, connectionId);
      status.updatedMovies = cacheUpdate?.updatedMovies || 0;
    }
    return json(status);
  }
  if (uploadMatch && method === 'PUT') {
    const progress = await googleDriveUploadChunk(req, sql, env, uploadMatch[1]);
    if (progress.complete && progress.file?.id) {
      const uploadRows = await sql`SELECT file_id,connection_id FROM public.google_drive_uploads WHERE id=${uploadMatch[1]} LIMIT 1`;
      if (uploadRows[0]?.file_id) {
        const cacheUpdate = await refreshAttachedGoogleDriveReferences(ctx, sql, env, progress.file.id, uploadRows[0]?.connection_id || connectionId);
        progress.updatedMovies = cacheUpdate?.updatedMovies || 0;
      }
    }
    return json(progress);
  }
  if (uploadMatch && method === 'DELETE') {
    await sql`UPDATE public.google_drive_uploads SET state='cancelled',updated_at=NOW()
      WHERE id=${uploadMatch[1]} AND state='active'`;
    return json({ ok: true });
  }

  const fileMatch = /^\/api\/admin\/google-drive\/files\/([A-Za-z0-9_-]{10,200})$/.exec(path);
  if (fileMatch && method === 'GET') {
    const file = await driveFileMetadata(sql, env, fileMatch[1], connectionId);
    return json({ file });
  }
  if (fileMatch && method === 'PATCH') {
    const name = driveSafeName(body.name);
    const current = await driveFileMetadata(sql, env, fileMatch[1], connectionId);
    if (!current.capabilities.canEdit || !current.capabilities.canRename) throw new Error('You do not have permission to rename this Drive file.');
    const data = await googleDriveJson(sql, env, '/drive/v3/files/' + encodeURIComponent(fileMatch[1]) +
      '?supportsAllDrives=true&fields=' + encodeURIComponent('id,name,mimeType,size,modifiedTime,parents,driveId,capabilities(canEdit,canDelete,canDownload,canRename)'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    }, connectionId);
    const updatedFile = googleDrivePublicFileSummary(data);
    if (updatedFile) await refreshAttachedGoogleDriveReferences(ctx, sql, env, updatedFile.id, connectionId);
    return json({ file: updatedFile });
  }
  if (fileMatch && method === 'DELETE') {
    const current = await driveFileMetadata(sql, env, fileMatch[1], connectionId);
    if (!current.capabilities.canDelete) throw new Error('You do not have permission to move this Drive file to trash.');
    if (current.driveId) {
      // Shared Drive items do not use an individual user's trash. Deleting
      // there is permanent and the UI asks for explicit confirmation.
      const response = await googleDriveApiRequest(sql, env,
        'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileMatch[1]) + '?supportsAllDrives=true',
        { method: 'DELETE' }, connectionId);
      if (!response.ok && response.status !== 204) {
        const detail = await response.text().catch(() => '');
        throw new Error('Google Drive delete failed (HTTP ' + response.status + '). ' + detail.slice(0, 160));
      }
    } else {
      await googleDriveJson(sql, env, '/drive/v3/files/' + encodeURIComponent(fileMatch[1]) +
        '?supportsAllDrives=true&fields=id,trashed', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      }, connectionId);
    }
    const affected = await sql`SELECT id FROM public.movies
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) AS item
        WHERE item->>'provider'='google-drive-private' AND item->>'file_id'=${fileMatch[1]}
          AND COALESCE(item->>'account_id','primary')=${connectionId})`;
    for (const movie of affected) {
      const rows = await sql`SELECT videos FROM public.movies WHERE id=${movie.id} LIMIT 1`;
      const sources = Array.isArray(rows[0]?.videos) ? rows[0].videos : [];
      const remaining = sources.filter((item) => !(item?.provider==='google-drive-private' &&
        item?.file_id===fileMatch[1] && (item?.account_id || 'primary')===connectionId));
      await sql`UPDATE public.movies SET videos=${JSON.stringify(remaining)}::jsonb,updated_at=NOW() WHERE id=${movie.id}`;
      await invalidateContentCaches(ctx, movie.id);
    }
    await ensureSeriesSchema(sql);
    const affectedEpisodes = await sql`SELECT id FROM public.episodes
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(videos,'[]'::jsonb)) AS item
        WHERE item->>'provider'='google-drive-private' AND item->>'file_id'=${fileMatch[1]}
          AND COALESCE(item->>'account_id','primary')=${connectionId})`;
    for (const episode of affectedEpisodes) {
      const rows = await sql`SELECT videos FROM public.episodes WHERE id=${episode.id} LIMIT 1`;
      const sources = Array.isArray(rows[0]?.videos) ? rows[0].videos : [];
      const remaining = sources.filter((item) => !(item?.provider==='google-drive-private' &&
        item?.file_id===fileMatch[1] && (item?.account_id || 'primary')===connectionId));
      await sql`UPDATE public.episodes SET videos=${JSON.stringify(remaining)}::jsonb,updated_at=NOW() WHERE id=${episode.id}`;
      await invalidateContentCaches(ctx, episode.id);
    }
    return json({ ok: true, detachedMovies: affected.length, detachedEpisodes: affectedEpisodes.length });
  }

  if (path === '/api/admin/google-drive/attach' && method === 'POST') {
    const movieId = typeof body.movieId === 'string' ? body.movieId : '';
    if (!/^[0-9a-f-]{36}$/i.test(movieId)) throw new Error('Choose a valid movie.');
    const file = await driveFileMetadata(sql, env, String(body.fileId || ''), connectionId);
    if (!isDriveVideoFile(file)) throw new Error('Choose a video file (MP4, MKV, MOV, WebM, AVI, or another video MIME type).');
    if (file.capabilities.canDownload === false) throw new Error('This Google Drive file cannot be downloaded by the connected account.');
    const rows = await sql`SELECT videos FROM public.movies WHERE id=${movieId} LIMIT 1`;
    if (!rows[0]) return json({ error: 'Movie not found.' }, 404);
    const sources = Array.isArray(rows[0].videos) ? rows[0].videos : [];
    if (sources.length >= 8) throw new Error('A movie can have up to 8 video sources.');
    const source = {
      label: (typeof body.label === 'string' && body.label.trim() ? body.label.trim() : file.name).slice(0, 60),
      provider: 'google-drive-private',
      file_id: file.id,
      account_id: connectionId,
      drive_id: file.driveId || null,
      modified_time: file.modifiedTime || null
    };
    if (sources.some((item) => item?.provider === source.provider && item?.file_id === source.file_id)) {
      throw new Error('This Drive file is already attached to the movie.');
    }
    sources.push(source);
    await sql`UPDATE public.movies SET videos=${JSON.stringify(sources)}::jsonb,updated_at=NOW() WHERE id=${movieId}`;
    await invalidateContentCaches(ctx, movieId);
    return json({ ok: true, source: { label: source.label, provider: source.provider } }, 201);
  }

  return json({ error: 'Google Drive endpoint not found.' }, 404);
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

// Video edge cache: store complete 4 MiB continuation chunks as cacheable 200 responses.
// Public 206 responses are capped at the active chunk boundary so open-ended
// browser ranges never stream the complete remainder of a movie in one response.
const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024;
const VIDEO_DIRECT_SEEK_THRESHOLD = 256 * 1024;
const VIDEO_STARTUP_CHUNK_SIZE = 1024 * 1024;
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
    props: cachedSourceProps(source, normalizedSourceVersion)
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
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const container = response.headers.get('x-moviwatch-container') || 'unknown';
  // Some internal cache/entrypoint response paths may omit Content-Length
  // for a streaming body. The trusted range metadata still determines the
  // exact segment size; when the header exists, it must agree with that size.
  const contentLengthHeader = response.headers.get('content-length');
  const expectedLength = end - start + 1;
  const contentLength = contentLengthHeader === null
    ? expectedLength
    : Number(contentLengthHeader);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) || start !== chunkStart || end < start ||
      total <= end || end > chunkStart + chunkSize - 1 ||
      !Number.isSafeInteger(contentLength) || contentLength !== expectedLength || !response.body) {
    const diagnostic = {
      start, end, total, chunkStart, chunkSize,
      contentLengthHeader, expectedLength, cacheStatus,
      hasBody: Boolean(response.body)
    };
    console.error('Invalid cached video chunk metadata:', diagnostic);
    try { await response.body?.cancel(); } catch {}
    throw new Error('Cloudflare returned an invalid cached video chunk');
  }

  // Keep the player path streaming. On a miss, a second branch drains the
  // cache object to completion so it can be stored for subsequent viewers.
  let body = response.body;
  if (cacheStatus !== 'HIT') {
    const branches = body.tee();
    body = branches[0];
    ctx.waitUntil(branches[1].pipeTo(new WritableStream({ write() {} })).catch((error) => {
      console.warn('Background video cache fill did not complete:', error?.message || error);
    }));
  }
  return { body, start, end, total, contentType, container, cacheStatus };
}

async function getVideoHeader(ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash) {
  const internalUrl = new URL(
    '/__video_header__/' + encodeURIComponent(movieId) + '/' + optionIndex + '/' + sourceHash,
    'https://moviwatch.internal'
  );
  const headerEntry = ctx.exports.VideoHeader({
    props: cachedSourceProps(source, normalizedSourceVersion)
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
  const startupSize = fragmented ? VIDEO_FRAGMENT_START_CHUNK_SIZE : VIDEO_STARTUP_CHUNK_SIZE;
  if (offset < startupSize) return 0;
  return startupSize + Math.floor((offset - startupSize) / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
}

function videoChunkSizeAt(chunkStart, fragmented) {
  if (chunkStart !== 0) return VIDEO_CHUNK_SIZE;
  return fragmented ? VIDEO_FRAGMENT_START_CHUNK_SIZE : VIDEO_STARTUP_CHUNK_SIZE;
}

async function fetchConfiguredVideoRange(source, start, end, env, timeoutOverride = 0, streamBody = false, externalSignal = null) {
  if (source?.provider !== 'google-drive-private') {
    return fetchVideoRangeFromMirrors(source.url, start, end, timeoutOverride, streamBody, externalSignal);
  }
  if (!isGoogleDriveFileId(source.fileId) || source.url !== googleDriveMediaUrl(source.fileId)) {
    throw new Error('Invalid private Google Drive video source');
  }
  const timeoutSignal = AbortSignal.timeout(timeoutOverride || Math.max(45000, Math.min(5 * 60 * 1000, 30000 + (end - start + 1) / (192 * 1024) * 2000)));
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const rangeHeaders = new Headers({ Range: 'bytes=' + start + '-' + end, 'Accept-Encoding': 'identity' });
  let mediaUrl = source.url;
  let upstream = null;
  for (let hop = 0; hop <= 5; hop++) {
    upstream = hop === 0
      ? await googleDriveApiRequest(sqlFor(env), env, mediaUrl, { headers: rangeHeaders, signal }, source.accountId || 'primary', redisFor(env))
      : await fetch(mediaUrl, { method: 'GET', headers: rangeHeaders, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
    const location = upstream.headers.get('location');
    try { await upstream.body?.cancel(); } catch {}
    if (!location || hop === 5) throw new Error('Google Drive media redirect limit reached.');
    const redirected = new URL(location, mediaUrl);
    const host = redirected.hostname.toLowerCase();
    const trustedRedirect = host === 'drive.usercontent.google.com' ||
      host === 'drive.google.com' || host === 'googleusercontent.com' ||
      host.endsWith('.googleusercontent.com') || host.endsWith('.googleapis.com');
    if (redirected.protocol !== 'https:' || !trustedRedirect) {
      throw new Error('Google Drive returned an untrusted media redirect.');
    }
    mediaUrl = redirected.toString();
  }
  if (!upstream) throw new Error('Google Drive media request returned no response.');
  if (upstream.status === 416) {
    const unsatisfied = /^bytes \*\/([0-9]+)$/.exec(upstream.headers.get('content-range') || '');
    try { await upstream.body?.cancel(); } catch {}
    if (unsatisfied) return { unsatisfiedTotal: Number(unsatisfied[1]) };
  }
  const range = parseContentRange(upstream.headers.get('content-range'));
  if (upstream.status !== 206 || !range || range.start !== start || range.end < start || range.end > end) {
    const status = upstream.status;
    const contentRange = upstream.headers.get('content-range') || 'none';
    try { await upstream.body?.cancel(); } catch {}
    throw new Error('Google Drive did not return the requested byte range (HTTP ' + status + ', Content-Range: ' + contentRange + ').');
  }
  const upstreamType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (streamBody) {
    if (!upstream.body) throw new Error('Google Drive returned an empty video stream');
    return { range, body: upstream.body, upstreamType };
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength !== range.end - range.start + 1) throw new Error('Google Drive returned an incomplete video range');
  return { range, bytes, upstreamType };
}

function cachedSourceProps(source, normalizedSourceVersion) {
  return {
    sourceUrl: source.url,
    sourceVersion: normalizedSourceVersion,
    sourceProvider: source.provider || '',
    sourceFileId: source.provider === 'google-drive-private' ? source.fileId : '',
    sourceAccountId: source.provider === 'google-drive-private' ? (source.accountId || 'primary') : ''
  };
}

function isValidCachedSource(sourceUrl, sourceProviderName, sourceFileId, sourceAccountId) {
  if (sourceProviderName === 'google-drive-private') {
    return isGoogleDriveFileId(sourceFileId) && sourceUrl === googleDriveMediaUrl(sourceFileId) && /^(primary|[0-9a-f-]{36})$/i.test(sourceAccountId || 'primary');
  }
  try {
    const parsed = new URL(sourceUrl);
    return parsed.protocol === 'https:' && allowedSourceHost(parsed.hostname);
  } catch { return false; }
}

async function fetchAndCacheVideoChunk(source, chunkStart, chunkSize = VIDEO_CHUNK_SIZE, env) {
  const requestedEnd = chunkStart + chunkSize - 1;
  const first = await fetchConfiguredVideoRange(source, chunkStart, requestedEnd, env, 0, true);
  if (first.unsatisfiedTotal !== undefined) return { unsatisfiedTotal: first.unsatisfiedTotal };
  const range = first.range;
  if (!range || range.start !== chunkStart || range.end < chunkStart || range.end > requestedEnd || !first.body) {
    try { await first.body?.cancel(); } catch {}
    throw new Error('Video source returned an invalid initial byte range');
  }

  const end = Math.min(requestedEnd, range.total - 1);
  const body = createRangeRelayStream({
    firstPart: first,
    end,
    total: range.total,
    fetchPart: (nextStart, nextEnd, signal) =>
      fetchConfiguredVideoRange(source, nextStart, nextEnd, env, 0, true, signal),
    maxRequests: 128
  });
  const contentType = first.upstreamType || 'application/octet-stream';
  const normalizedType = contentType.toLowerCase();
  const container = normalizedType.includes('webm') ? 'webm' :
    normalizedType.includes('matroska') ? 'mkv' :
    normalizedType.includes('ogg') ? 'ogg' :
    normalizedType.includes('mp4') ? 'mp4' : 'unknown';
  return { body, start: chunkStart, end, total: range.total, contentType, container };
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
    const sourceProviderName = props.sourceProvider || '';
    const sourceFileId = props.sourceFileId || '';
    const sourceAccountId = props.sourceAccountId || 'primary';
    const source = { url: sourceUrl, provider: sourceProviderName, fileId: sourceFileId, accountId: sourceAccountId };
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 7 ||
        typeof sourceUrl !== 'string' || sourceUrl.length > 2048) {
      return json({ error: 'Invalid internal video header parameters' }, 400);
    }
    try {
      if (!isValidCachedSource(sourceUrl, sourceProviderName, sourceFileId, sourceAccountId)) {
        return json({ error: 'Unsupported video source' }, 400);
      }
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(sourceUrl + '|' + sourceVersion));
      const expectedHash = hex(new Uint8Array(digest)).slice(0, 32);
      if (expectedHash !== sourceHash) return json({ error: 'Video header cache key did not match its source' }, 400);
      const probe = await fetchConfiguredVideoRange(source, 0, VIDEO_HEADER_PROBE_SIZE - 1, this.env, 20000);
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
    const sourceProviderName = props.sourceProvider || '';
    const sourceFileId = props.sourceFileId || '';
    const sourceAccountId = props.sourceAccountId || 'primary';
    const source = { url: sourceUrl, provider: sourceProviderName, fileId: sourceFileId, accountId: sourceAccountId };

    const alignedContinuationChunk = chunkSize === VIDEO_CHUNK_SIZE &&
      ((chunkStart >= VIDEO_STARTUP_CHUNK_SIZE &&
        (chunkStart - VIDEO_STARTUP_CHUNK_SIZE) % VIDEO_CHUNK_SIZE === 0) ||
       (chunkStart >= VIDEO_FRAGMENT_START_CHUNK_SIZE &&
        (chunkStart - VIDEO_FRAGMENT_START_CHUNK_SIZE) % VIDEO_CHUNK_SIZE === 0));
    const initialStartupChunk = chunkStart === 0 &&
      (chunkSize === VIDEO_STARTUP_CHUNK_SIZE || chunkSize === VIDEO_FRAGMENT_START_CHUNK_SIZE);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 7 ||
        !Number.isSafeInteger(chunkStart) || chunkStart < 0 ||
        !(alignedContinuationChunk || initialStartupChunk) ||
        typeof sourceUrl !== 'string' || sourceUrl.length > 2048) {
      return json({ error: 'Invalid internal video chunk parameters' }, 400);
    }

    try {
      if (!isValidCachedSource(sourceUrl, sourceProviderName, sourceFileId, sourceAccountId)) {
        return json({ error: 'Unsupported video source' }, 400);
      }
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(sourceUrl + '|' + sourceVersion));
      const expectedHash = hex(new Uint8Array(digest)).slice(0, 32);
      if (expectedHash !== sourceHash) return json({ error: 'Video cache key did not match its source' }, 400);

      const result = await fetchAndCacheVideoChunk(source, chunkStart, chunkSize, this.env);
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

      return new Response(result.body, {
        status: 200,
        headers: {
          'content-type': result.contentType,
          'content-length': String(result.end - result.start + 1),
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

async function fetchVideoRangeFromMirrors(sourceUrl, start, requestedEnd, timeoutOverride = 0, streamBody = false, externalSignal = null) {
  const details = archiveSourceParts(sourceUrl);
  const candidates = details ? await archiveCandidates(sourceUrl) : [{ url: sourceUrl, host: '', identifier: '' }];
  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const began = Date.now();
    try {
      const score = details && candidate.host ? archiveScore(details.identifier, candidate.host) : null;
      const timeoutSignal = AbortSignal.timeout(timeoutOverride || archiveTimeout(requestedEnd - start + 1, score));
      const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
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
      const upstreamType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (streamBody) {
        if (!upstream.body) throw new Error('Archive.org returned an empty video stream');
        let body = upstream.body;
        if (details && candidate.host) {
          const reader = upstream.body.getReader();
          let streamedBytes = 0;
          body = new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  const expectedBytes = range.end - range.start + 1;
                  if (streamedBytes !== expectedBytes) {
                    recordArchiveFailure(details.identifier, candidate.host);
                    controller.error(new Error('Archive.org mirror ended before its Content-Range was complete'));
                    return;
                  }
                  recordArchiveSuccess(details.identifier, candidate.host, streamedBytes, Date.now() - began);
                  controller.close();
                  return;
                }
                streamedBytes += value.byteLength;
                controller.enqueue(value);
              } catch (error) {
                if (!externalSignal?.aborted) recordArchiveFailure(details.identifier, candidate.host);
                controller.error(error);
              }
            },
            cancel(reason) {
              return reader.cancel(reason);
            }
          });
        }
        return { range, body, upstreamType };
      }
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      if (bytes.byteLength !== range.end - range.start + 1) throw new Error('Incomplete upstream byte range');
      if (details && candidate.host) recordArchiveSuccess(details.identifier, candidate.host, bytes.byteLength, Date.now() - began);
      return { range, bytes, upstreamType };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Video range request failed');
      if (details && candidate.host && !externalSignal?.aborted) recordArchiveFailure(details.identifier, candidate.host);
      if (i === candidates.length - 1) throw lastError;
      console.warn('Archive.org mirror failed; switching storage host:', candidate.host || 'archive.org router', lastError.message);
    }
  }
  throw lastError || new Error('No storage host returned the requested video range');
}

async function cachedVideoRange(req, env, ctx, source, movieId, optionIndex, rangeHeader, sourceVersion = '') {
  const parsed = parseByteRange(rangeHeader);
  if (!parsed || parsed.invalid) {
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */*', 'accept-ranges': 'bytes' } });
  }

  const baseSourceVersion = sourceVersion instanceof Date
    ? sourceVersion.toISOString()
    : String(sourceVersion || '');
  const normalizedSourceVersion = baseSourceVersion + '|' + String(source.modified_time || '') + '|' + String(source.account_id || 'primary');
  const sourceDigest = await crypto.subtle.digest('SHA-256', enc.encode(source.url + '|' + normalizedSourceVersion));
  const sourceHash = hex(new Uint8Array(sourceDigest)).slice(0, 32);

  // Header metadata is cached separately. The byte segment is relayed to the
  // player progressively, without waiting for the full cache chunk in memory.
  const header = await getVideoHeader(ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash);
  const fragmented = header.fragmented === true;
  const total = header.total;
  const container = header.container || 'unknown';
  const contentType = header.contentType || 'video/mp4';

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

  const requestedEnd = end;
  const responseWindow = getVideoRangeWindow({
    start,
    requestedEnd,
    total,
    fragmented,
    continuationChunkSize: VIDEO_CHUNK_SIZE,
    startupChunkSize: VIDEO_STARTUP_CHUNK_SIZE,
    fragmentStartupChunkSize: VIDEO_FRAGMENT_START_CHUNK_SIZE
  });
  end = responseWindow.end;

  const cacheAcquireStartedAt = Date.now();
  const firstChunk = await getVideoChunk(
    ctx, source, movieId, optionIndex, normalizedSourceVersion, sourceHash,
    responseWindow.chunkStart, videoChunkSizeAt(responseWindow.chunkStart, fragmented)
  );
  const cacheAcquireMs = Date.now() - cacheAcquireStartedAt;
  if (firstChunk.unsatisfiedTotal !== undefined) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': 'bytes */' + firstChunk.unsatisfiedTotal, 'accept-ranges': 'bytes' }
    });
  }
  if (firstChunk.total !== total || firstChunk.end < end || !firstChunk.body) {
    try { await firstChunk.body?.cancel(); } catch {}
    throw new Error('Video source size or cache segment changed during streaming');
  }

  const responseStart = start;
  const responseEnd = end;
  const contentLength = responseEnd - responseStart + 1;
  let skipRemaining = responseStart - firstChunk.start;
  let streamBody = firstChunk.body;
  let streamMode = firstChunk.cacheStatus === 'HIT' ? 'edge-cache' : 'progressive-cache-fill';
  let directSeek = false;
  let directSeekSetupMs = 0;

  // On a cold seek deep inside a cache chunk, warm the aligned shared object
  // in parallel while a second exact upstream Range starts at the desired byte.
  // This duplicates bytes only for cold deep seeks; subsequent viewers reuse cache.
  const directSeekCacheMiss = ['MISS', 'EXPIRED'].includes(firstChunk.cacheStatus);
  if (directSeekCacheMiss && skipRemaining > VIDEO_DIRECT_SEEK_THRESHOLD) {
    try {
      const directStartedAt = Date.now();
      const direct = await fetchConfiguredVideoRange(source, responseStart, responseEnd, env, 0, true, req.signal);
      directSeekSetupMs = Date.now() - directStartedAt;
      if (!direct.range || direct.range.start !== responseStart ||
          direct.range.total !== total || direct.range.end < responseStart ||
          direct.range.end > responseEnd || !direct.body) {
        try { await direct.body?.cancel(); } catch {}
        throw new Error('Direct seek source returned an invalid byte range');
      }
      streamBody = createRangeRelayStream({
        firstPart: direct,
        end: responseEnd,
        total,
        fetchPart: (nextStart, nextEnd, signal) =>
          fetchConfiguredVideoRange(source, nextStart, nextEnd, env, 0, true, signal),
        maxRequests: 128
      });
      try { await firstChunk.body.cancel(); } catch {}
      skipRemaining = 0;
      directSeek = true;
      streamMode = 'cold-seek-direct';
    } catch (error) {
      console.warn('Direct cold-seek stream failed; using the warming edge chunk:', error?.message || error);
    }
  }

  let responseRemaining = contentLength;
  const reader = streamBody.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (responseRemaining > 0) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Video upstream stream ended before the requested Range was complete');
          let from = 0;
          if (skipRemaining > 0) {
            const skip = Math.min(skipRemaining, value.byteLength);
            skipRemaining -= skip;
            from = skip;
          }
          if (from >= value.byteLength) continue;
          const length = Math.min(value.byteLength - from, responseRemaining);
          if (length < 1) continue;
          controller.enqueue(value.subarray(from, from + length));
          responseRemaining -= length;
          if (responseRemaining === 0) {
            reader.cancel().catch(() => {});
            controller.close();
          }
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    }
  });

  return new Response(body, {
    status: 206,
    headers: {
      'content-type': contentType,
      'x-moviwatch-container': container,
      'x-moviwatch-fragmented': String(fragmented),
      'x-moviwatch-stream-profile': fragmented ? 'single-file-fmp4' : 'range-stream',
      'x-moviwatch-stream-mode': streamMode,
      'cross-origin-resource-policy': 'same-origin',
      'content-length': String(contentLength),
      'content-range': 'bytes ' + responseStart + '-' + responseEnd + '/' + total,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store, max-age=0',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
      'surrogate-control': 'no-store',
      'vary': 'Range',
      'x-moviwatch-cache': firstChunk.cacheStatus,
      'x-moviwatch-seek-range-start': String(responseStart),
      'x-moviwatch-seek-range-end': String(responseEnd),
      'x-moviwatch-seek-requested-end': String(requestedEnd),
      'x-moviwatch-seek-range-truncated': String(responseEnd < requestedEnd),
      'x-moviwatch-seek-first-chunk-start': String(firstChunk.start),
      'x-moviwatch-seek-first-chunk-size': String(firstChunk.end - firstChunk.start + 1),
      'x-moviwatch-chunk-size': String(VIDEO_CHUNK_SIZE),
      'x-moviwatch-startup-chunk-size': String(videoChunkSizeAt(0, fragmented)),
      'x-moviwatch-header-cache': header.cacheStatus,
      'x-moviwatch-startup-prefetch-chunks': '0',
      'x-moviwatch-startup-prefetch-ms': '0',
      'x-moviwatch-cold-seek-direct': String(directSeek),
      'x-moviwatch-direct-seek-threshold': String(VIDEO_DIRECT_SEEK_THRESHOLD),
      'x-moviwatch-cache-acquire-ms': String(cacheAcquireMs),
      'x-moviwatch-direct-seek-setup-ms': String(directSeekSetupMs)
    }
  });
}

async function api(req, env, ctx) {
  if (new URL(req.url).pathname === '/api/google-drive/oauth/callback' && req.method === 'GET') {
    return await completeGoogleDriveOAuth(req, env);
  }
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'moviwatch' });

  // Each watch page establishes a short-lived, signed, HttpOnly session.
  // The credential is never exposed to JavaScript or placed in a media URL.
  if (path === '/api/playback/session' && method === 'POST') {
    sameOrigin(req, env);
    const body = await readBody(req);
    const movieId = typeof body.movieId === 'string' ? body.movieId : '';
    if (!/^[0-9a-f-]{36}$/i.test(movieId)) return json({ error: 'A valid movie ID is required.' }, 400);
    const token = await makePlaybackToken(env, movieId);
    return json({ ok: true, expiresIn: PLAYBACK_SESSION }, 200, {
      'set-cookie': playbackCookieName(movieId) + '=' + token + '; HttpOnly; Secure; SameSite=Strict; Path=/api/; Max-Age=' + PLAYBACK_SESSION
    });
  }

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

  const contentMatch = /^\/api\/content\/([0-9a-f-]{36})$/.exec(path);
  if (contentMatch && method === 'GET') {
    const contentId = contentMatch[1];
    const sql = sqlFor(env);
    try {
      // Public reads are read-only; series DDL belongs to authenticated Admin.
      const seriesRows = await sql`SELECT id,title,description,poster_url,category,created_at
        FROM public.series WHERE id=${contentId} AND is_published=TRUE LIMIT 1`;
      if (seriesRows[0]) {
        const seasons = await sql`SELECT season_number,
          jsonb_agg(jsonb_build_object('id',e.id,'episode_number',e.episode_number,'title',e.title,'description',e.description)
            ORDER BY e.episode_number) AS episodes
          FROM public.episodes e WHERE e.series_id=${contentId} AND e.is_published=TRUE
          GROUP BY season_number ORDER BY season_number`;
        return json({ content: { ...seriesRows[0], content_type: 'series', seasons } });
      }
    } catch (error) {
      console.error('Series detail unavailable; falling back to movie metadata:', error?.message || error);
    }
    const metadata = await movieById(ctx, env, contentId);
    const movie = metadata.movie;
    if (!movie) return json({ error: 'Content not found or not published.' }, 404);
    const content = { ...movie, video_sources: publicVideoSources(movie.video_sources) };
    if (movie.content_type === 'episode' && movie.series_id) {
      const siblings = await sql`SELECT id,title,season_number,episode_number FROM public.episodes
        WHERE series_id=${movie.series_id} AND is_published=TRUE
        ORDER BY season_number,episode_number`;
      const at = siblings.findIndex((item) => item.id === movie.id);
      content.previous_episode = at > 0 ? siblings[at - 1] : null;
      content.next_episode = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null;
    }
    return json({ content });
  }

  if (path === '/api/movies' && method === 'GET') {
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (category && !CATEGORIES.has(category)) return json({ error: 'Unknown category' }, 400);

    const catalogueUrl = new URL('https://moviwatch.internal/__public_catalogue__v3');
    if (category) catalogueUrl.searchParams.set('category', category);
    if (query) catalogueUrl.searchParams.set('q', query);
    const catalogueEntry = ctx.exports.PublicCatalogue({ props: { category, query } });
    let cachedCatalogue;
    try {
      cachedCatalogue = await catalogueEntry.fetch(new Request(catalogueUrl));
    } catch (error) {
      console.error('Public catalogue entrypoint threw:', error?.stack || error?.message || error);
      return json({ error: 'Could not load the public catalogue' }, 502);
    }
    if (!cachedCatalogue.ok) {
      const detail = await cachedCatalogue.clone().text().catch(() => '');
      console.error('Public catalogue entrypoint returned HTTP', cachedCatalogue.status, detail.slice(0, 800));
      return json({ error: 'Could not load the public catalogue' }, 502);
    }
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
  if (
    download.length === 5 &&
    download[1] === 'api' &&
    download[2] === 'download' &&
    (method === 'GET' || method === 'HEAD')
  ) {
    const movieId = download[3];
    if (!/^[0-9a-f-]{36}$/i.test(movieId)) {
      return json({ error: 'Invalid movie ID.' }, 400);
    }

    if (!await hasPlaybackAccess(req, env, download[3])) {
      return method === 'HEAD'
        ? new Response(null, {
            status: 403,
            headers: {
              'cache-control': 'no-store',
              'cross-origin-resource-policy': 'same-origin'
            }
          })
        : json({ error: 'Open this movie in Moviwatch before downloading.' }, 403);
    }

    const metadata = await movieById(ctx, env, movieId);
    const movie = metadata.movie;
    if (!movie) {
      return method === 'HEAD'
        ? new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
        : json({ error: 'Movie not found.' }, 404);
    }

    if (!/^(?:0|[1-7])$/.test(download[4])) {
      return method === 'HEAD'
        ? new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
        : json({ error: 'Invalid video source index.' }, 404);
    }

    const optionIndex = Number(download[4]);
    const source = storedVideoSource(movie, optionIndex);
    if (!source) {
      return method === 'HEAD'
        ? new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
        : json({ error: 'Google Drive or Archive.org video source not found.' }, 404);
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
      // HEAD uses the cached lightweight metadata probe. It does not download
      // a media chunk just to discover the file size.
      if (method === 'HEAD') {
        const baseSourceVersion = movie.updated_at instanceof Date
          ? movie.updated_at.toISOString()
          : String(movie.updated_at || '');
        const normalizedSourceVersion = baseSourceVersion + '|' +
          String(source.modified_time || '') + '|' +
          String(source.account_id || 'primary');
        const sourceDigest = await crypto.subtle.digest(
          'SHA-256',
          enc.encode(source.url + '|' + normalizedSourceVersion)
        );
        const sourceHash = hex(new Uint8Array(sourceDigest)).slice(0, 32);
        const header = await getVideoHeader(
          ctx,
          source,
          movieId,
          optionIndex,
          normalizedSourceVersion,
          sourceHash
        );

        const extension = ({
          mp4: 'mp4',
          webm: 'webm',
          mkv: 'mkv',
          avi: 'avi',
          flv: 'flv',
          ogg: 'ogg'
        })[header.container] || 'mp4';
        const filename = baseName + (optionName ? ' - ' + optionName : '') + '.' + extension;
        const fallback = filename.normalize('NFKD')
          .replace(/[^\x20-\x7E]/g, '')
          .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
          .replace(/[\r\n]/g, '')
          .trim() || 'Moviwatch-download.' + extension;
        const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
          (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());

        return new Response(null, {
          status: 200,
          headers: {
            'content-type': header.contentType || 'application/octet-stream',
            'content-length': String(header.total),
            'content-disposition': 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded,
            'accept-ranges': 'bytes',
            'x-moviwatch-file-size': String(header.total),
            'x-moviwatch-file-name': encoded,
            'cache-control': 'private, no-store, max-age=0',
            'cdn-cache-control': 'no-store',
            'vercel-cdn-cache-control': 'no-store',
            'surrogate-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin',
            'x-moviwatch-metadata-cache': metadata.cacheStatus
          }
        });
      }

      // Start with the exact requested range. cachedVideoRange() serves the
      // first aligned edge-cache segment; the relay below continues through
      // later cached segments until the requested file range is complete.
      const requestedRange = req.headers.get('Range');
      const hasRange = requestedRange !== null;
      const initialRangeHeader = hasRange ? requestedRange : 'bytes=0-';
      const firstResponse = await cachedVideoRange(
        req,
        env,
        ctx,
        source,
        movieId,
        optionIndex,
        initialRangeHeader,
        movie.updated_at
      );

      if (firstResponse.status === 416) return firstResponse;
      if (firstResponse.status !== 206 || !firstResponse.body) {
        try { await firstResponse.body?.cancel(); } catch {}
        throw new Error('Video source did not return a valid initial download range.');
      }

      const firstRange = parseContentRange(
        firstResponse.headers.get('content-range') || ''
      );
      if (!firstRange) {
        try { await firstResponse.body.cancel(); } catch {}
        throw new Error('Video source returned invalid initial Content-Range metadata.');
      }

      const total = firstRange.total;
      let start = firstRange.start;
      let end = total - 1;

      if (hasRange) {
        const parsed = parseByteRange(requestedRange);
        if (!parsed || parsed.invalid) {
          try { await firstResponse.body.cancel(); } catch {}
          return new Response(null, {
            status: 416,
            headers: {
              'content-range': 'bytes */' + total,
              'accept-ranges': 'bytes',
              'cache-control': 'no-store'
            }
          });
        }

        if (parsed.suffix) {
          start = Math.max(0, total - parsed.suffix);
        } else {
          start = parsed.start;
          end = parsed.end === null ? total - 1 : Math.min(parsed.end, total - 1);
        }
      }

      if (start >= total || end < start ||
          firstRange.start !== start || firstRange.end > end) {
        try { await firstResponse.body.cancel(); } catch {}
        return new Response(null, {
          status: 416,
          headers: {
            'content-range': 'bytes */' + total,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store'
          }
        });
      }

      const contentLength = end - start + 1;
      const container = firstResponse.headers.get('x-moviwatch-container') || 'unknown';
      const contentType = firstResponse.headers.get('content-type') || 'application/octet-stream';
      const extension = ({
        mp4: 'mp4',
        webm: 'webm',
        mkv: 'mkv',
        avi: 'avi',
        flv: 'flv',
        ogg: 'ogg'
      })[container] || 'mp4';
      const filename = baseName + (optionName ? ' - ' + optionName : '') + '.' + extension;
      const fallback = filename.normalize('NFKD')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
        .replace(/[\r\n]/g, '')
        .trim() || 'Moviwatch-download.' + extension;
      const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());

      const fullStream = createRangeRelayStream({
        firstPart: {
          range: firstRange,
          body: firstResponse.body
        },
        end,
        total,
        fetchPart: async (nextStart, nextEnd, signal) => {
          const continuationRequest = new Request(req, { signal });
          const partResponse = await cachedVideoRange(
            continuationRequest,
            env,
            ctx,
            source,
            movieId,
            optionIndex,
            'bytes=' + nextStart + '-' + nextEnd,
            movie.updated_at
          );

          if (partResponse.status !== 206 || !partResponse.body) {
            try { await partResponse.body?.cancel(); } catch {}
            throw new Error(
              'Video download continuation failed (HTTP ' + partResponse.status + ').'
            );
          }

          const range = parseContentRange(
            partResponse.headers.get('content-range') || ''
          );
          if (!range || range.start !== nextStart || range.end > nextEnd || range.total !== total) {
            try { await partResponse.body.cancel(); } catch {}
            throw new Error('Video download continuation returned an invalid byte range.');
          }

          return {
            range,
            body: partResponse.body
          };
        },
        // The source may split one requested window into several smaller
        // responses. Leave room for retries/short reads while keeping a hard cap.
        maxRequests: Math.max(
          128,
          Math.ceil(contentLength / VIDEO_CHUNK_SIZE) * 4 + 16
        )
      });

      // FixedLengthStream exposes a reliable Content-Length without buffering
      // the complete movie. A short/long upstream stream fails the response.
      const fixedLength = new FixedLengthStream(contentLength);
      const response = new Response(fullStream);
      const pump = response.body.pipeTo(fixedLength.writable).catch((streamError) => {
        console.error('Full-file download stream failed:', streamError?.message || streamError);
      });
      ctx.waitUntil(pump);

      const headers = new Headers({
        'content-type': contentType,
        'content-disposition': 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded,
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store, max-age=0',
        'cdn-cache-control': 'no-store',
        'vercel-cdn-cache-control': 'no-store',
        'surrogate-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'x-moviwatch-metadata-cache': metadata.cacheStatus,
        'x-moviwatch-cache': firstResponse.headers.get('x-moviwatch-cache') || 'UNKNOWN',
        'x-moviwatch-download-mode': 'progressive-edge-cache'
      });
      headers.set('content-length', String(contentLength));

      if (hasRange) {
        headers.set('content-range', 'bytes ' + start + '-' + end + '/' + total);
      }

      return new Response(fixedLength.readable, {
        status: hasRange ? 206 : 200,
        headers
      });
    } catch (error) {
      console.error('Video download failed:', error?.message || error);
      const detail = error instanceof Error ? error.message : 'Unknown download error';
      return method === 'HEAD'
        ? new Response(null, {
            status: 502,
            headers: {
              'cache-control': 'no-store',
              'x-moviwatch-error': detail.slice(0, 200)
            }
          })
        : json({ error: detail.slice(0, 300) }, 502);
    }
  }
  const watch = path.split('/');
  if (watch.length === 5 && watch[1] === 'api' && watch[2] === 'watch' && (method === 'GET' || method === 'HEAD')) {
    if (!await hasPlaybackAccess(req, env, watch[3])) {
      return method === 'HEAD'
        ? new Response(null, { status: 403, headers: { 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' } })
        : json({ error: 'Open this movie in Moviwatch to start playback.' }, 403);
    }
    const metadata = await movieById(ctx, env, watch[3]);
    const movie = metadata.movie;
    if (!movie) return json({ error: 'Movie not found' }, 404);
    const optionIndex = Number(watch[4]);
    const source = storedVideoSource(movie, optionIndex);
    if (!source) return json({ error: 'Google Drive or Archive.org video source not found' }, 404);

    // Serve HEAD and ordinary full-file GET through the same 4 MiB edge cache.
    // Only If-Range stays on the origin path because it depends on origin validators.
    if (req.headers.has('If-Range') && source.provider !== 'google-drive-private') {
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
        'cross-origin-resource-policy': 'same-origin',
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
          req, env, ctx, source, watch[3], optionIndex, 'bytes=0-0', movie.updated_at
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
          req, env, ctx, source, watch[3], optionIndex,
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

  if (path.startsWith('/api/admin/archive/')) {
    if (!await isAdmin(req, env)) return json({ error: 'Admin login required' }, 401);
    try {
      if (path === '/api/admin/archive/search' && method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        const year = url.searchParams.get('year') || '';
        const sort = url.searchParams.get('sort') || 'downloads desc';
        const query = url.searchParams.get('q') || '';
        const result = await searchArchiveItems({ query, year, page, sort, rows: 24 });
        return json(result, 200, { 'cache-control': 'private, max-age=30' });
      }
      const itemMatch = /^\/api\/admin\/archive\/items\/([A-Za-z0-9._-]{1,200})$/.exec(path);
      if (itemMatch && method === 'GET') {
        const item = await getArchiveItem(itemMatch[1]);
        return json({ item }, 200, { 'cache-control': 'private, max-age=60' });
      }
      const probeMatch = /^\/api\/admin\/archive\/items\/([A-Za-z0-9._-]{1,200})\/probe$/.exec(path);
      if (probeMatch && method === 'POST') {
        sameOrigin(req, env);
        const body = await readBody(req);
        const result = await probeArchiveFile(probeMatch[1], body.filename);
        return json({ probe: result }, 200, { 'cache-control': 'no-store' });
      }
      return json({ error: 'Archive.org admin endpoint not found.' }, 404);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const message = error instanceof Error ? error.message : 'Archive.org request failed.';
      console.error('Archive.org admin request failed:', message);
      return json({ error: message }, status);
    }
  }

  if (path.startsWith('/api/admin/')) {
    if (!await isAdmin(req, env)) return json({ error: 'Admin login required' }, 401);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) sameOrigin(req, env);
    if (path.startsWith('/api/admin/google-drive/')) {
      try { return await handleGoogleDriveAdmin(req, env, ctx, path, method); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Google Drive request failed.';
        console.error('Google Drive admin action failed:', message);
        const client = /required|invalid|permission|not found|expired|configured|upload|must |between |valid|already attached|folder|Drive file/i.test(message);
        return json({ error: client ? message : 'Google Drive request failed.' }, client ? 400 : 502);
      }
    }
    const sql = sqlFor(env);
    if (path === '/api/admin/catalogue-diagnostics' && method === 'GET') {
      const rows = await sql`SELECT current_database() AS database_name,
        current_schema() AS schema_name,
        (SELECT COUNT(*)::int FROM public.movies) AS movie_count,
        to_regclass('public.series')::text AS series_table,
        to_regclass('public.episodes')::text AS episodes_table,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public_objects`;
      let seriesCount = null, episodeCount = null, seriesReadError = null;
      if (rows[0]?.series_table && rows[0]?.episodes_table) {
        try {
          const counts = await sql`SELECT
            (SELECT COUNT(*)::int FROM public.series) AS series_count,
            (SELECT COUNT(*)::int FROM public.episodes) AS episode_count`;
          seriesCount = Number(counts[0]?.series_count || 0);
          episodeCount = Number(counts[0]?.episode_count || 0);
        } catch (error) {
          seriesReadError = (error instanceof Error ? error.message : 'Series tables could not be read').slice(0, 200);
        }
      }
      return json({
        database: rows[0]?.database_name || null,
        schema: rows[0]?.schema_name || null,
        movieCount: Number(rows[0]?.movie_count || 0),
        seriesTables: {
          seriesExists: Boolean(rows[0]?.series_table),
          episodesExists: Boolean(rows[0]?.episodes_table),
          canCreatePublicObjects: rows[0]?.can_create_public_objects === true,
          seriesCount,
          episodeCount,
          readError: seriesReadError
        }
      });
    }
    if (path === '/api/admin/series' || path.startsWith('/api/admin/series/') || path.startsWith('/api/admin/episodes/')) {
      await ensureSeriesSchema(sql);
      if (path === '/api/admin/series' && method === 'GET') {
        const rows = await sql`SELECT s.id,s.title,s.description,s.poster_url,s.category,s.is_published,s.created_at,s.updated_at,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',e.id,'series_id',e.series_id,'season_number',e.season_number,'episode_number',e.episode_number,
            'title',e.title,'description',e.description,'is_published',e.is_published,'created_at',e.created_at,
            'video_sources',COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'label',source.value->>'label','provider',source.value->>'provider','url',CASE WHEN source.value->>'provider'='google-drive-private' THEN 'drive-private://' || (source.value->>'file_id') ELSE source.value->>'url' END,
              'fileId',source.value->>'file_id','accountId',COALESCE(source.value->>'account_id','primary'),'driveId',source.value->>'drive_id','modifiedTime',source.value->>'modified_time'
            )) FROM jsonb_array_elements(e.videos) AS source(value)),'[]'::jsonb)
          ) ORDER BY e.season_number,e.episode_number)
          FROM public.episodes e WHERE e.series_id=s.id),'[]'::jsonb) AS episodes
          FROM public.series s ORDER BY s.updated_at DESC LIMIT 500`;
        return json({ series: rows });
      }
      if (path === '/api/admin/series' && method === 'POST') {
        const value = seriesInput(await readBody(req));
        const rows = await sql`INSERT INTO public.series(id,title,description,poster_url,category,is_published)
          VALUES(${crypto.randomUUID()},${value.title},${value.description},${value.poster},${value.category},${value.published})
          RETURNING id,title,description,poster_url,category,is_published,created_at,updated_at`;
        await invalidateContentCaches(ctx);
        return json({ series: rows[0] }, 201);
      }
      const seriesMatch = /^\/api\/admin\/series\/([0-9a-f-]{36})$/.exec(path);
      if (seriesMatch) {
        const seriesId = seriesMatch[1];
        if (method === 'PUT') {
          const value = seriesInput(await readBody(req));
          const rows = await sql`UPDATE public.series SET title=${value.title},description=${value.description},
            poster_url=${value.poster},category=${value.category},is_published=${value.published},updated_at=NOW()
            WHERE id=${seriesId} RETURNING id,title,description,poster_url,category,is_published,created_at,updated_at`;
          if (!rows[0]) return json({ error: 'Series not found.' }, 404);
          await invalidateContentCaches(ctx);
          return json({ series: rows[0] });
        }
        if (method === 'DELETE') {
          const rows = await sql`DELETE FROM public.series WHERE id=${seriesId} RETURNING id`;
          if (!rows[0]) return json({ error: 'Series not found.' }, 404);
          await invalidateContentCaches(ctx);
          return json({ ok: true });
        }
      }
      const episodeCreateMatch = /^\/api\/admin\/series\/([0-9a-f-]{36})\/episodes$/.exec(path);
      if (episodeCreateMatch && method === 'POST') {
        const seriesId = episodeCreateMatch[1];
        const value = episodeInput(await readBody(req));
        const seriesRows = await sql`SELECT id FROM public.series WHERE id=${seriesId} LIMIT 1`;
        if (!seriesRows[0]) return json({ error: 'Series not found.' }, 404);
        const rows = await sql`INSERT INTO public.episodes(id,series_id,season_number,episode_number,title,description,videos,is_published)
          VALUES(${crypto.randomUUID()},${seriesId},${value.season},${value.episode},${value.title},${value.description},${JSON.stringify(value.sources)}::jsonb,${value.published})
          RETURNING id,series_id,season_number,episode_number,title,description,is_published,created_at,updated_at`;
        await invalidateContentCaches(ctx);
        return json({ episode: rows[0] }, 201);
      }
      const episodeMatch = /^\/api\/admin\/episodes\/([0-9a-f-]{36})$/.exec(path);
      if (episodeMatch) {
        const episodeId = episodeMatch[1];
        if (method === 'PUT') {
          const value = episodeInput(await readBody(req));
          const rows = await sql`UPDATE public.episodes SET season_number=${value.season},episode_number=${value.episode},
            title=${value.title},description=${value.description},videos=${JSON.stringify(value.sources)}::jsonb,
            is_published=${value.published},updated_at=NOW() WHERE id=${episodeId}
            RETURNING id,series_id,season_number,episode_number,title,description,is_published,created_at,updated_at`;
          if (!rows[0]) return json({ error: 'Episode not found.' }, 404);
          await invalidateContentCaches(ctx, episodeId);
          return json({ episode: rows[0] });
        }
        if (method === 'DELETE') {
          const rows = await sql`DELETE FROM public.episodes WHERE id=${episodeId} RETURNING id`;
          if (!rows[0]) return json({ error: 'Episode not found.' }, 404);
          await invalidateContentCaches(ctx, episodeId);
          return json({ ok: true });
        }
      }
    }
    if (path === '/api/admin/movies' && method === 'GET') {
      const rows = await sql`SELECT id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at
        FROM movies ORDER BY updated_at DESC LIMIT 500`;
      const movies = rows.map((movie) => ({
        ...movie,
        video_sources: (Array.isArray(movie.video_sources) ? movie.video_sources : []).flatMap((source) => {
          if (source?.provider === 'google-drive-private' && isGoogleDriveFileId(source.file_id)) {
            return [{
              label: (source.label || 'Private Google Drive').slice(0, 60),
              url: 'drive-private://' + source.file_id,
              provider: 'google-drive-private',
              fileId: source.file_id,
              accountId: source.account_id || 'primary'
            }];
          }
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
      await ensureSeriesSchema(sql);
      const seriesRows = await sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_published)::int AS published FROM public.series`;
      return json({ stats: { ...rows[0], series: Number(seriesRows[0]?.total || 0), publishedSeries: Number(seriesRows[0]?.published || 0) } });
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
      const client = /required|invalid|cross-origin|must |between |only |unknown category|too large|HTTPS|Google Drive|Archive\.org|video link/i.test(message);
      return json({ error: client ? message : 'Internal server error' }, client ? 400 : 500);
    }
  }
};