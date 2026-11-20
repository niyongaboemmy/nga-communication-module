#!/usr/bin/env node
/**
 * verify:mail:inbound — receiving outside email (docs/MAIL_INBOUND_PLAN_2026-11.md).
 *
 * An in-memory IMAP server (hoodiecrow) stands in for the school's mail
 * server, and the SMTP sink for its outgoing side. Against the running stack:
 *
 *   connect     a wrong password is refused; the right one is kept, encrypted,
 *               and never returned
 *   import      outside mail → Inbox (with its attachment), spam → Spam,
 *               the whole history (newest first, read state kept), Tupo's own
 *               copy → not doubled
 *   sync        idempotent; new mail arrives; a reply threads by its headers
 *   reply       from Tupo to an outsider: as the person's own address, threaded
 *               on the outsider's Message-ID; their answer comes back in
 *   capture     a reply to the relay joins the conversation; a delivery report
 *               marks the recipient bounced; a colleague replying by email is
 *               their reply (Sent for them, Inbox for the others)
 *   disconnect  the password is deleted; imported mail can be removed
 *   UI          settings connect form and status; the "via email" badge
 *
 *   npm run verify:mail:inbound    (needs `npm run dev` with the MAIL_IMAP_* /
 *                                   MAIL_REPLY_* test settings: see the plan)
 */
import { createRequire } from 'node:module';
import { createSuite, sleep, API, env } from './lib/chatSuite.mjs';
import { startSmtpSink } from './lib/smtp-sink.mjs';

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');
const { ImapFlow } = require('imapflow');

const IMAP_PORT = Number(env.MAIL_IMAP_PORT || 14143);
const DOMAIN = 'amashuri.test'; // the dev relay's MAIL_FROM domain: Tupo's own Message-IDs use it
const SHOTS = process.argv[2] ?? '.mail-inbound-visual';
const S = createSuite('verify:mail:inbound', 'vmi-');
const part = async (name, fn) => {
  S.step(name);
  try { await fn(); } catch (e) { S.check(`${name} ran`, false, String(e?.message ?? e).split('\n')[0]); }
};
const until = async (fn, ms = 40_000, every = 1000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
};
const rfc = (d) => d.toUTCString().replace('GMT', '+0000');
const mail = ({ from, to, subject, id, date = new Date(), inReplyTo, headers = '', body = 'Hello.', attach }) => {
  const head = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${id}`, `Date: ${rfc(date)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}` : '', headers, 'MIME-Version: 1.0',
  ].filter(Boolean);
  if (!attach) return `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  return `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="XX"\r\n\r\n--XX\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n--XX\r\nContent-Type: application/pdf; name="${attach.name}"\r\nContent-Disposition: attachment; filename="${attach.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(attach.bytes).toString('base64')}\r\n--XX--\r\n`;
};

let imap; let relay; let sink;
// hoodiecrow keeps one mailbox for every user, so the relay's mailbox is a
// second server (MAIL_REPLY_IMAP_PORT).
const RELAY_PORT = Number(env.MAIL_REPLY_IMAP_PORT || 14144);
// `date`: when the server received it (IMAP INTERNALDATE), which is what a
// "since" search reads, not the Date header.
const append = async (user, pass, raw, date, flags = []) => {
  const port = user === 'tupo-relay' ? RELAY_PORT : IMAP_PORT;
  const c = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user, pass }, logger: false });
  await c.connect();
  await c.append('INBOX', raw, flags, date);
  await c.logout();
};
const threads = (u, folder = 'inbox') => S.api(`/api/mail/threads?folder=${folder}`, u).then((d) => d.threads);
const findThread = (u, subject, folder = 'inbox') => threads(u, folder).then((t) => t.find((x) => x.subject === subject) ?? null);
const thread = (u, id) => S.api(`/api/mail/threads/${id}`, u).then((d) => d.thread);

