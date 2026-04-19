CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  status INTEGER NOT NULL,
  category INTEGER NOT NULL,
  open_source INTEGER NOT NULL DEFAULT 0,
  login INTEGER NOT NULL DEFAULT 0,
  abandoned INTEGER NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  note TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  review TEXT NOT NULL DEFAULT 'pending'  -- pending, approved, rejected
);

CREATE INDEX IF NOT EXISTS idx_submissions_review ON submissions (review);
CREATE INDEX IF NOT EXISTS idx_submissions_domain ON submissions (domain);

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
