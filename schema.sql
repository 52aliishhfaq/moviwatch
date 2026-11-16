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
