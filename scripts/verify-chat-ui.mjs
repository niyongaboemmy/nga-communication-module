/**
 * Chat, in two real browsers.
 *
 * The API gate proves the rules; this proves the product. Two people sign in,
 * one opens a DM with the other and types — and the assertions are the things a
 * user would notice if they broke: the message appears without a reload, the
 * badge moves for the person who is not looking, the typing line shows, and the
 * unread count clears when the messages are actually on screen.
 *
 *   node scripts/verify-chat-ui.mjs        (needs `npm run dev` running)
 */
import { readFileSync, mkdirSync } from 'node:fs';
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\n⏭  Chat UI checks skipped — Playwright is not installed.');
  console.log('   npm i -D playwright && npx playwright install chromium\n');
  process.exit(0);
}
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const ROOT = process.cwd();
const SHOTS = process.argv[2] ?? `${ROOT}/.chat-ui-shots`;
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const pass = [], fails = [];
const check = (n, ok, d = '') => {
  (ok ? pass : fails).push(`${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`);
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`);
};

async function makeUser(name, roleName = 'Staff') {
  const id = `chatui-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]?.id ?? null]);
  const perms = (await pool.query(
    `SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id
      WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return {
    id, name, perms, roleName,
    token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' }),
    user,
  };
}

/** Plant a Tupo session in localStorage exactly as the SSO callback would. */
const seed = (u) => ({
  tupo_token: u.token,
  tupo_user: JSON.stringify(u.user),
  tupo_permissions: JSON.stringify([]),
  // AuthContext stores this as {keys, name}, not a bare array.
  tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }),
});

const BASE = 'http://localhost:5194';
const browser = await chromium.launch();
const alice = await makeUser('Ada Umutoni');
const bob = await makeUser('Bosco Rugema');

const contexts = [];
async function openAs(u, width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, seed(u));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/chat`, { waitUntil: 'networkidle' });
  contexts.push(ctx);
  return { page, errors };
}

