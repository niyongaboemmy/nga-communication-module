#!/usr/bin/env node
/**
 * Calls ring (N-05), with two real browsers:
 *
 *   - the caller presses "Start an audio call" in a DM (the socket send path);
 *     the other person, reading the feed, gets a ringing screen, and Accept
 *     takes them into the meeting;
 *   - Decline closes it and stays put;
 *   - a call nobody answers becomes a "Missed call" notice after 30 s;
 *   - a shared meeting card (not a call just started) does not ring.
 *
 *   npm run verify:calls      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';
import { prepareBrowser } from './lib/uiHarness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = randomBytes(3).toString('hex');

async function makeUser(name) {
  const id = `vcl-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, name, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => (await fetch(`${API}${path}`, {
  method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})).json().catch(() => ({}));
const contextFor = async (browser, u) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: 'Staff' }) });
  return ctx;
};

let browser; let convId = null;
try {
  const caller = await makeUser(`Cai Caller ${tag}`);
  const callee = await makeUser(`Eli Callee ${tag}`);
  convId = (await call(caller, 'POST', '/api/chat/conversations/direct', { userId: callee.id })).data.conversation.id;
  browser = prepareBrowser(await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }));
  const callerPage = await (await contextFor(browser, caller)).newPage();
  const calleePage = await (await contextFor(browser, callee)).newPage();
  await calleePage.goto(`${BASE}/app/feed`);
  await calleePage.waitForTimeout(2_000);

  const ringScreen = calleePage.getByRole('alertdialog').filter({ hasText: caller.name });
  const placeCall = async () => {
    await callerPage.goto(`${BASE}/app/chat?c=${convId}`);
    await callerPage.getByRole('button', { name: 'Start an audio call' }).click();
  };

  console.log('\nAccept');
  await placeCall();
  check('the other person, reading the feed, gets a ringing screen', await ringScreen.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
  check('it says who is calling and that it is a voice call', await ringScreen.getByText(/Voice call/).isVisible().catch(() => false));
  const meetingId = await callerPage.waitForURL(/\/app\/meet\/[^/?]+/, { timeout: 10_000 }).then(() => callerPage.url().match(/\/app\/meet\/([^/?]+)/)?.[1]).catch(() => null);
  check('the caller is taken into the call', Boolean(meetingId), callerPage.url().replace(BASE, ''));
  await ringScreen.getByRole('button', { name: 'Accept' }).click();
  check('Accept takes them into the same meeting', await calleePage.waitForURL(new RegExp(`/app/meet/${meetingId}`), { timeout: 8_000 }).then(() => true).catch(() => false));

  console.log('\nPicture-in-picture');
  // The caller passes the device check first.
  await callerPage.getByRole('button', { name: 'Join now' }).click({ timeout: 15_000 }).catch(() => {});
  const pop = callerPage.getByRole('button', { name: 'Pop out the video' });
  if (await pop.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) {
    await callerPage.waitForFunction(() => document.querySelector('video[data-meet-video]')?.readyState >= 2, null, { timeout: 15_000 }).catch(() => {});
    await pop.click();
    check('"Pop out the video" floats it over other apps', await callerPage.waitForFunction(() => Boolean(document.pictureInPictureElement), null, { timeout: 5_000 }).then(() => true).catch(() => false));
    await callerPage.getByRole('button', { name: 'Return the video to the meeting' }).click();
    check('and pressing again returns it', await callerPage.waitForFunction(() => !document.pictureInPictureElement, null, { timeout: 5_000 }).then(() => true).catch(() => false));
  } else {
    check('the meeting offers "Pop out the video"', false, 'control not found');
  }

  console.log('\nConnection drops');
  const banner = callerPage.getByText(/reconnecting you to the call/);
  const errorPage = callerPage.getByText('Something went wrong');
  await callerPage.context().setOffline(true);
  check('losing the network shows a reconnecting banner, not an error page',
    await banner.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false) && !(await errorPage.isVisible().catch(() => false)));
  await sleep(3_000);
  await callerPage.context().setOffline(false);
  check('and the call comes back by itself when the network does',
    await banner.waitFor({ state: 'hidden', timeout: 15_000 }).then(() => true).catch(() => false)
    && await callerPage.getByRole('button', { name: 'Leave the meeting' }).isVisible().catch(() => false));
  // A deploy restarting the realtime gateway (dev: tsx watch reloads it).
  const gw = join(ROOT, 'apps/realtime/src/index.ts');
  utimesSync(gw, new Date(), new Date());
  const sawDrop = await banner.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const back = await banner.waitFor({ state: 'hidden', timeout: 40_000 }).then(() => true).catch(() => false);
  check('a gateway restart is ridden out the same way', sawDrop && back && !(await errorPage.isVisible().catch(() => false)),
    `drop seen ${sawDrop}, back ${back}`);

  console.log('\nOn a phone');
  await callerPage.setViewportSize({ width: 390, height: 844 });
  // The app's own phone tab bar has a "More" too: use the meeting's.
  await callerPage.locator('div', { has: callerPage.getByRole('button', { name: 'Leave the meeting' }) }).last()
    .getByRole('button', { name: 'More', exact: true }).click();
  check('the host can end for everyone from a phone',
    await callerPage.getByRole('button', { name: /End for everyone/ }).first().isVisible().catch(() => false));
  await callerPage.keyboard.press('Escape');
  await callerPage.setViewportSize({ width: 1280, height: 900 });

  console.log('\nRecording, then leaving');
  await callerPage.getByRole('button', { name: 'More', exact: true }).click();
  const startRec = callerPage.getByRole('button', { name: /Start recording/ }).first();
  if (await startRec.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false)) {
    await startRec.click();
    await sleep(4_000);
    await callerPage.getByRole('button', { name: 'Leave the meeting' }).click();
    let rec = null;
    for (let i = 0; i < 30 && rec?.status !== 'ready'; i++) {
      await sleep(1_000);
      rec = (await pool.query(`SELECT status, file_id FROM meeting_recordings WHERE meeting_id = $1 ORDER BY started_at DESC LIMIT 1`, [meetingId])).rows[0] ?? null;
    }
    check('leaving while recording saves the recording instead of losing it', rec?.status === 'ready' && Boolean(rec?.file_id), JSON.stringify(rec));
  } else {
    check('the host can start a recording', false, 'control not found');
  }

  console.log('\nDecline');
  await calleePage.goto(`${BASE}/app/feed`);
  await calleePage.waitForTimeout(1_500);
  await placeCall();
  await ringScreen.waitFor({ timeout: 10_000 });
  await ringScreen.getByRole('button', { name: 'Decline' }).click();
  check('Decline closes it and stays put', !(await ringScreen.isVisible().catch(() => false)) && /\/app\/feed/.test(calleePage.url()));

  console.log('\nNo answer');
  await placeCall();
  await ringScreen.waitFor({ timeout: 10_000 });
  check('an unanswered call becomes a missed-call notice after 30 s',
    await calleePage.getByText(`Missed call from ${caller.name}`).first().waitFor({ timeout: 40_000 }).then(() => true).catch(() => false)
    && !(await ringScreen.isVisible().catch(() => false)));

  console.log('\nA shared meeting card');
  const later = (await call(caller, 'POST', '/api/meet', { title: `Planning ${tag}`, scheduledStart: new Date(Date.now() + 86_400_000).toISOString(), conversationId: convId }))?.data;
  if (later?.id) {
    const posted = await call(caller, 'POST', `/api/chat/conversations/${convId}/messages`, { body: 'see you tomorrow', nonce: randomUUID(), type: 'call_event', metadata: { meet: { meetingId: later.id } } });
    check('the card is posted in the conversation', posted?.data?.message?.type === 'call_event' && posted.data.message.metadata?.meet?.ring === false,
      JSON.stringify(posted?.data?.message?.metadata?.meet ?? posted).slice(0, 120));
    await sleep(3_000);
    check('and does not ring', !(await calleePage.getByRole('alertdialog').isVisible().catch(() => false)));
  } else {
    check('a scheduled meeting could be created for the card check', false, JSON.stringify(later).slice(0, 120));
  }
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await pool.query(`DELETE FROM meetings WHERE host_id = ANY($1)`, [ids]).catch(() => {});
  if (convId) await pool.query('DELETE FROM conversations WHERE id = $1', [convId]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:calls: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
