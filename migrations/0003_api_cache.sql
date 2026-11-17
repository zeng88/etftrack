CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  data_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
