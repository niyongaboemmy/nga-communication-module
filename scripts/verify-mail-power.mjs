#!/usr/bin/env node
/**
 * Mail like Gmail (U-10), in a real browser:
 *
 *   - Send closes the composer at once with "Sending… Undo"; Undo reopens the
 *     message as written, and nothing reaches the recipient;
 *   - left alone, it is delivered a few seconds later;
 *   - leaving Mail while a send is held still delivers it;
 *   - keyboard: c compose, ? the list, j open, s star, e archive.
 *
 *   npm run verify:mail:power      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
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
  const id = `vmp-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, name, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
/** Sent copies of a subject that reached the recipient's inbox. */
const delivered = async (userId, subject) => Number((await pool.query(
  // Distinct messages: with internal email copies on, one recipient has an
  // in-app row and an email row for the same message.
  `SELECT count(DISTINCT m.id)::int AS n FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id
    WHERE r.user_id = $1 AND m.subject = $2 AND NOT m.is_draft AND r.folder = 'inbox' AND NOT r.pending`, [userId, subject])).rows[0].n);

let browser;
try {
  const me = await makeUser(`Mo Mailer ${tag}`);
  const ben = await makeUser(`Ben Reader ${tag}`);
  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: me.token, tupo_user: JSON.stringify(me.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: me.perms, name: 'Staff' }) });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/mail`);
  await page.getByRole('button', { name: /compose/i }).first().waitFor({ timeout: 20_000 });

  const compose = async (subject, viaKey = false) => {
    if (viaKey) { await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('c'); }
    else await page.getByRole('button', { name: /compose/i }).first().click();
    await page.getByPlaceholder('Name or email address').fill(ben.name);
    await page.getByText(ben.user.email, { exact: false }).first().click();
    await page.getByPlaceholder('Subject').fill(subject);
    await page.locator('.tupo-prose[contenteditable="true"]').click();
    await page.keyboard.type(`Body of ${subject}`);
    await page.getByRole('button', { name: /^Send$/ }).click();
  };

  console.log('\nUndo send');
  const undone = `Undo me ${tag}`;
  await compose(undone);
  const undo = page.getByText('Changed your mind? Undo.').first();
  check('Send closes the composer and offers Undo', await undo.waitFor({ timeout: 3_000 }).then(() => true).catch(() => false)
    && !(await page.getByPlaceholder('Subject').isVisible().catch(() => false)));
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  const reopened = await page.getByPlaceholder('Subject').waitFor({ timeout: 3_000 }).then(() => true).catch(() => false);
  check('Undo reopens the message as written', reopened && (await page.getByPlaceholder('Subject').inputValue()) === undone);
  await sleep(8_000);
  check('and nothing reached the recipient', (await delivered(ben.id, undone)) === 0);

  console.log('\nHeld, then sent');
  await page.getByRole('button', { name: /^Send$/ }).click();
  await sleep(2_000);
  check('nothing has gone during the hold', (await delivered(ben.id, undone)) === 0);
  let n = 0;
  for (let i = 0; i < 20 && !n; i++) { await sleep(500); n = await delivered(ben.id, undone); }
  check('left alone, it is delivered a few seconds later', n === 1, `${n} delivered`);

  console.log('\nLeaving while held');
  const leaving = `Leaving ${tag}`;
  await compose(leaving, true);
  check('c opens the composer', true);
  await sleep(500);
  await page.goto(`${BASE}/app/feed`);
  n = 0;
  for (let i = 0; i < 20 && !n; i++) { await sleep(500); n = await delivered(ben.id, leaving); }
  check('leaving Mail while a send is held still delivers it', n === 1, `${n} delivered`);

  console.log('\nKeyboard');
  const benCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await benCtx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: ben.token, tupo_user: JSON.stringify(ben.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: ben.perms, name: 'Staff' }) });
  const bp = await benCtx.newPage();
  await bp.goto(`${BASE}/app/mail`);
  await bp.getByText(leaving).first().waitFor({ timeout: 15_000 });
  await bp.locator('body').click({ position: { x: 5, y: 5 } });
  await bp.keyboard.press('?');
  check('? shows the list of shortcuts', await bp.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ timeout: 3_000 }).then(() => true).catch(() => false));
  await bp.keyboard.press('Escape');
  await bp.keyboard.press('j');
  check('j opens the first conversation', await bp.waitForURL(/\/app\/mail\/t\//, { timeout: 5_000 }).then(() => true).catch(() => false));
  const opened = (await bp.locator('h2').filter({ hasText: tag }).first().innerText().catch(() => '')).trim();
  await bp.keyboard.press('s');
  await sleep(1_500);
  const starred = (await pool.query(`SELECT bool_or(is_starred) AS s FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id WHERE r.user_id = $1 AND m.subject = $2`, [ben.id, opened])).rows[0].s;
  check('s stars the open conversation', starred === true, opened);
  await bp.keyboard.press('e');
  await sleep(1_500);
  const folders = (await pool.query(`SELECT array_agg(DISTINCT r.folder) AS f FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id WHERE r.user_id = $1 AND m.subject = ANY($2)`, [ben.id, [leaving, undone]])).rows[0].f;
  check('e archives it', (folders ?? []).includes('archive'), JSON.stringify(folders));

  console.log('\nA long conversation, like Gmail');
  const api = async (u, body) => (await fetch(`${API}/api/mail/compose`, { method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const subjectLong = `Long thread ${tag}`;
  let r = await api(me, { to: [`userId:${ben.id}`], subject: subjectLong, bodyHtml: '<p>message 1</p>' });
  const threadId = r.data.threadId; let parentId = r.data.messageId;
  for (let i = 2; i <= 6; i++) {
    const quoted = i === 6 ? `<p>On Monday, Mo wrote:</p><blockquote><p>the quoted words ${tag}</p></blockquote>` : '';
    r = await api(me, { to: [`userId:${ben.id}`], subject: `Re: ${subjectLong}`, bodyHtml: `<p>message ${i}</p>${quoted}`, threadId, parentId, kind: 'reply' });
    parentId = r.data.messageId;
  }
  await bp.goto(`${BASE}/app/mail/t/${threadId}`);
  await bp.getByText('message 6').first().waitFor({ timeout: 15_000 });
  check('the middle of a long thread folds into "older messages"', await bp.getByRole('button', { name: /3 older messages/ }).isVisible().catch(() => false));
  // In the message bodies only: the mailbox list beside it previews the text.
  const bodies = bp.locator('.tupo-prose');
  check('the quoted earlier text is hidden behind •••', !(await bodies.getByText(`the quoted words ${tag}`).isVisible().catch(() => false))
    && await bp.getByRole('button', { name: 'Show quoted text' }).isVisible().catch(() => false));
  await bp.getByRole('button', { name: 'Show quoted text' }).click();
  check('and shown when asked for', await bodies.getByText(`the quoted words ${tag}`).isVisible().catch(() => false));
  await bp.getByRole('button', { name: /3 older messages/ }).click();
  check('the folded messages open from the bar', await bp.getByText('message 3').first().isVisible().catch(() => false));

  console.log('\nSnooze');
  await bp.goto(`${BASE}/app/mail/t/${threadId}`);
  await bp.getByRole('button', { name: 'Snooze', exact: true }).click();
  await bp.getByRole('menuitem', { name: /^Tomorrow/ }).click();
  const inboxRow = bp.locator('li').filter({ hasText: subjectLong });
  await bp.waitForTimeout(1_500);
  const folderOf = async () => (await pool.query(`SELECT array_agg(DISTINCT folder) AS f FROM mail_recipients WHERE thread_id = $1 AND user_id = $2`, [threadId, ben.id])).rows[0].f;
  check('snoozing for tomorrow takes it out of the Inbox', JSON.stringify(await folderOf()) === '["snoozed"]', JSON.stringify(await folderOf()));
  await bp.goto(`${BASE}/app/mail?folder=snoozed`);
  check('it waits in Snoozed', await inboxRow.first().waitFor({ timeout: 8_000 }).then(() => true).catch(() => false));
  await inboxRow.first().hover();
  await inboxRow.first().getByRole('button', { name: 'Unsnooze' }).first().click();
  await bp.waitForTimeout(1_500);
  check('and Unsnooze brings it straight back', JSON.stringify(await folderOf()) === '["inbox"]', JSON.stringify(await folderOf()));
  await benCtx.close();
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await pool.query(`DELETE FROM mail_messages WHERE sender_id = ANY($1)`, [ids]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:mail:power: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
