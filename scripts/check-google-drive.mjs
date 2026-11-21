import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const drive = await import('../src/google-drive.js');
const env = {
  GOOGLE_CLIENT_ID: 'moviwatch-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'https://moviwatch.vercel.app/api/google-drive/oauth/callback',
  GOOGLE_DRIVE_ENCRYPTION_KEY: 'a7'.repeat(32)
};

assert.equal(drive.isGoogleDriveConfigured(env), true);
assert.equal(drive.isGoogleDriveConfigured({}), false);
assert.equal(drive.isGoogleDriveFileId('1AbCdEfGhIjKlMnOpQrStUvWxYz'), true);
assert.equal(drive.isGoogleDriveFileId('not a file id'), false);
assert.equal(
  drive.googleDriveMediaUrl('1AbCdEfGhIjKlMnOpQrStUvWxYz'),
  'https://www.googleapis.com/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz?alt=media&supportsAllDrives=true'
);
assert.equal(
  drive.googleDriveFileIdFromMediaUrl('https://www.googleapis.com/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz?alt=media&supportsAllDrives=true'),
  '1AbCdEfGhIjKlMnOpQrStUvWxYz'
);
assert.equal(
  drive.googleDriveFileIdFromMediaUrl('https://attacker.invalid/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz?alt=media'),
  null
);
assert.equal(
  drive.googleDriveFileIdFromMediaUrl('https://www.googleapis.com/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz?alt=media&access_token=leak'),
  null
);

const secret = 'refresh-token-do-not-log-or-return';
const encrypted = await drive.encryptGoogleDriveSecret(env, secret, 'test-aad');
assert.notEqual(encrypted.ciphertext, secret);
assert.notEqual(encrypted.iv, '');
assert.equal(await drive.decryptGoogleDriveSecret(env, encrypted.ciphertext, encrypted.iv, 'test-aad'), secret);
await assert.rejects(
  drive.decryptGoogleDriveSecret(env, encrypted.ciphertext, encrypted.iv, 'different-aad')
);
await assert.rejects(
  drive.decryptGoogleDriveSecret({ ...env, GOOGLE_DRIVE_ENCRYPTION_KEY: '00'.repeat(32) }, encrypted.ciphertext, encrypted.iv, 'test-aad')
);

const summary = drive.googleDrivePublicFileSummary({
  id: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  name: 'Movie.mp4',
  mimeType: 'video/mp4',
  size: '123456',
  modifiedTime: '2026-11-21T00:00:00.000Z',
  driveId: '0AAbCdEfGhIjKlMnOpQrStUvW',
  capabilities: { canEdit: true, canDelete: true, canDownload: true, canRename: true }
});
assert.equal(summary.name, 'Movie.mp4');
assert.equal(summary.size, '123456');
assert.equal(summary.capabilities.canEdit, true);
assert.equal(drive.googleDrivePublicFileSummary({ id: 'bad' }), null);

const worker = readFileSync('src/index.js', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
assert.ok(worker.includes("scope: 'openid email https://www.googleapis.com/auth/drive'"));
assert.ok(worker.includes("code_challenge_method: 'S256'"));
assert.ok(worker.includes('encryptGoogleDriveSecret(env, refreshToken'));
assert.ok(worker.includes('session_ciphertext'));
assert.ok(worker.includes('async function googleDriveUploadStatus'));
assert.ok(worker.includes("'content-range': 'bytes */' + total"));
assert.ok(worker.includes("path === '/api/admin/google-drive/oauth/start'"));
assert.ok(worker.includes("path === '/api/admin/google-drive/files'"));
assert.ok(worker.includes("path === '/api/admin/google-drive/uploads'"));
assert.ok(worker.includes("path === '/api/admin/google-drive/attach'"));
assert.ok(worker.includes("provider:'google-drive-private'"));
assert.ok(worker.includes('fetchConfiguredVideoRange(source, cursor, requestedEnd, env)'));
assert.ok(admin.includes('id="googleDrivePanel"'));
assert.ok(admin.includes("source.provider==='google-drive-private'") || admin.includes("'google-drive-private'"));
assert.ok(admin.includes('DRIVE_CHUNK_BYTES=8*1024*1024'));
assert.ok(!/GOOGLE_CLIENT_SECRET|GOOGLE_DRIVE_ENCRYPTION_KEY|refresh_token=/.test(admin));
assert.ok(packageJson.scripts.check.includes('scripts/check-google-drive.mjs'));

console.log('Google Drive OAuth encryption, private source validation, upload reconciliation, admin controls and secret isolation checks passed.');
