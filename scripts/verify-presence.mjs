#!/usr/bin/env node
/**
 * Real-time presence — who is online, who was last seen when, and who is here.
 *
 * The claims worth pinning are the ones that were quietly false before:
 * a presence key whose TTL nothing refreshed (so a reader went grey while
 * looking at the screen), a `show_presence` toggle nothing read, and a
 * `last_seen_at` column nothing ever wrote.
 *
 * It also guards the ordering bug this suite found: the gateway must register
 * its socket handlers before any `await`, or a client that subscribes the
 * instant it connects has that subscribe dropped on the floor.
 *
 *   npm run verify:presence       (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { io as ioClient } from 'socket.io-client';
import { Redis } from 'ioredis';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const WS = 'http://localhost:5191';
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL || 'redis://localhost:6379');

const pass = [], fails = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`;
  (ok ? pass : fails).push(line);
  console.log('  ' + line);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Never wait forever on an ack: a silent handler should fail, not hang. */
const ask = (socket, event, payload, ms = 6000) => new Promise((resolve) => {
  let done = false;
  const t = setTimeout(() => { if (!done) { done = true; resolve({ __timeout: true }); } }, ms);
  const cb = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
  if (payload === undefined) socket.emit(event, cb); else socket.emit(event, payload, cb);
});
const made = [];

