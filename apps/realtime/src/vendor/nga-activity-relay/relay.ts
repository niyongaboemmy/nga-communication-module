// VENDORED from nga_central_mis/packages/activity/src/relay.ts -- do not edit.
// Re-sync with: node nga_central_mis/packages/activity/sync.mjs --relay <this dir>
// sha256:28f2f0e83feada13f7124999f0db6e45c12c6dfa3facd01abb154bd08965b027
/**
 * nga-activity relay: the server half each satellite app mounts
 * (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2).
 *
 * The browser posts to its OWN backend (same origin, its own session). This relay:
 *   1. takes the MIS user id from the app's session (or null for a public visitor);
 *      a user id the browser puts in the body is ignored;
 *   2. stamps the real client IP (the app needs `trust proxy`) and user agent;
 *   3. refuses anonymous traffic from foreign origins and rate-limits it per IP;
 *   4. coalesces every user's batches and forwards them to MIS every few seconds,
 *      gzipped, with the app's SSO client credentials;
 *   5. answers the browser at once, so analytics never slows the app down.
 * A MIS outage costs at most `maxQueue` batches. The app itself is never affected.
 *
 * Framework-agnostic: handlers take Express-like (req, res).
 */
import { gzipSync } from "zlib";
import { randomBytes } from "crypto";

export interface RelayOptions {
  app: "tm" | "tendo" | "tupo";
  /** MIS API base, e.g. https://api.amashuri.com (NGA_MIS_BASE_URL). */
  misBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** SPA origins allowed to send anonymous (public-page) batches. */
  origins: string[];
  /** The MIS user id behind this request's session, or null. Must never throw. */
  getUserId: (req: any) => number | null | Promise<number | null>;
  flushMs?: number;
  maxQueue?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: { warn: (...a: any[]) => void; error: (...a: any[]) => void };
}

