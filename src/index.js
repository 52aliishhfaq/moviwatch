import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';

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
function driveUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('A valid Google Drive video link is required');
  const value = input.trim();
  if (/^[\w-]{10,200}$/.test(value)) return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(value);
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid video URL'); }
  if (url.protocol !== 'https:') throw new Error('Video URL must use HTTPS');
  const host = url.hostname.toLowerCase();
  if (host !== 'drive.google.com' && host !== 'drive.usercontent.google.com' && !host.endsWith('.googleusercontent.com')) throw new Error('Only public Google Drive links are accepted');
  const id = url.pathname.split('/file/d/')[1]?.split('/')[0] || url.searchParams.get('id');
  if (id && (host === 'drive.google.com' || host === 'drive.usercontent.google.com')) return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id);
  return url.toString();
}
function movieInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Movie details are required');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) throw new Error('Movie name is required (max 200 characters)');
  if (!CATEGORIES.has(body.category)) throw new Error('Category must be Action or Romantic');
  let poster;
  try { poster = new URL(body.posterUrl); } catch { throw new Error('Poster must be an HTTPS URL'); }
  if (poster.protocol !== 'https:' || poster.href.length > 2048) throw new Error('Poster must be an HTTPS URL');
  if (!Array.isArray(body.videoSources) || body.videoSources.length < 1 || body.videoSources.length > 8) throw new Error('Add between 1 and 8 video options');
  return {
    title, poster: poster.href, category: body.category,
    sources: body.videoSources.map((v, i) => ({ label: (typeof v?.label === 'string' && v.label.trim() ? v.label.trim() : 'Option ' + (i + 1)).slice(0, 60), url: driveUrl(v?.url) })),
    published: body.isPublished !== false
  };
}
async function invalidateCache(env) {
  try {
    const r = redisFor(env);
    const keys = await r.keys('moviwatch:catalog:*');
    if (keys.length) await r.del(...keys);
  } catch (e) { console.warn('Redis cache invalidation failed:', e.message); }
}
async function publicMovies(env, category, query) {
  const key = 'moviwatch:catalog:' + (category || 'all') + ':' + encodeURIComponent(query).slice(0, 80);
  let r;
  try {
    r = redisFor(env);
    const cached = await r.get(key);
    if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;
  } catch (e) { console.warn('Redis cache read failed:', e.message); }
  const sql = sqlFor(env);
  const rows = await sql`SELECT id,title,poster_url,category,videos AS video_sources,created_at FROM movies
    WHERE is_published=TRUE
    AND (${category || null}::text IS NULL OR category=${category || null})
    AND (${query || null}::text IS NULL OR title ILIKE ${query ? '%' + query + '%' : null})
    ORDER BY created_at DESC LIMIT 100`;
  try {
    if (!r) r = redisFor(env);
    await r.set(key, JSON.stringify(rows), { ex: 60 });
  } catch (e) { console.warn('Redis cache write failed:', e.message); }
  return rows;
}
async function movieById(env, id) {
  const rows = await sqlFor(env)`SELECT id,videos AS video_sources FROM movies WHERE id=${id} AND is_published=TRUE LIMIT 1`;
  return rows[0] || null;
}
function allowedDriveHost(host) {
  host = host.toLowerCase();
  return host === 'drive.google.com' || host === 'drive.usercontent.google.com' || host.endsWith('.googleusercontent.com');
}
async function driveFetch(source, method, headers) {
  let url = new URL(source);
  let currentMethod = method;
  for (let hop = 0; hop <= 5; hop++) {
    if (url.protocol !== 'https:' || !allowedDriveHost(url.hostname)) throw new Error('Unsupported Google Drive redirect');
    const res = await fetch(url.toString(), { method: currentMethod, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('Location');
    if (!location || hop === 5) throw new Error('Drive redirect limit reached');
    url = new URL(location, url);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod !== 'HEAD')) currentMethod = 'GET';
  }
  throw new Error('Drive redirect limit reached');
}

// Video edge cache: store complete 4 MiB byte chunks as cacheable 200 responses.
// The public response is reconstructed as a standards-compliant 206 response.
const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024;
const VIDEO_CACHE_TTL = 6 * 60 * 60;

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

function parseContentRange(value) {
  const match = new RegExp('^bytes ([0-9]+)-([0-9]+)/([0-9]+)$').exec(value || '');
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || end < start || total <= end) return null;
  return { start, end, total };
}

