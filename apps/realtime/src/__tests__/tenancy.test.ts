import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { conversationRoom, userRoom } from '@tupo/shared';
import { TenantRegistry, currentTid, primaryTenantCtx, runWithTid, type TenantCtx } from '@tupo/tenancy';
import { bindSocketTenant, relayRooms, relayTid, tenantForSession } from '../tenancy.js';

const T2: TenantCtx = { tid: 2, slug: 'two', name: 'Two', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };
const registry = new TenantRegistry({ load: async () => [primaryTenantCtx(), T2, { ...T2, tid: 3, slug: 'three', status: 'SUSPENDED' }] });

afterEach(() => { delete process.env.TENANCY_LEGACY_DEFAULT_TID; });

describe('relay messages stay inside their tenant', () => {
  it('reads tid, defaulting an old publisher to tenant 1', () => {
    expect(relayTid({ tid: 2 })).toBe(2);
    expect(relayTid({})).toBe(1);
  });
  it('drops rooms of another tenant and scopes bare names', () => {
    expect(relayRooms(['t2:conv:1', 't1:conv:1', 'conv:9', 5], 2)).toEqual(['t2:conv:1', 't2:conv:9']);
    expect(relayRooms(['user:4'], 1)).toEqual(['t1:user:4']);
    expect(relayRooms('nope', 1)).toEqual([]);
  });
});

describe('handshake tenant (contract §6)', () => {
  it('gates the session tid and the MIS token inside it', async () => {
    expect(await tenantForSession({ tid: 2 }, registry)).toMatchObject({ ok: true, tenant: { tid: 2 } });
    expect(await tenantForSession({}, registry)).toMatchObject({ ok: true, tenant: { tid: 1 } });
    expect(await tenantForSession({ tid: 3 }, registry)).toEqual({ ok: false, message: 'forbidden: TENANT_SUSPENDED' });
    expect(await tenantForSession({ tid: 9 }, registry)).toEqual({ ok: false, message: 'unauthorized: TENANT_UNKNOWN' });
    const misToken = jwt.sign({ sub: '1', tid: 1 }, 'x');
    expect(await tenantForSession({ tid: 2, misToken }, registry)).toEqual({ ok: false, message: 'unauthorized: TENANT_MISMATCH' });
    process.env.TENANCY_LEGACY_DEFAULT_TID = 'none';
    expect(await tenantForSession({}, registry)).toMatchObject({ ok: false, message: 'unauthorized: TENANT_REQUIRED' });
  });
});

describe('a live gateway', () => {
  let server: http.Server;
  let io: Server;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    server = http.createServer();
    io = new Server(server);
    io.use((socket, next) => {
      socket.data.tenant = (socket.handshake.auth as { tid: number }).tid === 2 ? T2 : primaryTenantCtx();
      next();
    });
    // As index.ts: bind the listeners, and run the connection body in the tenant.
    io.on('connection', (socket) => runWithTid(socket.data.tenant.tid, () => {
      bindSocketTenant(socket, socket.data.tenant);
      const uid = (socket.handshake.auth as { uid: string }).uid;
      // Same snowflake-free ids on purpose: the room name alone must separate them.
      void socket.join([userRoom(uid), conversationRoom('100')]);
      socket.on('whoami', (ack: (tid: number) => void) => ack(currentTid()));
      socket.on('disconnect', () => { (io as unknown as { lastDisconnectTid?: number }).lastDisconnectTid = currentTid(); });
    }));
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    io.close();
    await new Promise((r) => server.close(r));
  });

  async function client(tid: number, uid: string) {
    const c = connect(url, { auth: { tid, uid }, transports: ['websocket'], forceNew: true });
    clients.push(c);
    await new Promise<void>((r) => c.on('connect', () => r()));
    await new Promise((r) => setTimeout(r, 30));
    return c;
  }

  it('runs every handler in the socket tenant and fans out only within it', async () => {
    const a = await client(1, '7');
    const b = await client(2, '7');
    expect(await new Promise((r) => a.emit('whoami', r))).toBe(1);
    expect(await new Promise((r) => b.emit('whoami', r))).toBe(2);

    const got: Record<string, string[]> = { a: [], b: [] };
    a.on('ping:test', (m: string) => got.a!.push(m));
    b.on('ping:test', (m: string) => got.b!.push(m));
    // What the relay subscriber does with a tenant-2 message.
    const rooms = relayRooms([userRoom('7', 2), conversationRoom('100', 2), userRoom('7', 1)], 2);
    io.to(rooms).emit('ping:test', 'for-two');
    runWithTid(1, () => io.to(conversationRoom('100')).emit('ping:test', 'for-one'));
    await new Promise((r) => setTimeout(r, 80));
    expect(got.a).toEqual(['for-one']);
    expect(got.b).toEqual(['for-two']);

    b.close();
    await new Promise((r) => setTimeout(r, 80));
    expect((io as unknown as { lastDisconnectTid?: number }).lastDisconnectTid).toBe(2);
  });
});
