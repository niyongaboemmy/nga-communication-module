import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import express from 'express';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import '../utils/asyncErrors.js';

/**
 * A-02: a rejected async handler is an error response, never a crashed
 * process, and malformed input is a 400 with no internals in the body.
 */

let token: string;
let userId: string;

beforeAll(async () => {
  await seedRbac(getPool());
  userId = snowflake();
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Student'`);
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,'Err','e@x.rw','student',$2)`,
    [userId, rows[0]!.id],
  );
  token = jwt.sign({ id: userId, misUserId: userId, name: 'Err', email: 'e@x.rw', role: 'student' }, config.jwtSecret);
});

afterAll(async () => {
  await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
  await closeDb();
});

describe('async route safety', () => {
  it('a malformed numeric query is a 400, and the server keeps answering', async () => {
    const bad = await request(app).get('/api/meet?limit=x').set('Authorization', `Bearer ${token}`);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/bigint|syntax|postgres|at \w+ \(/i);
    const health = await request(app).get('/health');
    expect(health.status).toBeLessThan(600);
  });

  it('any rejected async handler reaches the error middleware', async () => {
    const mini = express();
    mini.get('/boom', async () => { throw Object.assign(new Error('Nope.'), { status: 409 }); });
    mini.get('/kaput', async () => { throw new Error('internal detail'); });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mini.use((err: Error & { status?: number }, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
      s.status(err.status ?? 500).json({ message: err.status ? err.message : 'hidden' });
    });
    expect((await request(mini).get('/boom')).status).toBe(409);
    const k = await request(mini).get('/kaput');
    expect(k.status).toBe(500);
    expect(k.body.message).toBe('hidden');
  });
});
