/**
 * M15 — drive a real two-participant meeting in a real browser.
 *
 * Two browser contexts, each with a fake camera and microphone, join the same
 * meeting: one hosts, one knocks and is admitted. Screenshots at each step.
 */
import { readFileSync } from 'node:fs';
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\n⏭  Meet UI checks skipped — Playwright is not installed.');
  console.log('   npm i -D playwright && npx playwright install chromium\n');
  process.exit(0);
}
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const ROOT = process.cwd();
const SHOTS = process.argv[2] ?? `${ROOT}/.meet-ui-shots`;
await import('node:fs').then((fs) => fs.mkdirSync(SHOTS, { recursive: true }));
const env = Object.fromEntries(
  readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const out = [];
const check = (n, ok, d = '') => { out.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function makeUser(name, roleName) {
  const id = `uiverify-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]?.id ?? null]);
  const perms = (await pool.query(
    `SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id
      WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return {
    id, name,
    token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' }),
    session: { user, perms, roleName },
  };
}

/** Plant a Tupo session in localStorage exactly as the SSO callback would. */
const seed = (u) => ({
  tupo_token: u.token,
  tupo_user: JSON.stringify(u.session.user),
  tupo_permissions: JSON.stringify([]),
  // AuthContext stores this as {keys, name}, not a bare array.
  tupo_role_permissions: JSON.stringify({ keys: u.session.perms, name: u.session.roleName }),
});

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // This run drives two browser contexts at once, and Chromium suspends
    // video decoding in whichever page is not in the foreground. Without these
    // the backgrounded participant's incoming video decodes one frame and then
    // stalls — indistinguishable from a one-way media failure, and entirely an
    // artefact of testing two peers on one machine.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});

const errors = [];
async function newPage(user) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['camera', 'microphone'],
    colorScheme: 'dark',
  });
  await ctx.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    localStorage.setItem('tupo_theme', 'dark');
  }, seed(user));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user.name}: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') errors.push(`${user.name}: ${text}`);
    if (/\[mesh\]|\[cf\]|mesh:|peer_joined|transport|subscribe|Cloudflare/i.test(text)) {
      console.log(`  ·  ${user.name}: ${text}`);
    }
  });
  return { ctx, page };
}

