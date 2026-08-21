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

/**
 * Wait for a locator to become visible, and report a boolean.
 *
 * NOT `locator.isVisible({ timeout })`. That method samples the DOM once and
 * returns immediately — its `timeout` bounds resolving the selector, not
 * waiting for the element to appear. Using it for anything that follows a
 * network round trip reads as "the feature is broken" when the truth is "the
 * response had not arrived yet" — exactly the false failure it produced here
 * for edit and delete, both of which were working the whole time.
 */
const visible = (locator, ms = 6000) =>
  locator.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

const hidden = (locator, ms = 6000) =>
  locator.waitFor({ state: 'hidden', timeout: ms }).then(() => true).catch(() => false);

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

  const aliceThread = A.page.getByRole('log', { name: 'Messages' });
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
    await visible(badge, 6000));
  await B.page.screenshot({ path: `${SHOTS}/02-bob-badge.png` });

  await bobRow.click();
  const bobThread = B.page.getByRole('log', { name: 'Messages' });
  await bobThread.getByText(text).waitFor({ timeout: 8000 });
  check('the recipient can open it and read the message', true);

  /* ── Typing ───────────────────────────────────────────────────────────── */

  await B.page.locator('#composer').waitFor();
  await B.page.locator('#composer').type('typing something', { delay: 30 });
  const typingLine = A.page.getByText(/is typing/);
  check('a typing indicator reaches the other person',
    await visible(typingLine, 6000));
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
    await visible(A.page.getByRole('log', { name: 'Messages' }).getByText(text).first(), 8000));

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

  /* ── Rich text ────────────────────────────────────────────────────────── */

  const formatted = `**bold${randomBytes(2).toString('hex')}** and \`code\` and *italic*`;
  await A.page.locator('#composer').fill(formatted);
  await A.page.locator('#composer').press('Enter');

  check('bold renders as bold, not as asterisks',
    await visible(aliceThread.locator('strong', { hasText: /^bold/ }).first()));
  check('inline code renders as code',
    await visible(aliceThread.locator('code', { hasText: 'code' }).first()));

  // The property this whole rendering path exists to guarantee: a message body
  // must never become markup.
  const xss = '<img src=x onerror="window.__pwned=1">';
  await A.page.locator('#composer').fill(xss);
  await A.page.locator('#composer').press('Enter');
  const xssShown = await visible(aliceThread.getByText(xss).first());
  check('a message body is never interpreted as HTML',
    xssShown && (await A.page.evaluate(() => window.__pwned)) === undefined);

  /* ── Reactions ────────────────────────────────────────────────────────── */

  const reactTarget = `React to me — ${randomBytes(3).toString('hex')}`;
  await B.page.locator('#composer').fill(reactTarget);
  await B.page.locator('#composer').press('Enter');
  const reactRow = aliceThread.locator('li', { hasText: reactTarget }).first();
  await reactRow.waitFor({ timeout: 8000 });

  await reactRow.hover();
  await reactRow.getByRole('button', { name: 'React with 👍' }).click();
  check('a one-tap reaction appears for the reactor',
    await visible(reactRow.getByRole('button', { name: /^👍 1/ })));

  const bobReactRow = bobThread.locator('li', { hasText: reactTarget }).first();
  check('and reaches the other person live',
    await visible(bobReactRow.getByRole('button', { name: /^👍 1/ })));

  await reactRow.getByRole('button', { name: /^👍 1/ }).click();
  check('clicking your own reaction removes it',
    await hidden(reactRow.getByRole('button', { name: /^👍 \d/ })));

  /* ── Emoji picker ─────────────────────────────────────────────────────── */

  await A.page.getByRole('button', { name: 'Insert emoji' }).click();
  const picker = A.page.getByRole('dialog', { name: 'Choose an emoji' });
  check('the emoji picker opens', await visible(picker, 3000));
  await A.page.getByLabel('Search emoji').fill('rocket');
  await picker.getByRole('button', { name: '🚀' }).first().click();
  check('picking an emoji inserts it into the composer',
    (await A.page.locator('#composer').inputValue()).includes('🚀'),
    await A.page.locator('#composer').inputValue());
  await A.page.locator('#composer').fill('');

  /* ── Edit and delete ──────────────────────────────────────────────────── */

  const editable = `Edit me — ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(editable);
  await A.page.locator('#composer').press('Enter');
  const editRow = aliceThread.locator('li', { hasText: editable }).first();
  await editRow.waitFor({ timeout: 8000 });

  await editRow.hover();
  await editRow.getByRole('button', { name: 'Edit message' }).click();
  const editBox = A.page.getByLabel('Edit message text');
  check('editing happens in place, not in a dialog', await visible(editBox, 3000));

  await editBox.fill(`${editable} (fixed)`);
  await editBox.press('Enter');
  check('the edit lands and is marked as edited',
    await visible(aliceThread.getByText('(edited)').first()));
  check('and the other side sees the new text',
    await visible(bobThread.getByText(`${editable} (fixed)`).first()));

  // Bob must not be offered an edit control on someone else's message.
  const bobViewOfAlice = bobThread.locator('li', { hasText: `${editable} (fixed)` }).first();
  await bobViewOfAlice.hover();
  check('no edit control is offered on someone else’s message',
    (await bobViewOfAlice.getByRole('button', { name: 'Edit message' }).count()) === 0);

  const editedRow = aliceThread.locator('li', { hasText: `${editable} (fixed)` }).first();
  await editedRow.hover();
  await editedRow.getByRole('button', { name: 'Delete message' }).click();
  const confirmBox = A.page.getByRole('dialog', { name: 'Confirm deletion' });
  check('deletion asks first', await visible(confirmBox, 3000));

  await confirmBox.getByRole('button', { name: 'Delete' }).click();
  check('a deleted message becomes a tombstone rather than vanishing',
    await visible(aliceThread.getByText('This message was deleted').first()));
  check('and the tombstone reaches the other person live',
    await visible(bobThread.getByText('This message was deleted').first()));
  await A.page.screenshot({ path: `${SHOTS}/06-alice-phase2.png` });

  /* ── Quote reply ──────────────────────────────────────────────────────── */

  const quotable = `Quote me — ${randomBytes(3).toString('hex')}`;
  await B.page.locator('#composer').fill(quotable);
  await B.page.locator('#composer').press('Enter');
  const quotableRow = aliceThread.locator('li', { hasText: quotable }).first();
  await quotableRow.waitFor({ timeout: 8000 });

  await quotableRow.hover();
  await quotableRow.getByRole('button', { name: 'Quote reply' }).click();
  check('choosing to quote shows what is being answered above the composer',
    await visible(A.page.getByText(/Replying to Bosco Rugema/)));

  const answer = `Answered — ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(answer);
  await A.page.locator('#composer').press('Enter');
  const answerRow = aliceThread.locator('li', { hasText: answer }).first();
  await answerRow.waitFor({ timeout: 8000 });
  check('the sent message carries the quote block',
    await visible(answerRow.getByRole('button', { name: new RegExp(quotable) })));
  check('and the reply preview is cleared after sending',
    (await A.page.getByText(/Replying to/).count()) === 0);

  /* ── Threads ──────────────────────────────────────────────────────────── */

  const threadRoot = `Thread root — ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(threadRoot);
  await A.page.locator('#composer').press('Enter');
  const rootRow = aliceThread.locator('li', { hasText: threadRoot }).first();
  await rootRow.waitFor({ timeout: 8000 });

  await rootRow.hover();
  await rootRow.getByRole('button', { name: 'Reply in thread' }).click();
  const threadPane = A.page.getByRole('complementary', { name: 'Thread' });
  check('a thread opens in its own pane', await visible(threadPane, 4000));
  check('and repeats the message it is about, so the subject is never off-screen',
    await visible(threadPane.getByText(threadRoot).first()));

  const threadReply = `In the thread — ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#thread-composer').fill(threadReply);
  await A.page.locator('#thread-composer').press('Enter');
  check('a thread reply appears in the thread',
    await visible(threadPane.getByText(threadReply).first()));
  check('and NOT in the main channel flow',
    (await aliceThread.getByText(threadReply).count()) === 0);
  check('while the parent gains a reply count',
    await visible(aliceThread.getByRole('button', { name: /1 reply/ }).first()));

  await A.page.screenshot({ path: `${SHOTS}/07-alice-thread.png` });
  await threadPane.getByRole('button', { name: 'Close thread' }).click();
  check('the thread closes', await hidden(threadPane, 3000));

  /* ── Pin ──────────────────────────────────────────────────────────────── */

  await rootRow.hover();
  await rootRow.getByRole('button', { name: 'Pin message' }).click();
  check('a pinned message is surfaced in a bar above the conversation',
    await visible(A.page.getByRole('button', { name: new RegExp(threadRoot) }).first()));
  check('and pinning is announced in the room',
    await visible(aliceThread.getByText(/pinned a message/).first()));
  await A.page.screenshot({ path: `${SHOTS}/08-alice-pinned.png` });

  /* ── Save ─────────────────────────────────────────────────────────────── */

  await rootRow.hover();
  await rootRow.getByRole('button', { name: 'Save message' }).click();
  await A.page.getByRole('button', { name: 'Saved items', exact: true }).click();
  const savedPane = A.page.getByRole('complementary', { name: 'Saved items' });
  check('saved items open in their own pane', await visible(savedPane, 4000));
  check('and the saved message is listed with the conversation it came from',
    await visible(savedPane.getByText(threadRoot).first()));
  await savedPane.getByRole('button', { name: 'Close saved items' }).click();

  /* ── Forward ──────────────────────────────────────────────────────────── */

  await rootRow.hover();
  await rootRow.getByRole('button', { name: 'Forward message' }).click();
  const fwd = A.page.getByRole('dialog', { name: /Forward message/ });
  check('the forward dialog opens', await visible(fwd, 4000));
  check('and previews exactly what is about to be sent, and whose words they are',
    await visible(fwd.getByText(threadRoot).first())
      && await visible(fwd.getByText(/From You|From Ada Umutoni/).first()));
  await fwd.getByRole('button', { name: 'Cancel' }).click();

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
