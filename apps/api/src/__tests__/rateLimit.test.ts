import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { rateLimit, BUCKETS, __resetRateLimits } from '../middleware/rateLimit.js';
import { config } from '../config.js';

/** A-03: per-person ceilings, a helpful 429, and other people unaffected. */

const mini = express();
mini.use(rateLimit);
mini.post('/api/feed/posts/:id/comments', (_q, s) => s.status(201).json({ ok: true }));
mini.get('/api/feed', (_q, s) => s.json({ ok: true }));

const tokenFor = (id: string) => jwt.sign({ id, role: 'student' }, config.jwtSecret);

beforeAll(() => { process.env.RATE_LIMITS = 'on'; __resetRateLimits(); });
afterAll(() => { process.env.RATE_LIMITS = 'off'; });

describe('rate limits', () => {
  it('stops a burst of comments with a 429 that says when to retry', async () => {
    const limit = BUCKETS.find((b) => b.name === 'feed-comment')!.limit;
    const a = tokenFor(`rl-a-${Date.now()}`);
    const codes: number[] = [];
    for (let i = 0; i < limit + 3; i++) {
      codes.push((await request(mini).post('/api/feed/posts/1/comments').set('Authorization', `Bearer ${a}`)).status);
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(limit);
    const last = await request(mini).post('/api/feed/posts/1/comments').set('Authorization', `Bearer ${a}`);
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('one person hitting the ceiling does not affect another', async () => {
    const b = tokenFor(`rl-b-${Date.now()}`);
    expect((await request(mini).post('/api/feed/posts/1/comments').set('Authorization', `Bearer ${b}`)).status).toBe(201);
  });

  it('paths without a bucket are never limited', async () => {
    const c = tokenFor(`rl-c-${Date.now()}`);
    for (let i = 0; i < 50; i++) {
      expect((await request(mini).get('/api/feed').set('Authorization', `Bearer ${c}`)).status).toBe(200);
    }
  });
});
