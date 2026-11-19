#!/usr/bin/env node
/**
 * verify:chat:replies — replies people can see (chat experience plan;
 * replies report §6, criteria 1–8).
 *
 *   1  quotes never widen a bubble past its column; no sideways page scroll (R-01)
 *   2  who replied and when is visible without opening anything; one tap shows
 *      the latest replies in place (R-02, R-03)
 *   3  on a phone a thread is full screen, Back closes it, the URL has thread= (R-05)
 *   4  thread replies have the same actions as main-flow messages (R-04)
 *   5  a quote reply to my message notifies me / badges me (R-09)
 *   6  after jumping to a quoted message, one tap returns to the reply (R-10)
 *   7  phone long-press opens a labelled bottom sheet, targets ≥ 44 px (C-02)
 *   8  a conversation with unread messages opens at the "New messages" line (C-03)
 *
 * Screenshots of every screen land in SHOTS (default .chat-visual/).
 *
 *   npm run verify:chat:replies          (needs `npm run dev`)
 */
import { mkdirSync } from 'node:fs';
import { createSuite, sleep, waitTrue } from './lib/chatSuite.mjs';

const SHOTS = process.argv[2] ?? '.chat-visual';
mkdirSync(SHOTS, { recursive: true });
const S = createSuite('verify:chat:replies', 'vcx-');

/** No horizontal page scroll, and every bubble inside its row. */
async function layoutOk(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const pageScroll = doc.scrollWidth - window.innerWidth;
    const offenders = [];
    for (const b of document.querySelectorAll('.message-body')) {
      const r = b.getBoundingClientRect();
      const row = b.closest('li')?.getBoundingClientRect();
      if (row && (r.left < row.left - 1 || r.right > row.right + 1)) offenders.push(b.textContent?.slice(0, 40));
    }
    return { pageScroll, offenders };
  });
}

