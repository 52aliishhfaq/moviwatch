/**
 * Moviwatch lightweight catalogue store.
 *
 * Uses the already-provisioned Upstash Redis database for small curated
 * catalogue records. Writes that touch a record and its index are transactional.
 * Neon remains the migration source until the store is explicitly activated.
 */

const PREFIX = "moviwatch:catalogue:v1:";
const META_KEY = PREFIX + "meta";
const MOVIES_INDEX = PREFIX + "movies";
const CATEGORIES_KEY = PREFIX + "categories";
const COLLECTIONS_INDEX = PREFIX + "collections";
const BACKUP_PREFIX = PREFIX + "legacy-backup:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_CATEGORIES = ["Action", "Romantic"];
const MAX_MOVIES = 5000;
const MAX_COLLECTIONS = 1000;

function assertRedis(redis) {
  if (!redis || typeof redis.get !== "function" || typeof redis.set !== "function" ||
      typeof redis.multi !== "function" || typeof redis.zrange !== "function" ||
      typeof redis.mget !== "function") {
    throw new TypeError("A configured Upstash Redis client is required.");
  }
}

function keyForMovie(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new Error("Invalid movie ID.");
  return PREFIX + "movie:" + id.toLowerCase();
}

function keyForCollection(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new Error("Invalid collection ID.");
  return PREFIX + "collection:" + id.toLowerCase();
}

function safeScore(value) {
  const time = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(time) && time >= 0 ? time : 0;
}

function normalizeMovie(movie) {
  if (!movie || typeof movie !== "object" || Array.isArray(movie)) throw new Error("Movie record is required.");
  if (!UUID_RE.test(String(movie.id || ""))) throw new Error("Invalid movie ID.");
  if (typeof movie.title !== "string" || !movie.title.trim() || movie.title.length > 200) {
    throw new Error("Movie title is required (max 200 characters).");
  }
  if (typeof movie.poster_url !== "string" || !/^https:\/\//i.test(movie.poster_url) || movie.poster_url.length > 2048) {
    throw new Error("A valid HTTPS poster URL is required.");
  }
  if (typeof movie.category !== "string" || !movie.category.trim() || movie.category.length > 80) {
    throw new Error("Movie category is required.");
  }
  const sources = Array.isArray(movie.video_sources) ? movie.video_sources : [];
  if (sources.length > 8) throw new Error("A movie can have at most 8 video sources.");
  return {
    id: movie.id.toLowerCase(),
    title: movie.title.trim(),
    poster_url: movie.poster_url,
    category: movie.category.trim(),
    video_sources: sources,
    is_published: movie.is_published === true,
    is_featured: movie.is_featured === true,
    created_at: movie.created_at || new Date().toISOString(),
    updated_at: movie.updated_at || new Date().toISOString(),
    content_type: "movie"
  };
}

function normalizeCollection(collection) {
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
    throw new Error("Collection details are required.");
  }
  if (!UUID_RE.test(String(collection.id || ""))) throw new Error("Invalid collection ID.");
  const name = typeof collection.name === "string" ? collection.name.trim() : "";
  if (!name || name.length > 120) throw new Error("Collection name is required (max 120 characters).");
  const description = typeof collection.description === "string" ? collection.description.trim().slice(0, 2000) : "";
  const movieIds = Array.isArray(collection.movie_ids)
    ? [...new Set(collection.movie_ids.filter((id) => typeof id === "string" && UUID_RE.test(id)))].slice(0, 500)
    : [];
  return {
    id: collection.id.toLowerCase(),
    name,
    description,
    movie_ids: movieIds,
    is_published: collection.is_published === true,
    created_at: collection.created_at || new Date().toISOString(),
    updated_at: collection.updated_at || new Date().toISOString()
  };
}

export async function getCatalogueMeta(redis) {
  assertRedis(redis);
  const meta = await redis.get(META_KEY);
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? meta
    : { version: 1, active: false, migration: { status: "not_started" } };
}