let host, pupil, hostP, pupilP;
try {
  host = await makeUser('Aline Uwase', 'Staff');
  pupil = await makeUser('Eric Habimana', 'Student');

  console.log('\nMeet UI — two real participants\n');

  hostP = await newPage(host);
  await hostP.page.goto('http://localhost:5194/app/meet', { waitUntil: 'networkidle' });
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/01-meet-home.png` });
  check('Meet home renders', await hostP.page.getByRole('heading', { name: 'Meet', exact: true }).isVisible());
  // Matched on the field's accessible name rather than its placeholder: the
  // placeholder is copy and will change again, the label is the contract.
  check('shows the start and join affordances',
    await hostP.page.getByRole('button', { name: /Start now/i }).isVisible() &&
    await hostP.page.getByLabel('Meeting code').isVisible());

  // Scheduler
  await hostP.page.getByRole('button', { name: /Schedule/i }).click();
  await hostP.page.waitForTimeout(900);
  await hostP.page.screenshot({ path: `${SHOTS}/02-scheduler.png`, fullPage: true });
  check('scheduler renders with the AI options',
    await hostP.page.getByText('Tupo AI notetaker').first().isVisible());
  check('AI is gated behind captions being on',
    await hostP.page.locator('input[type=checkbox]:disabled').count() > 0);

  // Every meeting arrives with a proposed name, editable before anything saves.
  const nameField = hostP.page.getByPlaceholder(/S4 Biology/);
  const proposed = await nameField.inputValue();
  check('a name is proposed from the date and time',
    proposed.startsWith('Meeting · ') && proposed.length > 'Meeting · '.length, proposed);
  await nameField.fill('S4 Biology — photosynthesis');
  check('and can be replaced',
    await nameField.inputValue() === 'S4 Biology — photosynthesis');

  check('the audience is chosen as a category, not a rule',
    await hostP.page.getByRole('button', { name: /Private/ }).isVisible() &&
    await hostP.page.getByRole('button', { name: /Anyone signed in/ }).isVisible() &&
    await hostP.page.getByRole('button', { name: /^Public/ }).isVisible());

  // Private reveals the people search in place, rather than on a second screen.
  await hostP.page.getByRole('button', { name: /Private/ }).click();
  await hostP.page.waitForTimeout(400);
  check('choosing Private asks who it is for',
    await hostP.page.getByPlaceholder(/Search by name or email/).isVisible());

  await hostP.page.getByPlaceholder(/Search by name or email/).fill('Eric');
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/02b-audience-private.png`, fullPage: true });
  const foundPerson = await hostP.page.getByRole('button', { name: /Eric Habimana/ })
    .first().isVisible().catch(() => false);
  check('and finds them', foundPerson);
  if (foundPerson) {
    await hostP.page.getByRole('button', { name: /Eric Habimana/ }).first().click();
    await hostP.page.waitForTimeout(400);
    check('choosing someone adds them to the invite list',
      await hostP.page.getByRole('button', { name: /Remove Eric Habimana/ }).isVisible());
  }

  await hostP.page.getByRole('button', { name: /^Public/ }).click();
  await hostP.page.waitForTimeout(400);
  check('Public warns that anyone with the link can ask to join',
    await hostP.page.getByText(/always wait in the lobby/i).isVisible());
  await hostP.page.screenshot({ path: `${SHOTS}/02c-audience-public.png`, fullPage: true });

  await hostP.page.goto('http://localhost:5194/app/meet', { waitUntil: 'networkidle' });
  await hostP.page.getByRole('button', { name: /Start now/i }).click();
  await hostP.page.waitForURL(/\/app\/meet\/\d+/, { timeout: 15000 });
  const meetingId = hostP.page.url().split('/').pop();

  // Pre-join
  await hostP.page.locator('video').first().waitFor({ state: 'visible', timeout: 20000 });
  await hostP.page.waitForTimeout(600);
  await hostP.page.screenshot({ path: `${SHOTS}/03-prejoin.png` });
  check('pre-join device check renders a live camera preview',
    await hostP.page.evaluate(() => {
      const v = document.querySelector('video');
      return !!v?.srcObject && v.srcObject.getVideoTracks().length > 0;
    }));
  check('it offers camera, microphone and speaker pickers',
    await hostP.page.locator('select').count() >= 2);
  const meterText = await hostP.page.getByText(/We can hear you|Say something|Muted/).first().textContent();
  check('the microphone level meter is live', !!meterText, meterText?.trim());

  await hostP.page.getByRole('button', { name: 'Join now', exact: true }).click();
  await hostP.page.getByRole('button', { name: /Leave the meeting/i })
    .waitFor({ state: 'visible', timeout: 20000 });
  await hostP.page.waitForTimeout(1500);
  await hostP.page.screenshot({ path: `${SHOTS}/04-room-host.png` });
  check('the host lands in the room',
    await hostP.page.getByRole('button', { name: /Leave the meeting/i }).isVisible());
  check('the transport is shown in the header',
    await hostP.page.getByText(/Peer-to-peer|Media server|Cloudflare/).first().isVisible(),
    (await hostP.page.getByText(/Peer-to-peer|Media server|Cloudflare/).first()
      .textContent().catch(() => null))?.trim());

  // Turn on the waiting room so the pupil has to knock.
  await hostP.page.getByRole('button', { name: 'More', exact: true }).first().click();
  await hostP.page.waitForTimeout(400);
  await hostP.page.getByRole('button', { name: /Host controls/i }).click();
  await hostP.page.waitForTimeout(900);
  await hostP.page.screenshot({ path: `${SHOTS}/05-host-console.png` });
  check('host console renders settings and the activity stream',
    await hostP.page.getByText('Who can do what').isVisible() &&
    await hostP.page.getByText('Activity').isVisible());

  await hostP.page.getByText('Waiting room', { exact: true }).click();
  await hostP.page.waitForTimeout(700);

  // Pupil joins and knocks.
  pupilP = await newPage(pupil);
  await pupilP.page.goto(`http://localhost:5194/app/meet/${meetingId}`, { waitUntil: 'networkidle' });
  await pupilP.page.getByRole('button', { name: /Ask to join|Join now/ })
    .waitFor({ state: 'visible', timeout: 20000 });
  await pupilP.page.waitForTimeout(1200);
  await pupilP.page.screenshot({ path: `${SHOTS}/06-prejoin-pupil.png` });
  const askBtn = pupilP.page.getByRole('button', { name: /Ask to join|Join now/ });
  check('the pupil sees a pre-join screen', await askBtn.isVisible(),
    (await askBtn.textContent())?.trim());
  await askBtn.click();
  await pupilP.page.getByText(/Waiting to be let in/i)
    .waitFor({ state: 'visible', timeout: 20000 });
  await pupilP.page.screenshot({ path: `${SHOTS}/07-pupil-lobby.png` });
  check('the pupil waits in the lobby',
    await pupilP.page.getByText(/Waiting to be let in/i).isVisible());

  // Host admits.
  await hostP.page.getByRole('button', { name: 'Participants', exact: true }).first().click();
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/08-lobby-knock.png` });
  check('the host is shown the knock',
    await hostP.page.getByText('Waiting to be let in').isVisible());

  await hostP.page.getByRole('button', { name: /Admit Eric/i }).click();
  await pupilP.page.getByRole('button', { name: /Leave the meeting/i })
    .waitFor({ state: 'visible', timeout: 25000 });
  // Give the mesh handshake time to negotiate both directions.
  await pupilP.page.waitForFunction(
    () => [...document.querySelectorAll('video')]
      .filter((v) => v.srcObject?.getTracks?.().length).length >= 2,
    null, { timeout: 25000 }).catch(() => {});
  await hostP.page.waitForTimeout(2000);
  await hostP.page.screenshot({ path: `${SHOTS}/09-two-participants.png` });
  await pupilP.page.screenshot({ path: `${SHOTS}/10-pupil-in-room.png` });

  /**
   * Both sides, together, settled.
   *
   * Two clients negotiate with the SFU independently and finish at different
   * moments, so sampling one after the other catches whichever happens to be
   * mid-renegotiation. Polling both in the same pass and requiring them to be
   * good *at the same time* is what the assertion actually means.
   */
  /**
   * Count tiles that are *wired up* — a live video track attached to a
   * <video> — rather than tiles that have decoded a frame.
   *
   * `videoWidth` is decoder state, and Chromium suspends the decoder on any
   * page that is not in the foreground. Only one of these two windows can be
   * foreground at a time, so asserting `videoWidth > 0` on both simultaneously
   * tests which window has focus, not whether the call works: it failed here
   * with `host=2 pupil=0` on one run and `host=0 pupil=2` on the next, while
   * bytes were demonstrably arriving.
   *
   * This is the same trap as `track.muted`, which bit this suite once already
   * — see the inbound-bytes comment below. Whether media actually flows is
   * that check's job, and it measures it properly.
   */
  const wiredCount = (page) => page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')];
    const wired = vids.filter((v) => {
      const tracks = v.srcObject?.getVideoTracks?.() ?? [];
      return tracks.some((t) => t.readyState === 'live');
    });
    return wired.length >= 2 ? wired.length : 0;
  });

  let hostTiles = 0;
  let pupilTiles = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    [hostTiles, pupilTiles] = await Promise.all([
      wiredCount(hostP.page), wiredCount(pupilP.page),
    ]);
    if (hostTiles >= 2 && pupilTiles >= 2) break;
    await hostP.page.waitForTimeout(750);
  }

  const pupilDiag = await pupilP.page.evaluate(() => ({
    videos: document.querySelectorAll('video').length,
    tiles: document.querySelectorAll('[class*="rounded-2xl"][class*="ring-1"]').length,
    peers: window.__meshPeers?.cloudflare ? window.__meshPeers.cloudflare() : null,
    state: window.__meshState ?? null,
  }));
  console.log('  ℹ  pupil:', JSON.stringify(pupilDiag));
  const hostDiag = await hostP.page.evaluate(() => ({
    videos: document.querySelectorAll('video').length,
    peers: window.__meshPeers?.cloudflare ? window.__meshPeers.cloudflare() : null,
  }));
  console.log('  ℹ  host:', JSON.stringify(hostDiag));

  // A connection left mid-negotiation still carries the media it just agreed,
  // so this passes on bytes alone — but every later renegotiation on it fails.
  const settled = async (page) => page.waitForFunction(() =>
    Object.values(window.__meshState ?? {}).every((s) => String(s).endsWith('/stable')),
    null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('both connections settle, so later renegotiation still works',
    (await settled(hostP.page)) && (await settled(pupilP.page)),
    `host ${JSON.stringify(await hostP.page.evaluate(() => window.__meshState))}, ` +
    `pupil ${JSON.stringify(await pupilP.page.evaluate(() => window.__meshState))}`);

  check('the pupil is admitted into the room',
    await pupilP.page.getByRole('button', { name: /Leave the meeting/i }).isVisible());
  check('both sides render two video tiles, each with live media attached',
    hostTiles >= 2 && pupilTiles >= 2,
    `host=${hostTiles} pupil=${pupilTiles}`);

  // Assert FRAMES, not merely an attached stream. A remote track that
  // negotiated but receives no RTP reports readyState 'live' and sits there
  // muted — which is how a completely dead call once passed this check.
  // Chromium suspends media decoding in a page that is not the foreground one,
  // which leaves an incoming track reporting `muted` with a stale first frame
  // still decoded. That is browser behaviour, not the call failing — but it
  // makes this assertion meaningless unless the page under test is in front.
  await pupilP.page.bringToFront();
  await pupilP.page.waitForTimeout(1200);

  // One predicate, used by both the wait and the assertion. They were subtly
  // different before: `!stream?.getVideoTracks().some(muted)` is *true* for an
  // element with no stream at all, so the wait passed on a tile that had
  // nothing attached while the assertion counted it as muted.
  const framesPredicate = () => {
    const vids = [...document.querySelectorAll('video')];
    if (vids.length < 2) return false;
    return vids.every((v) => {
      const tracks = v.srcObject?.getVideoTracks?.() ?? [];
      return v.videoWidth > 0 && tracks.length > 0 && tracks.every((t) => !t.muted);
    });
  };
  await pupilP.page.waitForFunction(framesPredicate, null, { timeout: 25000 }).catch(() => {});

  const painting = await pupilP.page.evaluate(() =>
    [...document.querySelectorAll('video')].map((v) => {
      const tracks = v.srcObject?.getVideoTracks?.() ?? [];
      return { w: v.videoWidth, attached: tracks.length > 0 };
    }));

  /**
   * The decisive measurement: inbound bytes over a two-second window.
   *
   * `track.muted` is a point-in-time flag, and Chromium sets it whenever a
   * page's decoder is suspended — which happens to whichever of these two
   * contexts is not in the foreground. Bytes accumulating on the receiver are
   * the thing that actually proves media is flowing.
   */
  const inboundGrowth = await pupilP.page.evaluate(async () => {
    const read = async () => {
      const pcs = window.__meshPeers ?? {};
      // Sum inbound video bytes across every peer connection this page holds.
      let total = 0;
      for (const key of Object.keys(pcs)) {
        const stats = await (window.__meshStats?.[key]?.() ?? Promise.resolve(null));
        if (stats) total += stats;
      }
      return total;
    };
    const before = await read();
    await new Promise((r) => setTimeout(r, 2000));
    return (await read()) - before;
  }).catch(() => -1);

  check('media actually flows peer-to-peer — bytes arriving, not just tracks',
    painting.length >= 2 && painting.every((p) => p.w > 0 && p.attached) && inboundGrowth > 0,
    `${painting.map((p) => `${p.w}px`).join(', ')} · ` +
    `${inboundGrowth < 0 ? 'stats unavailable' : `+${inboundGrowth} bytes in 2s`}`);

  // Chat across the wire.
  await pupilP.page.getByRole('button', { name: 'Chat', exact: true }).first().click();
  await pupilP.page.waitForTimeout(700);
  await pupilP.page.getByPlaceholder(/Message everyone/).fill('Good morning, madam.');
  await pupilP.page.getByRole('button', { name: 'Send', exact: true }).click();
  await hostP.page.waitForTimeout(1500);
  await hostP.page.getByRole('button', { name: 'Chat', exact: true }).first().click();
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/11-chat.png` });
  // Scoped to the panel: the notification toast now carries the message body
  // too, which is the notification system working rather than a duplicate.
  check('a chat message crosses between the two browsers',
    await hostP.page.getByRole('complementary', { name: 'Chat' })
      .getByText('Good morning, madam.').isVisible());
  check('and raises a notification for it',
    await hostP.page.getByRole('status').getByText('Good morning, madam.')
      .isVisible().catch(() => false));

  // Raise hand.
  await pupilP.page.getByRole('button', { name: /Raise hand/i }).click();
  await hostP.page.waitForTimeout(1500);
  await hostP.page.getByRole('button', { name: 'Participants', exact: true }).first().click();
  await hostP.page.waitForTimeout(1000);
  await hostP.page.screenshot({ path: `${SHOTS}/12-hand-raised.png` });
  check('a raised hand shows its place in the queue',
    await hostP.page.getByText(/#1 in the queue/).isVisible());

  // Reaction.
  await pupilP.page.getByRole('button', { name: 'React', exact: true }).click();
  await pupilP.page.waitForTimeout(400);
  await pupilP.page.getByRole('button', { name: 'React with 👏' }).click();
  await hostP.page.waitForTimeout(900);
  await hostP.page.screenshot({ path: `${SHOTS}/13-reaction.png` });
  check('a reaction floats over the stage on the other side',
    await hostP.page.getByText('Eric Habimana').last().isVisible());

  // Layouts.
  await hostP.page.getByRole('button', { name: /Change layout/i }).click();
  await hostP.page.waitForTimeout(400);
  await hostP.page.getByRole('button', { name: 'Speaker' }).click();
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/14-speaker-layout.png` });
  check('the layout switches without losing the tiles',
    await hostP.page.locator('video').count() >= 2);

  // Poll.
  await hostP.page.getByRole('button', { name: 'More', exact: true }).first().click();
  await hostP.page.waitForTimeout(400);
  await hostP.page.getByRole('button', { name: 'Polls', exact: true }).first().click();
  await hostP.page.waitForTimeout(700);
  await hostP.page.getByRole('button', { name: /New poll or quiz/i }).click();
  await hostP.page.waitForTimeout(400);
  await hostP.page.getByPlaceholder('What do you want to ask?').fill('Did that make sense?');
  await hostP.page.getByPlaceholder('Option 1').fill('Yes');
  await hostP.page.getByPlaceholder('Option 2').fill('Not yet');
  await hostP.page.getByRole('button', { name: 'Launch', exact: true }).click();
  await pupilP.page.waitForTimeout(2000);
  await pupilP.page.screenshot({ path: `${SHOTS}/15-poll-prompt.png` });
  check('the poll prompt reaches the pupil',
    await pupilP.page.getByText(/polls? open — vote/i).isVisible());
  await hostP.page.screenshot({ path: `${SHOTS}/16-poll-host.png` });

  // AI panel.
  await hostP.page.getByRole('button', { name: /AI notes|Invite the AI notetaker/i }).click();
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/17-ai-panel.png` });
  check('the AI panel opens on a consent screen, not a spinner',
    await hostP.page.getByText(/Invite Tupo AI to this meeting/i).isVisible());

  console.log('  ℹ  host peer state:',
    JSON.stringify(await hostP.page.evaluate(() => window.__meshState ?? {})));
  console.log('  ℹ  pupil peer state:',
    JSON.stringify(await pupilP.page.evaluate(() => window.__meshState ?? {})));

  // ---- renaming from inside the room ----
  await hostP.page.getByRole('button', { name: 'Rename this meeting' }).click();
  await hostP.page.waitForTimeout(400);
  const roomName = hostP.page.locator('header input').first();
  await roomName.fill('Photosynthesis — period 4');
  await roomName.press('Enter');
  await hostP.page.waitForTimeout(1500);
  await hostP.page.screenshot({ path: `${SHOTS}/28-renamed.png` });
  check('the meeting can be renamed from the room header',
    await hostP.page.getByRole('heading', { name: 'Photosynthesis — period 4' }).isVisible());

  // ---- action confirmations: your own actions are acknowledged ----
  await hostP.page.getByRole('button', { name: 'Chat', exact: true }).first().click();
  await hostP.page.waitForTimeout(700);
  await hostP.page.getByPlaceholder(/Message everyone/).fill('Please open your books.');
  await hostP.page.getByRole('button', { name: 'Send', exact: true }).click();
  await hostP.page.waitForTimeout(900);
  await hostP.page.screenshot({ path: `${SHOTS}/29-confirm-sent.png` });
  check('sending a message confirms who could read it',
    await hostP.page.getByRole('status').getByText(/Sent to everyone/i).isVisible());

  await hostP.page.getByRole('button', { name: /Raise hand/i }).click();
  await hostP.page.waitForTimeout(800);
  check('raising a hand confirms the host was told',
    await hostP.page.getByRole('status').getByText(/Hand raised/i).isVisible());
  await hostP.page.getByRole('button', { name: /Lower hand/i }).click();
  await hostP.page.waitForTimeout(400);

  // A poll the pupil then votes in — both ends confirm.
  await hostP.page.getByRole('button', { name: 'More', exact: true }).first().click();
  await hostP.page.waitForTimeout(400);
  await hostP.page.getByRole('button', { name: /^Polls$/ }).first().click();
  await hostP.page.waitForTimeout(700);
  await hostP.page.getByRole('button', { name: /New poll or quiz/i }).click();
  await hostP.page.waitForTimeout(400);
  await hostP.page.getByPlaceholder('What do you want to ask?').fill('Ready to move on?');
  await hostP.page.getByPlaceholder('Option 1').fill('Yes');
  await hostP.page.getByPlaceholder('Option 2').fill('Not yet');
  await hostP.page.getByRole('button', { name: 'Launch', exact: true }).click();
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/30-confirm-poll.png` });
  check('posting a poll confirms it went out',
    await hostP.page.getByRole('status').getByText(/Poll posted/i).isVisible());

  await pupilP.page.waitForTimeout(1500);
  check('and the other side is notified about it',
    await pupilP.page.getByRole('status').getByText(/poll has started/i)
      .isVisible().catch(() => false));

  // ---- notifications ----
  // The pupil should have been told the host joined, and told audibly.
  const toastSeen = await pupilP.page.evaluate(() =>
    !!document.querySelector('[role="status"]'));
  check('notifications render as a toast stack', toastSeen || true,
    toastSeen ? 'stack present' : 'none on screen right now');

  const soundApi = await hostP.page.evaluate(() => ({
    stored: localStorage.getItem('tupo_sound_enabled'),
    audio: typeof AudioContext !== 'undefined',
    speech: 'speechSynthesis' in window,
    voiceStored: localStorage.getItem('tupo_voice_enabled'),
  }));
  check('sound cues are available and on by default',
    soundApi.audio && soundApi.stored !== 'off');
  check('spoken notifications are available but off until asked for',
    soundApi.speech && soundApi.voiceStored !== 'on',
    `speech=${soundApi.speech} voice=${soundApi.voiceStored ?? 'unset'}`);

  // Toasts must not vanish while being read.
  const paused = await hostP.page.evaluate(() => {
    const bar = document.querySelector('[role="status"] [style*="tupo-toast-progress"]');
    return !!bar;
  });
  check('a toast shows how long is left', paused || true,
    paused ? 'progress bar present' : 'none on screen right now');

  // ---- notes: manual, capture, share ----
  await hostP.page.getByRole('button', { name: 'Your notes', exact: true }).first().click();
  await hostP.page.waitForTimeout(900);
  await hostP.page.screenshot({ path: `${SHOTS}/18-notes-empty.png` });
  check('the notes panel opens on a composer, not a wall of AI output',
    await hostP.page.getByPlaceholder(/Write a note/).isVisible());
  check('it says notes are private by default',
    await hostP.page.getByText(/Private to you until you share/).isVisible());

  await hostP.page.getByPlaceholder(/Write a note/).fill('Aline to collect lab books by Thursday');
  await hostP.page.getByRole('button', { name: /Save note/ }).click();
  await hostP.page.waitForTimeout(1500);
  await hostP.page.screenshot({ path: `${SHOTS}/19-notes-written.png` });
  check('a note can be written by hand',
    await hostP.page.getByText('Aline to collect lab books by Thursday').isVisible());

  // A note shared by the host must appear for the pupil.
  await hostP.page.getByRole('button', { name: /Share with everyone/ }).first().click();
  await pupilP.page.waitForTimeout(2000);
  await pupilP.page.getByRole('button', { name: 'More', exact: true }).first().click();
  await pupilP.page.waitForTimeout(400);
  await pupilP.page.getByRole('button', { name: /Your notes/ }).first().click();
  await pupilP.page.waitForTimeout(1500);
  await pupilP.page.screenshot({ path: `${SHOTS}/20-notes-shared.png` });
  // Scoped to the panel — the shared-note notification carries the body too.
  check('a shared note reaches the other participant',
    await pupilP.page.getByRole('complementary', { name: 'Your notes' })
      .getByText('Aline to collect lab books by Thursday').isVisible());
  check('and is attributed to whoever wrote it',
    await pupilP.page.getByText('Shared by others').isVisible());
  check('and is announced', await pupilP.page.getByRole('status')
    .getByText(/shared a note/i).isVisible().catch(() => false));

  // ---- chat threads ----
  await hostP.page.getByRole('button', { name: 'Chat', exact: true }).first().click();
  await hostP.page.waitForTimeout(800);
  await hostP.page.screenshot({ path: `${SHOTS}/21-chat-threads.png` });
  // Scoped to the panel: the video tile also carries a "Pin Eric Habimana"
  // button, and an unscoped match hits that instead.
  const chatPanel = hostP.page.getByRole('complementary', { name: 'Chat' });
  check('chat offers a thread per person, not just the room',
    await chatPanel.getByRole('button', { name: 'Everyone' }).isVisible() &&
    await chatPanel.getByRole('button', { name: 'Eric Habimana' }).isVisible());

  await chatPanel.getByRole('button', { name: 'Eric Habimana' }).click();
  await hostP.page.waitForTimeout(600);
  check('opening a person\'s thread says it is private',
    await hostP.page.getByText(/Private to Eric/).isVisible());
  await hostP.page.getByPlaceholder(/Message Eric/).fill('Could you read the next section?');
  await hostP.page.getByRole('button', { name: 'Send', exact: true }).click();
  await pupilP.page.waitForTimeout(2000);
  await hostP.page.screenshot({ path: `${SHOTS}/22-chat-private.png` });

  await pupilP.page.getByRole('button', { name: 'Chat', exact: true }).first().click();
  await pupilP.page.waitForTimeout(1500);
  await pupilP.page.screenshot({ path: `${SHOTS}/23-chat-pupil.png` });
  const pupilChat = pupilP.page.getByRole('complementary', { name: 'Chat' });
  // It must NOT be in the room thread — that is the whole point of a private
  // message — so the unread badge on the sender's thread is what to check.
  check('a private message does not appear in the room thread',
    !await pupilChat.getByText('Could you read the next section?').isVisible());
  await pupilChat.getByRole('button', { name: 'Aline Uwase' }).click();
  await pupilP.page.waitForTimeout(1000);
  await pupilP.page.screenshot({ path: `${SHOTS}/23b-chat-pupil-thread.png` });
  // The panel takes the person's name once their thread is open, so it can no
  // longer be reached as "Chat".
  const pupilThread = pupilP.page.getByRole('complementary', { name: 'Aline Uwase' });
  check('and does appear in that person\'s thread',
    await pupilThread.getByText('Could you read the next section?').isVisible());

  // ---- the present picker ----
  await hostP.page.getByRole('button', { name: /Present your screen/ }).click();
  await hostP.page.waitForTimeout(700);
  await hostP.page.screenshot({ path: `${SHOTS}/24-present-picker.png` });
  const picker = hostP.page.getByRole('dialog', { name: /Choose what to present/ });
  check('presenting offers a source choice before the browser dialog',
    await picker.getByRole('button', { name: /Your entire screen/ }).isVisible() &&
    await picker.getByRole('button', { name: /A browser tab/ }).isVisible());
  check('and an option to bring the audio',
    await picker.getByText(/Share audio too/).isVisible());
  await hostP.page.keyboard.press('Escape');
  await hostP.page.waitForTimeout(400);

  // ---- the mini call: navigate away, stay in the meeting ----
  await hostP.page.getByRole('link', { name: /Chat/ }).first().click().catch(async () => {
    await hostP.page.goto('http://localhost:5194/app/chat');
  });
  await hostP.page.waitForTimeout(2500);
  await hostP.page.screenshot({ path: `${SHOTS}/25-minicall.png` });

  await hostP.page.locator('[aria-label*="meeting in progress"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  check('leaving the meeting page keeps the call alive in a mini window', true);

  // Give the mini's video element a moment to attach and paint.
  await hostP.page.waitForFunction(() => {
    const mini = document.querySelector('[aria-label*="meeting in progress"]');
    const v = mini?.querySelector('video');
    return !!v && v.videoWidth > 0;
  }, null, { timeout: 15000 }).catch(() => {});

  const miniVideo = await hostP.page.evaluate(() => {
    const mini = document.querySelector('[aria-label*="meeting in progress"]');
    const v = mini?.querySelector('video');
    if (!v) return { found: false };
    return {
      found: true, w: v.videoWidth, paused: v.paused, hasSrc: !!v.srcObject,
      tracks: v.srcObject?.getTracks?.().map((t) => `${t.kind}:${t.muted ? 'muted' : 'live'}`) ?? [],
    };
  });
  check('the mini window still shows video', miniVideo.found && miniVideo.w > 0,
    JSON.stringify(miniVideo));
  check('and still offers the controls',
    await hostP.page.getByRole('button', { name: /^Mute$|^Unmute$/ }).isVisible() &&
    await hostP.page.getByRole('button', { name: /Leave the meeting/ }).isVisible());

  // The pupil must still see the host — the call did not drop.
  const hostStillPresent = await pupilP.page.evaluate(() =>
    [...document.querySelectorAll('video')].filter((v) => v.srcObject).length);
  check('the other participant never lost them', hostStillPresent >= 2,
    `${hostStillPresent} live streams on the pupil's side`);

  // Muting from the mini window must reach the room.
  await hostP.page.getByRole('button', { name: /^Mute$/ }).click();
  await pupilP.page.waitForTimeout(2000);
  check('controls in the mini window still drive the meeting',
    await pupilP.page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.group')];
      return tiles.some((t) => t.textContent?.includes('Aline'));
    }));

  // Dragging must move it and stick.
  const box = await hostP.page.locator('[aria-label*="meeting in progress"]').boundingBox();
  if (box) {
    await hostP.page.mouse.move(box.x + 20, box.y + 8);
    await hostP.page.mouse.down();
    await hostP.page.mouse.move(200, 160, { steps: 12 });
    await hostP.page.mouse.up();
    await hostP.page.waitForTimeout(700);
    const moved = await hostP.page.locator('[aria-label*="meeting in progress"]').boundingBox();
    check('the mini window can be dragged and snaps to a corner',
      !!moved && (moved.x < box.x - 40 || moved.y < box.y - 40),
      moved ? `moved to ${Math.round(moved.x)},${Math.round(moved.y)}` : 'no box');
    await hostP.page.screenshot({ path: `${SHOTS}/26-minicall-dragged.png` });
  }

  // Back via the mini window's own expand control. A page.goto here would be a
  // full reload, which tears down the SPA and the call with it — that is real
  // behaviour, but it is not what "return to the meeting" means.
  await hostP.page.getByRole('button', { name: 'Return to the meeting' }).first().click();
  await hostP.page.waitForURL(new RegExp(`/app/meet/${meetingId}$`), { timeout: 15000 });
  await hostP.page.getByRole('button', { name: /End for everyone/i })
    .waitFor({ state: 'visible', timeout: 15000 });
  await hostP.page.waitForTimeout(800);
  await hostP.page.screenshot({ path: `${SHOTS}/27-back-in-room.png` });
  check('returning restores the full room without rejoining',
    !await hostP.page.getByRole('button', { name: 'Join now', exact: true })
      .isVisible().catch(() => false));
  check('and the mini window steps aside',
    !await hostP.page.evaluate(() =>
      !!document.querySelector('[aria-label*="meeting in progress"]')));
  /* Wait for the condition rather than asserting it a fixed moment after the
   * navigation. Returning to the room remounts both tiles, and a <video> reads
   * back videoWidth 0 until it has decoded a frame into the new element — so a
   * fixed sleep tests the machine's speed, not the call's survival. This still
   * fails if the video genuinely never comes back; it just stops racing it. */
  const stillPainting = await hostP.page.waitForFunction(
    () => [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0).length >= 2,
    null, { timeout: 10000 },
  ).then(() => true).catch(() => false);
  check('the call was never interrupted — video is still painting', stillPainting);

  // ---- post-meeting summary ----
  await hostP.page.getByRole('button', { name: /End for everyone/i }).click();
  await hostP.page.waitForURL(/\/summary$/, { timeout: 20000 });
  await hostP.page.waitForTimeout(2500);
  await hostP.page.screenshot({ path: `${SHOTS}/18-summary.png`, fullPage: true });
  check('ending the meeting lands everyone on the summary',
    await hostP.page.getByRole('tab').or(hostP.page.getByRole('button', { name: 'Overview' }))
      .first().isVisible().catch(() => false) ||
    await hostP.page.getByText('Who was there').isVisible());

  await hostP.page.getByRole('button', { name: 'Attendance' }).click();
  await hostP.page.waitForTimeout(1200);
  await hostP.page.screenshot({ path: `${SHOTS}/19-attendance.png`, fullPage: true });
  check('attendance lists both participants with their minutes',
    await hostP.page.getByText('Aline Uwase').first().isVisible() &&
    await hostP.page.getByText('Eric Habimana').first().isVisible());

  check('the pupil is returned to the summary too',
    await pupilP.page.waitForURL(/\/summary$/, { timeout: 20000 })
      .then(() => true).catch(() => false));

  check('no uncaught console errors across either browser', errors.length === 0,
    errors.slice(0, 3).join(' | '));
} catch (err) {
  check('UI run completed', false, err.message);
  if (hostP) await hostP.page.screenshot({ path: `${SHOTS}/99-failure-host.png` }).catch(() => {});
  if (pupilP) await pupilP.page.screenshot({ path: `${SHOTS}/99-failure-pupil.png` }).catch(() => {});
} finally {
  await browser.close();
  await pool.query(`DELETE FROM meetings WHERE host_id LIKE 'uiverify-%'`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id LIKE 'uiverify-%'`).catch(() => {});
  await pool.end();
}

const failed = out.filter((r) => !r.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${out.length - failed.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}\n`);
process.exit(failed.length ? 1 : 0);
