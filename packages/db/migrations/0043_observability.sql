-- Monitoring without paid tools (R-03, R-04, R-05).
--
-- metric_samples: each process writes its own numbers once a minute (a push
--   model: with two API instances behind pm2, a scrape would reach a random
--   one). Kept 14 days by the worker.
-- error_events: browser and server errors, grouped by fingerprint, so a crash
--   that happens 500 times is one row with a count.
-- alert_state: one row per alert rule, so a firing alert notifies once (and
--   again every few hours while it lasts), and says when it is resolved.

CREATE TABLE IF NOT EXISTS metric_samples (
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  service  TEXT NOT NULL,              -- 'api#0', 'api#1', 'realtime', 'worker', 'files', 'system'
  metric   TEXT NOT NULL,
  value    DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS metric_samples_metric_at_idx ON metric_samples (metric, at DESC);
CREATE INDEX IF NOT EXISTS metric_samples_at_idx ON metric_samples (at);

CREATE TABLE IF NOT EXISTS error_events (
  fingerprint     TEXT PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('web', 'api', 'realtime', 'worker', 'files')),
  message         TEXT NOT NULL,
  stack           TEXT,
  route           TEXT,
  release         TEXT,
  count           INTEGER NOT NULL DEFAULT 1,
  first_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_user_id    TEXT,
  last_user_agent TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored'))
);
CREATE INDEX IF NOT EXISTS error_events_last_at_idx ON error_events (last_at DESC);

CREATE TABLE IF NOT EXISTS alert_state (
  rule              TEXT PRIMARY KEY,
  firing            BOOLEAN NOT NULL DEFAULT false,
  since             TIMESTAMPTZ,
  last_notified_at  TIMESTAMPTZ,
  detail            TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