interface Batch {
  user_id: number | null;
  ip: string | null;
  ua: string | null;
  lang: string | null;
  envelope: any;
}
interface ServerEvent {
  id: string;
  n: string;
  t: number;
  user_id?: number | null;
  did?: string | null;
  ip?: string | null;
  p?: Record<string, unknown>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (time = Date.now()) => {
  let t = time;
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let r = "";
  for (const b of randomBytes(16)) r += CROCKFORD[b % 32];
  return ts + r;
};

class Bucket {
  private m = new Map<string, { tokens: number; at: number }>();
  constructor(private cap: number, private perMs: number) {}
  take(k: string, cost = 1) {
    const now = Date.now();
    let b = this.m.get(k);
    if (!b) {
      b = { tokens: this.cap, at: now };
      this.m.set(k, b);
      if (this.m.size > 20_000) this.m.delete(this.m.keys().next().value as string);
    } else {
      b.tokens = Math.min(this.cap, b.tokens + (now - b.at) * this.perMs);
      b.at = now;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
}

const clientIp = (req: any): string | null => {
  const ip = String(req.ip || req.socket?.remoteAddress || "");
  return ip.replace(/^::ffff:/, "") || null;
};

export const createActivityRelay = (opts: RelayOptions) => {
  const log = opts.logger ?? console;
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.misBaseUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`;
  const maxQueue = opts.maxQueue ?? 10_000;
  const anon = new Bucket(30, 30 / 60_000);
  const origins = new Set(opts.origins.map((o) => o.replace(/\/$/, "")));

  let batches: Batch[] = [];
  let serverEvents: ServerEvent[] = [];
  const commands = new Map<string, unknown>(); // did → cmd from MIS, handed to the browser next time
  let flushing = false;
  const stats = { forwarded: 0, dropped: 0, failures: 0, lastOkAt: 0 };

  const enqueue = (b: Batch) => {
    // Coalesce presence: keep only the newest beat per tab inside the window.
    const tab = b.envelope?.tab;
    if (tab && b.envelope?.beat && !(b.envelope.events?.length)) {
      const i = batches.findIndex((x) => x.envelope?.tab === tab && x.envelope?.did === b.envelope.did && !(x.envelope.events?.length));
      if (i >= 0) batches.splice(i, 1);
    }
    batches.push(b);
    while (batches.length > maxQueue) {
      batches.shift();
      stats.dropped++;
    }
  };

  const flush = async () => {
    if (flushing || (!batches.length && !serverEvents.length)) return;
    flushing = true;
    const sendB = batches.splice(0, 500);
    const sendS = serverEvents.splice(0, 500);
    try {
      const body = gzipSync(Buffer.from(JSON.stringify({ app: opts.app, batches: sendB, server_events: sendS })));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000);
      const res = await doFetch(`${base}/activity/ingest`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", "Content-Encoding": "gzip" },
        body,
        signal: ctrl.signal,
      } as any).finally(() => clearTimeout(timer));
      if (res.status >= 500 || res.status === 429) throw new Error(`MIS answered ${res.status}`);
      if (res.status >= 400) {
        // A config problem (credentials/allowlist): retrying won't help.
        stats.dropped += sendB.length + sendS.length;
        log.warn(`[activity-relay] MIS refused the batch (${res.status}); check ACTIVITY_SOURCE_CLIENTS and SSO credentials`);
      } else {
        stats.forwarded += sendB.length + sendS.length;
        stats.lastOkAt = Date.now();
        const data: any = await res.json().catch(() => null);
        for (const c of data?.commands ?? []) if (c?.did) commands.set(c.did, c.cmd);
      }
    } catch (err: any) {
      stats.failures++;
      // One retry: put them back at the front if there is room.
      if (batches.length + sendB.length <= maxQueue) batches = sendB.concat(batches);
      else stats.dropped += sendB.length;
      serverEvents = sendS.concat(serverEvents).slice(0, maxQueue);
      log.warn(`[activity-relay] forward failed: ${err?.message ?? err}`);
    } finally {
      flushing = false;
    }
  };

  const timer = setInterval(() => void flush(), opts.flushMs ?? 5_000);
  (timer as any).unref?.();

  const parseBody = (req: any) => {
    const b = req.body;
    if (b && typeof b === "object" && !Buffer.isBuffer(b)) return b;
    const s = Buffer.isBuffer(b) ? b.toString("utf8") : typeof b === "string" ? b : "";
    return s ? JSON.parse(s) : null;
  };

  /** POST /api/activity — mount with an optional-auth middleware and a 256 kB JSON/text parser. */
  const handler = async (req: any, res: any) => {
    try {
      const env = parseBody(req);
      if (!env || typeof env !== "object" || typeof env.did !== "string") return res.status(204).end();
      let userId: number | null = null;
      try {
        userId = (await opts.getUserId(req)) ?? null;
      } catch {
        userId = null;
      }
      const ip = clientIp(req);
      if (!userId) {
        const origin = String(req.get?.("Origin") || req.headers?.origin || "").replace(/\/$/, "");
        if (!origin || !origins.has(origin)) return res.status(204).end();
        if (!anon.take(ip ?? "unknown")) return res.status(204).end();
      }
      delete env.user_id;
      enqueue({
        user_id: userId,
        ip,
        ua: String(req.get?.("User-Agent") || req.headers?.["user-agent"] || "").slice(0, 512) || null,
        lang: String(req.get?.("Accept-Language") || "").slice(0, 35) || null,
        envelope: env,
      });
      const cmd = commands.get(env.did);
      if (cmd) {
        commands.delete(env.did);
        return res.status(202).json({ ok: true, cmd });
      }
      return res.status(204).end();
    } catch {
      return res.status(204).end();
    }
  };

  /** GET /api/activity/config — proxied to MIS (device id/token + switches). */
  const configHandler = async (req: any, res: any) => {
    const qs = new URLSearchParams();
    if (req.query?.did) qs.set("did", String(req.query.did));
    if (req.query?.dt) qs.set("dt", String(req.query.dt));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      const r = await doFetch(`${base}/activity/config?${qs}`, { signal: ctrl.signal } as any).finally(() => clearTimeout(t));
      res.set?.("Cache-Control", "no-store");
      return res.status(200).json(await r.json());
    } catch {
      // MIS unreachable: tell the SDK to stay quiet rather than queue forever.
      return res.status(200).json({ enabled: false, v: 1 });
    }
  };

  /** Server-side key event (counted even if the browser closed). */
  const track = (userId: number | null, deviceId: string | null, name: string, params?: Record<string, unknown>, ip?: string | null) => {
    if (!/^[a-z][a-z0-9_.]{0,63}$/.test(name)) return;
    serverEvents.push({ id: ulid(), n: name, t: Date.now(), user_id: userId, did: deviceId && /^[A-Za-z0-9_-]{22}$/.test(deviceId) ? deviceId : null, ip: ip ?? null, p: params });
    if (serverEvents.length > maxQueue) serverEvents.shift();
  };

  /** Publish this app's feature catalog (call once on boot; failures are only logged). */
  const pushCatalog = async (catalog: { version?: string; features: unknown[] }) => {
    try {
      const r = await doFetch(`${base}/monitor/catalog/${opts.app}`, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(catalog),
      } as any);
      if (!r.ok) log.warn(`[activity-relay] catalog push answered ${r.status}`);
      return r.ok;
    } catch (err: any) {
      log.warn(`[activity-relay] catalog push failed: ${err?.message ?? err}`);
      return false;
    }
  };

  /** The device id a request carries (shared cookie or SDK header), for server-side `track`. */
  const deviceIdOf = (req: any): string | null => {
    const h = req.get?.("X-NGA-Device") || req.headers?.["x-nga-device"];
    const c = req.cookies?.nga_did ?? String(req.headers?.cookie || "").match(/(?:^|; )nga_did=([^;]+)/)?.[1];
    for (const v of [h, c]) if (typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v)) return v;
    return null;
  };

  const stop = async () => {
    clearInterval(timer);
    await flush();
  };

  return { handler, configHandler, track, pushCatalog, deviceIdOf, flush, stop, stats, _queue: () => ({ batches: batches.length, serverEvents: serverEvents.length }) };
};

export type ActivityRelay = ReturnType<typeof createActivityRelay>;
