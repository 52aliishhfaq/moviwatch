const enc = new TextEncoder();

const DRIVE_TOKEN_AAD = 'moviwatch-google-drive-refresh-token-v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKEN_TIMEOUT_MS = 10000;

let schemaPromise = null;
let accessTokenCache = new Map();   // connectionId -> { token, expiresAt }
let accessTokenRefresh = new Map(); // connectionId -> Promise<string>
let aesKeyCache = { secret: null, keys: new Map() };


function normalizeConnectionId(connectionId = 'primary') {
  if (typeof connectionId !== 'string' || !/^(primary|[0-9a-f-]{36})$/i.test(connectionId)) {
    throw new Error('Invalid Google Drive account ID.');
  }
  return connectionId.toLowerCase();
}


export function googleDriveTokenAad(connectionId = 'primary') {
  const id = normalizeConnectionId(connectionId);
  return id === 'primary' ? DRIVE_TOKEN_AAD : DRIVE_TOKEN_AAD + ':' + id;
}


function base64Url(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}


function fromBase64Url(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}


function encryptionKeyBytes(env) {
  const value = env.GOOGLE_DRIVE_ENCRYPTION_KEY;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('Google Drive encryption secret is not configured. Set GOOGLE_DRIVE_ENCRYPTION_KEY to 64 hexadecimal characters.');
  }
  return Uint8Array.from(value.match(/.{2}/g), (part) => parseInt(part, 16));
}


// CryptoKey ek baar import hoti hai aur secret badalne par hi dobara banti hai
async function aesKey(env, usage) {
  const secret = env.GOOGLE_DRIVE_ENCRYPTION_KEY;
  if (aesKeyCache.secret !== secret) aesKeyCache = { secret, keys: new Map() };
  let key = aesKeyCache.keys.get(usage);
  if (!key) {
    key = await crypto.subtle.importKey('raw', encryptionKeyBytes(env), { name: 'AES-GCM' }, false, [usage]);
    aesKeyCache.keys.set(usage, key);
  }
  return key;
}