try {
  const A = await openAs(alice);
  const B = await openAs(bob);

  check('the chat screen renders for a signed-in user',
    await A.page.getByRole('heading', { name: 'Chat', exact: true }).isVisible());

  /* ── Start a DM ───────────────────────────────────────────────────────── */

  await A.page.getByRole('button', { name: 'New conversation' }).click();
  await A.page.getByRole('dialog').waitFor({ state: 'visible' });
  check('the new-conversation dialog opens', true);

  await A.page.getByLabel('Search people').fill('Bosco');
  await A.page.getByRole('button', { name: /Bosco Rugema/ }).first().click();
  await A.page.getByRole('button', { name: 'Open chat' }).click();
  await A.page.getByRole('dialog').waitFor({ state: 'detached' });

  await A.page.waitForSelector('#composer', { timeout: 8000 });
  check('opening a DM lands in the conversation with a composer', true);
  await A.page.screenshot({ path: `${SHOTS}/01-alice-dm-open.png` });

  /* ── Send, and see it arrive on the other side ────────────────────────── */

  const text = `Hello Bosco — ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(text);
  await A.page.locator('#composer').press('Enter');

  const aliceThread = A.page.locator('section[aria-label]');
  await aliceThread.getByText(text).waitFor({ timeout: 5000 });
  check('the sender sees their own message immediately', true);

  // Bob never reloads. If this appears, the socket delivered it.
  const bobRow = B.page.locator('li', { hasText: 'Ada Umutoni' }).first();
  await bobRow.waitFor({ timeout: 8000 });
  check('the conversation appears in the recipient sidebar without a reload', true);

  // The badge carries its count in its accessible name — which is also how a
  // screen-reader user learns there is something unread, so asserting on it
  // tests the thing that actually has to work.
  const badge = B.page.getByLabel(/^\d+ unread/).first();
  check('the recipient gets an unread badge while looking elsewhere',
    await badge.isVisible({ timeout: 6000 }).catch(() => false));
  await B.page.screenshot({ path: `${SHOTS}/02-bob-badge.png` });

  await bobRow.click();
  const bobThread = B.page.locator('section[aria-label]');
  await bobThread.getByText(text).waitFor({ timeout: 8000 });
  check('the recipient can open it and read the message', true);

  /* ── Typing ───────────────────────────────────────────────────────────── */

  await B.page.locator('#composer').waitFor();
  await B.page.locator('#composer').type('typing something', { delay: 30 });
  const typingLine = A.page.getByText(/is typing/);
  check('a typing indicator reaches the other person',
    await typingLine.isVisible({ timeout: 6000 }).catch(() => false));
  await A.page.screenshot({ path: `${SHOTS}/03-alice-typing.png` });

  /* ── Reply back ───────────────────────────────────────────────────────── */

  const reply = `Got it — ${randomBytes(3).toString('hex')}`;
  await B.page.locator('#composer').fill(reply);
  await B.page.locator('#composer').press('Enter');
  await aliceThread.getByText(reply).waitFor({ timeout: 8000 });
  check('a reply arrives live in the open conversation', true);

  /* ── Unread clears on read ────────────────────────────────────────────── */

  // Alice has it open and is at the bottom, so it should mark itself read.
  await A.page.waitForTimeout(1200);
  const { rows: watermark } = await pool.query(
    `SELECT m.unread_count FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.user_id = $1 AND c.type = 'dm'`, [alice.id]);
  check('having the conversation open and scrolled to the bottom clears unread',
    watermark[0]?.unread_count === 0, `unread ${watermark[0]?.unread_count}`);

  /* ── Persistence ──────────────────────────────────────────────────────── */

  await A.page.reload({ waitUntil: 'networkidle' });
  await A.page.waitForTimeout(1200);
  check('history survives a reload',
    await A.page.locator('section[aria-label]').getByText(text)
      .isVisible({ timeout: 8000 }).catch(() => false));

  /* ── Drafts ───────────────────────────────────────────────────────────── */

  await A.page.locator('#composer').fill('an unfinished thought');
  await A.page.waitForTimeout(1400); // let the debounced save land
  await A.page.reload({ waitUntil: 'networkidle' });
  await A.page.waitForSelector('#composer');
  await A.page.waitForTimeout(800);
  check('an unsent draft survives a reload',
    (await A.page.locator('#composer').inputValue()) === 'an unfinished thought',
    await A.page.locator('#composer').inputValue());
  await A.page.locator('#composer').fill('');

  /* ── Responsive ───────────────────────────────────────────────────────── */

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  await phone.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, seed(alice));
  const P = await phone.newPage();
  contexts.push(phone);
  await P.goto(`${BASE}/app/chat`, { waitUntil: 'networkidle' });
  await P.waitForTimeout(900);

  const composerOnList = await P.locator('#composer').isVisible().catch(() => false);
  check('on a phone the list is the screen — no conversation auto-opens',
    !composerOnList);
  await P.screenshot({ path: `${SHOTS}/04-phone-list.png` });

  await P.locator('li', { hasText: 'Bosco Rugema' }).first().click();
  await P.waitForSelector('#composer', { timeout: 6000 });
  check('tapping a conversation on a phone pushes to the thread', true);
  check('and Back is offered to return',
    await P.getByRole('button', { name: 'Back to conversations' }).isVisible());
  await P.screenshot({ path: `${SHOTS}/05-phone-thread.png` });

  const scrollsSideways = await P.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('the phone layout does not scroll sideways', !scrollsSideways);

  /* ── Console hygiene ──────────────────────────────────────────────────── */

  const noise = [...A.errors, ...B.errors].filter(
    (e) => !/favicon|ResizeObserver|Download the React DevTools/i.test(e));
  check('no console errors in either browser', noise.length === 0,
    noise.slice(0, 2).join(' | '));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack?.split('\n').slice(0, 4).join('\n') : err}`);
  console.error(err);
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  const ids = [alice.id, bob.id];
  await pool.query(
    `DELETE FROM conversations WHERE created_by = ANY($1::text[]) OR id IN (
       SELECT conversation_id FROM conversation_members WHERE user_id = ANY($1::text[]))`, [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await pool.end();
}

console.log(`\n  ${pass.length} passed, ${fails.length} failed`);
console.log(`  screenshots → ${SHOTS}\n`);
if (fails.length) for (const f of fails) console.log('  ' + f);
process.exit(fails.length ? 1 : 0);
