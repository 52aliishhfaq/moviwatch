-- Exactly one application table. Secrets live in Cloudflare Worker Secrets.
CREATE TABLE IF NOT EXISTS movies (
  id UUID PRIMARY KEY,
  title VARCHAR(200) NOT NULL CHECK (length(trim(title)) > 0),
  poster_url TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Action', 'Romantic')),
  video_sources JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(video_sources) = 'array' AND jsonb_array_length(video_sources) BETWEEN 1 AND 8),
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS movies_public_category_created_idx
  ON movies (is_published, category, created_at DESC);
