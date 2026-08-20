import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { app } from '../app.js';

/**
 * Tupo must never grow a login of its own. This is a hard product constraint,
 * not a preference: identity belongs to the NGA Central MIS, the same way it
 * does for TaskMentor and Discipline & Attendance.
 *
 * These tests are the tripwire. If someone adds a password field, a local
 * credential check or a /login route, CI fails here and the reviewer gets an
 * explanation instead of a merge.
 */

const repoRoot = new URL('../../../../', import.meta.url).pathname;

/** Remove //, /* *\/ and -- comments so documentation isn't mistaken for code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/^\s*--.*$/gm, ' ');
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '__tests__'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|sql)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('Tupo has no authentication of its own', () => {
  const files = [
    ...sourceFiles(join(repoRoot, 'apps/api/src')),
    ...sourceFiles(join(repoRoot, 'packages/db')),
  ];

  it('scans a non-trivial number of files (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('stores no credential of any kind', () => {
    // Comments are stripped first: the constraint is about code, and the
    // schema file legitimately *documents* the absence of these columns in
    // prose. Scanning raw text would flag that documentation as a violation.
    const banned = /\b(password_hash|password_salt|passwordHash|otp_secret|totp_secret|bcrypt|argon2|scrypt)\b/;
    const offenders = files.filter((f) => banned.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders, `credential handling found in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('declares no password column in any migration', () => {
    const migrations = sourceFiles(join(repoRoot, 'packages/db/migrations'));
    const offenders = migrations.filter((f) => /\bpassword\b/i.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('exposes no local login or registration endpoint', async () => {
    for (const path of ['/api/auth/login', '/api/login', '/api/register', '/api/auth/register']) {
      const res = await request(app).post(path).send({ email: 'a@b.c', password: 'hunter2' });
      expect(res.status, `${path} should not exist`).toBe(404);
    }
  });

  it('routes every sign-in through the MIS exchange endpoint', async () => {
    // The exchange route exists (400 for a missing code, not 404).
    const res = await request(app).post('/api/sso/exchange').send({});
    expect(res.status).toBe(400);
  });
});
