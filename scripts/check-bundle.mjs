#!/usr/bin/env node
/**
 * Bundle-size budget for the web app (P-01, target T3).
 *
 * "Initial JS" is what a first visit must download before anything renders:
 * the entry chunk plus every chunk it reaches through static imports. Lazy
 * routes are not counted; their size is capped separately so no single screen
 * drags in a library the rest of the app avoided.
 *
 *   node scripts/check-bundle.mjs [apps/web/dist]      exits 1 over budget
 *
 * Budgets are gzip sizes. Raise one only with a reason in the PR.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET = {
  initialKb: 250,
  /** Any one lazily loaded chunk. The rich-text editor is the largest today. */
  chunkKb: 130,
};

const dist = process.argv[2] ?? 'apps/web/dist';
if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No build at ${dist}. Run: npm run build -w @tupo/web`);
  process.exit(2);
}

const assets = join(dist, 'assets');
const gz = (f) => gzipSync(readFileSync(join(assets, f))).length;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = html.match(/src="\/assets\/([^"]+\.js)"/)?.[1];
if (!entry) { console.error('No entry script in index.html'); process.exit(2); }

// Static imports only: `import"./x.js"` and `import {a} from "./x.js"`, never `import("./x.js")`.
const STATIC = /(?:^|[;\n}])\s*import\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g;
const initial = new Set();
for (const stack = [entry]; stack.length;) {
  const f = stack.pop();
  if (initial.has(f)) continue;
  initial.add(f);
  for (const m of readFileSync(join(assets, f), 'utf8').matchAll(STATIC)) stack.push(m[1]);
}

const kb = (n) => (n / 1024).toFixed(1);
const initialBytes = [...initial].reduce((n, f) => n + gz(f), 0);
const lazy = readdirSync(assets).filter((f) => f.endsWith('.js') && !initial.has(f))
  .map((f) => [f, gz(f)]).sort((a, b) => b[1] - a[1]);

const failures = [];
console.log(`Initial JS: ${kb(initialBytes)} KB gzip in ${initial.size} files (budget ${BUDGET.initialKb} KB)`);
if (initialBytes > BUDGET.initialKb * 1024) failures.push(`initial JS ${kb(initialBytes)} KB > ${BUDGET.initialKb} KB`);
console.log('Largest lazy chunks:');
for (const [f, n] of lazy.slice(0, 5)) console.log(`  ${kb(n).padStart(6)} KB  ${f}`);
for (const [f, n] of lazy) {
  if (n > BUDGET.chunkKb * 1024) failures.push(`${f} ${kb(n)} KB > ${BUDGET.chunkKb} KB`);
}

if (failures.length) {
  console.error(`\nOver budget:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nWithin budget.');