function videoCacheKey(req, movieId, optionIndex, sourceHash, chunkStart) {
  const keyUrl = new URL('/__moviwatch_cache__/video/' +
    encodeURIComponent(movieId) + '/' + optionIndex + '/' + sourceHash + '/' + chunkStart, req.url);
  return new Request(keyUrl.toString(), { method: 'GET' });
}

async function getVideoChunk(req, source, movieId, optionIndex, sourceHash, chunkStart) {
  const cache = caches.default;
  const key = videoCacheKey(req, movieId, optionIndex, sourceHash, chunkStart);
  try {
    const cached = await cache.match(key);
    if (cached) {
      const start = Number(cached.headers.get('x-moviwatch-start'));
      const end = Number(cached.headers.get('x-moviwatch-end'));
      const total = Number(cached.headers.get('x-moviwatch-total'));
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
          Number.isSafeInteger(total) && start === chunkStart && end >= start && total > end) {
        return {
          bytes: new Uint8Array(await cached.arrayBuffer()),
          start, end, total,
          contentType: cached.headers.get('content-type') || 'video/mp4',
          cacheStatus: 'HIT'
        };
      }
    }
  } catch (error) {
    console.warn('Video cache read failed:', error?.message || error);
  }

  const requestedEnd = chunkStart + VIDEO_CHUNK_SIZE - 1;
  const upstream = await driveFetch(source.url, 'GET', new Headers({
    Range: 'bytes=' + chunkStart + '-' + requestedEnd,
    'Accept-Encoding': 'identity'
  }));
  if (upstream.status === 416) {
    const unsatisfied = new RegExp('^bytes [*]/([0-9]+)$').exec(upstream.headers.get('content-range') || '');
    if (unsatisfied) return { unsatisfiedTotal: Number(unsatisfied[1]), cacheStatus: 'MISS' };
  }
  const range = parseContentRange(upstream.headers.get('content-range'));
  if (upstream.status !== 206 || !range || range.start !== chunkStart ||
      range.end > requestedEnd || range.end !== Math.min(requestedEnd, range.total - 1)) {
    try { await upstream.body?.cancel(); } catch {}
    throw new Error('Google Drive did not honor the video byte range');
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength !== range.end - range.start + 1) {
    throw new Error('Google Drive returned an incomplete video chunk');
  }
  const contentType = upstream.headers.get('content-type') || 'video/mp4';
  try {
    const stored = new Response(bytes, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=' + VIDEO_CACHE_TTL,
        'x-moviwatch-start': String(range.start),
        'x-moviwatch-end': String(range.end),
        'x-moviwatch-total': String(range.total)
      }
    });
    await cache.put(key, stored);
  } catch (error) {
    console.warn('Video cache write failed:', error?.message || error);
  }
  return { bytes, ...range, contentType, cacheStatus: 'MISS' };
}

