PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  firebase_uid TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  theme_preference TEXT NOT NULL DEFAULT 'system'
    CHECK (theme_preference IN ('system', 'light', 'dark')),
  free_measurement_used INTEGER NOT NULL DEFAULT 0
    CHECK (free_measurement_used IN (0, 1)),
  has_had_subscription INTEGER NOT NULL DEFAULT 0
    CHECK (has_had_subscription IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL,
  preserve_name TEXT NOT NULL,
  ph REAL NOT NULL,
  confidence TEXT NOT NULL,
  lab_l REAL,
  lab_a REAL,
  lab_b REAL,
  hsv_h REAL,
  hsv_s REAL,
  hsv_v REAL,
  reference_r INTEGER,
  reference_g INTEGER,
  reference_b INTEGER,
  distance REAL,
  hue_distance REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (firebase_uid) REFERENCES users(firebase_uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_measurements_user_created
  ON measurements(firebase_uid, created_at DESC);

-- Comparaciones de dos capturas: no contienen un valor de pH estimado.
CREATE TABLE IF NOT EXISTS comparison_measurements (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL,
  preserve_name TEXT NOT NULL,
  method TEXT NOT NULL,
  within_range INTEGER NOT NULL CHECK (within_range IN (0, 1)),
  indicator_json TEXT NOT NULL,
  sample_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (firebase_uid) REFERENCES users(firebase_uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comparisons_user_created
  ON comparison_measurements(firebase_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  provider_subscription_id TEXT UNIQUE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('plus', 'pro', 'annual')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'active', 'paused', 'cancelled', 'expired')),
  period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0
    CHECK (cancel_at_period_end IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firebase_uid) REFERENCES users(firebase_uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_period
  ON subscriptions(firebase_uid, current_period_end DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  provider_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
