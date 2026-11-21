-- Production schema for Moviwatch (matches public.movies on Neon).
-- Run only for a new database. Existing production data is not modified.
CREATE TABLE IF NOT EXISTS public.movies (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  poster_url TEXT NOT NULL,
  category TEXT NOT NULL,
  videos JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(videos) = 'array'),
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  views BIGINT NOT NULL DEFAULT 0,
  streams BIGINT NOT NULL DEFAULT 0,
  downloads BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movies_catalog
  ON public.movies (is_published, category, title);


-- Web series and episode metadata. Existing movie rows remain unchanged.
CREATE TABLE IF NOT EXISTS public.series (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  poster_url TEXT NOT NULL,
  category TEXT NOT NULL,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.episodes (
  id UUID PRIMARY KEY,
  series_id UUID NOT NULL REFERENCES public.series(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number BETWEEN 1 AND 999),
  episode_number INTEGER NOT NULL CHECK (episode_number BETWEEN 1 AND 9999),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  videos JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(videos) = 'array'),
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_episodes_series_order
  ON public.episodes (series_id, season_number, episode_number);

CREATE INDEX IF NOT EXISTS idx_episodes_public_order
  ON public.episodes (is_published, series_id, season_number, episode_number);
