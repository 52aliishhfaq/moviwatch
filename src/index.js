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
function sameOrigin(req) {
  const origin = req.headers.get('Origin');
  if (!origin || new URL(origin).origin !== new URL(req.url).origin) throw new Error('Cross-origin request blocked');
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
  const rows = await sql`SELECT id,title,poster_url,category,video_sources,created_at FROM movies
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
  const rows = await sqlFor(env)`SELECT id,video_sources FROM movies WHERE id=${id} AND is_published=TRUE LIMIT 1`;
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
async function api(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'moviwatch' });

  if (path === '/api/auth/login' && method === 'POST') {
    sameOrigin(req);
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
    sameOrigin(req);
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
    const source = movie.video_sources?.[Number(watch[4])];
    if (!source?.url || !Number.isInteger(Number(watch[4]))) return json({ error: 'Video option not found' }, 404);
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

  if (path.startsWith('/api/admin/')) {
    if (!await isAdmin(req, env)) return json({ error: 'Admin login required' }, 401);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) sameOrigin(req);
    const sql = sqlFor(env);
    if (path === '/api/admin/movies' && method === 'GET') {
      return json({ movies: await sql`SELECT id,title,poster_url,category,video_sources,is_published,created_at,updated_at FROM movies ORDER BY updated_at DESC LIMIT 500` });
    }
    if (path === '/api/admin/stats' && method === 'GET') {
      const rows = await sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_published)::int AS published,
        COUNT(*) FILTER (WHERE category='Action')::int AS action, COUNT(*) FILTER (WHERE category='Romantic')::int AS romantic FROM movies`;
      return json({ stats: rows[0] });
    }
    if (path === '/api/admin/movies' && method === 'POST') {
      const v = movieInput(await readBody(req));
      const rows = await sql`INSERT INTO movies(id,title,poster_url,category,video_sources,is_published)
        VALUES(${crypto.randomUUID()},${v.title},${v.poster},${v.category},${JSON.stringify(v.sources)}::jsonb,${v.published})
        RETURNING id,title,poster_url,category,video_sources,is_published,created_at,updated_at`;
      await invalidateCache(env);
      return json({ movie: rows[0] }, 201);
    }
    const id = path.split('/')[4];
    if (path.startsWith('/api/admin/movies/') && id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Invalid movie ID' }, 400);
      if (method === 'PUT') {
        const v = movieInput(await readBody(req));
        const rows = await sql`UPDATE movies SET title=${v.title},poster_url=${v.poster},category=${v.category},
          video_sources=${JSON.stringify(v.sources)}::jsonb,is_published=${v.published},updated_at=NOW()
          WHERE id=${id} RETURNING id,title,poster_url,category,video_sources,is_published,created_at,updated_at`;
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
