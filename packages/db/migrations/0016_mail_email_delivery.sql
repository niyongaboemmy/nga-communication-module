-- Mail — deliver internal mail to real inboxes too.
--
-- FR-MAIL-9 made in-app the *only* delivery for someone who has a Tupo
-- account, to avoid an SMTP bill. Institutions that want mail to also land in
-- Gmail / Outlook the normal way turn that on with `MAIL_INTERNAL_EMAIL=on`
-- (read by both tupo-api and tupo-worker). When it is on, every internal
-- recipient with a real address gets an `smtp` delivery row alongside the
-- in-app one — unless they have explicitly opted out in mail settings.
--
-- The per-user switch stays in `mail_prefs.email_copies`; its meaning is now
-- "follow the instance default" when NULL (no row), opt-in when true, opt-out
-- when false. The column default flips to true so a user who opens mail
-- settings and saves without touching it keeps getting email copies.
--
-- Idempotent.

ALTER TABLE mail_prefs ALTER COLUMN email_copies SET DEFAULT true;

COMMENT ON COLUMN mail_prefs.email_copies IS
  'Whether this user also receives a real SMTP email for mail addressed to them. '
  'NULL (no row) = follow the MAIL_INTERNAL_EMAIL instance default.';
