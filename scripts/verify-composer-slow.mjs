#!/usr/bin/env node
/**
 * verify:composer:slow — typing and sending on a slow line (chat experience
 * plan, Phase 0; gaps G-01, G-03, G-04, G-05, G-06, G-07, G-10).
 *
 * Every case slows or breaks one request on purpose and asserts that what the
 * person typed is never changed or lost by the app.
 *
 *   npm run verify:composer:slow        (needs `npm run dev`)
 */
import { createSuite, sleep, waitTrue, delayRequests } from './lib/chatSuite.mjs';

const S = createSuite('verify:composer:slow', 'vcx-');
const composerValue = (page, sel = '#composer') => page.locator(sel).inputValue();

try {
  await S.launch();
  const ada = await S.makeUser('Ada Slow');
  const bosco = await S.makeUser('Bosco Slow');

  /* ── 1. G-01: a slow draft save never rewrites what is being typed ── */
  S.step('G-01 draft echo on a 2 s line');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const { page } = await S.openAs(ada, conv);
    await delayRequests(page, 'PUT', /\/draft$/, 2000);
    const box = page.locator('#composer');
    await box.click();
    await box.pressSequentially('I will come tomorow', { delay: 25 });
    await sleep(1100);                       // the 800 ms debounce fires; the PUT is now in flight
    for (let i = 0; i < 3; i++) await box.press('Backspace');
    await box.pressSequentially('rrow at 9', { delay: 25 });
    await sleep(1200);                       // a second save goes out
    await box.pressSequentially(' sharp', { delay: 25 });
    await sleep(4500);                       // both echoes have arrived by now
    const v = await composerValue(page);
    S.check('typed text survives every draft echo', v === 'I will come tomorrow at 9 sharp', JSON.stringify(v));
    await box.fill('');
    await sleep(1200);
  }

  /* ── 2. G-01: sending during a draft save never brings the text back ── */
  S.step('G-01 send while a draft save is in flight');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const { page } = await S.openAs(ada, conv);
    await delayRequests(page, 'PUT', /\/draft$/, 2500);
    const box = page.locator('#composer');
    const text = `ping ${Date.now()}`;
    await box.click();
    await box.pressSequentially(text, { delay: 20 });
    await sleep(1000);                       // save in flight
    await box.press('Enter');
    await sleep(4500);
    const v = await composerValue(page);
    S.check('composer stays empty after send', v === '', JSON.stringify(v));
    const copies = await page.locator('li[data-message-row]').filter({ hasText: text }).count();
    S.check('the message exists exactly once', copies === 1, `${copies} copies`);
  }

  /* ── 3. G-01: two tabs of the same person ── */
  S.step('G-01 two tabs: the typing tab is never overwritten');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const a = await S.openAs(ada, conv);
    const b = await S.openAs(ada, conv);
    await delayRequests(a.page, 'PUT', /\/draft$/, 1500);
    await b.page.locator('#composer').blur();
    const box = a.page.locator('#composer');
    await box.click();
    await box.pressSequentially('first part', { delay: 20 });
    await sleep(1100);
    await box.pressSequentially(' and more', { delay: 20 });
    await sleep(5000);
    const va = await composerValue(a.page);
    S.check('typing tab keeps its text', va === 'first part and more', JSON.stringify(va));
    const synced = await waitTrue(b.page, () => document.querySelector('#composer')?.value === 'first part and more', null, 8000);
    S.check('the other tab receives the draft', synced, JSON.stringify(await composerValue(b.page)));
    await box.fill('');
    await sleep(3500);
  }

  /* ── 4. G-06: Enter during IME composition never sends ── */
  S.step('G-06 IME composition');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const { page } = await S.openAs(ada, conv);
    const box = page.locator('#composer');
    await box.click();
    await box.pressSequentially('nihao', { delay: 20 });
    const before = await page.locator('li[data-message-row]').count();
    await page.evaluate(() => {
      const el = document.querySelector('#composer');
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    await sleep(800);
    const after = await page.locator('li[data-message-row]').count();
    S.check('nothing sent while composing', after === before && (await composerValue(page)).startsWith('nihao'),
      `rows ${before}→${after}, value ${JSON.stringify(await composerValue(page))}`);
    await box.fill('');
  }

  /* ── 5. G-03 / G-07: a slow thread reply keeps what is typed next ── */
  S.step('G-03 slow thread reply');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const root = await S.post(bosco, conv, `Thread root ${Date.now()}`);
    const { page } = await S.openAs(ada, conv, { query: `thread=${root.id}` });
    // Legacy and new thread send paths are both slowed: REST reply route and socket-less message POST.
    await delayRequests(page, 'POST', /\/replies$|\/messages$/, 3000);
    if (!(await page.locator('#thread-composer').isVisible().catch(() => false))) {
      const row = page.locator(`#msg-${root.id}`);
      await row.hover();
      await row.getByRole('button', { name: /^Reply( in thread)?$/ }).first().click();
    }
    const tbox = page.locator('#thread-composer');
    await tbox.waitFor({ timeout: 8000 });
    await tbox.click();
    await tbox.pressSequentially('first reply', { delay: 20 });
    await tbox.press('Enter');
    await sleep(300);
    await tbox.pressSequentially('next one', { delay: 20 });
    await sleep(4500);
    const v = await composerValue(page, '#thread-composer');
    S.check('text typed during the send is kept', v === 'next one', JSON.stringify(v));
    const landed = await page.locator('[aria-label="Thread messages"]').getByText('first reply').count();
    S.check('the first reply is shown in the thread', landed >= 1);
  }

  /* ── 6. G-04: a failed edit keeps the correction ── */
  S.step('G-04 failed edit');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const mine = await S.post(ada, conv, `Original ${Date.now()}`);
    const { page } = await S.openAs(ada, conv);
    await page.route((u) => /\/messages\/[^/]+$/.test(u.pathname), (route) =>
      (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"boom"}' }) : route.fallback()));
    const row = page.locator(`#msg-${mine.id}`);
    await row.hover();
    await row.getByRole('button', { name: 'Edit message' }).click();
    const edit = page.getByLabel('Edit message text');
    await edit.waitFor({ timeout: 5000 });
    await edit.fill('Corrected text');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const reopened = await waitTrue(page, () => document.querySelector('[aria-label="Edit message text"]')?.value === 'Corrected text', null, 6000);
    S.check('editor reopens with the attempted text', reopened);
    const told = await page.getByText(/edit was not saved|could not save/i).first().isVisible().catch(() => false);
    S.check('a toast says the edit failed', told);
    const rowText = await page.locator(`#msg-${mine.id}`).innerText();
    S.check("the row still shows the original until saved", /Original/.test(rowText));
  }

  /* ── 7. G-10: reconnect sends each queued message once ── */
  S.step('G-10 offline queue flushes once');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const { page, ctx } = await S.openAs(ada, conv);
    await sleep(1000);
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname)) posts.push(r.postDataJSON()?.nonce); });
    await ctx.setOffline(true);
    await sleep(2500);
    for (const t of ['offline one', 'offline two', 'offline three']) {
      await page.locator('#composer').fill(t);
      await page.locator('#composer').press('Enter');
      await sleep(200);
    }
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await sleep(9000);
    const unique = new Set(posts).size;
    S.check('three queued messages, three requests', posts.length === 3 && unique === 3, `${posts.length} POSTs, ${unique} nonces`);
    const shown = await page.locator('li[data-message-row]').filter({ hasText: /offline (one|two|three)/ }).count();
    S.check('each queued message appears once', shown === 3, `${shown} rows`);
  }

  /* ── 8. G-05: a send whose socket ack never comes still lands ── */
  S.step('G-05 dropped socket ack falls back to REST');
  {
    const conv = await S.channel(ada, [bosco], 'slow');
    const { page } = await S.openAs(ada, conv);
    await page.routeWebSocket(/socket\.io/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => { if (!(typeof m === 'string' && m.includes('"message:send"'))) server.send(m); });
      server.onMessage((m) => ws.send(m));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#composer').waitFor({ timeout: 20000 });
    await sleep(1500);
    const text = `half-open ${Date.now()}`;
    await page.locator('#composer').fill(text);
    await page.locator('#composer').press('Enter');
    const delivered = await waitTrue(page, (t) => {
      const row = [...document.querySelectorAll('li[data-message-row]')].find((li) => li.textContent?.includes(t));
      return Boolean(row && !row.querySelector('[aria-label="Sending"]') && !row.textContent?.includes('Sending…'));
    }, text, 15000);
    S.check('message settles within 15 s without a socket ack', delivered);
  }
} catch (e) {
  S.check('suite ran to the end', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
  await S.finish();
}
