#!/usr/bin/env node
/**
 * verify:composer:perf — what one keystroke costs (chat experience plan 0.4,
 * gap G-02).
 *
 * Opens a conversation with 180 messages at 6× CPU throttling (a low-end
 * phone), types 60 characters, and reads the probe in lib/perf.ts:
 *   - message-row renders caused by typing (target 0);
 *   - keystroke cost p50 / p95 (target < 16 ms / < 50 ms).
 *
 *   npm run verify:composer:perf        (needs `npm run dev`)
 *   PERF_REPORT_ONLY=1 …                 print numbers, never fail (baseline)
 */
import { createSuite, sleep } from './lib/chatSuite.mjs';

const S = createSuite('verify:composer:perf', 'vcx-');
const reportOnly = process.env.PERF_REPORT_ONLY === '1';
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN; };

try {
  await S.launch();
  const ada = await S.makeUser('Ada Perf');
  const bosco = await S.makeUser('Bosco Perf');
  const conv = await S.channel(ada, [bosco], 'perf');
  S.step('seed 180 messages');
  const lines = ['Morning everyone', 'Homework 5.3 is due Friday — **show your working**', 'Can someone share the notes from today? https://example.org/notes',
    'Yes, posting them now 👍', 'Remember the field trip form @Ada Perf', 'Thanks!'];
  await S.bulk([bosco, bosco, ada], conv, Array.from({ length: 180 }, (_, i) => `${lines[i % lines.length]} (${i})`));

  const { page, ctx } = await S.openAs(ada, conv, { query: 'perf=1' });
  await page.locator('li[data-message-row]').nth(150).waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.locator('#composer').click();
  await sleep(500);
  await page.evaluate(() => { window.__tupoPerf.rowRenders = 0; window.__tupoPerf.keyLatencies = []; });

  S.step('type 60 characters at 6× CPU throttle');
  await page.locator('#composer').pressSequentially('The quick brown fox jumps over the lazy dog, then naps. 1234', { delay: 60 });
  await sleep(1500);
  const perf = await page.evaluate(() => ({ rowRenders: window.__tupoPerf.rowRenders, lat: window.__tupoPerf.keyLatencies }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const p50 = pct(perf.lat, 50);
  const p95 = pct(perf.lat, 95);
  const rowsPerKey = perf.rowRenders / Math.max(1, perf.lat.length);
  console.log(`\n  keystrokes measured: ${perf.lat.length}`);
  console.log(`  keystroke cost p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms`);
  console.log(`  message-row renders while typing: ${perf.rowRenders} (${rowsPerKey.toFixed(1)} per key)`);
  if (reportOnly) {
    S.check('baseline recorded', perf.lat.length > 40, `${perf.lat.length} samples`);
  } else {
    S.check('typing renders no message rows', perf.rowRenders === 0, `${perf.rowRenders}`);
    S.check('keystroke cost p50 < 16 ms', p50 < 16, `${p50.toFixed(1)} ms`);
    S.check('keystroke cost p95 < 50 ms', p95 < 50, `${p95.toFixed(1)} ms`);
  }
} catch (e) {
  S.check('suite ran to the end', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
  await S.finish();
}
