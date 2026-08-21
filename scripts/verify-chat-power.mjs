#!/usr/bin/env node
/**
 * Chat Phase 6 — search, scheduled send, polls.
 *
 * The one that matters most is search: a search box that returns a single line
 * from a conversation you are not in has leaked that conversation, and it is
 * the easiest place in a chat product to leak from because the query touches
 * every message in the database.
 *
 *   npm run verify:chat:power      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { purgeUsers } from './lib/purge.mjs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(),
               l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const pass = [], fails = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`;
  (ok ? pass : fails).push(line);
  process.stderr.write('  ' + line + '\n');
  return ok;
};
const step = (s) => process.stderr.write(`\n  • ${s}\n`);
const nonce = () => randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(name, roleName = 'Staff') {
  const id = `chatpow-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0]?.id ?? null]);
  const token = jwt.sign(
    { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() },
    env.JWT_SECRET, { expiresIn: '30m' });
  return { id, name, token };
}

const api = async (path, token, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, data: body.data };
};

/* ══════════════════════════════════════════════════════════════════════════ */

const alice = await makeUser('Power Alice');
const bob = await makeUser('Power Bob');
const mallory = await makeUser('Power Mallory');
const pupil = await makeUser('Power Pupil', 'Student');
const ids = [alice.id, bob.id, mallory.id, pupil.id];

