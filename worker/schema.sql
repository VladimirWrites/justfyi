-- Submissions are the *review queue*. Approved entries are moved into the
-- `ratings` table and deleted from here, so this table only holds
-- pending/rejected rows. (`review='approved'` no longer occurs.)
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  status INTEGER NOT NULL,
  category INTEGER NOT NULL,              -- legacy: mirrors first element of `categories`
  categories TEXT NOT NULL DEFAULT '[]',  -- JSON array of category ids
  open_source INTEGER NOT NULL DEFAULT 0,
  login INTEGER NOT NULL DEFAULT 0,
  abandoned INTEGER NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
  subscription INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  note TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  review TEXT NOT NULL DEFAULT 'pending'  -- pending, rejected
);

CREATE INDEX IF NOT EXISTS idx_submissions_review ON submissions (review);
CREATE INDEX IF NOT EXISTS idx_submissions_domain ON submissions (domain);

-- Canonical catalog: one row per domain. UNIQUE(domain) makes duplicate
-- approved entries structurally impossible. Approving a submission moves
-- the data here and deletes the submission row in one transaction.
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL,
  category INTEGER NOT NULL,              -- legacy: mirrors first element of `categories`
  categories TEXT NOT NULL DEFAULT '[]',  -- JSON array of category ids
  open_source INTEGER NOT NULL DEFAULT 0,
  login INTEGER NOT NULL DEFAULT 0,
  abandoned INTEGER NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
  subscription INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  updated_at TEXT NOT NULL
);
-- No explicit index on `domain` — the UNIQUE constraint above already
-- creates one automatically.

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  subscribed_at TEXT NOT NULL
);

-- Short-lived table purely for rate limiting. Rows are purged opportunistically
-- on each request, so no PII lives here longer than ~1 hour in practice.
CREATE TABLE IF NOT EXISTS rate_limits (
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_ip_time ON rate_limits (ip, created_at);
