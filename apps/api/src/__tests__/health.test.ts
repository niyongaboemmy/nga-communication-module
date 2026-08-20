import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { closeDb } from '@tupo/db';
import { app } from '../app.js';

afterAll(async () => { await closeDb(); });

describe('GET /health', () => {
  it('reports the service and its database dependency', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: 'tupo-api', status: 'healthy', checks: { database: 'ok' } });
  });
});
