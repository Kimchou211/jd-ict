CREATE TABLE IF NOT EXISTS analysis_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'XAUUSD',
    tf_primary TEXT NOT NULL,
    tf_secondary TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'WAIT',
    confidence REAL NOT NULL DEFAULT 0,
    entry_low REAL,
    entry_high REAL,
    stop_loss REAL,
    take_profit_1 REAL,
    take_profit_2 REAL,
    image_primary TEXT NOT NULL,
    image_secondary TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analysis_records_created_at
    ON analysis_records (created_at DESC);