export function googleDriveConfigurationIssues(env) {
  const issues = [];
  if (typeof env.GOOGLE_CLIENT_ID !== 'string' || env.GOOGLE_CLIENT_ID.length <= 10) {
    issues.push('GOOGLE_CLIENT_ID');
  }
  if (typeof env.GOOGLE_CLIENT_SECRET !== 'string' || env.GOOGLE_CLIENT_SECRET.length <= 10) {
    issues.push('GOOGLE_CLIENT_SECRET');
  }
  let redirectValid = false;
  try {
    const redirect = new URL(env.GOOGLE_REDIRECT_URI);
    const localHttp = redirect.protocol === 'http:' &&
      (redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1');
    redirectValid = (redirect.protocol === 'https:' || localHttp) &&
      redirect.pathname === '/api/google-drive/oauth/callback' &&
      !redirect.username && !redirect.password && !redirect.hash;
  } catch {}
  if (!redirectValid) issues.push('GOOGLE_REDIRECT_URI');
  if (typeof env.GOOGLE_DRIVE_ENCRYPTION_KEY !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(env.GOOGLE_DRIVE_ENCRYPTION_KEY)) {
    issues.push('GOOGLE_DRIVE_ENCRYPTION_KEY');
  }
  return issues;
}


export function isGoogleDriveConfigured(env) {
  return googleDriveConfigurationIssues(env).length === 0;
}


export async function ensureGoogleDriveSchema(sql) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS public.google_drive_connections (
        id TEXT PRIMARY KEY,
        account_email TEXT NOT NULL,
        refresh_token_ciphertext TEXT NOT NULL,
        refresh_token_iv TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS public.google_drive_uploads (
        id UUID PRIMARY KEY,
        file_name TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        drive_id TEXT,
        mime_type TEXT NOT NULL,
        total_bytes BIGINT NOT NULL,
        next_byte BIGINT NOT NULL DEFAULT 0,
        session_ciphertext TEXT NOT NULL,
        session_iv TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'primary',
        state TEXT NOT NULL DEFAULT 'active',
        file_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`ALTER TABLE public.google_drive_uploads
        ADD COLUMN IF NOT EXISTS connection_id TEXT NOT NULL DEFAULT 'primary'`;
      await sql`CREATE INDEX IF NOT EXISTS idx_google_drive_uploads_active
        ON public.google_drive_uploads (state, expires_at)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_google_drive_uploads_connection
        ON public.google_drive_uploads (connection_id, state, expires_at)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}


export async function encryptGoogleDriveSecret(env, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(env, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(value)
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}


export async function decryptGoogleDriveSecret(env, ciphertext, iv, aad) {
  const key = await aesKey(env, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: enc.encode(aad) },
    key,
    fromBase64Url(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}


export async function googleDriveConnection(sql, connectionId = 'primary') {
  const id = normalizeConnectionId(connectionId);
  await ensureGoogleDriveSchema(sql);
  const rows = await sql`SELECT id, account_email, scopes, connected_at, updated_at
    FROM public.google_drive_connections WHERE id=${id} LIMIT 1`;
  return rows[0] || null;
}


export async function googleDriveConnections(sql) {
  await ensureGoogleDriveSchema(sql);
  return await sql`SELECT id, account_email, scopes, connected_at, updated_at
    FROM public.google_drive_connections ORDER BY connected_at ASC, account_email ASC`;
}


// Refresh token se naya access token banata hai. Sirf cache miss par call hota hai.
async function refreshGoogleDriveAccessToken(sql, env, connectionId, redis = null) {
  const id = normalizeConnectionId(connectionId);
  await ensureGoogleDriveSchema(sql);
  const rows = await sql`SELECT refresh_token_ciphertext, refresh_token_iv
    FROM public.google_drive_connections WHERE id=${id} LIMIT 1`;
  const connection = rows[0];
  if (!connection) throw new Error('Connect a Google Drive account from the Moviwatch Admin panel first.');

  let refreshToken;
  try {
    refreshToken = await decryptGoogleDriveSecret(
      env,
      connection.refresh_token_ciphertext,
      connection.refresh_token_iv,
      googleDriveTokenAad(connectionId)
    );
  } catch {
    throw new Error('Stored Google Drive refresh token cannot be decrypted with the current GOOGLE_DRIVE_ENCRYPTION_KEY. Reset the old Drive connection and reconnect after confirming the key.');
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== 'string') {
    if (payload.error === 'invalid_grant') {
      throw new Error('Google Drive authorization expired or was revoked. Reconnect the account in Admin.');
    }
    throw new Error('Google Drive could not refresh its access token. Reconnect the account and try again.');
  }

  // Google kabhi refresh token rotate karta hai; tab naya token encrypt karke save karein
  if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 20) {
    const encrypted = await encryptGoogleDriveSecret(env, payload.refresh_token, googleDriveTokenAad(connectionId));
    await sql`UPDATE public.google_drive_connections
      SET refresh_token_ciphertext=${encrypted.ciphertext}, refresh_token_iv=${encrypted.iv}, updated_at=NOW()
      WHERE id=${id}`;
  }

  const lifetimeSec = Math.max(120, Number(payload.expires_in) || 3600);
  const expiresAt = Date.now() + lifetimeSec * 1000;
  accessTokenCache.set(id, { token: payload.access_token, expiresAt });

  if (redis) {
    try {
      const ttl = Math.max(60, lifetimeSec - 300);
      await redis.set('moviwatch:gdrive:token:' + id, JSON.stringify({ token: payload.access_token, expiresAt }), { ex: ttl });
    } catch {}
  }

  return payload.access_token;
}


// Fast path: 1) Isolate Memory -> 2) Upstash Redis (<5ms) -> 3) Neon DB + OAuth
export async function googleDriveAccessToken(sql, env, connectionId = 'primary', redis = null) {
  connectionId = normalizeConnectionId(connectionId);
  const id = connectionId;
  if (!isGoogleDriveConfigured(env)) {
    throw new Error('Google Drive is not configured yet. Add the Google OAuth and encryption secrets in Cloudflare.');
  }

  const cached = accessTokenCache.get(connectionId);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  if (redis) {
    try {
      const shared = await redis.get('moviwatch:gdrive:token:' + id);
      const parsed = typeof shared === 'string' ? JSON.parse(shared) : shared;
      if (parsed?.token && parsed.expiresAt > Date.now() + 60000) {
        accessTokenCache.set(id, { token: parsed.token, expiresAt: parsed.expiresAt });
        return parsed.token;
      }
    } catch {}
  }

  if (accessTokenRefresh.has(id)) return accessTokenRefresh.get(id);

  const refreshPromise = refreshGoogleDriveAccessToken(sql, env, id, redis)
    .finally(() => accessTokenRefresh.delete(id));
  accessTokenRefresh.set(id, refreshPromise);
  return refreshPromise;
}


export async function googleDriveApiRequest(sql, env, target, options = {}, connectionId = 'primary', redis = null) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.origin !== 'https://www.googleapis.com' ||
      !(url.pathname.startsWith('/drive/v3/') || url.pathname.startsWith('/upload/drive/v3/'))) {
    throw new Error('Blocked an unexpected Google Drive API destination.');
  }
  const token = await googleDriveAccessToken(sql, env, connectionId, redis);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', 'Bearer ' + token);
  return fetch(url, { ...options, headers, redirect: 'manual' });
}


// Streaming ke liye: token ek baar lein, phir har window par ye function use karein.
// Relay ko { range, body } chahiye, isliye 206 aur Content-Range yahin validate hota hai.
export async function googleDriveRangePart(accessToken, fileId, start, end, signal) {
  if (typeof accessToken !== 'string' || accessToken.length < 10) {
    throw new Error('Missing Google Drive access token.');
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError('Invalid byte range.');
  }

  const response = await fetch(googleDriveMediaUrl(fileId), {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Range: `bytes=${start}-${end}`,
      'Accept-Encoding': 'identity'
    },
    redirect: 'manual',
    signal
  });

  if (response.status !== 206) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`Google Drive returned HTTP ${response.status} for a range request.`);
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((response.headers.get('Content-Range') || '').trim());
  if (!match) {
    try { await response.body?.cancel(); } catch {}
    throw new Error('Google Drive response is missing a valid Content-Range header.');
  }

  return {
    range: { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) },
    body: response.body
  };
}


export async function clearGoogleDriveAccessTokenCache(connectionId = null, redis = null) {
  if (connectionId) {
    const id = normalizeConnectionId(connectionId);
    accessTokenCache.delete(id);
    accessTokenRefresh.delete(id);
    if (redis) {
      try { await redis.del('moviwatch:gdrive:token:' + id); } catch {}
    }
    return;
  }
  accessTokenCache.clear();
  accessTokenRefresh.clear();
}


export function isGoogleDriveFileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}


export function googleDriveMediaUrl(fileId) {
  if (!isGoogleDriveFileId(fileId)) throw new Error('Invalid Google Drive file ID.');
  return 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true';
}


export function googleDriveFileIdFromMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== 'https://www.googleapis.com' ||
        url.searchParams.get('alt') !== 'media' ||
        !/^\/drive\/v3\/files\/[A-Za-z0-9_-]{10,200}$/.test(url.pathname)) return null;
    for (const key of url.searchParams.keys()) {
      if (!['alt', 'supportsAllDrives'].includes(key)) return null;
    }
    return url.pathname.split('/').pop();
  } catch {
    return null;
  }
}


export function googleDrivePublicFileSummary(file) {
  if (!file || typeof file.id !== 'string' || !isGoogleDriveFileId(file.id)) return null;
  return {
    id: file.id,
    name: typeof file.name === 'string' ? file.name : 'Untitled',
    mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
    size: /^\d+$/.test(String(file.size || '')) ? String(file.size) : null,
    modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
    driveId: typeof file.driveId === 'string' ? file.driveId : null,
    parents: Array.isArray(file.parents) ? file.parents.filter((id) => isGoogleDriveFileId(id)) : [],
    capabilities: {
      canEdit: file.capabilities?.canEdit === true,
      canDelete: file.capabilities?.canDelete === true,
      canDownload: file.capabilities?.canDownload !== false,
      canRename: file.capabilities?.canRename === true
    }
  };
}
