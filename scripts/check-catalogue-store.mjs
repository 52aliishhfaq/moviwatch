import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activateCatalogueStore, backupLegacyRecord, countCatalogueMovies, deleteCategory,
  deleteCollection, deleteMovie, getCatalogueMeta, getCollection, getMovie, getMovies,
  listCategories, listCollections, listMovies, isMoviePublishable, saveCategory, saveCollection,
  saveMigratedMovieBatch, saveMovie, setMigrationState, verifyCatalogueMigration
} from '../src/catalogue-store.js';
import { prepareNeonToRedisMigration } from '../src/catalogue-migration.js';

class FakeMulti {
  constructor(redis) { this.redis = redis; this.commands = []; }
  set(key, value) { this.commands.push(() => this.redis.set(key, value)); return this; }
  zadd(key, value) { this.commands.push(() => this.redis.zadd(key, value)); return this; }
  sadd(key, value) { this.commands.push(() => this.redis.sadd(key, value)); return this; }
  del(key) { this.commands.push(() => this.redis.del(key)); return this; }
  zrem(key, member) { this.commands.push(() => this.redis.zrem(key, member)); return this; }
  async exec() { return Promise.all(this.commands.map((command) => command())); }
}
class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.zsets = new Map(); }
  multi() { return new FakeMulti(this); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, structuredClone(value)); return 'OK'; }
  async mget(...keys) { return keys.map((key) => this.values.get(key) ?? null); }
  async del(key) { this.values.delete(key); this.sets.delete(key); this.zsets.delete(key); return 1; }
  async sadd(key, member) { if (!this.sets.has(key)) this.sets.set(key, new Set()); this.sets.get(key).add(member); return 1; }
  async srem(key, member) { this.sets.get(key)?.delete(member); return 1; }
  async smembers(key) { return [...(this.sets.get(key) || [])]; }
  async zadd(key, { score, member }) { if (!this.zsets.has(key)) this.zsets.set(key, new Map()); this.zsets.get(key).set(member, score); return 1; }
  async zrem(key, member) { this.zsets.get(key)?.delete(member); return 1; }
  async zcard(key) { return this.zsets.get(key)?.size || 0; }
  async zrange(key, start, end, options = {}) {
    let rows = [...(this.zsets.get(key) || new Map()).entries()].sort((a,b)=>a[1]-b[1]).map(([member])=>member);
    if (options.rev) rows.reverse();
    const to = end < 0 ? rows.length + end + 1 : end + 1;
    return rows.slice(start, to);
  }
}
const redis = new FakeRedis();
const movieA = {
  id: 'a0000000-0000-4000-8000-000000000001',
  title: 'First Movie',
  poster_url: 'https://archive.org/services/img/first',
  category: 'Action',
  video_sources: [{ label: 'Archive.org', provider: 'archive.org', url: 'https://archive.org/download/first/movie.mp4', verified_at: '2026-11-24T10:00:00.000Z', verified_size: 12345 }],
  is_published: true,
  is_featured: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z'
};
const movieB = { ...movieA, id: 'a0000000-0000-4000-8000-000000000002', title: 'Second Movie', category: 'Romantic', is_featured: false, updated_at: '2026-01-03T00:00:00.000Z' };
await saveMovie(redis, movieA);
await saveMovie(redis, movieB);
assert.equal((await getMovie(redis, movieA.id)).title, 'First Movie');
assert.deepEqual((await getMovies(redis, [movieA.id, movieB.id])).map(movie => movie.title), ['First Movie', 'Second Movie']);
assert.equal(await countCatalogueMovies(redis), 2);
assert.equal((await listMovies(redis, { publishedOnly: true })).length, 2);
assert.equal(isMoviePublishable(await getMovie(redis, movieA.id)), true);
await saveMovie(redis, { ...movieA, id: 'a0000000-0000-4000-8000-000000000003',
  video_sources: [{ label: 'Archive.org', provider: 'archive.org', url: 'https://archive.org/download/unprobed/movie.mp4' }] ,
  is_published: false });
