# Tupo Mail: the crash, and receiving outside email

**Date:** 19 November 2026
**Branch:** `feat/mail-inbound`

## 1. The crash ("Something went wrong in this screen")

**Symptom:** opening Mail in production showed the error panel for everyone. It never happened under the dev server, so no test caught it.

**Cause:** a cycle between two production chunks.
- The `editor` chunk (TipTap/ProseMirror) imported small ProseMirror helpers (`rope-sequence`, `orderedmap`, `w3c-keyname`) from the `mail` chunk.
- The `mail` chunk imports `editor`.
- When Mail opened, `editor` ran first and `prosemirror-history` read `RopeSequence.empty` from a module that had not run yet: `Cannot read properties of undefined (reading 'empty')`.

**Fix:**
- The `editor` chunk group now holds ProseMirror's own dependencies.
- `check:bundle` (run in CI) fails the build on any chunk cycle. It found two more latent cycles, between `chat-view` and its lazy facades, which are fixed by grouping four chat helpers.

**Also fixed:** the four mail verify suites had been dead since multi-tenancy (users inserted without a tenant). They run again: 42, 18, 10 and 14 checks.

## 2. Receiving outside email

Today Tupo Mail only sends. Real email goes out through the school's server (`mail.hackflix.net`, the relay `mis@nga.ac.rw`) with `Reply-To` set to the sender. So:
- An outsider's reply lands in the sender's own mailbox, never in Tupo.
- Mail people get from outside never appears in Tupo.

The server speaks IMAP over TLS on port 993, the standard way for software to read a mailbox. Two techniques use it.

### 2.1 Connect your school mailbox (per person)

In Mail settings, a person connects their own `@nga.ac.rw` mailbox with its email password.

**Connecting:**
- Tupo logs in over IMAP to check the password before saving anything, and checks SMTP too.
- The password is stored encrypted with AES-256-GCM. The key, `MAIL_ACCOUNT_KEY`, is generated on the server by `deploy-setup.sh` and is never in git.
- Only the school's own mail server is accepted (`MAIL_IMAP_HOST`, defaulting to the relay host). A person cannot point Tupo at an arbitrary or internal host.

**Syncing:**
- The worker reads the INBOX every minute, **read-only** (`EXAMINE`). Tupo never deletes, moves or marks anything in the person's real mailbox.
- It continues from the last UID seen, and restarts cleanly when the server's `UIDVALIDITY` changes.
- The first sync brings in the last 14 days, up to 200 messages.

**Each message becomes Tupo mail:**
- A thread in the person's Inbox, from the outside sender (no Tupo account needed). Messages the server flags as spam go to Spam.
- Attachments are stored in tupo-files, like any mail attachment.
- HTML goes through the same sanitiser as all mail.
- Threading uses `In-Reply-To` and `References`, so a reply to a Tupo message joins that conversation.
- Duplicates are skipped: once per person per `Message-ID`, and Tupo's own email copies (`MAIL_INTERNAL_EMAIL=on`) are recognised by Tupo's own Message-ID and never imported twice.

**Replying:**
- Uses the ordinary composer. The outside address becomes an SMTP recipient.
- With "Send from my address" on, mail goes out through the person's own account, so the outsider sees their real address and replies land in their mailbox, and from there back in Tupo.
- If the person's account fails to send, Tupo falls back to the relay.

**Status:** the settings show the connection state, the last sync and the last error, with Sync now and Disconnect. Disconnecting deletes the credentials; imported mail stays unless they choose to remove it.

### 2.2 Shared reply capture (opt-in, for people who have not connected)

Turned on with `MAIL_REPLY_CAPTURE=on`, using the relay's own mailbox (`SMTP_USER`/`SMTP_PASS`, or `MAIL_REPLY_IMAP_USER`/`MAIL_REPLY_IMAP_PASS`).

**What changes:**
- Mail from people without a connected mailbox carries `Reply-To: "<Name> via Tupo" <relay address>`.
- The worker reads that mailbox read-only and matches each message's `In-Reply-To`/`References` to the Tupo message it answers. The reply is then delivered into that conversation to the Tupo people on it.
- Unmatched mail is left alone.

**Bounces:** delivery reports (`multipart/report`) that name a Tupo message mark that recipient **bounced**, so the sender's delivery sheet tells the truth.

**Why it is off by default:** the mailbox is shared with the MIS, and turning it on changes where outsiders' replies go. That is the school's decision.

## 3. Tests

- **Unit tests:** header parsing, thread-id extraction, encryption round trip, host policy.
- **`verify:mail:inbound`:** an in-memory IMAP server plus the SMTP sink, against the running stack:
  - Connect: a wrong password is refused; the right one is saved, with no password in the API reply.
  - The sync imports the inbox, so the message shows in the list and the thread, with its attachment.
  - Sync is idempotent; a new message arrives on the next sync; spam lands in Spam.
  - A reply to an imported message goes to the outside sender, and sends as the person.
  - An outside reply to a Tupo message joins the thread (personal and shared capture).
  - A bounce marks the recipient bounced.
  - Tupo's own copies are not imported.
  - Disconnect deletes the credentials.
- **UI:** the settings flow in Chromium.

## 4. Status (19 November 2026)

All of the above is implemented. The crash fix is on its own branch (`fix/mail-editor-chunk-cycle`) so it can ship first; the inbound work builds on it (`feat/mail-inbound`).

**Production settings**, all made by `deploy-setup.sh` on the next deploy:
- `MAIL_ACCOUNT_KEY` is generated for the api and the worker.
- `MAIL_IMAP_HOST` is copied from the relay's `SMTP_HOST`.
- `MAIL_ACCOUNT_DOMAIN` is copied from the domain in `MAIL_FROM`.

Shared reply capture stays off until `MAIL_REPLY_CAPTURE=on` is added to both `apps/api/.env` and `apps/worker/.env`.

**Test results:**
- **New suite:** `verify:mail:inbound` 36/36.
- **Existing mail suites:** `verify:mail` 42/42, `verify:mail:power` 18/18, `verify:mail:campaigns` 10/10, `verify:mail:ui` 14/14.
- **Unit and API tests:** `@tupo/mail` unit tests 48/48. API suite 804/804 under CI settings; locally, without retries, a few known timing-sensitive files fail in a different place each run.
- **Web:** web unit tests 31/31.
- **Build checks:** typecheck clean; `check:bundle` finds no chunk cycles, initial JS 203.2 KB.

**Found while testing:**
- An IMAP "since" search reads the date the server received the mail, not the Date header. The two-week window follows arrival, as mail apps do.
- A reply whose Date header is earlier than the message it answers (whole seconds, or clock drift) used to sort above that message. It is now placed after it.
- Attachments are stored before the message, so an imported email never shows without them.
- A reply to an outside email now names that email's own Message-ID in `In-Reply-To`/`References`. It used to name only Tupo's ids, so the outsider's mail app could not thread it.
