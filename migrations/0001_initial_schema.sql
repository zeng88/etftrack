CREATE TABLE IF NOT EXISTS etfs (
  code TEXT PRIMARY KEY,
  tcode TEXT NOT NULL,
  name TEXT NOT NULL,
  index_name TEXT NOT NULL,
  group_name TEXT NOT NULL CHECK (group_name IN ('core', 'watch')),
  huijin_yi REAL
);
CREATE TABLE IF NOT EXISTS share_history (
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL REFERENCES etfs(code),
  shares REAL NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (trade_date, code)
);
CREATE INDEX IF NOT EXISTS idx_share_history_code_date ON share_history(code, trade_date);
CREATE TABLE IF NOT EXISTS daily_activity (
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL REFERENCES etfs(code),
  amount_yi REAL,
  volume_lots REAL,
  shape_json TEXT,
  tail_ratio REAL,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trade_date, code)
);
CREATE INDEX IF NOT EXISTS idx_daily_activity_code_date ON daily_activity(code, trade_date);
CREATE TABLE IF NOT EXISTS daily_closes (
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL REFERENCES etfs(code),
  close_price REAL NOT NULL,
  volume_lots REAL,
  turnover_yi REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (trade_date, code)
);
CREATE INDEX IF NOT EXISTS idx_daily_closes_code_date ON daily_closes(code, trade_date);
CREATE TABLE IF NOT EXISTS daily_snapshots (
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL REFERENCES etfs(code),
  payload_json TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (trade_date, code)
);
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_code_date ON daily_snapshots(code, trade_date);
CREATE TABLE IF NOT EXISTS collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'skipped', 'failed')),
  trade_date TEXT,
  message TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
