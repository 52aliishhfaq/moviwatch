/**
 * One-way, re-runnable migration preparation from Neon to the Redis catalogue.
 *
 * The source Neon database is read-only here. Every original movie, series and
 * episode record is copied to a separate Redis backup key before the new
 * Archive.org-only public record is written. Activation is a separate operation.
 */
import { sourceProvider, videoSourceUrl } from "./video-sources.js";
import {
  backupLegacyRecord,
  countCatalogueMovies,
  getCatalogueMeta,
  saveMovie,
  setMigrationState
} from "./catalogue-store.js";

const MAX_MIGRATION_MOVIES = 5000;
const FALLBACK_POSTER = "https://moviwatch.vercel.app/assets/moviwatch-app-icon.svg";

function parseSources(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function archiveSourcesOnly(value) {
  return parseSources(value).flatMap((source, index) => {
    if (!source || typeof source !== "object" || source.provider === "google-drive-private") return [];
    try {
      const url = videoSourceUrl(source.url);
      if (sourceProvider(url) !== "archive.org") return [];
      return [{
        label: (typeof source.label === "string" && source.label.trim()
          ? source.label.trim() : "Archive.org " + (index + 1)).slice(0, 60),
        url,
        provider: "archive.org"
      }];
    } catch { return []; }
  }).slice(0, 8);
}

function safePoster(value) {
  if (typeof value !== "string" || value.length > 2048) return FALLBACK_POSTER;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
  } catch {}
  return FALLBACK_POSTER;
}

async function inBatches(items, batchSize, operation) {
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    await Promise.all(batch.map(operation));
  }
}

async function optionalRows(sql, query) {
  try { return await query(sql); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|undefined table|relation .* not found/i.test(message)) return [];
    throw error;
  }
}

export async function prepareNeonToRedisMigration(sql, redis) {
  if (typeof sql !== "function") throw new TypeError("Neon SQL client is required for migration preparation.");
  const previous = await getCatalogueMeta(redis);
  if (previous.active) throw new Error("Redis catalogue is already active; migration preparation is locked.");
  if (previous.migration?.status === "prepared") return previous;

  await setMigrationState(redis, {
    status: "running",
    started_at: new Date().toISOString(),
    error: null
  });

  try {
    const movies = await sql`SELECT id,title,poster_url,category,videos,is_published,created_at,updated_at
      FROM public.movies ORDER BY created_at ASC,id ASC`;
    if (!Array.isArray(movies)) throw new Error("Neon returned an invalid movie list.");
    if (movies.length > MAX_MIGRATION_MOVIES) {
      throw new Error("Catalogue contains more than " + MAX_MIGRATION_MOVIES +
        " movies. Export and migrate in approved batches instead.");
    }

    const series = await optionalRows(sql, (client) => client`SELECT * FROM public.series ORDER BY created_at ASC,id ASC`);
    const episodes = await optionalRows(sql, (client) => client`SELECT * FROM public.episodes ORDER BY created_at ASC,id ASC`);

    await inBatches(movies, 10, async (row) => {
      const id = String(row.id || "");
      await backupLegacyRecord(redis, "movie", id, row);
      const sources = archiveSourcesOnly(row.videos);
      await saveMovie(redis, {
        id,
        title: String(row.title || id).slice(0, 200),
        poster_url: safePoster(row.poster_url),
        category: typeof row.category === "string" && row.category.trim() ? row.category.trim().slice(0, 80) : "Action",
        video_sources: sources,
        is_published: row.is_published === true && sources.length > 0,
        is_featured: false,
        created_at: row.created_at || new Date().toISOString(),
        updated_at: row.updated_at || row.created_at || new Date().toISOString()
      });
    });

    await inBatches(series, 10, async (row) => backupLegacyRecord(redis, "series", String(row.id || ""), row));
    await inBatches(episodes, 10, async (row) => backupLegacyRecord(redis, "episode", String(row.id || ""), row));

    const archivePlayableMovies = movies.filter((row) => archiveSourcesOnly(row.videos).length > 0).length;
    const migratedCount = await countCatalogueMovies(redis);
    if (migratedCount !== movies.length) {
      throw new Error("Redis movie count does not match the Neon source count.");
    }

    return await setMigrationState(redis, {
      status: "prepared",
      source: "neon",
      source_movie_count: movies.length,
      migrated_movies: migratedCount,
      backed_up_movies: movies.length,
      backed_up_series: series.length,
      backed_up_episodes: episodes.length,
      archive_playable_movies: archivePlayableMovies,
      hidden_movies: movies.length - archivePlayableMovies,
      prepared_at: new Date().toISOString(),
      error: null
    });
  } catch (error) {
    await setMigrationState(redis, {
      status: "failed",
      error: (error instanceof Error ? error.message : "Migration preparation failed.").slice(0, 500),
      failed_at: new Date().toISOString()
    }).catch((stateError) => console.error("Could not save migration failure state:", stateError?.message || stateError));
    throw error;
  }
}
