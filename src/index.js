import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';
import { WorkerEntrypoint } from 'cloudflare:workers';

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
function videoSourceUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
    throw new Error('A valid VOE embed URL is required, for example https://voe.sx/e/VIDEO_CODE');
  }
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Invalid VOE URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'voe.sx' ||
      url.username || url.password || url.port) {
    throw new Error('Only official https://voe.sx embed links are supported');
  }
  const match = /^\/e\/([A-Za-z0-9_-]{3,100})\/?$/.exec(url.pathname);
  if (!match) throw new Error('Use a VOE embed link in the format https://voe.sx/e/VIDEO_CODE');
  return 'https://voe.sx/e/' + match[1];
}

function movieInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Movie details are required');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) throw new Error('Movie name is required (max 200 characters)');
  if (!CATEGORIES.has(body.category)) throw new Error('Category must be Action or Romantic');
  let poster;
  try { poster = new URL(body.posterUrl); } catch { throw new Error('Poster must be an HTTPS URL'); }
  if (poster.protocol !== 'https:' || poster.href.length > 2048) throw new Error('Poster must be an HTTPS URL');
  if (!Array.isArray(body.videoSources) || body.videoSources.length < 1 || body.videoSources.length > 8) {
    throw new Error('Add at least one VOE embed URL');
  }
  const sources = body.videoSources.map((item, index) => ({
    label: (typeof item?.label === 'string' && item.label.trim() ? item.label.trim() : 'VOE ' + (index + 1)).slice(0, 60),
    url: videoSourceUrl(item?.url),
    provider: 'voe.sx'
  }));
  return { title, poster: poster.href, category: body.category, sources, published: body.isPublished !== false };
}

const CATALOGUE_CACHE_TTL = 30;

