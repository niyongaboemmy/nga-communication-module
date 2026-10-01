// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Usage analytics feature catalog (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.4).
 *
 * Every route the SPA declares must resolve to a named feature (never
 * `tupo.other`), the web copy of the catalog must be byte-identical to the
 * API's (the one published to the MIS), and the vendored tracker must not have
 * been edited by hand.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

const apiCatalog = read('../../api/src/activity/catalog.json');
const webCatalog = read('../src/activity/tupo.catalog.json');
const catalog = JSON.parse(webCatalog) as {
  app: string;
  features: { key: string; patterns?: string[]; event?: boolean; key_event?: boolean }[];
};

/**
 * Every route path in App.tsx, made absolute by joining nested <Route>s onto
 * their parents. The opening tag's end is found by brace depth, because
 * `element={<X />}` contains a "/>" of its own.
 */
function routePaths(source: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  const token = /<Route\b|<\/Route>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(source))) {
    if (m[0] === '</Route>') { stack.pop(); continue; }
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = source.slice(m.index, i + 1);
    const selfClosing = source[i - 1] === '/';
    const own = /\spath="([^"]*)"/.exec(tag)?.[1];
    const parent = stack[stack.length - 1] ?? '';
    const full = own === undefined ? parent
      : own.startsWith('/') ? own
        : `${parent.replace(/\/$/, '')}/${own}`;
    if (own !== undefined) out.push(full);
    if (!selfClosing) stack.push(full);
    token.lastIndex = i + 1;
  }
  return out;
}

/** A minimal browser, enough for initActivity to build its route table. */
async function loadTracker() {
  const g = globalThis as Record<string, unknown>;
  const noop = () => undefined;
  g.window ??= { addEventListener: noop, setInterval: () => 0, innerWidth: 0, innerHeight: 0 };
  g.document ??= { addEventListener: noop, cookie: '', visibilityState: 'hidden', hasFocus: () => false };
  return import('../src/vendor/nga-activity/index.ts');
}

test('the web catalog is a byte-for-byte copy of the API source (npm run activity:catalog)', () => {
  assert.equal(webCatalog, apiCatalog);
  assert.equal(catalog.app, 'tupo');
});

test('feature keys are unique and namespaced', () => {
  const keys = catalog.features.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.match(k, /^tupo\.[a-z0-9_.]+$/);
});

test('the server key events are declared as key events', () => {
  const keyEvents = catalog.features.filter((f) => f.key_event).map((f) => f.key).sort();
  assert.deepEqual(keyEvents, [
    'tupo.chat.send', 'tupo.feed.post', 'tupo.mail.send', 'tupo.meet.guest_join', 'tupo.meet.join',
  ]);
});

test('every <Route path> in App.tsx resolves to a named feature', async () => {
  // `*` is the catch-all that redirects to the sign-in page; it is never a page.
  const paths = [...new Set(routePaths(read('../src/App.tsx')))].filter((p) => !p.endsWith('*'));
  // The parser itself: nested routes come out absolute.
  for (const p of ['/', '/sso/callback', '/meet/:idOrCode', '/app', '/app/chat', '/app/feed/reels/:reelId?', '/app/feed/pages/:id/insights', '/app/meet/:id/summary', '/app/system']) {
    assert.ok(paths.includes(p), `parser missed ${p}`);
  }

  const sdk = await loadTracker();
  sdk._resetActivityForTests();
  sdk.initActivity({ app: 'tupo', endpoint: '/x', configUrl: '/x', catalog: catalog.features });
  const t = sdk._trackerForTests();
  assert.ok(t, 'tracker did not start');
  const concrete = (p: string) => p.replace(/:[A-Za-z]+\??/g, '123');
  const missing = paths.filter((p) => sdk.resolveRoute('tupo', t.compiled, concrete(p)).feature === 'tupo.other');
  // A few concrete spot checks on specificity: literal segments beat parameters.
  const at = (p: string) => sdk.resolveRoute('tupo', t.compiled, p).feature;
  sdk._resetActivityForTests();
  assert.deepEqual(missing, []);
  assert.equal(at('/app/meet/new'), 'tupo.meet.schedule');
  assert.equal(at('/app/meet/history'), 'tupo.meet.history');
  assert.equal(at('/app/meet/abc-defg-hij'), 'tupo.meet.room');
  assert.equal(at('/app/meet/123/summary'), 'tupo.meet.summary');
  assert.equal(at('/app/feed/reels'), 'tupo.feed.reels');
  assert.equal(at('/app/mail/t/99'), 'tupo.mail.mailbox');
  assert.equal(at('/meet/abc-defg-hij'), 'tupo.meet.guest');
  assert.equal(at('/'), 'tupo.sign_in');
});

test('every data-track key in the app is a catalogued event', () => {
  const srcDir = resolve(here, '../src');
  const events = new Set(catalog.features.filter((f) => f.event).map((f) => f.key));
  const attr = /data-track=(?:"([^"]+)"|\{[^}]*?'([^']+)'[^}]*\})/g;
  const used = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx') && !f.includes('vendor'))
    .flatMap((f) => [...readFileSync(resolve(srcDir, f), 'utf8').matchAll(attr)].map((m) => m[1] ?? m[2]!));
  assert.ok(used.length >= 10, `expected the tracked buttons, found ${used.length}`);
  for (const k of used) assert.ok(events.has(k), `${k} is not an event in the catalog`);
});

test('the vendored tracker matches its provenance hash (re-sync, never edit)', () => {
  for (const f of ['index.ts', 'react.ts']) {
    const [, , shaLine, ...rest] = read(`../src/vendor/nga-activity/${f}`).split('\n');
    assert.equal(shaLine, `// sha256:${createHash('sha256').update(rest.join('\n')).digest('hex')}`, f);
  }
});