assert.equal((await listMovies(redis, { publishedOnly: true })).length, 2);
assert.equal(isMoviePublishable(await getMovie(redis, 'a0000000-0000-4000-8000-000000000003')), false);
assert.equal(await deleteMovie(redis, 'a0000000-0000-4000-8000-000000000003'), true);
await assert.rejects(() => saveMovie(redis, {
  ...movieA, video_sources: [{ label: 'Archive.org', provider: 'archive.org', url: 'https://archive.org/download/unprobed/movie.mp4' }]
}), /server-side Archive.org byte-range verification/);
const legacyUnverified = {
  ...movieA,
  id: 'a0000000-0000-4000-8000-000000000004',
  video_sources: [{ label: 'Old Archive URL', provider: 'archive.org', url: 'https://archive.org/download/old-unprobed/movie.mp4' }],
  is_published: true,
  is_featured: true
};
await redis.set('moviwatch:catalogue:v1:movie:'+legacyUnverified.id, legacyUnverified);
await redis.zadd('moviwatch:catalogue:v1:movies', { score: Date.parse(legacyUnverified.updated_at), member: legacyUnverified.id });
assert.equal(isMoviePublishable(await getMovie(redis, legacyUnverified.id)), false);
assert.equal((await listMovies(redis, { publishedOnly: true })).length, 2);
await redis.del('moviwatch:catalogue:v1:movie:'+legacyUnverified.id);
await redis.zrem('moviwatch:catalogue:v1:movies', legacyUnverified.id);
assert.equal((await listMovies(redis, { category: 'Romantic' }))[0].id, movieB.id);
assert.equal((await listMovies(redis, { query: 'first' }))[0].is_featured, true);
await assert.rejects(() => saveMovie(redis, { ...movieA, id: 'not-a-uuid' }), /movie ID/);
await assert.rejects(() => saveMovie(redis, { ...movieA, poster_url: 'http://insecure.example/poster.jpg' }), /HTTPS/);
await assert.rejects(() => saveMovie(redis, {
  ...movieA,
  video_sources: [{ label: 'Legacy Drive', provider: 'google-drive', url: 'https://drive.google.com/file/d/abcdefghij/view' }]
}), /Only Archive.org/);
await assert.rejects(() => saveMovie(redis, {
  ...movieA, is_published: true, video_sources: []
}), /at least one Archive.org source/);

assert.deepEqual(await listCategories(redis), ['Action', 'Romantic']);
await saveCategory(redis, 'Documentary');
assert.ok((await listCategories(redis)).includes('Documentary'));
await assert.rejects(() => deleteCategory(redis, 'Action'), /Default/);
await assert.rejects(() => deleteCategory(redis, 'Romantic'), /Default/);
assert.equal(await deleteCategory(redis, 'Documentary'), true);

const collectionId = 'b0000000-0000-4000-8000-000000000001';
await saveCollection(redis, { id: collectionId, name: 'Classics', description: 'Selected classics', movie_ids: [movieA.id, movieB.id], is_published: true });
assert.equal((await getCollection(redis, collectionId)).movie_ids.length, 2);
assert.equal((await listCollections(redis, { publishedOnly: true })).length, 1);
assert.equal(await deleteCollection(redis, collectionId), true);
assert.equal(await listCollections(redis).then((rows) => rows.length), 0);

assert.ok((await backupLegacyRecord(redis, 'movie', movieA.id, { original: true })).includes('legacy-backup'));
await saveMigratedMovieBatch(redis, [{ legacy: { id: movieA.id, original: true }, movie: movieA }]);
await setMigrationState(redis, { status: 'prepared', migrated_movies: 1, backed_up_movies: 1 });
await assert.rejects(() => activateCatalogueStore(redis, { movieCount: 2 }), /counts do not match/);
await deleteMovie(redis, movieB.id);
const active = await activateCatalogueStore(redis, { movieCount: 1 });
assert.equal(active.active, true);
assert.equal((await getCatalogueMeta(redis)).migration.status, 'prepared');
assert.equal(await deleteMovie(redis, movieA.id), true);
assert.equal(await deleteMovie(redis, movieA.id), false);
assert.equal(await countCatalogueMovies(redis), 0);