export async function setMigrationState(redis, migration) {
  assertRedis(redis);
  const previous = await getCatalogueMeta(redis);
  const next = {
    version: 1,
    active: previous.active === true,
    migration: {
      ...previous.migration,
      ...migration,
      updated_at: new Date().toISOString()
    }
  };
  await redis.set(META_KEY, next);
  return next;
}

export async function activateCatalogueStore(redis, expectedCounts = {}) {
  assertRedis(redis);
  const previous = await getCatalogueMeta(redis);
  const migration = previous.migration || {};
  if (migration.status !== "prepared") throw new Error("Catalogue migration must be prepared before activation.");
  const movieCount = Number(await redis.zcard(MOVIES_INDEX));
  const expected = Number(expectedCounts.movieCount);
  if (!Number.isSafeInteger(expected) || expected < 0 || movieCount !== expected ||
      Number(migration.migrated_movies) !== expected ||
      Number(migration.backed_up_movies) !== expected) {
    throw new Error("Catalogue migration counts do not match; store activation was refused.");
  }
  const next = {
    ...previous,
    version: 1,
    active: true,
    activated_at: new Date().toISOString()
  };
  await redis.set(META_KEY, next);
  return next;
}

export async function saveMovie(redis, rawMovie) {
  assertRedis(redis);
  const movie = normalizeMovie(rawMovie);
  const tx = redis.multi();
  tx.set(keyForMovie(movie.id), movie);
  tx.zadd(MOVIES_INDEX, { score: safeScore(movie.updated_at), member: movie.id });
  tx.sadd(CATEGORIES_KEY, movie.category);
  await tx.exec();
  return movie;
}

export async function getMovie(redis, id) {
  assertRedis(redis);
  return redis.get(keyForMovie(id));
}

export async function listMovies(redis, {
  category = "",
  query = "",
  publishedOnly = false,
  limit = 500
} = {}) {
  assertRedis(redis);
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_MOVIES) : 500;
  const ids = await redis.zrange(MOVIES_INDEX, 0, MAX_MOVIES - 1, { rev: true });
  if (!Array.isArray(ids) || !ids.length) return [];
  const records = await redis.mget(...ids.map((id) => keyForMovie(String(id))));
  const normalizedQuery = typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
  return (Array.isArray(records) ? records : [])
    .filter((movie) => movie && typeof movie === "object" && !Array.isArray(movie))
    .filter((movie) => !publishedOnly || movie.is_published === true)
    .filter((movie) => !category || movie.category === category)
    .filter((movie) => !normalizedQuery || String(movie.title || "").toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => (publishedOnly ? Number(b.is_featured === true) - Number(a.is_featured === true) : 0) ||
      safeScore(b.updated_at || b.created_at) - safeScore(a.updated_at || a.created_at))
    .slice(0, boundedLimit);
}

export async function deleteMovie(redis, id) {
  assertRedis(redis);
  const movie = await getMovie(redis, id);
  if (!movie) return false;
  const tx = redis.multi();
  tx.del(keyForMovie(id));
  tx.zrem(MOVIES_INDEX, String(id).toLowerCase());
  await tx.exec();
  return true;
}

export async function listCategories(redis) {
  assertRedis(redis);
  const values = await redis.smembers(CATEGORIES_KEY);
  const categories = new Set(DEFAULT_CATEGORIES);
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === "string" && value.trim() && value.length <= 80) categories.add(value);
  }
  return [...categories].sort((a, b) => a.localeCompare(b));
}

export async function saveCategory(redis, name) {
  assertRedis(redis);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
    throw new Error("Category name is required (max 80 characters).");
  }
  const value = name.trim();
  await redis.sadd(CATEGORIES_KEY, value);
  return value;
}

export async function deleteCategory(redis, name) {
  assertRedis(redis);
  if (typeof name !== "string" || !name.trim()) throw new Error("Category name is required.");
  if (DEFAULT_CATEGORIES.includes(name.trim())) throw new Error("Default categories cannot be deleted.");
  const movies = await listMovies(redis, { limit: MAX_MOVIES });
  if (movies.some((movie) => movie.category === name.trim())) {
    throw new Error("Move or delete movies in this category before deleting it.");
  }
  await redis.srem(CATEGORIES_KEY, name.trim());
  return true;
}