try {
  await S.launch();
  const ada = await S.makeUser('Ada Umutoni');
  const bosco = await S.makeUser('Bosco Rugema');
  const claire = await S.makeUser('Claire Mukamana');
  const didier = await S.makeUser('Didier Habimana');
  const conv = await S.channel(ada, [bosco, claire, didier], 's4-maths');

  const long = await S.post(bosco, conv, 'Reminder: the S4 maths test moves to Thursday 08:00 in Room 12. Bring a calculator and a geometry set, and revise chapters 4 to 6 (quadratics, inequalities, and sequences).');
  for (const [u, t] of [[claire, 'Noted, thanks'], [didier, 'Will it cover chapter 7?'], [bosco, 'Only 4 to 6']]) await S.post(u, conv, t);
  const root = await S.post(claire, conv, "Who can share last week's homework solutions for exercise 5.3? I missed Tuesday.");
  await S.reply(didier, conv, root.id, 'I have them, sending a photo in a minute');
  await S.reply(bosco, conv, root.id, 'Question 4 had a mistake in the book, the answer is x = -3 not 3');
  await S.reply(didier, conv, root.id, 'Here: 1) 12  2) 7/3  3) x>4  4) x=-3  5) 18');
  await S.reply(claire, conv, root.id, 'Thank you both!');
  await S.reply(bosco, conv, root.id, 'Also check 5.3 q6, many people got it wrong', true);
  await S.post(didier, conv, 'Is the library open on Saturday?');
  await S.post(claire, conv, 'Thursday works for me', { replyToId: long.id });
  await S.post(ada, conv, 'Good morning class, please read the reminder above about the test.', { replyToId: long.id });
  await S.post(bosco, conv, 'Ok madam');

  /* ── 1. R-01 layout at three widths ── */
  S.step('1 · quotes stay inside their bubbles (R-01)');
  for (const [w, h, touch] of [[360, 760, true], [390, 844, true], [1440, 900, false]]) {
    const { page } = await S.openAs(ada, conv, { width: w, height: h, touch });
    await sleep(1500);
    await page.screenshot({ path: `${SHOTS}/channel-${w}.png` });
    const { pageScroll, offenders } = await layoutOk(page);
    S.check(`${w}px: no sideways page scroll`, pageScroll <= 1, `${pageScroll}px`);
    S.check(`${w}px: every bubble inside its row`, offenders.length === 0, offenders.join(' | '));
    if (w === 390) {
      const ownVisible = await page.getByText('Good morning class, please read').first().isVisible();
      S.check('390px: own reply text visible', ownVisible);
      const chip = await page.evaluate(() => {
        const li = [...document.querySelectorAll('li.sticky')][0];
        return li ? getComputedStyle(li).backgroundColor : 'none';
      });
      S.check('date strip is opaque (C-01)', chip !== 'none' && chip !== 'rgba(0, 0, 0, 0)', chip);
    }
  }

  /* ── 2. R-02 / R-03 summary line and inline expansion ── */
  S.step('2 · replies visible in place (R-02, R-03)');
  const desk = await S.openAs(ada, conv);
  const P = desk.page;
  const rootRow = P.locator(`#msg-${root.id}`);
  await rootRow.scrollIntoViewIfNeeded();
  const summary = rootRow.locator('[data-thread-summary]');
  const hasSummary = await summary.isVisible().catch(() => false);
  S.check('summary line under the root', hasSummary);
  if (hasSummary) {
    const label = (await summary.innerText()).replace(/\s+/g, ' ');
    S.check('summary names who replied', /Didier|Bosco/.test(label) && /5 replies/.test(label), label);
    S.check('summary shows replier faces', (await summary.locator('[data-avatar]').count()) >= 2);
    const box = await summary.boundingBox();
    S.check('summary is a comfortable target', (box?.height ?? 0) >= 28, `${box?.height}px`);
    await summary.click();
    const inline = rootRow.locator('[data-inline-thread]');
    const opened = await inline.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
    S.check('one tap expands replies in place', opened);
    if (opened) {
      const shown = await inline.locator('li[data-message-row]').count();
      S.check('latest 3 replies shown inline', shown === 3, `${shown}`);
      S.check('earlier replies offered', await inline.getByRole('button', { name: /earlier repl/i }).isVisible().catch(() => false));
      const composer = inline.locator('textarea[data-inline-composer]');
      S.check('inline reply box present', await composer.isVisible().catch(() => false));
      await composer.fill('Inline answer from Ada');
      await composer.press('Enter');
      const appended = await inline.getByText('Inline answer from Ada').waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      S.check('inline reply appears in place', appended);
      await P.screenshot({ path: `${SHOTS}/inline-thread-1440.png` });
    }
  }
  const echoRow = P.locator('li[data-message-row]').filter({ hasText: 'many people got it wrong' }).first();
  S.check('thread copy in the channel says where it came from (R-07)',
    await echoRow.getByText(/Replied in a thread/i).isVisible().catch(() => false));

  /* ── 4. R-04 actions on thread replies (desktop panel) ── */
  S.step('4 · thread replies have actions (R-04)');
  await P.goto(`${P.url().split('?')[0]}?c=${conv.id}&thread=${root.id}`, { waitUntil: 'domcontentloaded' });
  const aside = P.locator('aside[aria-label="Thread"]');
  const panelOpen = await aside.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  S.check('?thread= opens the thread', panelOpen);
  if (panelOpen) {
    const reply = aside.locator('li[data-message-row]').filter({ hasText: 'Thank you both' }).first();
    await reply.hover();
    for (const name of ['Add reaction', 'Reply', 'More actions']) {
      S.check(`thread reply offers "${name}"`, await reply.getByRole('button', { name, exact: true }).count() > 0);
    }
    await P.screenshot({ path: `${SHOTS}/thread-panel-1440.png` });
  }

  /* ── 6. R-10 back to the reply after a quote jump ── */
  S.step('6 · back to the reply after jumping (R-10)');
  await P.goto(`${P.url().split('?')[0]}?c=${conv.id}`, { waitUntil: 'domcontentloaded' });
  await P.locator('#composer').waitFor();
  await sleep(1000);
  const quote = P.locator('li[data-message-row]').filter({ hasText: 'Good morning class' }).locator('button').filter({ hasText: 'Bosco' }).first();
  await quote.click();
  const back = P.getByRole('button', { name: /Back to reply/i });
  const backShown = await back.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  S.check('"Back to reply" offered after the jump', backShown);
  if (backShown) {
    await back.click();
    await sleep(800);
    const inView = await P.evaluate(() => {
      const li = [...document.querySelectorAll('li[data-message-row]')].find((l) => l.textContent?.includes('Good morning class'));
      const r = li?.getBoundingClientRect();
      return Boolean(r && r.top >= 0 && r.bottom <= window.innerHeight);
    });
    S.check('back returns to the reply', inView);
  }

  /* ── 5. R-09 being replied to ── */
  S.step('5 · a quote reply to my message badges me (R-09)');
  const mine = await S.post(didier, conv, 'Didier asks: is the quiz open book?');
  await S.post(claire, conv, 'Yes, open book', { replyToId: mine.id });
  await sleep(800);
  const list = await S.api('/api/chat/conversations', didier);
  const row = (list.conversations ?? list).find((c) => c.id === conv.id);
  S.check('replied-to author gains a mention', (row?.unreadMentions ?? 0) >= 1, `unreadMentions=${row?.unreadMentions}`);

  /* ── 3 + 7. phone: full-screen thread, Back, action sheet ── */
  S.step('3 · phone thread is a full-screen page (R-05)');
  const phone = await S.openAs(ada, conv, { width: 390, height: 844, touch: true });
  const Q = phone.page;
  const pRoot = Q.locator(`#msg-${root.id}`);
  await pRoot.scrollIntoViewIfNeeded();
  const openThread = pRoot.locator('[data-thread-open]').first();
  if (await openThread.count()) await openThread.tap();
  else await pRoot.locator('[data-thread-summary]').tap();
  const pAside = Q.locator('aside[aria-label="Thread"]');
  if (!(await pAside.isVisible().catch(() => false))) {
    // The inline view opened instead; its "Open thread" goes full screen.
    await Q.getByRole('button', { name: /Open thread/i }).first().tap().catch(() => {});
  }
  const pOpen = await pAside.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  S.check('thread opens on the phone', pOpen);
  if (pOpen) {
    const box = await pAside.boundingBox();
    S.check('phone thread is full width', Math.round(box?.width ?? 0) >= 389, `${box?.width}px`);
    S.check('URL names the thread', Q.url().includes(`thread=${root.id}`), Q.url());
    await Q.screenshot({ path: `${SHOTS}/thread-390.png` });
    await Q.goBack();
    S.check('Back closes the thread', await pAside.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false));
  }

  S.step('7 · phone long-press opens a labelled sheet (C-02)');
  const target = Q.locator('li[data-message-row]').filter({ hasText: 'Is the library open' }).first();
  await target.scrollIntoViewIfNeeded();
  const b = await target.boundingBox();
  if (b) {
    const cdp = await phone.ctx.newCDPSession(Q);
    const pt = { x: b.x + 90, y: b.y + b.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  const sheet = Q.locator('[role="dialog"][aria-label="Message actions"]');
  const sheetOpen = await sheet.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
  S.check('long-press opens the action sheet', sheetOpen);
  if (sheetOpen) {
    await Q.screenshot({ path: `${SHOTS}/action-sheet-390.png` });
    for (const name of ['Reply', 'Forward', 'Copy text']) {
      S.check(`sheet offers "${name}"`, await sheet.getByRole('button', { name, exact: true }).count() > 0);
    }
    const small = await sheet.locator('button').evaluateAll((bs) => bs.filter((x) => x.getBoundingClientRect().height < 44).map((x) => x.textContent?.trim() || x.getAttribute('aria-label')));
    S.check('every sheet target ≥ 44 px', small.length === 0, small.join(', '));
    const inside = await sheet.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight + 1);
    S.check('sheet fully on screen', inside);
    S.check('desktop hover bar hidden on touch', await target.locator('button[aria-label="Quote reply"]:visible').count() === 0);
    await Q.keyboard.press('Escape');
  }

  /* ── 8. C-03 open at the first unread ── */
  S.step('8 · opens at the first unread (C-03)');
  const busy = await S.channel(bosco, [ada], 'busy');
  await S.post(ada, busy, 'I read up to here');
  await S.bulk([bosco], busy, Array.from({ length: 45 }, (_, i) => `Unread message number ${i + 1} with some ordinary length text`));
  const fresh = await S.openAs(ada, busy);
  await sleep(2000);
  const dividerInView = await fresh.page.evaluate(() => {
    const d = document.querySelector('[aria-label="New messages"]');
    const r = d?.getBoundingClientRect();
    return Boolean(r && r.top >= 0 && r.top < window.innerHeight * 0.6);
  });
  S.check('"New messages" line is on screen when opened', dividerInView);
  await fresh.page.screenshot({ path: `${SHOTS}/first-unread-1440.png` });
} catch (e) {
  S.check('suite ran to the end', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
  await S.finish();
}