const migrationRedis = new FakeRedis();
const legacyMovies = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    title: 'Archive Classic', poster_url: 'https://archive.org/services/img/classic',
    category: 'Action', is_published: true,
    videos: [{ label: 'Archive master', provider: 'archive.org', url: 'https://archive.org/download/classic/movie.mp4' }],
    created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-02T00:00:00.000Z'
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    title: 'Drive-only Legacy', poster_url: 'https://example.com/legacy.jpg',
    category: 'Romantic', is_published: true,
    videos: [{ label: 'Old Drive', provider: 'google-drive', url: 'https://drive.google.com/file/d/abcdefghij/view' }],
    created_at: '2025-01-03T00:00:00.000Z', updated_at: '2025-01-04T00:00:00.000Z'
  }
];
const legacySeries = [{ id: 'd0000000-0000-4000-8000-000000000001', title: 'Legacy Series' }];
const legacyEpisodes = [{ id: 'e0000000-0000-4000-8000-000000000001', series_id: legacySeries[0].id }];
async function fakeSql(strings) {
  const query = strings.join(' ').toLowerCase();
  if (query.includes('from public.movies')) return legacyMovies;
  if (query.includes('from public.series')) return legacySeries;
  if (query.includes('from public.episodes')) return legacyEpisodes;
  throw new Error('Unexpected SQL query: '+query);
}
const legacyPreparedRedis = new FakeRedis();
await setMigrationState(legacyPreparedRedis, {
  status: 'prepared', source: 'neon', source_movie_count: 2, migrated_movies: 2,
  backed_up_movies: 2, backed_up_series: 1, backed_up_episodes: 1
});
for (const row of legacyMovies) {
  const sources = row.id === legacyMovies[0].id
    ? [{ label: 'Archive.org', provider: 'archive.org', url: 'https://archive.org/download/legacy/movie.mp4' }]
    : [];
  const legacyMovie = {
    id: row.id, title: row.title, poster_url: row.poster_url, category: row.category,
    video_sources: sources, is_published: row.is_published && sources.length > 0,
    is_featured: false, created_at: row.created_at, updated_at: row.updated_at
  };
  await legacyPreparedRedis.set('moviwatch:catalogue:v1:movie:'+row.id, legacyMovie);
  await legacyPreparedRedis.zadd('moviwatch:catalogue:v1:movies', { score: Date.parse(row.updated_at), member: row.id });
  await legacyPreparedRedis.sadd('moviwatch:catalogue:v1:legacy-movie-ids', row.id);
  await legacyPreparedRedis.set('moviwatch:catalogue:v1:legacy-backup:movie:'+row.id, row);
  await legacyPreparedRedis.sadd('moviwatch:catalogue:v1:backed-up-movie-ids', row.id);
}
await legacyPreparedRedis.set('moviwatch:catalogue:v1:legacy-backup:series:'+legacySeries[0].id, legacySeries[0]);
await legacyPreparedRedis.sadd('moviwatch:catalogue:v1:backed-up-series-ids', legacySeries[0].id);
await legacyPreparedRedis.set('moviwatch:catalogue:v1:legacy-backup:episode:'+legacyEpisodes[0].id, legacyEpisodes[0]);
await legacyPreparedRedis.sadd('moviwatch:catalogue:v1:backed-up-episode-ids', legacyEpisodes[0].id);
const legacySnapshotVerification = await verifyCatalogueMigration(legacyPreparedRedis, {
  movieCount: 2, seriesCount: 1, episodeCount: 1
});
assert.equal(legacySnapshotVerification.ok, false);
assert.ok(legacySnapshotVerification.errors.some(error => error.includes('without a successful Archive.org byte-range verification')));
const repairedLegacySnapshot = await prepareNeonToRedisMigration(fakeSql, legacyPreparedRedis);
assert.equal(repairedLegacySnapshot.migration.status, 'prepared');
assert.equal(repairedLegacySnapshot.migration.verification.ok, true);
assert.equal((await getMovie(legacyPreparedRedis, legacyMovies[0].id)).is_published, false);

const stalePreparedRedis = new FakeRedis();
await setMigrationState(stalePreparedRedis, {
  status: 'prepared', source_movie_count: 2, migrated_movies: 2,
  backed_up_movies: 2, backed_up_series: 1, backed_up_episodes: 1
});
const repairedSnapshot = await prepareNeonToRedisMigration(fakeSql, stalePreparedRedis);
assert.equal(repairedSnapshot.migration.status, 'prepared');
assert.equal(repairedSnapshot.migration.verification.ok, true);
assert.equal(await countCatalogueMovies(stalePreparedRedis), 2);

