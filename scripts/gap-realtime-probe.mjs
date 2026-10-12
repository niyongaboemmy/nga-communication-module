#!/usr/bin/env node
/**
 * Gap-analysis probe (temporary, not part of the product): drives the realtime
 * layer with real sockets for three users and records which events reach whom.
 * Needs `npm run dev`. Cleans up its users afterwards.
 */
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190';
const RT = 'http://localhost:5191';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const ids = [];

async function makeUser(name, roleName) {
  const id = `gapp-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  const role = roleName.toLowerCase() === 'moderator' ? 'staff' : roleName.toLowerCase();
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role, rows[0].id]);
  ids.push(id);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role };
  return { id, name, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' }) };
}

const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

function connect(u, label) {
  const s = io(RT, { auth: { token: u.token, did: `dev-${label}` }, transports: ['websocket'], reconnection: false });
  s.log = [];
  s.onAny((ev, payload) => s.log.push({ ev, payload, t: Date.now() }));
  return new Promise((res, rej) => {
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}
const got = (s, ev, pred = () => true) => s.log.some((e) => e.ev === ev && pred(e.payload));
const evs = (s) => [...new Set(s.log.map((e) => e.ev))].join(', ');
const reset = (...ss) => ss.forEach((s) => { s.log = []; });

let sockets = [];
try {
  const A = await makeUser('Probe Ada', 'Staff');
  const B = await makeUser('Probe Ben', 'Staff');
  const C = await makeUser('Probe Cleo', 'Student');
  const ADM = await makeUser('Probe Admin', 'Admin');

  const a1 = await connect(A, 'a1');
  const b1 = await connect(B, 'b1');
  const b2 = await connect(B, 'b2');
  const c1 = await connect(C, 'c1');
  const adm = await connect(ADM, 'adm');
  sockets = [a1, b1, b2, c1, adm];
  await sleep(800);

  console.log('\n── Chat: conversation creation & messages');
  const dm = await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id });
  check('A can open a DM with B', dm.status === 200, `status ${dm.status}`);
  const convId = dm.body?.data?.conversation?.id;
  await sleep(800);
  check('B (device 1) learns of the new DM live', b1.log.length > 0 && /conversation/.test(evs(b1)), evs(b1) || 'no events');
  check('B (device 2) learns of the new DM live', /conversation/.test(evs(b2)), evs(b2) || 'no events');
  // client subscribes to the conversation (as the web app does)
  for (const s of [a1, b1, b2]) s.emit('conversation:subscribe', { conversationIds: [convId] }, () => {});
  await sleep(400); reset(a1, b1, b2);

  const sent = await call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: 'hello from probe', nonce: randomBytes(8).toString('hex') });
  check('A sends via REST', sent.status === 201 || sent.status === 200, `status ${sent.status}`);
  const msgId = sent.body?.data?.message?.id;
  await sleep(800);
  check('B device 1 receives message:new', got(b1, 'message:new'), evs(b1));
  check('B device 2 receives message:new', got(b2, 'message:new'), evs(b2));
  check('A\'s own socket gets echo (multi-device sync for sender)', got(a1, 'message:new'), evs(a1));

  console.log('\n── Chat: socket-only send path');
  reset(a1, b1, b2);
  const ack = await new Promise((r) => a1.emit('message:send', { conversationId: convId, body: 'via socket', nonce: randomBytes(8).toString('hex') }, r));
  await sleep(600);
  check('socket message:send acks ok', !!ack && (ack.ok !== false), JSON.stringify(ack).slice(0, 120));
  check('B receives socket-sent message', got(b1, 'message:new'), evs(b1));

  console.log('\n── Chat: typing');
  reset(b1);
  a1.emit('typing:start', { conversationId: convId, kind: 'text' });
  await sleep(500);
  check('B receives typing start', b1.log.some((e) => /typing/.test(e.ev)), evs(b1));
  const t0 = b1.log.length; await sleep(9000);
  const later = b1.log.slice(t0).map((e) => e.ev);
  check('typing auto-expires server-side when stop never sent (9s)', later.some((e) => /typing/.test(e)), later.join(',') || 'no expiry event');

  console.log('\n── Chat: reactions / edit / delete');
  reset(a1, b1, b2);
  const re = await call(B, 'POST', `/api/chat/conversations/${convId}/messages/${msgId}/reactions`, { emoji: '👍' });
  await sleep(500);
  check('B reacts', re.status === 200, `status ${re.status}`);
  check('A receives message:reaction live', got(a1, 'message:reaction'), evs(a1));
  check('B other device receives reaction', got(b2, 'message:reaction'), evs(b2));
  const bad = await call(B, 'POST', `/api/chat/conversations/${convId}/messages/${msgId}/reactions`, { emoji: '<script>' });
  check('arbitrary non-emoji reaction string rejected', bad.status >= 400, `status ${bad.status}`);
  const longE = await call(B, 'POST', `/api/chat/conversations/${convId}/messages/${msgId}/reactions`, { emoji: 'x'.repeat(500) });
  check('500-char reaction rejected', longE.status >= 400, `status ${longE.status}`);
  const edB = await call(B, 'PATCH', `/api/chat/conversations/${convId}/messages/${msgId}`, { body: 'hijack' });
  check('B cannot edit A\'s message', edB.status === 403 || edB.status === 404, `status ${edB.status}`);
  reset(b1);
  const ed = await call(A, 'PATCH', `/api/chat/conversations/${convId}/messages/${msgId}`, { body: 'edited text' });
  await sleep(500);
  check('A edits', ed.status === 200, `status ${ed.status}`);
  check('B receives message:updated', got(b1, 'message:updated'), evs(b1));

  console.log('\n── Chat: read receipts & unread across devices');
  reset(a1, b1, b2);
  const unreadBefore = await call(B, 'GET', '/api/chat/unread');
  const rd = await call(B, 'POST', `/api/chat/conversations/${convId}/read`, { seq: 99 });
  await sleep(600);
  check('B marks read', rd.status === 200, `status ${rd.status}`);
  check('B other device told the conversation is read (unread sync)', b2.log.some((e) => /read|unread/.test(e.ev)), evs(b2));
  check('A receives read receipt', a1.log.some((e) => /read|receipt/.test(e.ev)), evs(a1));
  const unreadAfter = await call(B, 'GET', '/api/chat/unread');
  check('unread endpoint drops after read', JSON.stringify(unreadAfter.body) !== JSON.stringify(unreadBefore.body), `${JSON.stringify(unreadBefore.body?.data).slice(0, 80)} → ${JSON.stringify(unreadAfter.body?.data).slice(0, 80)}`);

  console.log('\n── Authorization');
  const cRead = await call(C, 'GET', `/api/chat/conversations/${convId}/messages`);
  check('non-member cannot read DM messages', cRead.status === 403 || cRead.status === 404, `status ${cRead.status}`);
  const cReact = await call(C, 'POST', `/api/chat/conversations/${convId}/messages/${msgId}/reactions`, { emoji: '😀' });
  check('non-member cannot react', cReact.status === 403 || cReact.status === 404, `status ${cReact.status}`);
  reset(c1);
  c1.emit('conversation:subscribe', { conversationIds: [convId] }, () => {});
  await sleep(300);
  await call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: 'secret', nonce: randomBytes(8).toString('hex') });
  await sleep(600);
  check('non-member socket cannot subscribe and eavesdrop', !got(c1, 'message:new'), evs(c1) || 'none');
  const cDm = await call(C, 'POST', '/api/chat/conversations/direct', { userId: A.id });
  check('student→staff DM policy decision recorded', true, `status ${cDm.status} (${cDm.body?.error ?? 'allowed'})`);

  console.log('\n── Notifications');
  const nB = await call(B, 'GET', '/api/notifications');
  check('B has notifications listing', nB.status === 200, `count=${(nB.body?.data?.notifications ?? nB.body?.data ?? []).length}`);
  check('B socket received notification:new for DM', got(b1, 'notification:new') || b1.log.length === 0 ? got(b1, 'notification:new') : false, evs(b1));

  console.log('\n── Mail realtime');
  reset(b1, b2);
  const countsBefore = await call(B, 'GET', '/api/mail/counts');
  const mc = await call(A, 'POST', '/api/mail/compose', { to: [`${B.id}@amashuri.com`], subject: 'probe mail', bodyHtml: '<p>hi <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a></p>' });
  check('A sends mail', mc.status < 300, `status ${mc.status} ${JSON.stringify(mc.body).slice(0, 120)}`);
  await sleep(4000);
  check('B gets a live socket event for new mail', b1.log.some((e) => /mail|notification/.test(e.ev)), evs(b1) || 'no events');
  const countsAfter = await call(B, 'GET', '/api/mail/counts');
  check('B mail counts increase', JSON.stringify(countsAfter.body) !== JSON.stringify(countsBefore.body), `${JSON.stringify(countsBefore.body?.data)} → ${JSON.stringify(countsAfter.body?.data)}`);
  const th = await call(B, 'GET', '/api/mail/threads?folder=inbox');
  const thr = (th.body?.data?.threads ?? th.body?.data?.items ?? [])[0];
  if (thr) {
    const full = await call(B, 'GET', `/api/mail/threads/${thr.id}`);
    const html = JSON.stringify(full.body);
    check('mail body sanitized server-side (no onerror / javascript:)', !/onerror|javascript:/i.test(html), /onerror|javascript:/i.test(html) ? 'raw handlers stored/returned' : 'clean');
    reset(b2);
    await call(B, 'POST', `/api/mail/threads/${thr.id}/read`, { read: true });
    await sleep(800);
    check('mail read on device 1 syncs to device 2 live', b2.log.some((e) => /mail/.test(e.ev)), evs(b2) || 'no events');
    const cMail = await call(C, 'GET', `/api/mail/threads/${thr.id}`);
    check('non-recipient cannot open mail thread', cMail.status === 403 || cMail.status === 404, `status ${cMail.status}`);
  } else check('B inbox lists the mail', false, JSON.stringify(th.body).slice(0, 160));


  console.log('\n── Mail: security probes');
  const inj = await call(C, 'GET', `/api/mail/threads?folder=${encodeURIComponent("x' OR '1'='1")}`);
  const injN = (inj.body?.data?.threads ?? []).length;
  check('folder param is not injectable (student sees no foreign threads)', inj.status === 400 || injN === 0, `status ${inj.status}, ${injN} foreign threads returned to a student`);
  const slp = Date.now();
  await call(C, 'GET', `/api/mail/threads?folder=${encodeURIComponent("x' OR (SELECT 1 FROM pg_sleep(2)) IS NOT NULL OR '1'='1")}`);
  check('no time-based SQL injection via folder', Date.now() - slp < 1800, `took ${Date.now() - slp} ms`);
  const before = (await call(C, 'GET', '/api/mail/counts')).body?.data?.counts;
  const dr = await call(A, 'POST', '/api/mail/compose', { to: [`${C.id}@amashuri.com`], subject: 'HALF-WRITTEN DRAFT', bodyHtml: '<p>wip</p>', draft: true });
  await sleep(1500);
  const cInbox = await call(C, 'GET', '/api/mail/threads?folder=inbox');
  const draftLeak = JSON.stringify(cInbox.body).includes('HALF-WRITTEN DRAFT');
  check('a draft does NOT appear in the recipient inbox', !draftLeak, `draft status ${dr.status}; leak=${draftLeak}; counts ${JSON.stringify(before)} → ${JSON.stringify((await call(C, 'GET', '/api/mail/counts')).body?.data?.counts)}`);
  const sdr = await call(C, 'POST', '/api/mail/compose', { to: [`${A.id}@amashuri.com`], subject: 'STUDENT DRAFT SPAM', bodyHtml: '<p>x</p>', draft: true });
  await sleep(800);
  const aInbox = await call(A, 'GET', '/api/mail/threads?folder=inbox');
  check('student (no MAIL_SEND) cannot place a subject in staff inbox via draft', !JSON.stringify(aInbox.body).includes('STUDENT DRAFT SPAM'), `draft status ${sdr.status}`);
  const future = new Date(Date.now() + 3 * 864e5).toISOString();
  const sch = await call(A, 'POST', '/api/mail/compose', { to: [`${C.id}@amashuri.com`], subject: 'EMBARGOED RESULTS', bodyHtml: '<p>secret until monday</p>', scheduledAt: future, scheduleAt: future, sendAt: future });
  await sleep(1500);
  const cInbox2 = await call(C, 'GET', '/api/mail/threads?folder=inbox');
  check('scheduled mail is NOT visible before its send time', !JSON.stringify(cInbox2.body).includes('EMBARGOED RESULTS'), `schedule status ${sch.status} ${JSON.stringify(sch.body?.data ?? sch.body).slice(0, 100)}`);
  const lists = await call(C, 'GET', '/api/mail/lists');
  const L = (lists.body?.data?.lists ?? [])[0];
  if (L) { const mem = await call(C, 'GET', `/api/mail/lists/${L.id}/members`); check('student cannot export distribution-list member addresses', mem.status >= 400, `status ${mem.status}, list "${L.name}", ${(mem.body?.data?.members ?? []).length} members`); }

  console.log('\n── Feed realtime');
  const page = await call(ADM, 'POST', '/api/feed/pages', { name: `Probe page ${randomBytes(3).toString('hex')}`, audience: 'everyone' });
  const pageId = page.body?.data?.page?.id;
  check('admin creates feed page', page.status === 201, `status ${page.status}`);
  await call(B, 'POST', `/api/feed/pages/${pageId}/follow`, {});
  const fC = await call(C, 'POST', `/api/feed/pages/${pageId}/follow`, {});
  check('student follows page', fC.status === 200, `status ${fC.status}`);
  reset(b1, c1);
  const staffPost = await call(ADM, 'POST', `/api/feed/pages/${pageId}/posts`, { body: 'STAFF ONLY probe', audience: 'staff' });
  check('admin publishes staff-only post', staffPost.status === 201, `status ${staffPost.status}`);
  await sleep(1200);
  const leaked = c1.log.find((e) => e.ev === 'feed:post_new' && JSON.stringify(e.payload).includes('STAFF ONLY'));
  check('student does NOT receive staff-only post body over socket', !leaked, leaked ? 'LEAK: feed:post_new delivered to student' : evs(c1));
  const leakN = c1.log.find((e) => e.ev === 'notification:new');
  check('student does NOT get notification for staff-only post', !leakN, leakN ? JSON.stringify(leakN.payload).slice(0, 120) : 'none');
  const staffPostId = staffPost.body?.data?.postId;
  const cComment = await call(C, 'POST', `/api/feed/posts/${staffPostId}/comments`, { body: 'student sneaking' });
  check('student cannot comment on staff-only post', cComment.status >= 400, `status ${cComment.status}`);
  const cList = await call(C, 'GET', `/api/feed/posts/${staffPostId}/comments`);
  check('student cannot list comments of staff-only post', cList.status >= 400, `status ${cList.status}`);
  const cReactF = await call(C, 'POST', `/api/feed/posts/${staffPostId}/reactions`, { emoji: 'like' });
  check('student cannot react to staff-only post', cReactF.status >= 400, `status ${cReactF.status}`);

  // A student cannot listen in on a staff-only post's room by knowing its id.
  reset(c1);
  c1.emit('feed:subscribe', { postIds: [staffPostId] });
  await sleep(400);
  await call(ADM, 'POST', `/api/feed/posts/${staffPostId}/comments`, { body: 'STAFF-ONLY COMMENT' });
  await sleep(800);
  check('student socket subscribed to a staff-only post receives none of its events', !c1.log.some((e) => JSON.stringify(e.payload ?? '').includes('STAFF-ONLY COMMENT')), evs(c1) || 'none');

  const pub = await call(ADM, 'POST', `/api/feed/pages/${pageId}/posts`, { body: 'public probe', audience: 'everyone' });
  const postId = pub.body?.data?.postId;
  for (const s of [b1, c1, a1]) s.emit('feed:subscribe', { postIds: [postId] });
  await sleep(400); reset(b1, c1, a1);
  const kinds = ['like', 'love', '👍', 'heart'];
  let reacted = null;
  for (const k of kinds) { const r = await call(C, 'POST', `/api/feed/posts/${postId}/reactions`, { emoji: k, reaction: k, kind: k }); if (r.status < 300) { reacted = k; break; } }
  await sleep(600);
  const fr = b1.log.find((e) => e.ev === 'feed:reaction');
  check('B receives live feed:reaction', !!fr, evs(b1));
  if (fr) check('broadcast carries no reactor-specific "mine" (neutral payload + actorId)', !fr.payload?.reactions?.mine && !!fr.payload?.actorId, `mine=${JSON.stringify(fr.payload?.reactions?.mine)} actorId=${fr.payload?.actorId ? 'set' : 'missing'}`);
  reset(b1);
  await call(C, 'POST', `/api/feed/posts/${postId}/comments`, { body: 'live comment' });
  await sleep(600);
  check('B receives live feed:comment_new', got(b1, 'feed:comment_new'), evs(b1));
  const ce = b1.log.find((e) => e.ev === 'feed:comment_new');
  if (ce) check('comment broadcast does not carry author canEdit=true to others', !JSON.stringify(ce.payload).includes('"canEdit":true'), JSON.stringify(ce.payload).match(/"canEdit":\w+/)?.[0] ?? '');
  for (let i = 0; i < 3; i++) await call(B, 'POST', `/api/feed/posts/${postId}/view`, {});
  const pv = await call(ADM, 'GET', `/api/feed/posts/${postId}`); const vc = pv.body?.data?.post?.viewCount ?? pv.body?.data?.post?.views ?? pv.body?.data?.viewCount;
  check('repeated views by one user are deduplicated', (vc ?? 0) <= 1, `viewCount=${vc} keys=${Object.keys(pv.body?.data?.post??{}).join('|').slice(0,200)}`);

  console.log('\n── Presence');
  reset(a1);
  b2.disconnect();
  await sleep(1000);
  check('B stays online while one device remains', !a1.log.some((e) => e.ev === 'presence:update' && e.payload?.userId === B.id && e.payload?.status === 'offline'), evs(a1));
  b1.disconnect();
  await sleep(2500);
  const off = a1.log.find((e) => e.ev === 'presence:update' && e.payload?.userId === B.id);
  check('A sees B go offline after last device leaves', !!off, off ? JSON.stringify(off.payload) : evs(a1) || 'none (may be debounced)');

  console.log('\n── Missed-event recovery (reconnect)');
  await call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: 'while you were away', nonce: randomBytes(8).toString('hex') });
  const b3 = await connect(B, 'b3'); sockets.push(b3);
  await sleep(1000);
  check('on reconnect, gateway replays/announces missed messages (connection:ready carries sync info)', b3.log.some((e) => e.ev === 'message:new' || (e.ev === 'connection:ready' && /seq|since|unread/i.test(JSON.stringify(e.payload)))), evs(b3) + ' :: ' + JSON.stringify(b3.log.find((e) => e.ev === 'connection:ready')?.payload ?? {}).slice(0, 160));

  console.log('\n── Rate limiting');
  let codes = {};
  await Promise.all(Array.from({ length: 60 }, () => call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: 'spam', nonce: randomBytes(8).toString('hex') }).then((r) => { codes[r.status] = (codes[r.status] ?? 0) + 1; })));
  check('60 messages in a burst are throttled', !!codes[429], JSON.stringify(codes));
  codes = {};
  await Promise.all(Array.from({ length: 40 }, () => call(C, 'POST', `/api/feed/posts/${postId}/comments`, { body: 'spam' }).then((r) => { codes[r.status] = (codes[r.status] ?? 0) + 1; })));
  check('40 feed comments in a burst are throttled', !!codes[429], JSON.stringify(codes));

  await call(ADM, 'DELETE', `/api/feed/pages/${pageId}`);
  if (convId) await pool.query('DELETE FROM conversations WHERE id = $1', [convId]).catch(() => {});
} catch (e) {
  console.error('probe crashed:', e);
} finally {
  sockets.forEach((s) => s.connected && s.disconnect());
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(process.env.OUT ?? '/dev/null', JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await pool.end();
  process.exit(0);
}