async function cachedVideoRange(req, source, movieId, optionIndex, rangeHeader) {
  const parsed = parseByteRange(rangeHeader);
  if (!parsed || parsed.invalid) {
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */*', 'accept-ranges': 'bytes' } });
  }
  const sourceDigest = await crypto.subtle.digest('SHA-256', enc.encode(source.url));
  const sourceHash = hex(new Uint8Array(sourceDigest)).slice(0, 32);
  // A suffix range needs the representation size, so prime/read chunk zero first.
  const firstStart = parsed.suffix ? 0 : Math.floor(parsed.start / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
  const firstChunk = await getVideoChunk(req, source, movieId, optionIndex, sourceHash, firstStart);
  if (firstChunk.unsatisfiedTotal !== undefined) {
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + firstChunk.unsatisfiedTotal, 'accept-ranges': 'bytes' } });
  }
  const total = firstChunk.total;
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

  const firstChunkStart = Math.floor(start / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
  let first = firstChunkStart === firstChunk.start ? firstChunk : await getVideoChunk(
    req, source, movieId, optionIndex, sourceHash, firstChunkStart
  );
  if (first.unsatisfiedTotal !== undefined || first.total !== total) throw new Error('Google Drive video size changed during streaming');
  const responseStart = start;
  const responseEnd = end;
  const contentLength = responseEnd - responseStart + 1;
  const cacheStates = [first.cacheStatus];

  const body = new ReadableStream({
    async start(controller) {
      try {
        let cursor = responseStart;
        let chunk = first;
        while (cursor <= responseEnd) {
          const expectedChunkStart = Math.floor(cursor / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
          if (chunk.start !== expectedChunkStart) {
            chunk = await getVideoChunk(req, source, movieId, optionIndex, sourceHash, expectedChunkStart);
            if (chunk.unsatisfiedTotal !== undefined || chunk.total !== total) throw new Error('Google Drive video size changed during streaming');
            cacheStates.push(chunk.cacheStatus);
          }
          const from = cursor - chunk.start;
          const through = Math.min(responseEnd, chunk.end) - chunk.start + 1;
          if (through <= from) throw new Error('Invalid cached video chunk boundary');
          controller.enqueue(chunk.bytes.subarray(from, through));
          cursor = chunk.start + through;
          chunk = null;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return new Response(body, {
    status: 206,
    headers: {
      'content-type': first.contentType,
      'content-length': String(contentLength),
      'content-range': 'bytes ' + responseStart + '-' + responseEnd + '/' + total,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600',
      'x-moviwatch-cache': cacheStates.every((state) => state === 'HIT') ? 'HIT' :
        cacheStates.every((state) => state === 'MISS') ? 'MISS' : 'PARTIAL',
      'x-moviwatch-chunk-size': String(VIDEO_CHUNK_SIZE)
    }
  });
}

async function api(req, env) {
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
    const rows = await publicMovies(env, category, query);
    return json({ movies: rows.map(({ video_sources, ...movie }) => ({ ...movie, video_sources: (video_sources || []).map((s) => ({ label: s.label || 'Play' })) })) }, 200,
      { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' });
  }

  const watch = path.split('/');
  if (watch.length === 5 && watch[1] === 'api' && watch[2] === 'watch' && (method === 'GET' || method === 'HEAD')) {
    const movie = await movieById(env, watch[3]);
    if (!movie) return json({ error: 'Movie not found' }, 404);
    const optionIndex = Number(watch[4]);
    const source = movie.video_sources?.[optionIndex];
    if (!source?.url || !Number.isInteger(optionIndex) || optionIndex < 0) return json({ error: 'Video option not found' }, 404);

    // HEAD and non-range GETs preserve normal HTTP semantics. Browsers' video
    // elements generally use Range GETs, which are served from the 4 MiB cache.
    if (method === 'HEAD' || !req.headers.get('Range') || req.headers.has('If-Range')) {
      const headers = new Headers();
      for (const name of ['Range', 'If-Range']) { const value = req.headers.get(name); if (value) headers.set(name, value); }
      let upstream;
      try { upstream = await driveFetch(source.url, method, headers); }
      catch { return json({ error: 'Google Drive could not be reached' }, 502); }
      if (![200, 206, 416].includes(upstream.status) || (upstream.headers.get('content-type') || '').toLowerCase().includes('text/html')) return json({ error: 'Drive did not return a playable video. Check public sharing and quota.' }, 502);
      const out = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' });
      for (const name of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) { const value = upstream.headers.get(name); if (value) out.set(name, value); }
      return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
    }

    try {
      const response = await cachedVideoRange(req, source, watch[3], optionIndex, req.headers.get('Range'));
      if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
        return json({ error: 'Drive returned an HTML page instead of video. Check public sharing and quota.' }, 502);
      }
      return response;
    } catch (error) {
      console.error('Video proxy failed:', error?.message || error);
      return json({ error: 'Google Drive could not provide a playable byte range. Check public sharing and quota.' }, 502);
    }
  }

  if (path.startsWith('/api/admin/')) {
    if (!await isAdmin(req, env)) return json({ error: 'Admin login required' }, 401);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) sameOrigin(req, env);
    const sql = sqlFor(env);
    if (path === '/api/admin/movies' && method === 'GET') {
      return json({ movies: await sql`SELECT id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at FROM movies ORDER BY updated_at DESC LIMIT 500` });
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
      await invalidateCache(env);
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
        await invalidateCache(env);
        return json({ movie: rows[0] });
      }
      if (method === 'DELETE') {
        const rows = await sql`DELETE FROM movies WHERE id=${id} RETURNING id`;
        if (!rows[0]) return json({ error: 'Movie not found' }, 404);
        await invalidateCache(env);
        return json({ ok: true });
      }
    }
    return json({ error: 'Admin endpoint not found' }, 404);
  }
  return json({ error: 'API route not found' }, 404);
}

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/')) return await api(req, env);
      if (url.pathname === '/admin.html') return Response.redirect(new URL('/admin', url), 302);
      if (url.pathname === '/admin') return env.ASSETS.fetch(new Request(new URL('/admin.html', url), req));
      return env.ASSETS.fetch(req);
    } catch (error) {
      console.error('Request failed:', error?.stack || error?.message || error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      const client = /required|invalid|must |between |only |unknown category|too large|HTTPS|Google Drive/i.test(message);
      return json({ error: client ? message : 'Internal server error' }, client ? 400 : 500);
    }
  }
};