const migration = await prepareNeonToRedisMigration(fakeSql, migrationRedis);
assert.equal(migration.migration.status, 'prepared');
assert.equal(migration.migration.source_movie_count, 2);
assert.equal(migration.migration.migrated_movies, 2);
assert.equal(migration.migration.backed_up_movies, 2);
assert.equal(migration.migration.backed_up_series, 1);
assert.equal(migration.migration.backed_up_episodes, 1);
assert.equal(migration.migration.archive_source_candidates, 1);
assert.equal(migration.migration.hidden_movies, 1);
assert.equal(migration.migration.needs_probe_movies, 1);
assert.equal(migration.migration.verification.ok, true);
assert.equal(migration.migration.verification.actual.seriesBackups, 1);
assert.equal(migration.migration.verification.actual.episodeBackups, 1);
const verifiedPrepared = await verifyCatalogueMigration(migrationRedis, {
  movieCount: 2, seriesCount: 1, episodeCount: 1
});
assert.equal(verifiedPrepared.ok, true);
const migratedArchive = await getMovie(migrationRedis, legacyMovies[0].id);
const migratedDriveOnly = await getMovie(migrationRedis, legacyMovies[1].id);
assert.equal(migratedArchive.is_published, false);
assert.equal(isMoviePublishable(migratedArchive), false);
assert.equal(migratedArchive.video_sources[0].provider, 'archive.org');
assert.equal(migratedDriveOnly.is_published, false);
assert.deepEqual(migratedDriveOnly.video_sources, []);
const repeated = await prepareNeonToRedisMigration(fakeSql, migrationRedis);
assert.equal(repeated.migration.status, 'prepared');
assert.equal(await countCatalogueMovies(migrationRedis), 2);
const stagedNew = {
  id: 'c0000000-0000-4000-8000-000000000003',
  title: 'Newly Curated Archive Movie',
  poster_url: 'https://archive.org/services/img/new-title',
  category: 'Documentary',
  video_sources: [{ label: 'Archive.org', provider: 'archive.org', url: 'https://archive.org/download/new-title/movie.mp4', verified_at: '2026-11-24T10:00:00.000Z', verified_size: 4096 }],
  is_published: true,
  is_featured: true
};
await saveMovie(migrationRedis, stagedNew);
await deleteMovie(migrationRedis, legacyMovies[0].id);
await assert.rejects(() => activateCatalogueStore(migrationRedis, { movieCount: 2 }), /verification failed/);
await saveMovie(migrationRedis, migratedArchive);
const activated = await activateCatalogueStore(migrationRedis, { movieCount: 2 });
assert.equal(activated.active, true);
assert.equal(await countCatalogueMovies(migrationRedis), 3);

const incompleteRedis = new FakeRedis();
await prepareNeonToRedisMigration(fakeSql, incompleteRedis);
await incompleteRedis.del('moviwatch:catalogue:v1:legacy-backup:series:'+legacySeries[0].id);
await assert.rejects(
  () => activateCatalogueStore(incompleteRedis, { movieCount: 2 }),
  /series backups are missing/
);

const corruptedRedis = new FakeRedis();
await prepareNeonToRedisMigration(fakeSql, corruptedRedis);
await corruptedRedis.set(
  'moviwatch:catalogue:v1:legacy-backup:episode:'+legacyEpisodes[0].id,
  { ...legacyEpisodes[0], id: 'e0000000-0000-4000-8000-000000000099' }
);
const corruptedVerification = await verifyCatalogueMigration(corruptedRedis, {
  movieCount: 2, seriesCount: 1, episodeCount: 1
});
assert.equal(corruptedVerification.ok, false);
assert.ok(corruptedVerification.errors.some((error) => error.includes('episode backups') ||
  error.includes('episode backup manifest')));

