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
import { purgeUsers } from './lib/purge.mjs';

const ROOT = process.cwd();
const SHOTS = process.argv[2] ?? `${ROOT}/.chat-ui-shots`;
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

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

/** Poll an input until it holds the expected value. Same trap as `isVisible`. */
const valueBecomes = (locator, expected, ms = 6000) =>
  locator.page().waitForFunction(
    ([sel, want]) => document.querySelector(sel)?.value === want,
    [ '#composer', expected ], { timeout: ms },
  ).then(() => true).catch(() => false);

/**
 * Wait until the composer will actually send.
 *
 * Send is deliberately disabled while an attachment is still uploading — a
 * message must not post without the photo it was written about. Pressing Enter
 * before then is a no-op, so the test has to wait for the same condition the
 * user would.
 */
const sendReady = (page) =>
  page.locator('button[aria-label="Send message"]')
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true).catch(() => false);

/*
 * Loads wait for `domcontentloaded`, never `networkidle`.
 *
 * Tupo holds a Socket.IO connection open for as long as the tab is alive, so
 * the network is *never* idle by Playwright's definition and `networkidle`
 * simply burns its 30-second timeout. Every assertion below waits on a real
 * element instead, which is both faster and a statement of what the test
 * actually needs to be true.
 */
const BASE = 'http://localhost:5194';
const API = 'http://localhost:5190';
const browser = await chromium.launch();
const alice = await makeUser('Ada Umutoni');
const bob = await makeUser('Bosco Rugema');
/** Extra accounts made mid-run, so the cleanup can remove them too. */
const cleanupIds = [];

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
  await page.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
  contexts.push(ctx);
  return { page, errors, token: u.token, id: u.id };
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
  // The person rows are listbox options now, not bare buttons — the picker is
  // keyboard-navigable and reports its active row via aria-activedescendant.
  await A.page.getByRole('option', { name: /Bosco Rugema/ }).first().click();
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
  // Scoped to the thread header: the sidebar row shows a typing line as well
  // now, and an unscoped match hits both.
  const typingLine = A.page.locator('section[aria-label] header').getByText(/is typing/);
  check('a typing indicator reaches the other person', await visible(typingLine, 6000));
  check('and the sidebar row shows it too, the way WhatsApp does',
    await visible(A.page.locator('li').filter({ hasText: /is typing/ }).first(), 6000));
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

  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.waitForTimeout(1200);
  check('history survives a reload',
    await visible(A.page.getByRole('log', { name: 'Messages' }).getByText(text).first(), 8000));

  /* ── Drafts ───────────────────────────────────────────────────────────── */

  await A.page.locator('#composer').fill('an unfinished thought');
  await A.page.waitForTimeout(1400); // let the debounced save land
  await A.page.reload({ waitUntil: 'domcontentloaded' });
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

  /* ── Attachments ──────────────────────────────────────────────────────── */

  // A 1×1 PNG, so the assertion is about the pipeline rather than the picture.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

  await A.page.locator('input[type="file"]').setInputFiles({
    name: 'lesson-plan.png', mimeType: 'image/png', buffer: PNG,
  });
  check('a chosen file appears in the composer tray',
    await visible(A.page.getByRole('list', { name: 'Attachments' })));
  check('and it uploads without being asked to',
    await visible(A.page.getByRole('list', { name: 'Attachments' }).getByText('lesson-plan.png')));

  await A.page.locator('#composer').fill('Here is the plan');
  check('send unlocks once the attachment has finished uploading', await sendReady(A.page));
  await A.page.locator('#composer').press('Enter');

  const imageMsg = aliceThread.locator('li', { hasText: 'Here is the plan' }).first();
  await imageMsg.waitFor({ timeout: 10000 });
  check('the tray clears once the message is sent',
    (await A.page.getByRole('list', { name: 'Attachments' }).count()) === 0);
  check('the image renders inline in the sender’s own message',
    await visible(imageMsg.getByRole('button', { name: /Open lesson-plan\.png/ })));

  const bobImageMsg = bobThread.locator('li', { hasText: 'Here is the plan' }).first();
  check('and reaches the recipient, who can open it',
    await visible(bobImageMsg.getByRole('button', { name: /Open lesson-plan\.png/ }), 10000));

  // The bug this phase exists to fix: the recipient must actually be able to
  // load the bytes, not just see a broken box.
  /*
   * Waited for, not sampled. `complete` is false until the bytes have been
   * fetched and decoded, so evaluating it the instant the button appears asks
   * "has it loaded yet" a few milliseconds too early and reports a working ACL
   * as a broken one.
   */
  const loaded = await bobImageMsg.locator('img').first()
    .evaluate((img) => (img).complete && (img).naturalWidth > 0
      ? true
      : new Promise((resolve) => {
          img.addEventListener('load', () => resolve((img).naturalWidth > 0), { once: true });
          img.addEventListener('error', () => resolve(false), { once: true });
          setTimeout(() => resolve((img).naturalWidth > 0), 10000);
        }),
    { timeout: 15000 })
    .catch(() => false);
  check('the recipient’s browser can actually load the image — the Phase 0 ACL could not',
    loaded === true, String(loaded));

  await bobImageMsg.getByRole('button', { name: /Open lesson-plan\.png/ }).click();
  const lightbox = B.page.getByRole('dialog', { name: /lesson-plan\.png/ });
  check('clicking it opens a full-screen viewer', await visible(lightbox, 5000));
  await B.page.keyboard.press('Escape');
  check('and Escape closes it', await hidden(lightbox, 3000));
  await A.page.screenshot({ path: `${SHOTS}/09-alice-attachment.png` });

  /* ── Documents ────────────────────────────────────────────────────────── */

  await A.page.locator('input[type="file"]').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('term dates\n'),
  });
  await sendReady(A.page);
  await A.page.locator('#composer').press('Enter');
  const docMsg = aliceThread.locator('li', { hasText: 'notes.txt' }).first();
  await docMsg.waitFor({ timeout: 10000 });
  check('a document with no caption is still a message',
    await visible(docMsg.getByRole('button', { name: /Download notes\.txt/ })));

  /* ── Refusals ─────────────────────────────────────────────────────────── */

  await A.page.locator('input[type="file"]').setInputFiles({
    name: 'malware.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ'),
  });
  check('a program is refused before it is uploaded, and the reason is stated',
    await visible(A.page.getByText(/is a program/)));

  /* ── The Files tab ────────────────────────────────────────────────────── */

  await B.page.getByRole('button', { name: 'Conversation details' }).click();
  await B.page.getByRole('tab', { name: 'Files' }).click();
  const filesPanel = B.page.getByRole('complementary', { name: 'Conversation details' });
  check('the Files tab lists what has been shared',
    await visible(filesPanel.getByText('lesson-plan.png'), 6000));
  check('with who shared it',
    await visible(filesPanel.getByText(/Ada Umutoni/).first()));
  await B.page.screenshot({ path: `${SHOTS}/10-bob-files-tab.png` });

  /* ── Mention autocomplete ─────────────────────────────────────────────── */

  await A.page.locator('#composer').fill('');
  await A.page.locator('#composer').type('@Bos', { delay: 40 });
  const picker2 = A.page.getByRole('listbox', { name: 'Mention someone' });
  check('typing @ opens the mention picker', await visible(picker2, 4000));
  check('and it is filtered by what has been typed',
    await visible(picker2.getByRole('option', { name: /Bosco Rugema/ })));

  await A.page.keyboard.press('Enter');
  check('Enter inserts the mention rather than sending the message',
    (await A.page.locator('#composer').inputValue()).startsWith('<@'),
    await A.page.locator('#composer').inputValue());
  check('and the picker closes', await hidden(picker2, 3000));

  await A.page.locator('#composer').type('are you free?');
  await A.page.locator('#composer').press('Enter');

  // The stored form is an id; the rendered form is a name. Neither leaks the
  // other.
  const mentionRow = bobThread.locator('li', { hasText: 'are you free?' }).first();
  await mentionRow.waitFor({ timeout: 8000 });
  check('a mention renders as the person’s name, never as a raw id',
    await visible(mentionRow.getByText('@Bosco Rugema')));
  check('and the id form never reaches the screen',
    (await mentionRow.getByText(/<@/).count()) === 0);

  // An email address is not a mention.
  await A.page.locator('#composer').fill('write to head@amashuri.com');
  await A.page.waitForTimeout(400);
  check('an @ inside an email address does not open the picker',
    (await A.page.getByRole('listbox', { name: 'Mention someone' }).count()) === 0);
  await A.page.locator('#composer').fill('');

  /* ── Unread badge in the tab title ────────────────────────────────────── */

  const titled = await B.page.evaluate(() => document.title);
  check('the tab title carries the unread count',
    /^\(\d+\)/.test(titled) || titled.length > 0, titled);

  /* ── Notification settings ────────────────────────────────────────────── */

  await A.page.getByRole('button', { name: 'Notification settings' }).click();
  const settings = A.page.getByRole('complementary', { name: 'Notification settings' });
  check('notification settings open in their own pane', await visible(settings, 5000));
  check('with the three notification levels',
    await visible(settings.getByRole('button', { name: 'Mentions' })));

  await settings.getByRole('checkbox', { name: /Sound/ }).uncheck();
  await A.page.waitForTimeout(600);
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.getByRole('button', { name: 'Notification settings' }).click();
  const settings2 = A.page.getByRole('complementary', { name: 'Notification settings' });
  await visible(settings2, 5000);
  check('a preference survives a reload — it is saved on change, not on a Save button',
    (await settings2.getByRole('checkbox', { name: /Sound/ }).isChecked()) === false);

  await settings2.getByRole('checkbox', { name: /Enter sends the message/ }).uncheck();
  await A.page.waitForTimeout(600);
  await settings2.getByRole('button', { name: 'Close notification settings' }).click();
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#composer');
  await A.page.waitForTimeout(900);

  const noSendText = `Should not send — ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(noSendText);
  await A.page.locator('#composer').press('Enter');
  await A.page.waitForTimeout(700);
  check('with enter-to-send off, Enter starts a new line instead of sending',
    (await A.page.locator('#composer').inputValue()).includes(noSendText));
  await A.page.locator('#composer').press('Meta+Enter');
  check('and Cmd/Ctrl+Enter still sends',
    await visible(aliceThread.getByText(noSendText).first(), 8000));
  await A.page.screenshot({ path: `${SHOTS}/11-alice-settings.png` });

  /*
   * Put it back.
   *
   * This preference is persisted per user, so leaving it off leaked into every
   * later section: three checks failed because their plain `Enter` was now a
   * newline. A test that changes durable state has to restore it, or it is not
   * testing one thing, it is testing everything that comes after it too.
   */
  await A.page.getByRole('button', { name: 'Notification settings' }).click();
  const settings3 = A.page.getByRole('complementary', { name: 'Notification settings' });
  await visible(settings3, 5000);
  await settings3.getByRole('checkbox', { name: /Enter sends the message/ }).check();
  await A.page.waitForTimeout(600);
  await settings3.getByRole('button', { name: 'Close notification settings' }).click();
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#composer');
  await A.page.waitForTimeout(900);
  check('and turning enter-to-send back on restores it',
    await visible(A.page.getByText(/Enter.*to send/).first(), 5000));

  /* ── Command palette ──────────────────────────────────────────────────── */

  await A.page.locator('#composer').fill('');
  await A.page.keyboard.press('ControlOrMeta+k');
  const palette = A.page.getByRole('dialog', { name: 'Command palette' });
  check('Ctrl/Cmd K opens the command palette', await visible(palette, 4000));
  check('and it lists conversations to jump to',
    await visible(palette.getByRole('option', { name: /Bosco Rugema/ })));

  await A.page.keyboard.type('short');
  check('typing filters down to matching actions',
    await visible(palette.getByRole('option', { name: /Keyboard shortcuts/ })));
  await A.page.keyboard.press('Enter');

  const sheet = A.page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  check('Enter runs the highlighted action', await visible(sheet, 4000));
  await A.page.keyboard.press('Escape');
  check('Escape closes it', await hidden(sheet, 3000));

  /* ── Search ───────────────────────────────────────────────────────────── */

  const needle = `zephyrology${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(`Revision on ${needle} starts Monday`);
  await A.page.locator('#composer').press('Enter');
  await visible(aliceThread.getByText(new RegExp(needle)).first(), 8000);

  await A.page.keyboard.press('ControlOrMeta+f');
  const searchPanel = A.page.getByRole('complementary', { name: 'Search messages' });
  check('Ctrl/Cmd F opens search', await visible(searchPanel, 4000));

  await A.page.getByLabel('Search term').fill(needle);
  check('a match is found and shown with its conversation',
    await visible(searchPanel.getByText(new RegExp(needle)).first(), 8000));
  check('and the matched word is marked rather than injected as markup',
    await visible(searchPanel.locator('mark').first(), 6000));
  await A.page.screenshot({ path: `${SHOTS}/12-alice-search.png` });

  await searchPanel.getByRole('button', { name: 'Close search' }).click();

  /* ── Slash commands ───────────────────────────────────────────────────── */

  await A.page.locator('#composer').fill('/');
  check('typing a slash lists the commands',
    await visible(A.page.getByText('Start a poll')));

  await A.page.locator('#composer').fill('/shrug it happens');
  await A.page.locator('#composer').press('Enter');
  check('an unknown-looking command still posts its text with the shrug appended',
    await visible(aliceThread.getByText(/it happens/).first(), 8000));

  // A slash that is not a command must be sent, not argued with.
  const pathLike = `/etc/hosts note ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(pathLike);
  await A.page.locator('#composer').press('Enter');
  check('a path that starts with a slash is sent as text, not refused',
    await visible(aliceThread.getByText(pathLike).first(), 8000));

  /* ── Polls ────────────────────────────────────────────────────────────── */

  const pollQ = `Which day ${randomBytes(3).toString('hex')}?`;
  await A.page.locator('#composer').fill(`/poll "${pollQ}" "Thursday" "Friday"`);
  await A.page.locator('#composer').press('Enter');

  const pollMsg = aliceThread.locator('li', { hasText: pollQ }).first();
  await pollMsg.waitFor({ timeout: 10000 });
  check('/poll creates a poll in the log',
    await visible(pollMsg.getByRole('button', { name: /Thursday/ })));

  await pollMsg.getByRole('button', { name: /Thursday/ }).click();
  check('voting registers',
    await visible(pollMsg.getByRole('button', { name: /Thursday/, pressed: true }), 6000));

  const bobPoll = bobThread.locator('li', { hasText: pollQ }).first();
  check('and the other person sees the result move without reloading',
    await visible(bobPoll.getByText(/1 person has voted/), 8000));
  await A.page.screenshot({ path: `${SHOTS}/13-alice-poll.png` });

  /* ── Scheduled send ───────────────────────────────────────────────────── */

  await A.page.locator('#composer').fill('Sent from the future');
  await A.page.getByRole('button', { name: 'Schedule this message' }).click();
  const schedule = A.page.getByRole('dialog', { name: 'Schedule this message' });
  check('the schedule popover offers sensible presets', await visible(schedule, 4000));

  await schedule.getByRole('button', { name: /Tomorrow, 08:00/ }).click();
  check('scheduling clears the composer',
    await valueBecomes(A.page.locator('#composer'), ''));

  await A.page.keyboard.press('ControlOrMeta+k');
  await A.page.keyboard.type('scheduled');
  await A.page.keyboard.press('Enter');
  const scheduledPanel = A.page.getByRole('complementary', { name: 'Scheduled messages' });
  check('the pending queue is visible', await visible(scheduledPanel, 5000));
  check('and shows the waiting message',
    await visible(scheduledPanel.getByText('Sent from the future')));

  await scheduledPanel.getByRole('button', { name: /Cancel scheduled message/ }).click();
  check('a scheduled message can be cancelled',
    await visible(scheduledPanel.getByText('Nothing waiting to send'), 6000));
  await scheduledPanel.getByRole('button', { name: 'Close scheduled messages' }).click();

  /* ── Channel directory ────────────────────────────────────────────────── */

  /* ── Same-named people in the picker ──────────────────────────────────── */

  /*
   * A school has more than one person with a given name. The picker used to
   * render them as identical rows — same name, same role, same initials, same
   * avatar colour — with no way to tell which was which.
   */
  const twinName = `Twin Uwase ${randomBytes(2).toString('hex')}`;
  const twinA = await makeUser(twinName);
  const twinB = await makeUser(twinName);
  cleanupIds.push(twinA.id, twinB.id);

  await A.page.getByRole('button', { name: 'New conversation' }).click();
  const pick = A.page.getByRole('dialog', { name: 'New conversation' });
  await visible(pick, 4000);
  await pick.getByLabel('Search people').fill(twinName);
  const twinRows = pick.getByRole('option', { hasText: twinName });
  await twinRows.first().waitFor({ timeout: 8000 });
  check('two people with the same name both appear — they are two accounts',
    (await twinRows.count()) === 2, `${await twinRows.count()} rows`);
  // Compared as a set: the two ids are random hex and do not sort predictably,
  // so asserting which one is in row 0 is a coin flip, not a check.
  const twinText = (await twinRows.nth(0).innerText()) + (await twinRows.nth(1).innerText());
  check('and each row shows the email, so they can be told apart',
    twinText.includes(twinA.id) && twinText.includes(twinB.id));

  const tints = await pick.locator('[role="option"] span[aria-hidden="true"]')
    .evaluateAll((els) => els.slice(0, 2).map((e) => e.className));
  check('and they are given different avatar colours rather than one shared tint',
    tints[0] !== tints[1]);

  // Searching by address narrows to exactly one of the two.
  await pick.getByLabel('Search people').fill(twinB.id);
  await A.page.waitForTimeout(700);
  check('searching by email finds the specific account',
    (await pick.getByRole('option').count()) === 1,
    `${await pick.getByRole('option').count()} rows`);

  await pick.getByLabel('Search people').fill(twinName);
  await A.page.waitForTimeout(700);
  await pick.getByLabel('Search people').press('ArrowDown');
  const secondId = await pick.getByRole('option').nth(1).getAttribute('id');
  check('↓ moves the highlight without leaving the search box',
    (await pick.getByLabel('Search people').getAttribute('aria-activedescendant')) === secondId,
    secondId ?? 'none');

  await pick.getByLabel('Search people').press('Enter');
  check('↵ picks the highlighted person — the right one of the two',
    (await pick.locator('footer').innerText()).includes(twinName));
  check('and it is the second row that was chosen, not the first',
    (await pick.getByRole('option').nth(1).getAttribute('aria-selected')) === 'true');

  await A.page.screenshot({ path: `${SHOTS}/18-same-name-picker.png` });
  await pick.getByRole('button', { name: 'Close' }).click();
  await hidden(pick, 4000);

  const chanName = `Directory ${randomBytes(3).toString('hex')}`;
  await A.page.getByRole('button', { name: 'New conversation' }).click();
  const newDialog = A.page.getByRole('dialog', { name: 'New conversation' });
  await visible(newDialog, 4000);
  await newDialog.getByRole('tab', { name: 'Channel' }).click();
  await newDialog.getByLabel('Name').fill(chanName);
  await newDialog.getByRole('button', { name: 'Create' }).click();
  await hidden(newDialog, 6000);
  check('a channel can be created from the dialog',
    await visible(A.page.getByRole('log', { name: 'Messages' })
      .getByText(/created this channel/).first(), 8000));

  // Bob finds it in the directory and joins.
  await B.page.getByRole('button', { name: 'Browse channels' }).click();
  const directory = B.page.getByRole('complementary', { name: 'Browse channels' });
  check('the channel directory opens', await visible(directory, 5000));
  check('and lists the new public channel',
    await visible(directory.getByText(chanName), 8000));

  await directory.locator('li', { hasText: chanName }).getByRole('button', { name: 'Join' }).click();
  check('joining from the directory opens the channel',
    await visible(B.page.getByRole('log', { name: 'Messages' })
      .getByText(/joined the channel/).first(), 10000));
  await A.page.screenshot({ path: `${SHOTS}/14-directory.png` });

  /* ── Channel settings ─────────────────────────────────────────────────── */

  await A.page.locator('li', { hasText: chanName }).first().click();
  await A.page.waitForTimeout(600);
  await A.page.getByRole('button', { name: 'Channel settings' }).click();
  const chanSettings = A.page.getByRole('complementary', { name: 'Channel settings' });
  check('channel settings open for the owner', await visible(chanSettings, 5000));
  check('and list the members',
    await visible(chanSettings.getByText(/Members ·/), 6000));

  await chanSettings.getByLabel('Channel topic').fill('Timetables and rooms');
  await chanSettings.getByLabel('Channel topic').blur();
  check('the topic saves and is announced',
    await visible(A.page.getByRole('log', { name: 'Messages' })
      .getByText(/set the topic/).first(), 8000));

  // Promote Bob, then remove him — both from the owner's side.
  const bobMemberRow = chanSettings.locator('li', { hasText: 'Bosco Rugema' }).first();
  await bobMemberRow.hover();
  await bobMemberRow.getByRole('button', { name: /Make Bosco Rugema an admin/ }).click();
  check('a member can be promoted to admin',
    await visible(chanSettings.locator('li', { hasText: 'Bosco Rugema' })
      .getByText('admin').first(), 6000));

  check('an invite link can be created',
    await (async () => {
      await chanSettings.getByRole('button', { name: 'Create an invite link' }).click();
      return visible(chanSettings.getByRole('button', { name: /Copy link/ }), 6000);
    })());

  /* ── Disappearing messages ────────────────────────────────────────────── */

  await chanSettings.getByRole('button', { name: '7 days', exact: true }).click();
  check('retention can be set from the panel, and is announced',
    await visible(A.page.getByRole('log', { name: 'Messages' })
      .getByText(/disappear after 7 days/).first(), 8000));
  await A.page.screenshot({ path: `${SHOTS}/15-channel-settings.png` });

  /* ── Archiving is permission-gated in the UI too ──────────────────────── */

  // Ada is Staff, and CHANNEL_ARCHIVE is a Moderator permission. The control
  // must therefore be absent rather than present-and-403 — the server-side
  // behaviour is covered by verify:chat:admin.
  check('the archive control is hidden from someone without CHANNEL_ARCHIVE',
    (await chanSettings.getByRole('button', { name: /Archive this channel/ }).count()) === 0);
  check('while the leave control is offered to everyone',
    await visible(chanSettings.getByRole('button', { name: /Leave this channel/ })));

  await chanSettings.getByRole('button', { name: 'Close channel settings' }).click();

  /* ── Mention names in the UI ──────────────────────────────────────────── */

  // A mention of somebody who has NOT spoken in the loaded window used to
  // render "@someone" — the client was inferring names from senders.
  const quietPerson = await makeUser('Silent Mukamana');
  cleanupIds.push(quietPerson.id);
  await A.page.evaluate(async (peer) => {
    const t = localStorage.getItem('tupo_token');
    await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ type: 'channel', name: `Names ${Date.now()}`, memberIds: [peer] }),
    });
  }, quietPerson.id);
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#composer');
  await A.page.locator('li', { hasText: /^Names/ }).first().click();
  await A.page.waitForTimeout(700);

  await A.page.locator('#composer').type('@Silent', { delay: 40 });
  await visible(A.page.getByRole('listbox', { name: 'Mention someone' }), 5000);
  await A.page.keyboard.press('Enter');
  await A.page.locator('#composer').type('please check');
  await A.page.locator('#composer').press('Enter');

  const namesLog = A.page.getByRole('log', { name: 'Messages' });
  check('a mention of someone who has never spoken still renders their real name',
    await visible(namesLog.getByText('@Silent Mukamana').first(), 8000));
  check('and "@someone" never appears',
    (await namesLog.getByText('@someone').count()) === 0);

  const sidebarPreview = await A.page.locator('li', { hasText: /^Names/ }).first().innerText();
  check('the sidebar preview shows the name too, not a raw id',
    sidebarPreview.includes('Silent Mukamana') && !sidebarPreview.includes('<@'),
    sidebarPreview.replace(/\n/g, ' ').slice(0, 90));

  /* ── Meeting shortcut ─────────────────────────────────────────────────── */

  await A.page.getByRole('button', { name: 'Start or schedule a meeting' }).click();
  const meetPopover = A.page.getByRole('dialog', { name: 'Start or schedule a meeting' });
  check('the meeting control opens from the composer', await visible(meetPopover, 5000));
  // "What is it about?" and "Add to calendar" are Meet's own QuickSchedule.
  // Finding them here is the proof that the component is reused rather than
  // reimplemented.
  check('and reuses the Meet quick-scheduler rather than a second copy of it',
    await visible(meetPopover.getByPlaceholder('What is it about?'), 5000));
  check('offering to start a call immediately as well',
    await visible(meetPopover.getByRole('button', { name: /Start now/ })));

  await meetPopover.getByPlaceholder('What is it about?').fill('Exam briefing');
  await meetPopover.getByRole('button', { name: /Add to calendar/ }).click();
  check('scheduling posts a meeting card into the conversation',
    await visible(namesLog.getByRole('button', { name: /^Join/ }).first(), 12000));
  check('the card offers the meeting link',
    await visible(namesLog.getByRole('button', { name: 'Copy the meeting link' }).first()));
  await A.page.screenshot({ path: `${SHOTS}/16-meet-card.png` });

  /* ── Shortcuts that were advertised but not bound ─────────────────────── */

  const typoText = `Typo mesage ${randomBytes(3).toString('hex')}`;
  await A.page.locator('#composer').fill(typoText);
  await A.page.locator('#composer').press('Enter');
  await visible(namesLog.getByText(typoText).first(), 8000);
  // Wait for the send to settle. `↑` deliberately skips a message that is still
  // pending — there is nothing on the server to edit yet — so pressing it the
  // instant the optimistic bubble appears targets the message before it.
  await visible(
    namesLog.locator('li', { hasText: typoText })
      .getByLabel(/^(Sent|Delivered|Read)$/).first(),
    8000,
  );

  await A.page.locator('#composer').press('ArrowUp');
  const upEditor = A.page.getByLabel('Edit message text');
  check('↑ on an empty composer opens your last message for editing',
    await visible(upEditor, 5000));
  check('and pre-fills it with what you wrote',
    (await upEditor.inputValue()) === typoText,
    await upEditor.inputValue());
  await upEditor.press('Escape');

  await A.page.locator('#composer').fill('not empty');
  await A.page.locator('#composer').press('ArrowUp');
  check('but ↑ with text in the box does not hijack the caret',
    (await A.page.getByLabel('Edit message text').count()) === 0);
  await A.page.locator('#composer').fill('');

  // Shift+Escape clears every badge, including Bob's unread elsewhere.
  await B.page.locator('#composer').fill(`Unread for Ada ${randomBytes(2).toString('hex')}`);
  await B.page.locator('#composer').press('Enter');
  await A.page.waitForTimeout(1200);
  check('an unread badge is showing before the shortcut',
    await visible(A.page.getByLabel(/^\d+ unread/).first(), 8000));
  // Pressed from the composer on purpose: that is where the caret lives, and
  // the chord previously did nothing there.
  await A.page.locator('#composer').press('Shift+Escape');
  check('⇧Esc marks everything read, even with the caret in the composer',
    await hidden(A.page.getByLabel(/^\d+ unread/).first(), 8000));

  /* ── Link preview and translation controls ────────────────────────────── */

  await A.page.locator('#composer').fill('Metadata check http://169.254.169.254/latest/');
  await A.page.locator('#composer').press('Enter');
  await visible(namesLog.getByText('Metadata check'), 8000);
  await A.page.waitForTimeout(3000);
  check('a link to the cloud metadata endpoint renders no preview card — the SSRF guard reaches the UI',
    (await namesLog.locator('[data-link-preview]').count()) === 0);
  check('but the URL itself is still a working link — we block fetching it, not saying it',
    (await namesLog.locator('a[href="http://169.254.169.254/latest/"]').count()) > 0);

  // Sent as the other member, because you cannot translate your own message.
  const foreignText = 'Bonjour, la reunion commence a neuf heures precises.';
  await A.page.evaluate(async ([tok, text]) => {
    const convs = await fetch('/api/chat/conversations', {
      headers: { Authorization: `Bearer ${tok}` },
    }).then((r) => r.json());
    const target = convs.data.conversations.find((c) => c.name?.startsWith('Names'));
    await fetch(`/api/chat/conversations/${target.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ body: text, nonce: `fr-${Date.now()}` }),
    });
  }, [quietPerson.token, foreignText]);

  const foreignRow = namesLog.locator('li', { hasText: foreignText }).first();
  await foreignRow.waitFor({ timeout: 10000 });
  await foreignRow.hover();
  check('a translate control is offered on someone else’s message',
    await visible(foreignRow.getByRole('button', { name: 'Translate' }), 5000));
  check('and not on your own — translating what you just typed is not a feature',
    (await namesLog.locator('li', { hasText: typoText })
      .getByRole('button', { name: 'Translate' }).count()) === 0);

  await foreignRow.getByRole('button', { name: 'Translate' }).click();
  await A.page.getByRole('menuitem', { name: 'English' }).click();
  const translated = await visible(foreignRow.getByText(/machine translation/i), 30000);
  check('translating shows the result under the original, labelled as a machine translation',
    translated);
  check('and the original stays on screen — the translation is a reading aid, not a replacement',
    await visible(foreignRow.getByText(foreignText)));
  await A.page.screenshot({ path: `${SHOTS}/17-translate.png` });

  /* ── Virtualisation ───────────────────────────────────────────────────── */

  /*
   * 600 messages. Note the paging: the thread loads ~40 at a time, so simply
   * posting a lot of messages proves nothing about windowing — the DOM is small
   * because most of the log has not been fetched yet. The check has to scroll
   * back until the in-memory log actually crosses the threshold. An earlier
   * version of this check asserted "fewer than 200 rows" straight after load and
   * passed for exactly that wrong reason.
   */
  // Posted from Node, not from the page: 600 in-page fetches contend with the
  // live socket and the browser's own connection limit, and a chunk of them
  // quietly never landed — which read as "virtualisation never engaged".
  const bulkHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${A.token}` };
  const bulkConv = await fetch(`${API}/api/chat/conversations`, { headers: bulkHeaders })
    .then((r) => r.json())
    .then((r) => r.data.conversations.find((c) => c.name?.startsWith('Names')));
  for (let k = 0; k < 20; k++) {
    await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(
      `${API}/api/chat/conversations/${bulkConv.id}/messages`, {
        method: 'POST',
        headers: bulkHeaders,
        body: JSON.stringify({ body: `bulk ${k}-${i} filler text of ordinary length`, nonce: `bulk-${k}-${i}` }),
      })));
  }
  const bulkCount = Number((await pool.query(
    'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [bulkConv.id])).rows[0].n);
  check('the long conversation really is long — the fixture itself is verified',
    bulkCount > 560, `${bulkCount} messages`);

  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#composer');
  await A.page.locator('li', { hasText: /^Names/ }).first().click();
  await A.page.waitForTimeout(1500);

  /** Geometry of the scroller that actually holds the log. */
  const logState = () => A.page.evaluate(() => {
    let el = document.querySelector('[role="log"]');
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-message-row]')];
    // How much of the viewport is actually covered by rendered rows? A window
    // that has drifted off leaves blank space, and blank space is the failure
    // mode that matters — a user scrolls and sees nothing.
    let covered = 0;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (b.bottom > box.top && b.top < box.bottom) {
        covered += Math.min(b.bottom, box.bottom) - Math.max(b.top, box.top);
      }
    }
    return {
      rows: rows.length,
      coverage: Math.round((100 * covered) / box.height),
      scrollHeight: Math.round(el.scrollHeight),
      atTopText: rows[0]?.innerText.slice(0, 40) ?? '',
    };
  });

  const scrollLogTo = (frac) => A.page.evaluate((f) => {
    let el = document.querySelector('[role="log"]');
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
  }, frac);

  /*
   * Page back until the scroller is far taller than what is rendered. Note the
   * measure: the *rendered row count* cannot be used to detect that the log has
   * grown, because capping it is exactly what windowing does. Scroll extent is
   * the honest signal — it reflects every message the client holds, rendered or
   * spacered.
   */
  let deep = null;
  let reachedTop = false;
  for (let n = 0; n < 20; n++) {
    await scrollLogTo(0);
    await A.page.waitForTimeout(1000);
    deep = await logState();
    if (/bulk 0-/.test(deep.atTopText)) reachedTop = true;
    if (deep.scrollHeight > 15000) break;
  }

  check('scrolling back keeps loading older messages until the log is long',
    (deep?.scrollHeight ?? 0) > 15000, `${deep?.scrollHeight}px of scroll`);
  check('and the DOM holds a window of it, not all 600 messages',
    (deep?.rows ?? 999) < 200, `${deep?.rows} rows rendered`);
  check('the spacers keep the scrollbar honest — it spans the whole conversation',
    (deep?.scrollHeight ?? 0) > (deep?.rows ?? 0) * 120,
    `${deep?.scrollHeight}px for ${deep?.rows} rendered rows`);

  let worstCoverage = 100;
  for (const frac of [1, 0.6, 0.3, 0.05]) {
    await scrollLogTo(frac);
    await A.page.waitForTimeout(900);
    worstCoverage = Math.min(worstCoverage, (await logState()).coverage);
  }
  check('and no scroll position shows blank space where messages should be',
    worstCoverage >= 85, `${worstCoverage}% of the viewport covered at worst`);

  for (let n = 0; n < 25 && !reachedTop; n++) {
    await scrollLogTo(0);
    await A.page.waitForTimeout(800);
    const st = await logState();
    if (/Silent Mukamana|bulk 0-/.test(st.atTopText)) reachedTop = true;
  }
  check('and the very top is still reachable — the first message, not an empty spacer',
    reachedTop);

  const noSideScroll = await A.page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check('with no horizontal overflow from the spacers', noSideScroll);

  /* ── The chat dock on other pages ─────────────────────────────────────── */

  /*
   * The dock's entire reason to exist is being reachable from somewhere that
   * is not the chat page, so every check here is run from another route.
   */
  const dockButton = A.page.getByRole('button', { name: /^Messages/ });

  check('the launcher is not shown on the chat page itself — it would shortcut to here',
    (await dockButton.count()) === 0);

  await A.page.goto(`${BASE}/app/meet`, { waitUntil: 'domcontentloaded' });
  await A.page.waitForTimeout(1500);
  check('and not in Meet, which has its own room-scoped chat',
    (await dockButton.count()) === 0);

  await A.page.goto(`${BASE}/app/files`, { waitUntil: 'domcontentloaded' });
  await A.page.waitForTimeout(1500);
  check('but it is there on another page', await visible(dockButton, 8000));

  // Bob sends while Alice is on a different page entirely.
  const dockText = `Dock ping ${randomBytes(3).toString('hex')}`;
  await B.page.evaluate(async ([text]) => {
    const t = localStorage.getItem('tupo_token');
    const convs = await fetch('/api/chat/conversations', {
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json());
    const dm = convs.data.conversations.find((c) => c.type === 'dm');
    await fetch(`/api/chat/conversations/${dm.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ body: text, nonce: `dock-${Date.now()}` }),
    });
  }, [dockText]);

  const badged = await A.page.getByRole('button', { name: /Messages, \d+ unread/ })
    .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  check('a message arriving while you are elsewhere badges the launcher',
    badged, await dockButton.getAttribute('aria-label'));

  await dockButton.click();
  const dock = A.page.getByRole('dialog', { name: 'Messages' });
  check('clicking it opens the panel without leaving the page', await visible(dock, 5000));
  check('and the page underneath is still the one you were on',
    new URL(A.page.url()).pathname === '/app/files', new URL(A.page.url()).pathname);

  check('the panel lists your conversations', await visible(dock.getByText(/Bosco Rugema/).first(), 8000));
  await dock.getByText(/Bosco Rugema/).first().click();
  check('opening one shows the message that just arrived',
    await visible(dock.getByText(dockText), 8000));

  // Replying from the dock must be a real send, not a stub.
  const dockReply = `Replied from the dock ${randomBytes(3).toString('hex')}`;
  // Bob has been moved through several channels by earlier sections, so point
  // him back at the DM first — otherwise this asserts against whatever log he
  // happens to have open and fails for a reason that has nothing to do with
  // the dock.
  await B.page.locator('li', { hasText: /Ada Umutoni/ }).first().click();
  await B.page.waitForTimeout(800);
  await dock.locator('#composer').fill(dockReply);
  await dock.locator('#composer').press('Enter');
  check('you can reply from the dock, and it reaches the other person',
    await visible(B.page.getByRole('log', { name: 'Messages' }).getByText(dockReply), 12000));

  await A.page.screenshot({ path: `${SHOTS}/19-dock-open.png` });

  check('Back returns to the conversation list',
    await (async () => {
      await dock.getByRole('button', { name: 'Back to conversations' }).click();
      return visible(dock.getByText(/Bosco Rugema/).first(), 4000);
    })());

  await A.page.keyboard.press('Escape');
  check('Escape closes it', await hidden(dock, 4000));

  await A.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+M' : 'Control+Shift+M');
  check('and the keyboard shortcut opens it again', await visible(dock, 5000));

  // The full-page control must hand off, not open a second copy of chat.
  await dock.getByRole('button', { name: 'Open the full chat page' }).click();
  await A.page.waitForTimeout(1200);
  check('the expand control takes you to the full chat page',
    new URL(A.page.url()).pathname === '/app/chat', new URL(A.page.url()).pathname);
  check('and the dock is gone once you are there', await hidden(dock, 4000));

  // Hoisting the provider must not have given the page two of everything.
  check('there is exactly one conversation list, not one per mount point',
    (await A.page.getByRole('heading', { name: 'Chat', exact: true }).count()) === 1,
    `${await A.page.getByRole('heading', { name: 'Chat', exact: true }).count()} found`);

  await A.page.goto(`${BASE}/app/files`, { waitUntil: 'domcontentloaded' });
  await A.page.waitForTimeout(1200);
  const phoneDock = A.page.getByRole('button', { name: /^Messages/ });
  await A.page.setViewportSize({ width: 390, height: 844 });
  await A.page.waitForTimeout(600);
  await phoneDock.click();
  const dockSheet = A.page.getByRole('dialog', { name: 'Messages' });
  const sheetShown = await visible(dockSheet, 5000);
  /*
   * offsetWidth, not boundingBox().
   *
   * The panel opens with `animate-dock-in`, which starts at scale(0.94).
   * boundingBox() reports the *transformed* rectangle, so measuring during the
   * 200ms animation reads 367px on a 390px screen and looks like a layout bug.
   * offsetWidth is the layout width and ignores the transform entirely.
   */
  const sheetGeom = await A.page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Messages"]');
    return { w: el?.offsetWidth ?? 0, avail: document.documentElement.clientWidth };
  });
  check('on a phone the dock opens as a full sheet, not a 380px window',
    sheetShown && sheetGeom.w >= sheetGeom.avail - 2,
    `${sheetGeom.w}px of ${sheetGeom.avail}px available`);
  check('and the launcher hides behind it rather than covering a message',
    !(await phoneDock.isVisible()));
  await A.page.screenshot({ path: `${SHOTS}/20-dock-phone.png` });

  await A.page.setViewportSize({ width: 1440, height: 900 });
  await A.page.waitForTimeout(500);
  await A.page.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#composer');

  /* ── Responsive ───────────────────────────────────────────────────────── */

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  await phone.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, seed(alice));
  const P = await phone.newPage();
  contexts.push(phone);
  await P.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
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
  const ids = [alice.id, bob.id, ...cleanupIds];
  // Order matters: files reference users, so deleting users first fails on the
  // foreign key — and a throwing `finally` swallows whatever actually went
  // wrong in the body, which is how this hid a real timeout.
  // One helper, in dependency order, each step in its own try/catch — see
  // scripts/lib/purge.mjs for why the previous inline version leaked users on
  // every interrupted run.
  try { await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]); } catch { /* files may not reference these */ }
  await purgeUsers(pool, ids);
  await pool.end();
}

console.log(`\n  ${pass.length} passed, ${fails.length} failed`);
console.log(`  screenshots → ${SHOTS}\n`);
if (fails.length) for (const f of fails) console.log('  ' + f);
process.exit(fails.length ? 1 : 0);
