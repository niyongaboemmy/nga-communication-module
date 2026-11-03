#!/usr/bin/env node
/**
 * Re-sanitise mail HTML stored before C-02 (sanitise-on-write) existed.
 *
 *   node scripts/mail-sanitize-backfill.mjs            # dry run: counts only
 *   node scripts/mail-sanitize-backfill.mjs --apply    # write the changes
 *
 * Runs the same policy the API now applies on write over message bodies,
 * templates, campaigns and signatures. Idempotent: a second run changes
 * nothing. Take a pg_dump first in production.
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { sanitizeMailHtml } from '@tupo/mail';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = `${ROOT}/apps/api/.env`;
const env = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])) : {};
const apply = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL });

const targets = [
  { table: 'mail_messages', key: 'id', col: 'body_html' },
  { table: 'mail_templates', key: 'id', col: 'body_html' },
  { table: 'mail_campaigns', key: 'id', col: 'body_html' },
  { table: 'mail_prefs', key: 'user_id', col: 'signature_html' },
];

let total = 0;
for (const t of targets) {
  const { rows } = await pool.query(`SELECT ${t.key} AS k, ${t.col} AS html FROM ${t.table} WHERE ${t.col} IS NOT NULL AND ${t.col} <> ''`);
  let changed = 0;
  for (const r of rows) {
    const clean = sanitizeMailHtml(r.html);
    if (clean === r.html) continue;
    changed++;
    if (apply) await pool.query(`UPDATE ${t.table} SET ${t.col} = $2 WHERE ${t.key} = $1`, [r.k, clean]);
  }
  total += changed;
  console.log(`${t.table}.${t.col}: ${rows.length} rows, ${changed} ${apply ? 'rewritten' : 'would change'}`);
}
console.log(apply ? `\nDone — ${total} value(s) rewritten.` : `\nDry run — ${total} value(s) would change. Re-run with --apply to write.`);
await pool.end();