try {
  const shared = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Power ${randomBytes(3).toString('hex')}`,
      memberIds: [bob.id, pupil.id],
    }),
  });
  const channelId = shared.data.conversation.id;

  const secret = await api('/api/chat/conversations', mallory.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Private ${randomBytes(3).toString('hex')}`, isPrivate: true,
    }),
  });
  const secretId = secret.data.conversation.id;
  check('a shared channel and a private one exist', Boolean(channelId && secretId));

  const post = async (who, conv, body) => {
    const r = await api(`/api/chat/conversations/${conv}/messages`, who.token, {
      method: 'POST', body: JSON.stringify({ body, nonce: nonce() }) });
    return r.data?.message;
  };

  /* ── Search ────────────────────────────────────────────────────────────── */
  step('search');

  const token = randomBytes(4).toString('hex');
  await post(alice, channelId, `The zephyrology exam is on Thursday ${token}`);
  await post(bob, channelId, `Zephyrology revision starts Monday ${token}`);
  await post(alice, channelId, 'Something else entirely');
  // The same rare word, in a channel Bob cannot see.
  await post(mallory, secretId, `Secret zephyrology plans ${token}`);
  await sleep(200);

  const found = await api(`/api/chat/search?q=zephyrology`, bob.token);
  check('search finds messages', found.status === 200 && found.data.hits.length >= 2,
    `${found.status} ${found.data?.hits?.length}`);

  check('and NEVER returns a message from a conversation the searcher is not in',
    !found.data.hits.some((h) => h.conversationId === secretId),
    JSON.stringify(found.data.hits.map((h) => h.conversationName)));

  const asMallory = await api(`/api/chat/search?q=zephyrology`, mallory.token);
  check('while the owner of that channel does see it',
    asMallory.data.hits.some((h) => h.conversationId === secretId));

  check('a hit carries where it came from',
    found.data.hits.every((h) => Boolean(h.conversationName && h.message.senderName)));

  check('and a highlight marking the matched words',
    found.data.hits.every((h) => h.highlight.includes('') && h.highlight.includes('')),
    JSON.stringify(found.data.hits[0]?.highlight));

  const highlight = found.data.hits[0].highlight;
  check('the highlight is not HTML — the client must never be handed markup',
    !/<[a-z]/i.test(highlight), highlight.slice(0, 60));

  const scoped = await api(
    `/api/chat/search?q=zephyrology&conversationId=${channelId}`, bob.token);
  check('search can be scoped to one conversation',
    scoped.data.hits.every((h) => h.conversationId === channelId));

  const byPerson = await api(
    `/api/chat/search?q=zephyrology&from=${alice.id}`, bob.token);
  check('and filtered by who wrote it',
    byPerson.data.hits.length > 0 && byPerson.data.hits.every((h) => h.message.senderId === alice.id),
    `${byPerson.data.hits.length} hits`);

  const phrase = await api(
    `/api/chat/search?q=${encodeURIComponent('"revision starts"')}`, bob.token);
  check('a quoted phrase matches as a phrase',
    phrase.data.hits.length === 1, `${phrase.data.hits.length} hits`);

  const excluded = await api(
    `/api/chat/search?q=${encodeURIComponent('zephyrology -revision')}`, bob.token);
  check('and an -exclusion removes results',
    excluded.data.hits.length < found.data.hits.length,
    `${excluded.data.hits.length} vs ${found.data.hits.length}`);

  const nonsense = await api(
    `/api/chat/search?q=${encodeURIComponent('") | ( ! &&')}`, bob.token);
  check('search syntax that would break to_tsquery does not 500',
    nonsense.status === 200, String(nonsense.status));

  const tooShort = await api('/api/chat/search?q=a', bob.token);
  check('a one-character query returns nothing rather than the whole database',
    tooShort.data.hits.length === 0);

  // A deleted message must leave the index.
  const doomed = await post(alice, channelId, `Ephemeralist note ${token}`);
  await api(`/api/chat/conversations/${channelId}/messages/${doomed.id}`, alice.token,
    { method: 'DELETE' });
  const afterDelete = await api('/api/chat/search?q=Ephemeralist', bob.token);
  check('a deleted message is not findable',
    afterDelete.data.hits.length === 0, `${afterDelete.data.hits.length} hits`);

  // And so must a conversation you have left.
  await pool.query(
    `UPDATE conversation_members SET left_at = now()
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);
  const afterLeaving = await api('/api/chat/search?q=zephyrology', bob.token);
  check('leaving a channel removes its messages from your search',
    !afterLeaving.data.hits.some((h) => h.conversationId === channelId),
    `${afterLeaving.data.hits.length} hits`);
  await pool.query(
    `UPDATE conversation_members SET left_at = NULL
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);

  /* ── Link unfurling, and the SSRF guard ────────────────────────────────── */
  step('link unfurling');

  /** Wait for the worker to record a verdict for a URL. */
  const waitForPreview = async (url, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        'SELECT status, title FROM link_previews WHERE url = $1', [url]);
      if (rows[0]) return rows[0];
      await sleep(500);
    }
    return null;
  };

  // The attack: make the server read its own network.
  const metadataUrl = 'http://169.254.169.254/latest/meta-data/';
  await post(alice, channelId, `have a look at ${metadataUrl}`);
  const metadataVerdict = await waitForPreview(metadataUrl);
  check('a link to the cloud metadata address is refused, not fetched',
    metadataVerdict?.status === 'blocked', JSON.stringify(metadataVerdict));

  const localApi = 'http://127.0.0.1:5190/health';
  await post(alice, channelId, `and ${localApi}`);
  const localVerdict = await waitForPreview(localApi);
  check('so is a link pointed at the server’s own API on loopback',
    localVerdict?.status === 'blocked', JSON.stringify(localVerdict));

  const privateHost = 'http://10.0.0.1/admin';
  await post(alice, channelId, `also ${privateHost}`);
  const privateVerdict = await waitForPreview(privateHost);
  check('and a private RFC 1918 address',
    privateVerdict?.status === 'blocked', JSON.stringify(privateVerdict));

  // A blocked link must produce no card at all — the refusal is cached so the
  // address is not re-resolved, but nothing is shown for it.
  const withBlocked = (await api(
    `/api/chat/conversations/${channelId}/messages?limit=20`, bob.token))
    .data.messages.find((m) => m.body?.includes('169.254.169.254'));
  check('a blocked link renders no preview card',
    withBlocked && withBlocked.linkPreviews.length === 0,
    JSON.stringify(withBlocked?.linkPreviews));

  const { rows: linked } = await pool.query(
    'SELECT count(*)::int AS n FROM message_links WHERE conversation_id = $1', [channelId]);
  check('the links are still recorded against the message, so a later refetch knows about them',
    linked[0].n >= 3, String(linked[0].n));

  // Two messages sharing a URL must not cause two fetches.
  const beforeRows = (await pool.query(
    'SELECT count(*)::int AS n FROM link_previews WHERE url = $1', [metadataUrl])).rows[0].n;
  await post(alice, channelId, `again ${metadataUrl}`);
  await sleep(2500);
  const afterRows = (await pool.query(
    'SELECT count(*)::int AS n FROM link_previews WHERE url = $1', [metadataUrl])).rows[0].n;
  check('a URL is cached once however many messages carry it',
    beforeRows === 1 && afterRows === 1, `${beforeRows} then ${afterRows}`);

  /* ── Scheduled send ────────────────────────────────────────────────────── */
  step('scheduled send');

  const soon = new Date(Date.now() + 45_000).toISOString();
  const created = await api(`/api/chat/conversations/${channelId}/scheduled`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'Scheduled hello', sendAt: soon }) });
  check('a message can be scheduled', created.status === 201, `${created.status} ${created.body.message ?? ''}`);

  const pending = await api('/api/chat/scheduled', alice.token);
  check('and appears in the pending queue',
    pending.data.scheduled.some((s) => s.id === created.data.scheduled.id));
  check('carrying where it will go',
    Boolean(pending.data.scheduled[0]?.conversationName));

  const othersQueue = await api('/api/chat/scheduled', bob.token);
  check('nobody else can see it', !othersQueue.data.scheduled.some(
    (s) => s.id === created.data.scheduled.id));

  const tooSoon = await api(`/api/chat/conversations/${channelId}/scheduled`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'now', sendAt: new Date().toISOString() }) });
  check('scheduling for the past is refused', tooSoon.status === 400, String(tooSoon.status));

  const tooFar = await api(`/api/chat/conversations/${channelId}/scheduled`, alice.token, {
    method: 'POST',
    body: JSON.stringify({
      body: 'much later',
      sendAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
    }) });
  check('and so is scheduling two years out', tooFar.status === 400, String(tooFar.status));

  const noPerm = await api(`/api/chat/conversations/${channelId}/scheduled`, pupil.token, {
    method: 'POST', body: JSON.stringify({ body: 'nope', sendAt: soon }) });
  check('scheduling is permissioned', noPerm.status === 403, String(noPerm.status));

  const foreignCancel = await api(
    `/api/chat/scheduled/${created.data.scheduled.id}`, bob.token, { method: 'DELETE' });
  check('somebody else cannot cancel your scheduled message',
    foreignCancel.status === 404, String(foreignCancel.status));

  // Due now → the worker's claim must pick it up exactly once.
  const dueId = created.data.scheduled.id;
  await pool.query(`UPDATE scheduled_messages SET send_at = now() - interval '1 minute'
                     WHERE id = $1`, [dueId]);

  const { rows: firstClaim } = await pool.query(
    `UPDATE scheduled_messages s SET state = 'sending'
      WHERE s.id IN (SELECT id FROM scheduled_messages
                      WHERE state = 'pending' AND send_at <= now() AND id = $1
                      FOR UPDATE SKIP LOCKED)
      RETURNING s.id`, [dueId]);
  const { rows: secondClaim } = await pool.query(
    `UPDATE scheduled_messages s SET state = 'sending'
      WHERE s.id IN (SELECT id FROM scheduled_messages
                      WHERE state = 'pending' AND send_at <= now() AND id = $1
                      FOR UPDATE SKIP LOCKED)
      RETURNING s.id`, [dueId]);
  check('a due message is claimed exactly once, so two workers cannot both send it',
    firstClaim.length === 1 && secondClaim.length === 0,
    `${firstClaim.length} then ${secondClaim.length}`);
  await pool.query(`UPDATE scheduled_messages SET state = 'cancelled' WHERE id = $1`, [dueId]);

  const cancellable = await api(`/api/chat/conversations/${channelId}/scheduled`, alice.token, {
    method: 'POST',
    body: JSON.stringify({ body: 'cancel me', sendAt: new Date(Date.now() + 120_000).toISOString() }),
  });
  const cancelled = await api(
    `/api/chat/scheduled/${cancellable.data.scheduled.id}`, alice.token, { method: 'DELETE' });
  check('you can cancel your own', cancelled.status === 200, String(cancelled.status));
  check('and it leaves the queue',
    !(await api('/api/chat/scheduled', alice.token)).data.scheduled
      .some((s) => s.id === cancellable.data.scheduled.id));

  /* ── Inline translation ────────────────────────────────────────────────── */
  step('translation');

  const langs = await api('/api/chat/languages', bob.token);
  check('the supported languages are advertised',
    langs.status === 200 && Object.keys(langs.data.languages).length === 3,
    JSON.stringify(langs.data?.languages));

  const toTranslate = await post(alice, channelId, 'Good morning, the exam starts at eight.');
  const trUrl =
    `/api/chat/conversations/${channelId}/messages/${toTranslate.id}/translate`;

  const badLang = await api(trUrl, bob.token, {
    method: 'POST', body: JSON.stringify({ language: 'klingon' }) });
  check('an unsupported language is refused rather than passed to the model',
    badLang.status === 400, String(badLang.status));

  const outsiderTr = await api(trUrl, mallory.token, {
    method: 'POST', body: JSON.stringify({ language: 'fr' }) });
  check('translation is a read of the conversation, so a non-member is refused',
    outsiderTr.status === 404, String(outsiderTr.status));

  const translated = await api(trUrl, bob.token, {
    method: 'POST', body: JSON.stringify({ language: 'fr' }) });
  if (translated.status === 503) {
    check('translation is unavailable in this environment — skipped', true,
      translated.body.message ?? '');
  } else {
    check('a message can be translated',
      translated.status === 200 && typeof translated.data.text === 'string'
        && translated.data.text.length > 0,
      JSON.stringify(translated.data?.text)?.slice(0, 80));
    check('and the first call is not served from cache',
      translated.data.cached === false, String(translated.data?.cached));

    const again = await api(trUrl, pupil.token, {
      method: 'POST', body: JSON.stringify({ language: 'fr' }) });
    check('a second reader gets the cached translation, not a second model call',
      again.data.cached === true, String(again.data?.cached));
    check('and the same text', again.data.text === translated.data.text);

    // An edit must invalidate it, or the translation describes what the
    // message used to say.
    await api(`/api/chat/conversations/${channelId}/messages/${toTranslate.id}`, alice.token, {
      method: 'PATCH', body: JSON.stringify({ body: 'Correction: the exam starts at nine.' }) });
    const afterEdit = await api(trUrl, bob.token, {
      method: 'POST', body: JSON.stringify({ language: 'fr' }) });
    check('editing the message invalidates its cached translation',
      afterEdit.data.cached === false, String(afterEdit.data?.cached));
  }

  /* ── Polls ─────────────────────────────────────────────────────────────── */
  step('polls');

  const poll = await api(`/api/chat/conversations/${channelId}/polls`, alice.token, {
    method: 'POST',
    body: JSON.stringify({ question: 'Which day for the practical?', options: ['Thursday', 'Friday'] }),
  });
  check('a poll can be created', poll.status === 201, `${poll.status} ${poll.body.message ?? ''}`);
  check('and rides on a real message, so it sits in the log',
    Boolean(poll.data.message?.id) && poll.data.message.type === 'poll');

  const pollId = poll.data.poll.id;
  const oneOption = await api(`/api/chat/conversations/${channelId}/polls`, alice.token, {
    method: 'POST', body: JSON.stringify({ question: 'One?', options: ['Only'] }) });
  check('a poll with one option is refused', oneOption.status === 400, String(oneOption.status));

  const voted = await api(`/api/chat/polls/${pollId}/vote`, bob.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['o0'] }) });
  check('a member can vote',
    voted.status === 200 && voted.data.poll.options[0].votes === 1,
    JSON.stringify(voted.data?.poll?.options?.map((o) => o.votes)));

  const changed = await api(`/api/chat/polls/${pollId}/vote`, bob.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['o1'] }) });
  check('changing your mind moves the vote rather than adding one',
    changed.data.poll.options[0].votes === 0 && changed.data.poll.options[1].votes === 1,
    JSON.stringify(changed.data.poll.options.map((o) => o.votes)));
  check('and the total counts people, not votes',
    changed.data.poll.totalVoters === 1, String(changed.data.poll.totalVoters));

  const multiVote = await api(`/api/chat/polls/${pollId}/vote`, bob.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['o0', 'o1'] }) });
  check('a single-choice poll refuses two answers', multiVote.status === 400, String(multiVote.status));

  const bogus = await api(`/api/chat/polls/${pollId}/vote`, bob.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['does-not-exist'] }) });
  check('an option id that is not on the poll is discarded, not stored',
    bogus.status === 200 && bogus.data.poll.totalVoters === 0,
    JSON.stringify(bogus.data?.poll?.totalVoters));

  const outsiderVote = await api(`/api/chat/polls/${pollId}/vote`, mallory.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['o0'] }) });
  check('a non-member cannot vote', outsiderVote.status === 404, String(outsiderVote.status));

  const anonPoll = await api(`/api/chat/conversations/${channelId}/polls`, alice.token, {
    method: 'POST',
    body: JSON.stringify({ question: 'Anonymous?', options: ['Yes', 'No'], anonymous: true }),
  });
  await api(`/api/chat/polls/${anonPoll.data.poll.id}/vote`, bob.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['o0'] }) });
  const anonRead = await api(
    `/api/chat/conversations/${channelId}/messages/${anonPoll.data.message.id}/poll`, alice.token);
  check('an anonymous poll never puts the voter list on the wire',
    anonRead.data.poll.options.every((o) => o.voters.length === 0),
    JSON.stringify(anonRead.data.poll.options.map((o) => o.voters)));
  check('though the counts are still visible',
    anonRead.data.poll.options[0].votes === 1);

  const foreignClose = await api(`/api/chat/polls/${pollId}/close`, bob.token, { method: 'POST' });
  check('someone else cannot close your poll', foreignClose.status === 403, String(foreignClose.status));

  const closed = await api(`/api/chat/polls/${pollId}/close`, alice.token, { method: 'POST' });
  check('the author can', closed.status === 200 && Boolean(closed.data.poll.closedAt));

  const lateVote = await api(`/api/chat/polls/${pollId}/vote`, bob.token, {
    method: 'POST', body: JSON.stringify({ optionIds: ['o0'] }) });
  check('and a closed poll takes no more votes', lateVote.status === 409, String(lateVote.status));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  // One helper, in dependency order, each step in its own try/catch — see
  // scripts/lib/purge.mjs for why the previous inline version leaked users on
  // every interrupted run.
  try { await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]); } catch { /* files may not reference these */ }
  await purgeUsers(pool, ids);
  await pool.end();
}

console.log('\n── Chat Phase 6: search, scheduling, polls ──────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
