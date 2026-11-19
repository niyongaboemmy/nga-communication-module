-- Being replied to, and a phone gesture (chat experience plan, Phase 6).
--
--   notify_replies   a quote reply to your message reaches you like a mention
--                    (badge, notification, push: "Claire replied to you")
--                    — R-09. On by default; the person can turn it off.
--   double_tap_like  double-tap a message on a phone to add 👍 — C-02/6.2.
--                    On by default.

ALTER TABLE user_chat_prefs ADD COLUMN IF NOT EXISTS notify_replies  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE user_chat_prefs ADD COLUMN IF NOT EXISTS double_tap_like BOOLEAN NOT NULL DEFAULT true;