const alteredBackupRedis = new FakeRedis();
await prepareNeonToRedisMigration(fakeSql, alteredBackupRedis);
const alteredEpisode = { ...legacyEpisodes[0], title: 'Silently altered after backup' };
await alteredBackupRedis.set(
  'moviwatch:catalogue:v1:legacy-backup:episode:' + legacyEpisodes[0].id,
  alteredEpisode
);
const alteredBackupVerification = await verifyCatalogueMigration(alteredBackupRedis, {
  movieCount: 2, seriesCount: 1, episodeCount: 1
});
assert.equal(alteredBackupVerification.ok, false);
assert.ok(alteredBackupVerification.errors.some((error) =>
  error.includes('episode backups failed SHA-256 integrity verification')));


const workerSource = readFileSync('src/index.js', 'utf8');
const adminSource = readFileSync('public/admin.html', 'utf8');
const homeSource = readFileSync('public/index.html', 'utf8');
const migrationSource = readFileSync('src/catalogue-migration.js', 'utf8');
const storeSource = readFileSync('src/catalogue-store.js', 'utf8');
assert.ok(workerSource.includes("Never expose stored source URLs"));
assert.ok(workerSource.includes("storeMeta.active===true||storeMeta.migration?.status==='prepared'"));
assert.ok(workerSource.includes("migrationRunning&&['POST','PUT','PATCH','DELETE'].includes(method)"));
assert.ok(workerSource.includes("Movie deletion is locked until the Redis catalogue is activated"));
assert.ok(workerSource.includes("Google Drive OAuth is disabled while Moviwatch is in Archive-only migration mode."));
assert.ok(workerSource.includes("This legacy Neon-backed admin endpoint is disabled in Archive-only mode."));
assert.ok(workerSource.includes("if(storeMeta.active){"));
assert.ok(workerSource.includes("sourceMovieCount=Number(storeMeta.migration?.source_movie_count||0);"));
assert.ok(workerSource.includes("__movie_metadata__v5/"));
assert.ok(workerSource.includes("__public_catalogue__v5"));
assert.ok(workerSource.includes("v5 deliberately bypasses prior unverified-publication metadata cached under the previous namespace"));
assert.ok(migrationSource.includes("if (previous.migration?.status === \"prepared\")"));
assert.ok(migrationSource.includes("if (existingVerification.ok) return previous;"));
assert.ok(adminSource.includes("catalogueNeedsRebuild"));
assert.ok(adminSource.includes("Rebuild and verify migration"));
assert.ok(adminSource.includes("Deleting movies remains locked until activation"));
assert.ok(workerSource.includes("video_sources:(Array.isArray(movie.video_sources)?movie.video_sources:[])"));
assert.ok(migrationSource.includes('await clearStagedMovies(redis)'));
assert.ok(!/DELETE\\s+FROM\\s+public\\.(movies|series|episodes)/i.test(migrationSource));
assert.ok(adminSource.includes("PREPARE_ARCHIVE_ONLY_MIGRATION"));
assert.ok(adminSource.includes("ACTIVATE_REDIS_CATALOGUE"));
assert.ok(adminSource.includes('id="categoryForm"'));
assert.ok(adminSource.includes('id="collectionForm"'));
assert.ok(adminSource.includes('id="featured"'));
assert.ok(homeSource.includes("async function loadCollections()"));
assert.ok(homeSource.includes("featured-tag"));
assert.ok(workerSource.includes("async function verifyArchiveVideoSources(sources)"));
assert.ok(workerSource.includes("verifyArchiveSources(sources, probeArchiveFile)"));
assert.ok(workerSource.includes("const value=await prepareRedisMovieInput(req,env)"));
assert.ok(workerSource.includes("isMoviePublishable(movie)"));
assert.ok(adminSource.includes("re-checks every source again when you save a movie as Published"));
assert.ok(workerSource.includes("const movie=isMoviePublishable(stored)"));
assert.ok(workerSource.includes("published:all.filter(isMoviePublishable).length"));
assert.ok(workerSource.includes("featured:all.filter(x=>isMoviePublishable(x)&&x.is_featured).length"));
assert.ok(migrationSource.includes("is_published: false, // Archive.org URLs are candidates"));
assert.ok(storeSource.includes("without a successful Archive.org byte-range verification"));
assert.ok(adminSource.includes("need range verification"));
assert.ok(workerSource.includes("parseArchiveSourceUrl"));

console.log('Transactional Redis movie, category, collection, backup and activation checks passed.');
