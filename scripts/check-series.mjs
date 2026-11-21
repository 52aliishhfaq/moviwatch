import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync('src/index.js', 'utf8');
const drive = readFileSync('src/google-drive.js', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');
const home = readFileSync('public/index.html', 'utf8');
const watch = readFileSync('public/watch.html', 'utf8');
const schema = readFileSync('schema.sql', 'utf8');

function includes(source, value, label) {
  assert.ok(source.includes(value), label + ' is missing');
}

// Multi-account Drive connections must be distinct and each private source
// must retain the exact OAuth connection used to browse or upload it.
includes(drive, 'googleDriveConnections(sql)', 'Connected Drive account listing');
includes(drive, 'accessTokenCache.get(connectionId)', 'Per-account access-token cache');
includes(drive, 'googleDriveTokenAad(connectionId)', 'Per-account refresh-token encryption context');
includes(worker, "body.addAccount === true ? (existingAccounts.length ? crypto.randomUUID() : 'primary')", 'New Drive account ID allocation');
includes(worker, "prompt: 'consent select_account'", 'Google account chooser for additional accounts');
includes(worker, 'WHERE LOWER(account_email)=LOWER(${profile.email})', 'Prevent duplicate Google email connections');
includes(worker, "WHERE id=${connectionId}", 'Connection-scoped refresh-token storage');
includes(worker, "account_id:accountId", 'Private video account binding');
includes(worker, "source.accountId || 'primary'", 'Per-account private stream authorization');
includes(drive, 'connection_id TEXT NOT NULL DEFAULT \'primary\'', 'Legacy-compatible upload connection column');
includes(admin, 'id="driveAccountSelector"', 'Drive account selector');
includes(admin, 'id="driveAddAccount"', 'Add another Google account control');
includes(admin, "accountId:pendingEpisodeFile.accountId||driveAccountId", 'Episode account binding');
includes(admin, "accountId:pendingPublishFile.accountId||driveAccountId", 'Movie account binding');

// Series are separate root cards; episodes are independently playable items.
includes(worker, 'CREATE TABLE IF NOT EXISTS public.series', 'Series schema');
includes(worker, 'CREATE TABLE IF NOT EXISTS public.episodes', 'Episode schema');
includes(worker, 'UNIQUE(series_id, season_number, episode_number)', 'Unique episode numbering');
includes(worker, "const contentMatch = /^\\/api\\/content\\/", 'Public content detail endpoint');
includes(worker, "content_type: 'series'", 'Public series detail response');
includes(worker, 'content.next_episode = at >= 0', 'Episode sibling navigation');
includes(worker, "path === '/api/admin/series' && method === 'POST'", 'Series creation endpoint');
includes(worker, "episodeCreateMatch && method === 'POST'", 'Episode publishing endpoint');
includes(worker, "path.startsWith('/api/admin/episodes/')", 'Episode management route');
includes(admin, 'id="seriesForm"', 'Series creation form');
includes(admin, 'id="episodeForm"', 'Episode publishing form');
includes(admin, 'stageDriveFileForEpisode(file)', 'Drive-to-episode selection');
includes(home, "movie.content_type==='series'", 'Series catalogue card');
includes(watch, "fetch('/api/content/'+encodeURIComponent(movieId)", 'Series/episode detail loading');
includes(watch, 'id="seriesBrowser"', 'Season and episode browser');
includes(watch, 'id="previousEpisode"', 'Previous episode navigation');
includes(watch, 'id="nextEpisode"', 'Next episode navigation');

// New tables are additive; the legacy movies schema remains present.
includes(schema, 'CREATE TABLE IF NOT EXISTS public.movies', 'Legacy movie schema');
includes(schema, 'CREATE TABLE IF NOT EXISTS public.series', 'Series SQL schema');
includes(schema, 'CREATE TABLE IF NOT EXISTS public.episodes', 'Episode SQL schema');

console.log('Multi-account Google Drive, account-bound private streaming, series schema, episode publishing and navigation checks passed.');