async function makeUser(name) {
  const id = `pres-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', ['Staff']);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, 'staff', rows[0]?.id ?? null]);
  made.push(id);
  const token = jwt.sign(
    { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    env.JWT_SECRET, { expiresIn: '1h' });
  return { id, name, token };
}

const api = (token, path, opts = {}) => fetch(`${API}${path}`, {
  ...opts,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) },
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const connect = (token) => new Promise((resolve, reject) => {
  const s = ioClient(WS, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('ws timeout')), 8000);
});

async function main() {
  const alice = await makeUser('Alice Presence');
  const bob = await makeUser('Bob Presence');

  console.log('\n  • presence key + heartbeat');
  const sa = await connect(alice.token);
  await sleep(400);
  const key = `presence:${alice.id}`;
  check('presence key written on connect', (await redis.get(key)) === 'online');

  // Force the key near expiry, then heartbeat and confirm the TTL is restored.
  await redis.expire(key, 5);
  const before = await redis.ttl(key);
  await ask(sa, 'presence:heartbeat');
  const after = await redis.ttl(key);
  check('presence:heartbeat restores the TTL', after > before + 30, `ttl ${before}s → ${after}s`);

  console.log('\n  • chosen status survives the heartbeat');
  await ask(sa, 'presence:set', { status: 'busy' });
  await sleep(200);
  await ask(sa, 'presence:heartbeat');
  check('heartbeat does not clobber "busy"', (await redis.get(key)) === 'busy',
    `stored: ${await redis.get(key)}`);
  await ask(sa, 'presence:set', { status: 'online' });

  console.log('\n  • presence:query');
  const q = await ask(sa, 'presence:query', { userIds: [alice.id, bob.id] });
  check('query reports self online', q.presence?.[alice.id]?.status === 'online');
  check('query reports absent user offline', q.presence?.[bob.id]?.status === 'offline');

  console.log('\n  • channel roster: N of M online');
  const created = await api(alice.token, '/api/chat/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: `presence-${randomBytes(3).toString('hex')}`, memberIds: [bob.id] }),
  });
  const convId = created.body?.data?.conversation?.id;
  if (!convId) { check('channel created', false, JSON.stringify(created.body)); return; }
  check('channel created', true);

  const roster1 = await api(alice.token, `/api/chat/conversations/${convId}/members`);
  check('roster returns counts',
    roster1.body?.data?.memberCount === 2 && roster1.body?.data?.onlineCount === 1,
    `${roster1.body?.data?.onlineCount} of ${roster1.body?.data?.memberCount}`);

  console.log('\n  • conversation:presence is pushed');
  const pushes = [];
  sa.on('conversation:presence', (p) => pushes.push(p));
  check('Alice subscribe acked', !(await ask(sa, 'conversation:subscribe', { conversationIds: [convId] })).__timeout);
  await sleep(400);
  check('roster pushed on subscribe', pushes.some((p) => p.conversationId === convId),
    `${pushes.length} push(es)`);
  check('subscriber counted as viewing',
    pushes.at(-1)?.viewing?.includes(alice.id), JSON.stringify(pushes.at(-1)?.viewing));

  const sb = await connect(bob.token);
  check('Bob subscribe acked', !(await ask(sb, 'conversation:subscribe', { conversationIds: [convId] })).__timeout);
  await sleep(600);
  const last = pushes.at(-1);
  check('Bob joining pushes a new roster to Alice',
    last?.online?.includes(bob.id) && last?.viewing?.includes(bob.id),
    `online=${JSON.stringify(last?.online)} viewing=${JSON.stringify(last?.viewing)}`);

  const roster2 = await api(alice.token, `/api/chat/conversations/${convId}/members`);
  check('roster now 2 of 2 online', roster2.body?.data?.onlineCount === 2,
    `${roster2.body?.data?.onlineCount} of ${roster2.body?.data?.memberCount}`);

  console.log('\n  • typing carries a kind');
  const typing = [];
  sa.on('typing:update', (p) => typing.push(p));
  sb.emit('typing:start', { conversationId: convId, kind: 'uploading' });
  await sleep(500);
  check('typing:update reports kind=uploading',
    typing.at(-1)?.users?.some((u) => u.userId === bob.id && u.kind === 'uploading'),
    JSON.stringify(typing.at(-1)?.users));

  console.log('\n  • last seen on disconnect');
  const t0 = Date.now();
  sb.disconnect();
  await sleep(900);
  const cached = await redis.get(`lastseen:${bob.id}`);
  check('lastseen cached in redis', !!cached, String(cached));
  const { rows } = await pool.query('SELECT last_seen_at FROM users WHERE id = $1', [bob.id]);
  const stamped = rows[0]?.last_seen_at ? new Date(rows[0].last_seen_at).getTime() : 0;
  check('users.last_seen_at written', stamped >= t0 - 5000, String(rows[0]?.last_seen_at));

  const roster3 = await api(alice.token, `/api/chat/conversations/${convId}/members`);
  const bobRow = roster3.body?.data?.members?.find((m) => m.userId === bob.id);
  check('roster shows Bob offline with a lastSeenAt',
    bobRow?.presence === 'offline' && !!bobRow?.lastSeenAt,
    `${bobRow?.presence} / ${bobRow?.lastSeenAt}`);

  console.log('\n  • show_presence opt-out');
  await pool.query(
    `INSERT INTO user_chat_prefs (user_id, show_presence) VALUES ($1, false)
       ON CONFLICT (user_id) DO UPDATE SET show_presence = false`, [bob.id]);
  const sb2 = await connect(bob.token);
  await sleep(500);
  check('no presence key for an opted-out user', (await redis.get(`presence:${bob.id}`)) === null);
  const roster4 = await api(alice.token, `/api/chat/conversations/${convId}/members`);
  const bobRow2 = roster4.body?.data?.members?.find((m) => m.userId === bob.id);
  check('opted-out user reads offline with no lastSeenAt',
    bobRow2?.presence === 'offline' && !bobRow2?.lastSeenAt,
    `${bobRow2?.presence} / ${bobRow2?.lastSeenAt}`);

  /*
   * The opt-out has to hold on every path that returns a person, not just the
   * roster. A DM summary carries the counterpart inline, and fetching one
   * conversation goes through a different function from listing them — which
   * is exactly the kind of second door a preference like this leaks through.
   */
  const dm = await api(bob.token, '/api/chat/conversations/direct', {
    method: 'POST', body: JSON.stringify({ userId: alice.id }),
  });
  const dmId = dm.body?.data?.conversation?.id;
  check('DM created', !!dmId, `status ${dm.status} ${JSON.stringify(dm.body)?.slice(0, 200)}`);
  const list = await api(alice.token, '/api/chat/conversations');
  const dmRow = list.body?.data?.conversations?.find((c) => c.id === dmId);
  check('DM list hides an opted-out peer\'s last seen',
    dmRow?.peer?.presence === 'offline' && !dmRow?.peer?.lastSeenAt,
    `${dmRow?.peer?.presence} / ${dmRow?.peer?.lastSeenAt}`);

  const one = await api(alice.token, `/api/chat/conversations/${dmId}`);
  check('fetching one DM hides it too',
    !one.body?.data?.conversation?.peer?.lastSeenAt,
    String(one.body?.data?.conversation?.peer?.lastSeenAt));
  sb2.disconnect();

  sa.disconnect();
}

main()
  .catch((e) => { fails.push(`❌ threw: ${e.message}`); console.error(e); })
  .finally(async () => {
    for (const id of made) {
      await pool.query('DELETE FROM conversation_members WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM user_chat_prefs WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
      await redis.del(`presence:${id}`, `lastseen:${id}`).catch(() => {});
    }
    console.log(`\n  ${pass.length} passed, ${fails.length} failed`);
    if (fails.length) console.log(fails.join('\n'));
    await pool.end(); redis.disconnect();
    process.exit(fails.length ? 1 : 0);
  });
