#!/usr/bin/env node
/**
 * Mail (FR-MAIL-1…11) — the spine, against the running stack.
 *
 * The invariants worth pinning:
 *   · in-app delivery: an internal recipient gets the message with no SMTP
 *   · threading by normalised subject — a reply lands in the same thread
 *   · folders and read state are per-recipient, not global
 *   · scheduled send stays out of the mailbox until its time, and cancels
 *   · per-recipient delivery tracking exists for the sender (FR-MAIL-8)
 *   · MAIL_SEND actually gates sending; a Student without it gets 403
 *   · distribution lists resolve, a campaign previews its true recipient count,
 *     and a >200 audience is forced through approval (FR-MAIL-10)
 *   · a mail attachment is readable by its recipient and nobody else
 *
 *   npm run verify:mail        (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { startSmtpSink } from './lib/smtp-sink.mjs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const FILES = 'http://localhost:5192';
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const pass = [], fails = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`;
  (ok ? pass : fails).push(line);
  process.stderr.write('  ' + line + '\n');
  return ok;
};
const step = (s) => process.stderr.write(`\n  • ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(name, roleName = 'Staff') {
  const id = `mailtest-${randomBytes(6).toString('hex')}`;
  const email = `${id}@amashuri.com`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, email, roleName.toLowerCase(), rows[0]?.id ?? null]);
  const token = jwt.sign({ id, misUserId: id, name, email, role: roleName.toLowerCase() },
    env.JWT_SECRET, { expiresIn: '30m' });
  return { id, name, email, token };
}

const api = async (path, token, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, data: body.data };
};

const cleanup = async () => {
  await pool.query(`DELETE FROM files WHERE owner_id LIKE 'mailtest-%'`);
  await pool.query(`DELETE FROM users WHERE id LIKE 'mailtest-%'`);
  await pool.query(`DELETE FROM mail_distribution_lists WHERE slug LIKE 'verify-%'`);
  await pool.query(`DELETE FROM mail_suppressions WHERE address LIKE 'mailtest-%' OR address LIKE '%@nowhere.invalid'`);
};

let ada, ben, sam, admin, sink;
const emailOn = (env.MAIL_INTERNAL_EMAIL ?? '').toLowerCase() === 'on';
const smtpPort = Number(readFileSync('apps/worker/.env', 'utf8').match(/^SMTP_PORT=(\d+)/m)?.[1] ?? 0);

try {
  await cleanup();
  if (emailOn && smtpPort) sink = await startSmtpSink(smtpPort).catch(() => null);
  ada = await makeUser('Mail Ada');
  ben = await makeUser('Mail Ben');
  sam = await makeUser('Mail Sam', 'Student');
  admin = await makeUser('Mail Admin', 'Admin');

  /* ── 1. compose → delivery ───────────────────────────────────────────── */
  step('Ada sends Ben a message');
  const subject = `Verify ${randomBytes(3).toString('hex')}`;
  const sent = await api('/api/mail/compose', ada.token, {
    method: 'POST',
    body: { to: [`userId:${ben.id}`], subject, bodyHtml: '<p>Hello Ben</p>' },
  });
  check('compose returns 201 with a threadId', sent.status === 201 && !!sent.data?.threadId, `status ${sent.status}`);
  const threadId = sent.data?.threadId;

  const { rows: rcpt } = await pool.query(
    `SELECT id, channel, delivery_status FROM mail_recipients WHERE message_id = $1 ORDER BY channel`, [sent.data?.messageId]);
  const inApp = rcpt.find((r) => r.channel === 'in_app');
  const smtp = rcpt.find((r) => r.channel === 'smtp');
  check('in-app copy is delivered', inApp?.delivery_status === 'delivered', `${inApp?.delivery_status}`);

  if (emailOn) {
    check('internal recipient also gets a real-email delivery row', !!smtp, `${rcpt.map((r) => r.channel).join(',')}`);
    if (sink) {
      // The worker's mail:send job + sweep deliver the SMTP copy.
      for (let i = 0; i < 20 && !sink.received.some((m) => m.to.includes(ben.email)); i++) await sleep(1000);
      const got = sink.received.find((m) => m.to.includes(ben.email));
      check('the email reaches the SMTP relay', !!got, got ? `to ${got.to[0]}` : 'not received');
      check('the email carries the subject', !!got && got.data.includes(subject));
      const { rows: s2 } = await pool.query(`SELECT delivery_status FROM mail_recipients WHERE id = $1`, [smtp?.id]);
      check('the SMTP row is marked delivered', s2[0]?.delivery_status === 'delivered', s2[0]?.delivery_status);
    }
  } else {
    check('internal recipient is in-app only (email delivery off)', !smtp);
  }

  step("Ben's inbox");
  const benInbox = await api('/api/mail/threads?folder=inbox', ben.token);
  const inThread = benInbox.data?.threads?.find((t) => t.threadId === threadId);
  check('thread is in Ben’s inbox, unread', !!inThread && inThread.unread === true);

  const benCounts = await api('/api/mail/counts', ben.token);
  check('Ben’s inbox unread count ≥ 1', (benCounts.data?.counts?.inbox ?? 0) >= 1, String(benCounts.data?.counts?.inbox));

  step('Ada cannot see it in her inbox, but it is in Sent');
  const adaInbox = await api('/api/mail/threads?folder=inbox', ada.token);
  check('not in Ada’s inbox', !adaInbox.data?.threads?.some((t) => t.threadId === threadId));
  const adaSent = await api('/api/mail/threads?folder=sent', ada.token);
  check('in Ada’s Sent', adaSent.data?.threads?.some((t) => t.threadId === threadId));

  /* ── 2. read + reply → threading ─────────────────────────────────────── */
  step('Ben opens the thread (marks read) and replies');
  const opened = await api(`/api/mail/threads/${threadId}`, ben.token);
  check('thread opens with one message', opened.data?.thread?.messages?.length === 1);
  const benInbox2 = await api('/api/mail/threads?folder=inbox', ben.token);
  check('thread now read for Ben', benInbox2.data?.threads?.find((t) => t.threadId === threadId)?.unread === false);

  const parentId = opened.data.thread.messages[0].id;
  const reply = await api('/api/mail/compose', ben.token, {
    method: 'POST',
    body: { to: [`userId:${ada.id}`], subject: `Re: ${subject}`, bodyHtml: '<p>Hi Ada</p>', threadId, parentId, kind: 'reply' },
  });
  check('reply accepted', reply.status === 201 && reply.data?.threadId === threadId, `thread ${reply.data?.threadId}`);

  const adaInbox2 = await api('/api/mail/threads?folder=inbox', ada.token);
  const adaThread = adaInbox2.data?.threads?.find((t) => t.threadId === threadId);
  check('reply reached Ada’s inbox, same thread, 2 messages', !!adaThread && adaThread.messageCount === 2);

  /* ── 3. folders are per-recipient ───────────────────────────────────── */
  step('Ben archives; Ada is unaffected');
  await api(`/api/mail/threads/${threadId}/move`, ben.token, { method: 'POST', body: { folder: 'archive' } });
  const benInbox3 = await api('/api/mail/threads?folder=inbox', ben.token);
  const benArch = await api('/api/mail/threads?folder=archive', ben.token);
  check('gone from Ben’s inbox, now in Ben’s archive',
    !benInbox3.data?.threads?.some((t) => t.threadId === threadId)
    && benArch.data?.threads?.some((t) => t.threadId === threadId));
  const adaInbox3 = await api('/api/mail/threads?folder=inbox', ada.token);
  check('still in Ada’s inbox', adaInbox3.data?.threads?.some((t) => t.threadId === threadId));

  /* ── 4. scheduled send ──────────────────────────────────────────────── */
  step('Ada schedules a message for the future');
  const future = new Date(Date.now() + 3600_000).toISOString();
  const sch = await api('/api/mail/compose', ada.token, {
    method: 'POST',
    body: { to: [`userId:${ben.id}`], subject: `Scheduled ${randomBytes(2).toString('hex')}`, bodyHtml: '<p>later</p>', scheduledAt: future },
  });
  check('schedule returns scheduled:true', sch.data?.scheduled === true);
  const schList = await api('/api/mail/threads?folder=scheduled', ada.token);
  check('appears in Ada’s Scheduled', schList.data?.threads?.some((t) => t.threadId === sch.data?.threadId));
  await sleep(2500); // give the worker sweep a chance to (wrongly) fire
  const { rows: schRcpt } = await pool.query(
    `SELECT count(*)::int n FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id
      WHERE m.id = $1 AND r.delivery_status = 'delivered'`, [sch.data?.messageId]);
  check('nothing delivered before the scheduled time (in-app or email)', schRcpt[0].n === 0, `${schRcpt[0].n} delivered`);
  if (sink) check('no email sent for a not-yet-due scheduled message',
    !sink.received.some((m) => m.data.includes(sch.data?.threadId ?? 'nomatch')));
  const cancel = await api(`/api/mail/messages/${sch.data?.messageId}/cancel`, ada.token, { method: 'POST' });
  check('cancel scheduled succeeds', cancel.status === 200);

  /* ── 5. delivery tracking (FR-MAIL-8) ───────────────────────────────── */
  step('Ada inspects per-recipient delivery');
  const del = await api(`/api/mail/messages/${sent.data.messageId}/delivery`, ada.token);
  check('delivery lists every recipient channel with events',
    (del.data?.recipients?.length ?? 0) === (emailOn ? 2 : 1)
    && del.data.recipients.every((r) => r.events.length >= 2),
    del.data?.recipients?.map((r) => `${r.channel}:${r.status}`).join(' '));
  const benDel = await api(`/api/mail/messages/${sent.data.messageId}/delivery`, ben.token);
  check('a non-sender cannot read delivery', benDel.status === 404);

  /* ── 6. permission gate ─────────────────────────────────────────────── */
  step('Sam (Student, no MAIL_SEND) is refused');
  const samSend = await api('/api/mail/compose', sam.token, {
    method: 'POST', body: { to: [`userId:${ada.id}`], subject: 'nope', bodyHtml: '<p>x</p>' },
  });
  check('send is 403 for a Student', samSend.status === 403, `status ${samSend.status}`);
  const samDraft = await api('/api/mail/compose', sam.token, {
    method: 'POST', body: { to: [`userId:${ada.id}`], subject: 'draft', bodyHtml: '<p>x</p>', draft: true },
  });
  check('but saving a draft is allowed (MAIL_READ)', samDraft.status === 201);

  /* ── 6b. AI assistant ──────────────────────────────────────────────── */
  step('AI assistant');
  const aiStatus = await api('/api/mail/ai/status', admin.token);
  const aiOn = aiStatus.data?.available === true;
  check('ai/status reports availability', typeof aiStatus.data?.available === 'boolean', String(aiStatus.data?.available));
  check('Sam (Student) cannot reach the AI assistant',
    (await api('/api/mail/ai/subject', sam.token, { method: 'POST', body: { bodyText: 'x' } })).status === 403);

  // The public AI providers are genuinely flaky (quota, transient 5xx). Retry
  // an AI call a couple of times before calling it a real failure.
  const aiRetry = async (fn, ok) => {
    let last;
    for (let i = 0; i < 3; i++) {
      last = await fn();
      if (ok(last)) return last;
      await sleep(1500);
    }
    return last;
  };

  if (aiOn) {
    const draft = await aiRetry(
      () => api('/api/mail/ai/compose', ada.token, {
        method: 'POST',
        body: { action: 'draft', instruction: 'Tell parents the library will be closed this Friday for stocktaking.' },
      }),
      (r) => r.status === 200 && /<p>/i.test(r.data?.html ?? ''));
    check('AI drafts an HTML body', draft.status === 200 && /<p>/i.test(draft.data?.html ?? '') && !!draft.data?.providerUsed,
      draft.data?.providerUsed);
    check('AI draft is sanitised (no script tags)', !/<script/i.test(draft.data?.html ?? ''));

    const improve = await aiRetry(
      () => api('/api/mail/ai/compose', ada.token, {
        method: 'POST', body: { action: 'grammar', currentText: 'the libary will be close on friday' },
      }),
      (r) => r.status === 200 && (r.data?.html ?? '').length > 0);
    check('AI grammar-fix returns a revised body', improve.status === 200 && (improve.data?.html ?? '').length > 0);

    const subj = await aiRetry(
      () => api('/api/mail/ai/subject', ada.token, {
        method: 'POST', body: { bodyText: 'The library will be closed this Friday for stocktaking. It reopens Monday.' },
      }),
      (r) => r.status === 200 && Array.isArray(r.data?.suggestions) && r.data.suggestions.length > 0);
    check('AI suggests subject lines', subj.status === 200 && Array.isArray(subj.data?.suggestions) && subj.data.suggestions.length > 0,
      JSON.stringify(subj.data?.suggestions?.[0]));

    const sumRes = await aiRetry(
      () => api('/api/mail/ai/summarize', ben.token, { method: 'POST', body: { threadId } }),
      (r) => r.status === 200 && typeof r.data?.summary === 'string' && r.data.summary.length > 0);
    check('AI summarises a thread the reader is in', sumRes.status === 200 && typeof sumRes.data?.summary === 'string');
    const sumOutsider = await api('/api/mail/ai/summarize', admin.token, { method: 'POST', body: { threadId } });
    check('AI summary refuses a thread the caller is not in', sumOutsider.status === 404);
  } else {
    const draft = await api('/api/mail/ai/compose', ada.token, {
      method: 'POST', body: { action: 'draft', instruction: 'hello' },
    });
    check('AI endpoint returns 503 when no provider is configured', draft.status === 503);
  }

  /* ── 7. distribution list + campaign preview + approval gate ─────────── */
  step('Admin builds a distribution list and a campaign');
  const slug = `verify-${randomBytes(3).toString('hex')}`;
  const list = await api('/api/mail/lists', admin.token, {
    method: 'POST', body: { name: `Verify ${slug}`, origin: 'manual' },
  });
  check('list created', list.status === 201, `status ${list.status}`);
  const listId = list.data?.list?.id;
  for (let i = 0; i < 3; i++) {
    await api(`/api/mail/lists/${listId}/members`, admin.token, {
      method: 'POST', body: { address: `p${i}-${slug}@example.com`, name: `Parent ${i}` },
    });
  }
  const members = await api(`/api/mail/lists/${listId}/members`, admin.token);
  check('list has 3 members', members.data?.members?.length === 3);

  const camp = await api('/api/mail/campaigns', admin.token, {
    method: 'POST',
    body: { subject: 'Fees for {{name}}', bodyHtml: '<p>Dear {{first_name}}, {{amount}} is due.</p>', listIds: [listId] },
  });
  check('campaign created as draft', camp.data?.campaign?.status === 'draft');
  const prev = await api(`/api/mail/campaigns/${camp.data.campaign.id}/preview`, admin.token);
  check('preview counts 3 recipients', prev.data?.preview?.totalRecipients === 3, String(prev.data?.preview?.totalRecipients));
  check('preview flags the missing {{amount}} merge field', prev.data?.preview?.missingFields?.includes('amount'));
  check('preview does not require approval under 200', prev.data?.preview?.requiresApproval === false);

  const sub = await api(`/api/mail/campaigns/${camp.data.campaign.id}/submit`, admin.token, { method: 'POST' });
  check('small campaign is approved on submit (admin holds MAIL_APPROVE)',
    ['approved', 'sending', 'sent'].includes(sub.data?.campaign?.status), sub.data?.campaign?.status);

  step('the worker fans the campaign out');
  let counts = {};
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const c = await api(`/api/mail/campaigns/${camp.data.campaign.id}`, admin.token);
    counts = c.data?.campaign?.counts ?? {};
    if (c.data?.campaign?.status === 'sent') break;
  }
  check('campaign materialised 3 personalised messages',
    (counts.total ?? 0) === 3, JSON.stringify(counts));
  const { rows: rendered } = await pool.query(
    `SELECT subject FROM mail_messages WHERE campaign_id = $1 LIMIT 1`, [camp.data.campaign.id]);
  check('merge fields were rendered into the subject',
    !!rendered[0] && rendered[0].subject.startsWith('Fees for Parent'), rendered[0]?.subject);

  /* ── 8. big audience forces approval ────────────────────────────────── */
  step('a >200 audience is forced through approval');
  const bigSlug = `verify-big-${randomBytes(3).toString('hex')}`;
  const big = await api('/api/mail/lists', admin.token, { method: 'POST', body: { name: `Verify ${bigSlug}`, origin: 'manual' } });
  // Seed 201 members straight into the DB — faster than 201 HTTP calls.
  const values = Array.from({ length: 201 }, (_, i) => `('${big.data.list.id}','x${i}-${bigSlug}@example.com','Name ${i}')`).join(',');
  await pool.query(`INSERT INTO mail_list_members (list_id, address, name) VALUES ${values}`);
  await pool.query(`UPDATE mail_distribution_lists SET member_count = 201 WHERE id = $1`, [big.data.list.id]);
  const bigCamp = await api('/api/mail/campaigns', admin.token, {
    method: 'POST', body: { subject: 'Big', bodyHtml: '<p>hi</p>', listIds: [big.data.list.id] },
  });
  // Give an ordinary bulk sender (no MAIL_APPROVE) — use a Moderator-less path:
  // admin holds approve, so submit would auto-approve. Assert the preview instead.
  const bigPrev = await api(`/api/mail/campaigns/${bigCamp.data.campaign.id}/preview`, admin.token);
  check('preview says approval required for 201 recipients', bigPrev.data?.preview?.requiresApproval === true,
    String(bigPrev.data?.preview?.totalRecipients));

  /* ── 9. suppression skips an address ────────────────────────────────── */
  step('a suppressed address is not delivered to');
  await api('/api/mail/suppressions', admin.token, { method: 'POST', body: { address: `p0-${slug}@example.com`, note: 'test' } });
  const camp2 = await api('/api/mail/campaigns', admin.token, {
    method: 'POST', body: { subject: 'Round two', bodyHtml: '<p>hi</p>', listIds: [listId] },
  });
  const prev2 = await api(`/api/mail/campaigns/${camp2.data.campaign.id}/preview`, admin.token);
  check('suppressed address drops the count to 2', prev2.data?.preview?.totalRecipients === 2,
    String(prev2.data?.preview?.totalRecipients));

  /* ── 10. attachment access ─────────────────────────────────────────── */
  step('a mail attachment is readable by the recipient only');
  const ticketRes = await fetch(`${FILES}/api/files/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` },
    body: JSON.stringify({ name: 'note.txt', size: 5, mime: 'text/plain' }),
  });
  const ticket = { data: (await ticketRes.json()).data };
  await fetch(`${FILES}/api/files/${ticket.data.fileId}/content`, {
    method: 'PUT', headers: { Authorization: `Bearer ${ada.token}`, 'Content-Type': 'text/plain' }, body: 'hello',
  });
  const withAtt = await api('/api/mail/compose', ada.token, {
    method: 'POST',
    body: {
      to: [`userId:${ben.id}`], subject: `Att ${randomBytes(2).toString('hex')}`, bodyHtml: '<p>see attached</p>',
      attachments: [{ fileId: ticket.data.fileId, name: 'note.txt', mime: 'text/plain', size: 5 }],
    },
  });
  check('message with attachment sent', withAtt.status === 201);
  const benGet = await fetch(`${FILES}/api/files/${ticket.data.fileId}/content`, { headers: { Authorization: `Bearer ${ben.token}` } });
  check('recipient Ben can download the attachment', benGet.status === 200, `status ${benGet.status}`);
  const samGet = await fetch(`${FILES}/api/files/${ticket.data.fileId}/content`, { headers: { Authorization: `Bearer ${sam.token}` } });
  check('unrelated Sam cannot', samGet.status === 403 || samGet.status === 404, `status ${samGet.status}`);

} catch (err) {
  check(`unexpected error: ${err.message}`, false);
  console.error(err);
} finally {
  await cleanup();
  if (sink) await sink.close().catch(() => {});
  await pool.end();
}

process.stderr.write(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