async function publicMovies(env, category, query) {
  const sql = sqlFor(env);
  return await sql\`SELECT id,title,poster_url,category,created_at,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'label', COALESCE(NULLIF(item.value->>'label',''),'VOE'),
          'provider', 'voe.sx',
          'embed_url', item.value->>'url'
        )
        ORDER BY item.ordinality
      )
      FROM jsonb_array_elements(COALESCE(videos, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
      WHERE item.value->>'provider'='voe.sx'
    ), '[]'::jsonb) AS video_sources
    FROM movies
    WHERE is_published=TRUE
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(videos, '[]'::jsonb)) AS item(value)
        WHERE item.value->>'provider'='voe.sx'
      )
      AND (${category || null}::text IS NULL OR category=${category || null})
      AND (${query || null}::text IS NULL OR title ILIKE ${query ? '%' + query + '%' : null})
    ORDER BY created_at DESC LIMIT 100\`;
}

export class PublicCatalogue extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
    const { category = '', query = '' } = this.ctx.props || {};
    const rows = await publicMovies(this.env, category, query);
    const payload = {
      movies: rows.map(({ video_sources, ...movie }) => ({
        ...movie,
        video_sources: (video_sources || []).flatMap((source) => {
          try {
            const embedUrl = videoSourceUrl(source.embed_url);
            return [{
              label: source.label || 'VOE',
              provider: 'voe.sx',
              embed_url: embedUrl,
              download_url: embedUrl
            }];
          } catch {
            return [];
          }
        })
      }))
    };
    return json(payload, 200, {
      'cache-control': 'public, max-age=' + CATALOGUE_CACHE_TTL + ', stale-while-revalidate=120',
      'cache-tag': 'public-catalogue'
    });
  }

  async invalidate() {
    return this.ctx.cache.purge({ tags: ['public-catalogue'] });
  }
}

async function invalidateContentCaches(ctx) {
  try {
    await ctx.exports.PublicCatalogue().invalidate();
  } catch (error) {
    console.warn('Catalogue cache invalidation failed:', error?.message || error);
  }
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
  if (path === '/api/auth/me' && method === 'GET') {
    return await isAdmin(req, env) ? json({ authenticated: true }) : json({ authenticated: false }, 401);
  }

  if (path === '/api/movies' && method === 'GET') {
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (category && !CATEGORIES.has(category)) return json({ error: 'Unknown category' }, 400);
    const catalogueUrl = new URL('https://moviwatch.internal/__public_catalogue__');
    if (category) catalogueUrl.searchParams.set('category', category);
    if (query) catalogueUrl.searchParams.set('q', query);
    const catalogueEntry = ctx.exports.PublicCatalogue({ props: { category, query } });
    const cachedCatalogue = await catalogueEntry.fetch(new Request(catalogueUrl));
    if (!cachedCatalogue.ok) return json({ error: 'Could not load the public catalogue' }, 502);
    const payload = await cachedCatalogue.json();
    return json(payload, 200, {
      'cache-control': 'private, no-store, max-age=0',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
      'surrogate-control': 'no-store',
      'x-moviwatch-catalog-cache': cachedCatalogue.headers.get('cf-cache-status') || 'UNKNOWN'
    });
  }

  // Media delivery now stays with the VOE-hosted player. Legacy app-level
  // proxy routes are deliberately retired.
  if ((path.startsWith('/api/watch/') || path.startsWith('/api/download/')) &&
      (method === 'GET' || method === 'HEAD')) {
    return json({ error: 'Video playback and any available download are provided on the official VOE page.' }, 410);
  }

  if (path.startsWith('/api/admin/')) {
    if (!await isAdmin(req, env)) return json({ error: 'Admin login required' }, 401);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) sameOrigin(req, env);
    const sql = sqlFor(env);

    if (path === '/api/admin/movies' && method === 'GET') {
      const rows = await sql\`SELECT id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at
        FROM movies ORDER BY updated_at DESC LIMIT 500\`;
      const movies = rows.map((movie) => ({
        ...movie,
        video_sources: (Array.isArray(movie.video_sources) ? movie.video_sources : []).flatMap((source) => {
          if (source?.provider !== 'voe.sx') return [];
          try {
            return [{
              label: (typeof source.label === 'string' && source.label.trim() ? source.label.trim() : 'VOE').slice(0, 60),
              url: videoSourceUrl(source.url),
              provider: 'voe.sx'
            }];
          } catch {
            return [];
          }
        })
      }));
      return json({ movies });
    }

    if (path === '/api/admin/stats' && method === 'GET') {
      const rows = await sql\`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_published)::int AS published,
        COUNT(*) FILTER (WHERE category='Action')::int AS action, COUNT(*) FILTER (WHERE category='Romantic')::int AS romantic
        FROM movies\`;
      return json({ stats: rows[0] });
    }

    if (path === '/api/admin/movies' && method === 'POST') {
      const movie = movieInput(await readBody(req));
      const rows = await sql\`INSERT INTO movies(id,title,poster_url,category,videos,is_published)
        VALUES(${crypto.randomUUID()},${movie.title},${movie.poster},${movie.category},${JSON.stringify(movie.sources)}::jsonb,${movie.published})
        RETURNING id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at\`;
      await invalidateContentCaches(ctx);
      return json({ movie: rows[0] }, 201);
    }

    const id = path.split('/')[4];
    if (path.startsWith('/api/admin/movies/') && id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Invalid movie ID' }, 400);
      if (method === 'PUT') {
        const movie = movieInput(await readBody(req));
        const rows = await sql\`UPDATE movies SET title=${movie.title},poster_url=${movie.poster},category=${movie.category},
          videos=${JSON.stringify(movie.sources)}::jsonb,is_published=${movie.published},updated_at=NOW()
          WHERE id=${id} RETURNING id,title,poster_url,category,videos AS video_sources,is_published,created_at,updated_at\`;
        if (!rows[0]) return json({ error: 'Movie not found' }, 404);
        await invalidateContentCaches(ctx);
        return json({ movie: rows[0] });
      }
      if (method === 'DELETE') {
        const rows = await sql\`DELETE FROM movies WHERE id=${id} RETURNING id\`;
        if (!rows[0]) return json({ error: 'Movie not found' }, 404);
        await invalidateContentCaches(ctx);
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
      const client = /required|invalid|must |unknown category|too large|HTTPS|VOE|video link/i.test(message);
      return json({ error: client ? message : 'Internal server error' }, client ? 400 : 500);
    }
  }
};
