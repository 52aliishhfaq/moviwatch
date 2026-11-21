const enc = new TextEncoder();

const DRIVE_TOKEN_AAD = 'moviwatch-google-drive-refresh-token-v1';

export function googleDriveTokenAad(connectionId = 'primary') {
  if (typeof connectionId !== 'string' || !/^(primary|[0-9a-f-]{36})$/i.test(connectionId)) {
    throw new Error('Invalid Google Drive account ID.');
  }
  return connectionId === 'primary' ? DRIVE_TOKEN_AAD : DRIVE_TOKEN_AAD + ':' + connectionId.toLowerCase();
}

let schemaPromise = null;
let accessTokenCache = new Map();
let accessTokenRefresh = new Map();

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

async function aesKey(env, usages) {
  return crypto.subtle.importKey('raw', encryptionKeyBytes(env), { name: 'AES-GCM' }, false, usages);
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
  const key = await aesKey(env, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(value)
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

export async function decryptGoogleDriveSecret(env, ciphertext, iv, aad) {
  const key = await aesKey(env, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: enc.encode(aad) },
    key,
    fromBase64Url(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

export async function googleDriveConnection(sql, connectionId = 'primary') {
  if (typeof connectionId !== 'string' || !/^(primary|[0-9a-f-]{36})$/i.test(connectionId)) {
    throw new Error('Invalid Google Drive account ID.');
  }
  await ensureGoogleDriveSchema(sql);
  const rows = await sql`SELECT id, account_email, scopes, connected_at, updated_at
    FROM public.google_drive_connections WHERE id=${connectionId} LIMIT 1`;
  return rows[0] || null;
}

export async function googleDriveConnections(sql) {
  await ensureGoogleDriveSchema(sql);
  return await sql`SELECT id, account_email, scopes, connected_at, updated_at
    FROM public.google_drive_connections ORDER BY connected_at ASC, account_email ASC`;
}

function consumeRequestBudget(budget) {
  if (!budget) return;
  if (budget.used >= budget.limit) throw new Error('Video upstream request budget exhausted (' + budget.limit + ').');
  budget.used++;
}

export async function googleDriveAccessToken(sql, env, connectionId = 'primary', requestBudget = null) {
  if (typeof connectionId !== 'string' || !/^(primary|[0-9a-f-]{36})$/i.test(connectionId)) {
    throw new Error('Invalid Google Drive account ID.');
  }
  if (!isGoogleDriveConfigured(env)) {
    throw new Error('Google Drive is not configured yet. Add the Google OAuth and encryption secrets in Cloudflare.');
  }
  await ensureGoogleDriveSchema(sql);
  const rows = await sql`SELECT account_email, refresh_token_ciphertext, refresh_token_iv, scopes, updated_at
    FROM public.google_drive_connections WHERE id=${connectionId} LIMIT 1`;
  const connection = rows[0];
  if (!connection) throw new Error('Connect a Google Drive account from the Moviwatch Admin panel first.');

  const updatedAt = connection.updated_at instanceof Date
    ? connection.updated_at.getTime()
    : new Date(connection.updated_at).getTime();
  const cached = accessTokenCache.get(connectionId);
  if (cached && cached.updatedAt === updatedAt && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }
  if (accessTokenRefresh.has(connectionId)) return accessTokenRefresh.get(connectionId);

  const refreshPromise = (async () => {
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
    consumeRequestBudget(requestBudget);
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.access_token !== 'string') {
      if (payload.error === 'invalid_grant') {
        throw new Error('Google Drive authorization expired or was revoked. Reconnect the account in Admin.');
      }
      throw new Error('Google Drive could not refresh its access token. Reconnect the account and try again.');
    }

    let cacheUpdatedAt = updatedAt;
    if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 20) {
      const encrypted = await encryptGoogleDriveSecret(env, payload.refresh_token, googleDriveTokenAad(connectionId));
      await sql`UPDATE public.google_drive_connections
        SET refresh_token_ciphertext=${encrypted.ciphertext}, refresh_token_iv=${encrypted.iv}, updated_at=NOW()
        WHERE id=${connectionId}`;
      cacheUpdatedAt = Date.now();
    }

    accessTokenCache.set(connectionId, {
      token: payload.access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
      updatedAt: cacheUpdatedAt
    });
    return payload.access_token;
  })().finally(() => {
    accessTokenRefresh.delete(connectionId);
  });
  accessTokenRefresh.set(connectionId, refreshPromise);
  return refreshPromise;
}

export async function googleDriveApiRequest(sql, env, target, options = {}, connectionId = 'primary', requestBudget = null) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.origin !== 'https://www.googleapis.com' ||
      !(url.pathname.startsWith('/drive/v3/') || url.pathname.startsWith('/upload/drive/v3/'))) {
    throw new Error('Blocked an unexpected Google Drive API destination.');
  }
  const token = await googleDriveAccessToken(sql, env, connectionId, requestBudget);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', 'Bearer ' + token);
  consumeRequestBudget(requestBudget);
  return fetch(url, { ...options, headers, redirect: 'manual' });
}

export function clearGoogleDriveAccessTokenCache(connectionId = null) {
  if (connectionId) {
    accessTokenCache.delete(connectionId);
    accessTokenRefresh.delete(connectionId);
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