try {
  await S.launch();
  // The relay test server numbers its mail from 1 on every run.
  await S.pool.query('DELETE FROM mail_reply_capture_state');
  sink = await startSmtpSink(Number(env.MAIL_ACCOUNT_SMTP_PORT || 5195));
  const ada = await S.makeUser('Ada Inbound', 'Staff');
  const bosco = await S.makeUser('Bosco Inbound', 'Staff');
  const cyn = await S.makeUser('Cyn Inbound', 'Staff');
  const PW = 'right-pw-ada';

  // Tupo's own email copy, which must not come back in twice: Bosco writes to Ada.
  const internal = await S.api('/api/mail/compose', bosco, { body: { to: [`userId:${ada.id}`], subject: `Internal note ${Date.now()}`, bodyHtml: '<p>Inside Tupo</p>' } });
  const internalSubject = (await thread(ada, internal.threadId)).subject;

  const now = Date.now();
  imap = hoodiecrow({
    plugins: ['IDLE', 'UIDPLUS', 'ENABLE', 'SPECIAL-USE', 'LITERALPLUS'],
    users: { [ada.user.email]: { password: PW } },
    storage: { INBOX: { messages: [] } },
  });
  relay = hoodiecrow({
    plugins: ['IDLE', 'UIDPLUS', 'ENABLE', 'SPECIAL-USE', 'LITERALPLUS'],
    users: { 'tupo-relay': { password: 'relaypw' } },
    storage: { INBOX: { messages: [] } },
  });
  await new Promise((r) => imap.listen(IMAP_PORT, r));
  await new Promise((r) => relay.listen(RELAY_PORT, r));
  const seed = [
    mail({ from: 'Carol Outside <carol@outside.org>', to: ada.user.email, subject: 'Outside hello', id: '<c1@outside.org>', date: new Date(now - 3600_000), body: 'Hi Ada, the brief is attached.', attach: { name: 'brief.pdf', bytes: '%PDF-1.1 test brief' } }),
    mail({ from: 'Prize Desk <win@spam.example>', to: ada.user.email, subject: 'You won', id: '<s1@spam.example>', date: new Date(now - 1800_000), headers: 'X-Spam-Flag: YES' }),
    mail({ from: 'Old Friend <old@outside.org>', to: ada.user.email, subject: 'Ancient history', id: '<o1@outside.org>', date: new Date(now - 30 * 86_400_000) }),
    mail({ from: `NGA Tupo <no-reply@${DOMAIN}>`, to: ada.user.email, subject: internalSubject, id: `<${internal.messageId}@${DOMAIN}>`, date: new Date(now - 600_000) }),
  ];
  // The old one was read in her real mailbox: it must arrive read.
  for (const raw of seed) {
    const old = raw.includes('Ancient history');
    await append(ada.user.email, PW, raw, old ? new Date(now - 30 * 86_400_000) : undefined, old ? ['\\Seen'] : []);
  }

  await part('connect: wrong password refused, right one kept encrypted', async () => {
    const s0 = await S.api('/api/mail/account', ada);
    S.check('the server offers connecting', s0.settings.available === true && s0.settings.account === null, JSON.stringify(s0.settings).slice(0, 120));
    const bad = await fetch(`${API}/api/mail/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ address: ada.user.email, password: 'nope' }) });
    const badBody = await bad.json();
    S.check('a wrong password is refused, in words', bad.status === 400 && /not right/i.test(badBody.message ?? ''), `${bad.status} ${badBody.message}`);
    const noRow = await S.pool.query('SELECT 1 FROM mail_accounts WHERE user_id = $1', [ada.id]);
    S.check('nothing is stored after a refusal', noRow.rows.length === 0);
    const res = await fetch(`${API}/api/mail/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ address: ada.user.email, password: PW, sendAs: true }) });
    const text = await res.text();
    S.check('the right password connects', res.ok, text.slice(0, 160));
    S.check('the reply never carries the password', !text.includes(PW) && !/secret/i.test(text));
    const row = (await S.pool.query('SELECT secret_enc, send_as, smtp_host FROM mail_accounts WHERE user_id = $1', [ada.id])).rows[0];
    S.check('stored encrypted, not as typed', row && row.secret_enc.startsWith('v1:') && !row.secret_enc.includes(PW));
    S.check('sending as her address is on (SMTP login checked)', row?.send_as === true && Boolean(row?.smtp_host));
  });

  await part('import: inbox, attachment, spam, whole history, no doubles', async () => {
    const t = await until(() => findThread(ada, 'Outside hello'));
    S.check('outside mail arrives in the Inbox', Boolean(t));
    // The first sync works through the whole mailbox: wait for it to finish.
    await until(async () => (await S.pool.query('SELECT last_sync_at FROM mail_accounts WHERE user_id = $1', [ada.id])).rows[0]?.last_sync_at, 30_000);
    if (!t) return;
    const view = await thread(ada, t.threadId);
    const m = view.messages[0];
    S.check('it is from the outside sender, marked as email', m.from.address === 'carol@outside.org' && m.from.userId === null && m.source === 'imap', `${m.from.address} ${m.source}`);
    S.check('the body came through', /brief is attached/.test(m.bodyText));
    const att = m.attachments[0];
    const dbAtt = (await S.pool.query(`SELECT f.status, f.size_bytes FROM mail_attachments a JOIN files f ON f.id = a.file_id WHERE a.message_id = $1`, [m.id])).rows;
    S.check('its attachment is kept', att?.name === 'brief.pdf', `${att?.name} db=${JSON.stringify(dbAtt)} has=${m.attachments.length}`);
    if (att) {
      const f = await fetch(`${API.replace('5190', '5192')}/api/files/${att.fileId}/content`, { headers: { Authorization: `Bearer ${ada.token}` } });
      S.check('and opens with its bytes', f.ok && (await f.text()).includes('%PDF-1.1 test brief'), `HTTP ${f.status}`);
    }
    const spamRows = (await S.pool.query(`SELECT r.folder, r.channel FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id WHERE m.subject = 'You won' AND r.user_id = $1`, [ada.id])).rows;
    S.check('spam goes to Spam', Boolean(await findThread(ada, 'You won', 'spam')) && !(await findThread(ada, 'You won')), JSON.stringify(spamRows));
    const ancient = await until(() => findThread(ada, 'Ancient history'), 30_000);
    S.check('older mail is brought in too (the whole history)', Boolean(ancient));
    S.check('mail already read in the mailbox arrives read; new mail unread',
      ancient?.unread === false && t.unread === true, `ancient.unread=${ancient?.unread} new.unread=${t.unread}`);
    const acct = (await until(async () => { const r = (await S.pool.query('SELECT history_done, history_seen, mailbox_total FROM mail_accounts WHERE user_id = $1', [ada.id])).rows[0]; return r?.history_done ? r : null; }, 30_000));
    S.check('the history import finishes and counts the mailbox', acct?.history_done === true && acct.mailbox_total === 4 && acct.history_seen === 4, JSON.stringify(acct));
    // Everything seeded before connecting is history.
    const notes = (await S.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'mail.received' AND (title LIKE '%Ancient history%' OR title LIKE '%Outside hello%')`, [ada.id])).rows[0].n;
    S.check('history arrives quietly (no notifications)', notes === 0, `notifications=${notes}`);
    const internalThreads = (await threads(ada)).filter((x) => x.subject === internalSubject);
    S.check("Tupo's own email copy is not imported twice", internalThreads.length === 1 && internalThreads[0].messageCount === 1, JSON.stringify(internalThreads.map((x) => x.messageCount)));
  });

  let carolThread;
  await part('sync: idempotent, new mail, threading by headers', async () => {
    const before = (await S.pool.query('SELECT imported_count FROM mail_accounts WHERE user_id = $1', [ada.id])).rows[0].imported_count;
    await S.api('/api/mail/account/sync', ada, { body: {} });
    await sleep(4000);
    const after = (await S.pool.query('SELECT imported_count FROM mail_accounts WHERE user_id = $1', [ada.id])).rows[0].imported_count;
    S.check('syncing again imports nothing new', after === before, `${before} → ${after}`);
    await append(ada.user.email, PW, mail({ from: 'Carol Outside <carol@outside.org>', to: ada.user.email, subject: 'Re: Outside hello', id: '<c2@outside.org>', inReplyTo: '<c1@outside.org>', body: 'One more thing.' }));
    await S.api('/api/mail/account/sync', ada, { body: {} });
    carolThread = await until(async () => { const t = await findThread(ada, 'Outside hello'); return t && t.messageCount === 2 ? t : null; }, 30_000);
    S.check('a follow-up joins the same conversation', Boolean(carolThread), carolThread ? '' : JSON.stringify((await threads(ada)).map((x) => [x.subject, x.messageCount])));
  });

  await part('reply: as her own address, threaded; the answer comes back', async () => {
    if (!carolThread) return S.check('needs the thread', false);
    const view = await thread(ada, carolThread.threadId);
    const last = view.messages[view.messages.length - 1];
    const n = sink.received.length;
    const sent = await S.api('/api/mail/compose', ada, { body: { to: ['carol@outside.org'], subject: 'Re: Outside hello', bodyHtml: '<p>Thanks Carol</p>', threadId: carolThread.threadId, parentId: last.id, kind: 'reply' } });
    const got = await until(async () => sink.received.slice(n).find((m) => m.to.includes('carol@outside.org')), 30_000);
    S.check('the reply goes out to the outsider', Boolean(got));
    if (got) {
      S.check('as her own address, with her login', new RegExp(`^From:.*${ada.user.email}`, 'mi').test(got.data) && got.auth === ada.user.email, `auth=${got.auth}`);
      S.check("threaded on the outsider's Message-ID", /^In-Reply-To:\s*<c2@outside\.org>/mi.test(got.data), (got.data.match(/^In-Reply-To:.*$/mi) ?? [''])[0]);
    }
    await append(ada.user.email, PW, mail({ from: 'Carol Outside <carol@outside.org>', to: ada.user.email, subject: 'Re: Outside hello', id: '<c3@outside.org>', inReplyTo: `<${sent.messageId}@${DOMAIN}>`, body: 'You are welcome.' }));
    await S.api('/api/mail/account/sync', ada, { body: {} });
    // Replying renamed the conversation "Re: …": found by its id.
    const back = await until(async () => { const t = await thread(ada, carolThread.threadId); return t.messages.length === 4 ? t : null; }, 30_000);
    S.check('her answer to the Tupo reply joins the conversation', Boolean(back), back ? '' : JSON.stringify((await S.pool.query(`SELECT m.subject, m.thread_id = $2 AS same, m.source FROM mail_messages m JOIN mail_recipients r ON r.message_id = m.id WHERE r.user_id = $1 ORDER BY m.created_at DESC LIMIT 4`, [ada.id, carolThread.threadId])).rows));
  });

  await part('capture: replies to the relay, bounces, reply by email', async () => {
    // The capture sweep starts at the newest message: wait for its first run.
    const ready = await until(async () => (await S.pool.query('SELECT last_sync_at FROM mail_reply_capture_state')).rows[0]?.last_sync_at, 40_000);
    S.check('the relay mailbox is being read', Boolean(ready));
    const n = sink.received.length;
    const m = await S.api('/api/mail/compose', bosco, { body: { to: ['dave@outside.org', 'gone@nowhere.example'], subject: `Trip forms ${Date.now()}`, bodyHtml: '<p>Please sign</p>' } });
    const out = await until(async () => sink.received.slice(n).find((x) => x.to.includes('dave@outside.org')), 30_000);
    S.check('without a connected mailbox, replies are sent to the relay', Boolean(out) && /^Reply-To:.*no-reply@amashuri\.test/mi.test(out.data), out ? (out.data.match(/^Reply-To:.*$/mi) ?? [''])[0] : 'not sent');
    await until(async () => (await S.pool.query(`SELECT 1 FROM mail_recipients WHERE message_id = $1 AND address = 'gone@nowhere.example' AND delivery_status = 'delivered'`, [m.messageId])).rows.length, 20_000);
    await append('tupo-relay', 'relaypw', mail({ from: 'Dave Outside <dave@outside.org>', to: 'no-reply@amashuri.test', subject: 'Re: Trip forms', id: '<d1@outside.org>', inReplyTo: `<${m.messageId}@${DOMAIN}>`, body: 'Signed and sent back.' }));
    const dsn = [
      'From: Mail Delivery System <MAILER-DAEMON@relay.test>', 'To: no-reply@amashuri.test', 'Subject: Undelivered Mail Returned to Sender',
      `Message-ID: <dsn${Date.now()}@relay.test>`, `Date: ${rfc(new Date())}`, 'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '',
      '--B', 'Content-Type: text/plain', '', 'Your message could not be delivered.', '',
      '--B', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; relay.test', '',
      'Final-Recipient: rfc822; gone@nowhere.example', 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 User unknown', '',
      '--B', 'Content-Type: text/rfc822-headers', '', `Message-ID: <${m.messageId}@${DOMAIN}>`, '', '--B--', '',
    ].join('\r\n');
    await append('tupo-relay', 'relaypw', dsn);
    const joined = await until(async () => { const t = await thread(bosco, m.threadId); return t.messages.length === 2 ? t : null; }, 45_000);
    S.check("the outsider's reply joins Bosco's conversation", Boolean(joined) && joined.messages[1].source === 'reply' && joined.messages[1].from.address === 'dave@outside.org');
    const bounced = await until(async () => (await S.pool.query(`SELECT delivery_status FROM mail_recipients WHERE message_id = $1 AND address = 'gone@nowhere.example'`, [m.messageId])).rows[0]?.delivery_status === 'bounced', 30_000);
    S.check('a delivery report marks that recipient bounced', Boolean(bounced));

    // Cyn (no mailbox connected) gets a Tupo mail and replies to its email copy.
    const m2 = await S.api('/api/mail/compose', bosco, { body: { to: [`userId:${cyn.id}`], subject: `Staff lunch ${Date.now()}`, bodyHtml: '<p>Friday?</p>' } });
    await append('tupo-relay', 'relaypw', mail({ from: `Cyn Inbound <${cyn.user.email}>`, to: 'no-reply@amashuri.test', subject: 'Re: Staff lunch', id: `<cy${Date.now()}@mail.example>`, inReplyTo: `<${m2.messageId}@${DOMAIN}>`, body: 'Friday works for me.' }));
    const lunch = await until(async () => { const t = await thread(bosco, m2.threadId); return t.messages.length === 2 ? t : null; }, 45_000);
    S.check('a colleague replying by email is their reply', Boolean(lunch) && lunch.messages[1].from.userId === cyn.id, lunch ? JSON.stringify(lunch.messages.map((x) => [x.from.userId, x.from.address, x.source])) : 'not joined');
    if (lunch) {
      const sentList = await threads(cyn, 'sent');
      S.check('it is in their Sent, and in Bosco\'s Inbox', sentList.some((x) => x.threadId === m2.threadId) && (await threads(bosco)).some((x) => x.threadId === m2.threadId));
    }
  });

  await part('UI: settings status and the via-email badge', async () => {
    const { page } = await S.openAs(ada, null);
    const base = page.url().split('/app/')[0];
    await page.goto(`${base}/app/mail/settings`, { waitUntil: 'domcontentloaded' });
    const box = page.getByTestId('connected-mailbox');
    S.check('settings show the connected mailbox', await box.getByTestId('mailbox-address').waitFor({ timeout: 15_000 }).then(async () => (await box.getByTestId('mailbox-address').innerText()) === ada.user.email).catch(() => false));
    S.check('with its last check and count', /Checked .* · \d+ imported/.test(await box.getByTestId('mailbox-status').innerText().catch(() => '')));
    await page.screenshot({ path: `${SHOTS}/settings-connected.png` });
    if (carolThread) {
      await page.goto(`${base}/app/mail/t/${carolThread.threadId}`, { waitUntil: 'domcontentloaded' });
      S.check('imported mail is marked "via email"', await page.getByText('via email').first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
      await page.screenshot({ path: `${SHOTS}/thread-via-email.png` });
    }
    const fresh = await S.openAs(bosco, null);
    await fresh.page.goto(`${base}/app/mail/settings`, { waitUntil: 'domcontentloaded' });
    const form = fresh.page.getByRole('form', { name: 'Connect your school mailbox' });
    S.check('someone not connected sees the connect form', await form.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
    await fresh.page.getByLabel('Email password').fill('nope');
    await fresh.page.getByRole('button', { name: /Connect mailbox/ }).click();
    S.check('a wrong password is explained in the form', await fresh.page.getByRole('alert').filter({ hasText: /not right/i }).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
    await fresh.page.screenshot({ path: `${SHOTS}/settings-connect-error.png` });
  });

  await part('disconnect: password deleted, imported mail removable', async () => {
    const r = await fetch(`${API}/api/mail/account?purge=1`, { method: 'DELETE', headers: { Authorization: `Bearer ${ada.token}` } });
    S.check('disconnect works', r.ok);
    S.check('the saved password is gone', (await S.pool.query('SELECT 1 FROM mail_accounts WHERE user_id = $1', [ada.id])).rows.length === 0);
    const left = (await S.pool.query(`SELECT count(*)::int n FROM mail_messages WHERE source = 'imap' AND metadata->>'importedFor' = $1`, [ada.id])).rows[0].n;
    S.check('imported mail is removed when asked', left === 0 && !(await findThread(ada, 'You won', 'spam')), `${left} left`);
    S.check('Tupo mail stays', Boolean(await findThread(ada, internalSubject)));
  });
} catch (e) {
  S.check('suite ran to the end', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
  await new Promise((r) => (imap ? imap.close(r) : r()));
  await new Promise((r) => (relay ? relay.close(r) : r()));
  await sink?.close();
  await S.finish();
}
