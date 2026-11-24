/**
 * One-way, re-runnable migration preparation from Neon to the Redis catalogue.
 *
 * The source Neon database is read-only here. Every original movie, series and
 * episode record is copied to a separate Redis backup key before the new
 * Archive.org-only public record is written. Activation is a separate operation.
 */
import { sourceProvider, videoSourceUrl } from "./video-sources.js";
import {
  backupLegacyRecords,
  clearStagedMovies,
  countCatalogueMovies,
  getCatalogueMeta,
  saveMigratedMovieBatch,
  setMigrationState,
  verifyCatalogueMigration
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
  if (!Array.isArray(items) || !Number.isInteger(batchSize) || batchSize < 1 ||
      typeof operation !== "function") {
    throw new TypeError("Invalid migration batch configuration.");
  }
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    await operation(batch);
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
  if (previous.migration?.status === "prepared") {
    const existingVerification = await verifyCatalogueMigration(redis, {
      movieCount: previous.migration.source_movie_count,
      seriesCount: previous.migration.backed_up_series,
      episodeCount: previous.migration.backed_up_episodes
    });
    if (existingVerification.ok) return previous;
    // Older deployments could mark a snapshot prepared before writing backup
    // manifests. Rebuild from the read-only Neon source instead of leaving the
    // administrator permanently unable to activate a valid catalogue.
  }

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
    if (!Array.isArray(series) || !Array.isArray(episodes) ||
        series.length > MAX_MIGRATION_MOVIES || episodes.length > MAX_MIGRATION_MOVIES) {
      throw new Error("Legacy series or episode count exceeds the supported migration batch limit.");
    }

    // A failed prior preparation may have left a partial staging index. Clear
    // only the new-catalogue movie index, never the separate immutable backups.
    await clearStagedMovies(redis);
    const preparedAt = new Date().toISOString();
    const preparedMovies = movies.map((row) => {
      const id = String(row.id || "");
      const sources = archiveSourcesOnly(row.videos);
      return {
        legacy: row,
        movie: {
          id,
          title: String(row.title || id).slice(0, 200),
          poster_url: safePoster(row.poster_url),
          category: typeof row.category === "string" && row.category.trim() ? row.category.trim().slice(0, 80) : "Action",
          video_sources: sources,
          is_published: false, // Archive.org URLs are candidates until each file passes an admin byte-range probe.
          is_featured: false,
          created_at: row.created_at || preparedAt,
          updated_at: row.updated_at || row.created_at || preparedAt
        }
      };
    });
    await inBatches(preparedMovies, 25, (batch) => saveMigratedMovieBatch(redis, batch));
    await inBatches(series, 50, (batch) => backupLegacyRecords(redis, "series", batch));
    await inBatches(episodes, 50, (batch) => backupLegacyRecords(redis, "episode", batch));

    const archiveSourceCandidates = movies.filter((row) => archiveSourcesOnly(row.videos).length > 0).length;
    const migratedCount = await countCatalogueMovies(redis);
    if (migratedCount !== movies.length) {
      throw new Error("Redis movie count does not match the Neon source count.");
    }

    const prepared = await setMigrationState(redis, {
      status: "prepared",
      source: "neon",
      source_movie_count: movies.length,
      migrated_movies: migratedCount,
      backed_up_movies: movies.length,
      backed_up_series: series.length,
      backed_up_episodes: episodes.length,
      archive_source_candidates: archiveSourceCandidates,
      needs_probe_movies: archiveSourceCandidates,
      hidden_movies: movies.length - archiveSourceCandidates,
      prepared_at: new Date().toISOString(),
      error: null
    });
    const verification = await verifyCatalogueMigration(redis, {
      movieCount: movies.length,
      seriesCount: series.length,
      episodeCount: episodes.length
    });
    if (!verification.ok) {
      throw new Error("Migration backup verification failed: " + verification.errors.join("; "));
    }
    return await setMigrationState(redis, {
      verification,
      verified_at: new Date().toISOString()
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
