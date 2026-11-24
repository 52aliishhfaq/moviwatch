import assert from 'node:assert/strict';
import {
  activateCatalogueStore, backupLegacyRecord, countCatalogueMovies, deleteCategory,
  deleteCollection, deleteMovie, getCatalogueMeta, getCollection, getMovie,
  listCategories, listCollections, listMovies, saveCategory, saveCollection,
  saveMovie, setMigrationState
} from '../src/catalogue-store.js';

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
  video_sources: [{ label: 'Archive.org', provider: 'archive.org', url: 'https://archive.org/download/first/movie.mp4' }],
  is_published: true,
  is_featured: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z'
};
const movieB = { ...movieA, id: 'a0000000-0000-4000-8000-000000000002', title: 'Second Movie', category: 'Romantic', is_featured: false, updated_at: '2026-01-03T00:00:00.000Z' };
await saveMovie(redis, movieA);
await saveMovie(redis, movieB);
assert.equal((await getMovie(redis, movieA.id)).title, 'First Movie');
assert.equal(await countCatalogueMovies(redis), 2);
assert.equal((await listMovies(redis, { publishedOnly: true })).length, 2);
assert.equal((await listMovies(redis, { category: 'Romantic' }))[0].id, movieB.id);
assert.equal((await listMovies(redis, { query: 'first' }))[0].is_featured, true);
await assert.rejects(() => saveMovie(redis, { ...movieA, id: 'not-a-uuid' }), /movie ID/);
await assert.rejects(() => saveMovie(redis, { ...movieA, poster_url: 'http://insecure.example/poster.jpg' }), /HTTPS/);

assert.deepEqual(await listCategories(redis), ['Action', 'Romantic']);
await saveCategory(redis, 'Documentary');
assert.ok((await listCategories(redis)).includes('Documentary'));
await assert.rejects(() => deleteCategory(redis, 'Action'), /Default/);
await assert.rejects(() => deleteCategory(redis, 'Romantic'), /Move or delete/);
assert.equal(await deleteCategory(redis, 'Documentary'), true);

const collectionId = 'b0000000-0000-4000-8000-000000000001';
await saveCollection(redis, { id: collectionId, name: 'Classics', description: 'Selected classics', movie_ids: [movieA.id, movieB.id], is_published: true });
assert.equal((await getCollection(redis, collectionId)).movie_ids.length, 2);
assert.equal((await listCollections(redis, { publishedOnly: true })).length, 1);
assert.equal(await deleteCollection(redis, collectionId), true);
assert.equal(await listCollections(redis).then((rows) => rows.length), 0);

assert.ok((await backupLegacyRecord(redis, 'movie', movieA.id, { original: true })).includes('legacy-backup'));
await saveMovie(redis, movieA);
await setMigrationState(redis, { status: 'prepared', migrated_movies: 1, backed_up_movies: 1 });
await assert.rejects(() => activateCatalogueStore(redis, { movieCount: 2 }), /counts do not match/);
const active = await activateCatalogueStore(redis, { movieCount: 1 });
assert.equal(active.active, true);
assert.equal((await getCatalogueMeta(redis)).migration.status, 'prepared');
assert.equal(await deleteMovie(redis, movieA.id), true);
assert.equal(await deleteMovie(redis, movieA.id), false);
assert.equal(await countCatalogueMovies(redis), 0);
console.log('Transactional Redis movie, category, collection, backup and activation checks passed.');