export async function saveCollection(redis, rawCollection) {
  assertRedis(redis);
  const collection = normalizeCollection(rawCollection);
  const tx = redis.multi();
  tx.set(keyForCollection(collection.id), collection);
  tx.zadd(COLLECTIONS_INDEX, { score: safeScore(collection.updated_at), member: collection.id });
  await tx.exec();
  return collection;
}

export async function getCollection(redis, id) {
  assertRedis(redis);
  return redis.get(keyForCollection(id));
}

export async function listCollections(redis, { publishedOnly = false, limit = 100 } = {}) {
  assertRedis(redis);
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_COLLECTIONS) : 100;
  const ids = await redis.zrange(COLLECTIONS_INDEX, 0, boundedLimit - 1, { rev: true });
  if (!Array.isArray(ids) || !ids.length) return [];
  const records = await redis.mget(...ids.map((id) => keyForCollection(String(id))));
  return (Array.isArray(records) ? records : [])
    .filter((collection) => collection && typeof collection === "object" && !Array.isArray(collection))
    .filter((collection) => !publishedOnly || collection.is_published === true);
}

export async function deleteCollection(redis, id) {
  assertRedis(redis);
  const collection = await getCollection(redis, id);
  if (!collection) return false;
  const tx = redis.multi();
  tx.del(keyForCollection(id));
  tx.zrem(COLLECTIONS_INDEX, String(id).toLowerCase());
  await tx.exec();
  return true;
}

export async function saveMigratedMovieBatch(redis, records) {
  assertRedis(redis);
  if (!Array.isArray(records) || records.length < 1 || records.length > 50) {
    throw new Error("Migration batches must contain 1–50 movies.");
  }
  const tx = redis.multi();
  for (const record of records) {
    const movie = normalizeMovie(record.movie);
    if (!record.legacy || typeof record.legacy !== "object") throw new Error("Legacy movie backup is missing.");
    tx.set(BACKUP_PREFIX + "movie:" + movie.id, record.legacy);
    tx.set(keyForMovie(movie.id), movie);
    tx.zadd(MOVIES_INDEX, { score: safeScore(movie.updated_at), member: movie.id });
    tx.sadd(CATEGORIES_KEY, movie.category);
  }
  await tx.exec();
  return records.length;
}

export async function backupLegacyRecords(redis, type, rows) {
  assertRedis(redis);
  if (!["series", "episode"].includes(type) || !Array.isArray(rows) || rows.length > 50) {
    throw new Error("Legacy backup batches must contain at most 50 series or episodes.");
  }
  if (!rows.length) return 0;
  const tx = redis.multi();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !UUID_RE.test(String(row.id || ""))) {
      throw new Error("Invalid legacy " + type + " backup record.");
    }
    tx.set(BACKUP_PREFIX + type + ":" + row.id.toLowerCase(), row);
  }
  await tx.exec();
  return rows.length;
}

export async function clearStagedMovies(redis) {
  assertRedis(redis);
  const ids = await redis.zrange(MOVIES_INDEX, 0, MAX_MOVIES - 1);
  for (let offset = 0; offset < (ids || []).length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const tx = redis.multi();
    for (const id of batch) {
      tx.del(keyForMovie(String(id)));
      tx.zrem(MOVIES_INDEX, String(id));
    }
    await tx.exec();
  }
  return (ids || []).length;
}

export async function backupLegacyRecord(redis, type, id, value) {
  assertRedis(redis);
  if (!["movie", "series", "episode"].includes(type) ||
      typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error("Invalid legacy backup record.");
  }
  const key = BACKUP_PREFIX + type + ":" + id.toLowerCase();
  await redis.set(key, value);
  return key;
}

export async function countCatalogueMovies(redis) {
  assertRedis(redis);
  return Number(await redis.zcard(MOVIES_INDEX)) || 0;
}
