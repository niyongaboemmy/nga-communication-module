import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake, recordError, writeSamples } from '@tupo/db';
import { primaryTenantCtx, runAsPlatform, runWithTenant } from '@tupo/tenancy';
import { app } from '../app.js';
import { config } from '../config.js';
// The worker's alert rules, loaded at run time: a static import would pull the
// worker's sources into this project's typecheck (outside its rootDir).
type Rule = { name: string };
type MonitorModule = {
  evaluateAlerts: (notify: (subject: string, text: string) => Promise<void>, rules: Rule[]) => Promise<string[]>;
  alertRules: () => Rule[];
};
const monitorPath = new URL('../../../worker/src/jobs/monitor.ts', import.meta.url).href;
const { evaluateAlerts, alertRules } = (await import(monitorPath)) as MonitorModule;

/** R-03/R-04/R-05: errors are grouped and visible, metrics read back, alerts fire once and resolve. */

async function roleId(name: string) {
  return (await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name])).rows[0]!.id;
}
async function user(name: string, role: string) {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1, $1, $2, $3, 'staff', $4)`,
    [id, name, `${id}@amashuri.com`, await roleId(role)]);
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' }, config.jwtSecret, { expiresIn: '10m' });
  return { id, auth: `Bearer ${token}` };
}

let admin: { id: string; auth: string };
let staff: { id: string; auth: string };
beforeEach(async () => {
  // error_events has RLS (0047): clear every tenant's rows and the process-level ones.
  await runAsPlatform('test clean-up', () => getPool().query('DELETE FROM error_events'));
  await getPool().query('DELETE FROM metric_samples');
  await getPool().query('DELETE FROM alert_state');
  await getPool().query('DELETE FROM users');
  await seedRbac(getPool());
  admin = await user('Ada Admin', 'Admin');
  staff = await user('Sam Staff', 'Staff');
});
afterAll(async () => { await closeDb(); });

describe('browser errors', () => {
  it('any signed-in person can report one; the same crash twice is one row counted twice', async () => {
    const crash = { message: 'Cannot read properties of undefined (reading "id")', stack: 'TypeError\n    at Thread (src/pages/chat/MessageThread.tsx:10:2)', route: '/app/chat' };
    expect((await request(app).post('/api/system/client-errors').set('Authorization', staff.auth).send(crash)).status).toBe(202);
    // The in-process throttle lets one write through per 10 s; the next carries the count.
    // Same tenant as the signed-in reporter (a legacy token = tenant 1).
    await runWithTenant(primaryTenantCtx(), () => recordError({ source: 'web', ...crash }));
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await runAsPlatform('test', () => getPool().query('SELECT source, count, route, tenant_id FROM error_events'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'web', route: '/app/chat', tenant_id: '1' });
  });

  it('needs a message, and a session', async () => {
    expect((await request(app).post('/api/system/client-errors').set('Authorization', staff.auth).send({})).status).toBe(400);
    expect((await request(app).post('/api/system/client-errors').send({ message: 'x' })).status).toBe(401);
  });
});

describe('the System page endpoints', () => {
  it('are for SYSTEM_HEALTH_VIEW only', async () => {
    for (const path of ['/api/system/metrics', '/api/system/errors', '/api/system/alerts']) {
      expect((await request(app).get(path).set('Authorization', staff.auth)).status).toBe(403);
      expect((await request(app).get(path).set('Authorization', admin.auth)).status).toBe(200);
    }
  });

  it('sum API counts across instances and keep the worst latency', async () => {
    await writeSamples('api#0', [['http_requests', 30], ['http_p95_ms', 120]]);
    await writeSamples('api#1', [['http_requests', 12], ['http_p95_ms', 480]]);
    const res = await request(app).get('/api/system/metrics?minutes=5').set('Authorization', admin.auth);
    const last = (k: string) => res.body.data.series[k].at(-1)[1];
    expect(last('api.http_requests')).toBe(42);
    expect(last('api.http_p95_ms')).toBe(480);
  });

  it('list open errors and let an admin resolve one', async () => {
    await recordError({ source: 'api', message: 'boom on purpose', stack: 'Error\n    at x (/a.js:1:1)', route: 'GET /api/x' });
    const list = await request(app).get('/api/system/errors').set('Authorization', admin.auth);
    expect(list.body.data.errors).toHaveLength(1);
    const fp = list.body.data.errors[0].fingerprint;
    expect((await request(app).patch(`/api/system/errors/${fp}`).set('Authorization', admin.auth).send({ status: 'resolved' })).status).toBe(200);
    expect((await request(app).get('/api/system/errors').set('Authorization', admin.auth)).body.data.errors).toHaveLength(0);
    expect((await request(app).patch(`/api/system/errors/${fp}`).set('Authorization', admin.auth).send({ status: 'gone' })).status).toBe(400);
  });

  it('an error row keeps the route pattern it was recorded with', async () => {
    await recordError({ source: 'api', message: 'Simulated failure', route: 'GET /api/chat/conversations/:id' });
    const { rows } = await runAsPlatform('test', () => getPool().query("SELECT route FROM error_events WHERE message = 'Simulated failure'"));
    expect(rows[0].route).toBe('GET /api/chat/conversations/:id');
  });
});

describe('alerts', () => {
  const sent: string[] = [];
  const notify = async (subject: string) => { sent.push(subject); };
  const lowDisk = () => alertRules().filter((r) => r.name === 'low_disk');

  it('fire once, stay quiet while still firing, and say when resolved', async () => {
    sent.length = 0;
    await writeSamples('system', [['host_disk_free_pct', 4]]);
    expect(await evaluateAlerts(notify, lowDisk())).toEqual(['low_disk']);
    expect(sent).toEqual(['Alert: low_disk']);

    await evaluateAlerts(notify, lowDisk());
    expect(sent).toHaveLength(1);
    const { rows } = await getPool().query("SELECT firing, detail FROM alert_state WHERE rule = 'low_disk'");
    expect(rows[0].firing).toBe(true);
    expect(rows[0].detail).toMatch(/4\.0% free/);

    await getPool().query('DELETE FROM metric_samples');
    await writeSamples('system', [['host_disk_free_pct', 60]]);
    expect(await evaluateAlerts(notify, lowDisk())).toEqual([]);
    expect(sent).toEqual(['Alert: low_disk', 'Resolved: low_disk']);
  });

  it('judge the API error rate only with enough traffic', async () => {
    sent.length = 0;
    const rate = () => alertRules().filter((r) => r.name === 'api_error_rate');
    await writeSamples('api#0', [['http_requests', 10], ['http_5xx', 9]]);
    expect(await evaluateAlerts(notify, rate())).toEqual([]);
    // Not firing still leaves a row, so the System page lists every rule watched.
    expect((await getPool().query("SELECT firing FROM alert_state WHERE rule = 'api_error_rate'")).rows[0]?.firing).toBe(false);
    await writeSamples('api#1', [['http_requests', 200], ['http_5xx', 30]]);
    expect(await evaluateAlerts(notify, rate())).toEqual(['api_error_rate']);
  });

  it('notice a service that has stopped reporting', async () => {
    sent.length = 0;
    await getPool().query(`INSERT INTO metric_samples (at, service, metric, value) VALUES (now() - interval '10 minutes', 'files', 'rss_mb', 50)`);
    const silent = alertRules().filter((r) => r.name === 'files_silent');
    expect(await evaluateAlerts(notify, silent)).toEqual(['files_silent']);
  });
});
