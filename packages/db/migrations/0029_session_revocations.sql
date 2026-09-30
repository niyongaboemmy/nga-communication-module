-- Single sign-out (nga_central_mis/docs/SINGLE_SIGN_OUT.md).
--
-- When someone signs out of NGA MIS, MIS POSTs a signed logout_token to
-- /api/sso/backchannel-logout (OIDC Back-Channel Logout). We record when that
-- user's sessions ended; the API and the realtime gateway then refuse any Tupo
-- session token issued before it. Idempotent.

CREATE TABLE IF NOT EXISTS session_revocations (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revoked_at  TIMESTAMPTZ NOT NULL
);
