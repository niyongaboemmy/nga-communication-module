// VENDORED from nga_central_mis/packages/activity/src/index.ts -- do not edit.
// Re-sync with: node nga_central_mis/packages/activity/sync.mjs <this dir>
// sha256:74261338f7689f9299c91eeec5f321de2f125124bef028115c234ef9518b3967
/**
 * nga-activity: the browser tracker shared by the NGA apps
 * (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.1).
 *
 * Framework-agnostic and dependency-free. Each app vendors it with
 * `node nga_central_mis/packages/activity/sync.mjs <dir>` and never edits the copy.
 *
 * What it records: route PATTERNS (never concrete paths, query strings or hashes),
 * named features, engagement time, heartbeats for live presence, opt-in clicks
 * ([data-track]), outbound links, downloads, tracked form submits (ids only), 90% scroll,
 * JS errors, Web Vitals and, only when the server enables it, a browser location fix.
 * It never records typed text, form values, page content or titles.
 *
 * Identity is never claimed by the browser: the server takes it from the session token
 * sent in `authHeader()`. A browser without a session is a public visitor.
 */

export type AppKey = "mis" | "tm" | "tendo" | "tupo";
export type ParamValue = string | number | boolean | null;
export type Params = Record<string, ParamValue>;

export interface CatalogEntry {
  key: string;
  label?: string;
  module?: string;
  patterns?: string[];
  event?: boolean;
  key_event?: boolean;
  public?: boolean;
}

export interface ActivityOptions {
  app: AppKey;
  /** POST target: MIS `${API}/activity/sync`, satellites their own `/api/activity`. */
  endpoint: string;
  /** GET config: MIS `${API}/activity/config`, satellites `/api/activity/config`. */
  configUrl: string;
  /** The current session token header ("Bearer …"), or null on public pages. Read at send time. */
  authHeader?: () => string | null;
  /** Something that changes when the signed-in person changes (their id). */
  userKey?: () => string | number | null;
  /** The signed-in person's MIS user type, for the "staff" precise-location policy. */
  userType?: () => string | null;
  release?: string;
  catalog?: CatalogEntry[];
  /** "include" when the endpoint is cross-origin and should carry cookies (MIS SPA → api.). */
  credentials?: RequestCredentials;
  /** The server asked this device to sign out (admin "sign out this device"). */
  onEndCommand?: () => void;
  /** Override timings (tests). */
  heartbeatMs?: number;
  flushMs?: number;
  maxBatch?: number;
  debug?: boolean;
}

interface QueuedEvent {
  id: string;
  n: string;
  t: number;
  pv?: string | undefined;
  r?: string | undefined;
  f?: string | undefined;
  p?: Params | undefined;
}

/** What GET /activity/config answers. */
interface ConfigResponse {
  enabled?: boolean;
  heartbeat_s?: number;
  flush_s?: number;
  idle_after_s?: number;
  precise_location?: string;
  did?: string;
  dt?: string;
}

/** What POST /activity/sync (or a relay) answers. */
interface SyncResponse {
  did?: string;
  dt?: string;
  ticket?: string;
  disabled?: boolean;
  cmd?: { type?: string } | null;
}

/** Browser extras that are not (yet) in lib.dom for every TypeScript version. */
type NavigatorExtras = Navigator & {
  webdriver?: boolean;
  standalone?: boolean;
  connection?: { effectiveType?: string };
};
const navx = () => navigator as NavigatorExtras;

type VitalEntry = PerformanceEntry & { hadRecentInput?: boolean; value?: number; interactionId?: number };
interface QueueItem {
  ev: QueuedEvent;
  auth: string | null;
}

const COOKIE_DID = "nga_did";
const COOKIE_DT = "nga_dt";
const LS_QUEUE = "nga_activity_q_";
const MAX_PERSISTED = 200;
const PERSIST_TTL_MS = 24 * 3600_000;
const IDLE_DEFAULT_MS = 120_000;
const STAFF_TYPES = ["TEACHER", "STAFF", "ADMIN"];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const rand = (n: number) => {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
};
export const ulid = (time = Date.now()) => {
  let t = time;
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let r = "";
  for (const b of rand(16)) r += CROCKFORD[b % 32];
  return ts + r;
};
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newDeviceId = () => b64url(rand(16)); // 22 chars
const shortId = () => b64url(rand(6)); // 8 chars

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const ls = {
  get: (k: string) => safe(() => window.localStorage.getItem(k), null),
  set: (k: string, v: string) => safe(() => window.localStorage.setItem(k, v), undefined),
  del: (k: string) => safe(() => window.localStorage.removeItem(k), undefined),
};
const ss = {
  get: (k: string) => safe(() => window.sessionStorage.getItem(k), null),
  set: (k: string, v: string) => safe(() => window.sessionStorage.setItem(k, v), undefined),
};

const cookieDomain = () => {
  const h = location.hostname;
  return /(^|\.)amashuri\.com$/.test(h) ? ".amashuri.com" : null;
};
const readCookie = (name: string) =>
  safe(() => {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1] ?? "") : null;
  }, null);
const writeCookie = (name: string, value: string) =>
  safe(() => {
    const d = cookieDomain();
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=63072000; SameSite=Lax${secure}${d ? `; Domain=${d}` : ""}`;
  }, undefined);

const DID_RE = /^[A-Za-z0-9_-]{22}$/;

// ---------------------------------------------------------------------------
// Route → pattern → feature
// ---------------------------------------------------------------------------
interface CompiledPattern {
  key: string;
  pattern: string;
  re: RegExp;
  score: number;
}
const compile = (catalog: CatalogEntry[]): CompiledPattern[] => {
  const out: CompiledPattern[] = [];
  for (const c of catalog) {
    for (const p of c.patterns ?? []) {
      const norm = p.replace(/\/+$/, "") || "/";
      const segs = norm.split("/").filter(Boolean);
      let score = 0;
      const re = segs
        .map((s) => {
          if (s === "*") return "(?:/.*)?";
          if (s.startsWith(":")) {
            score += 1;
            return s.endsWith("?") ? "(?:/[^/]+)?" : "/[^/]+";
          }
          score += 10;
          return "/" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("");
      out.push({ key: c.key, pattern: norm, re: new RegExp(`^${re || "/"}/?$`, "i"), score });
    }
  }
  // Most specific first: more literal segments, then longer.
  return out.sort((a, b) => b.score - a.score || b.pattern.length - a.pattern.length);
};

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[A-Za-z0-9_-]{20,}|[^/]*@[^/]*)$/i;
/** Best-effort pattern for an uncatalogued path: ids become ":id". */
export const genericPattern = (path: string) =>
  "/" +
  path
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((s) => (ID_SEGMENT.test(s) ? ":id" : s.slice(0, 40)))
    .join("/");

export const resolveRoute = (app: AppKey, compiled: CompiledPattern[], path: string) => {
  const clean = (path.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  for (const c of compiled) if (c.re.test(clean)) return { route: c.pattern, feature: c.key };
  return { route: genericPattern(clean), feature: `${app}.other` };
};

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
class Tracker {
  opts: ActivityOptions;
  did: string;
  dt: string | null;
  tab: string;
  enabled = true;
  heartbeatMs: number;
  flushMs: number;
  idleMs = IDLE_DEFAULT_MS;
  precisePolicy = "off";
  queue: QueueItem[] = [];
  compiled: CompiledPattern[];
  ticket: string | null = null;
  lastUserKey: string | number | null = null;

  // page state
  pv: string | null = null;
  route: string | null = null;
  feature: string | null = null;
  path: string | null = null;
  firstPageSent = false;
  scrolled = false;
  errorsThisPage = 0;

  // engagement
  engagedMs = 0;
  activeSince: number | null = null;
  lastInput = Date.now();
  idleReported = false;

  timers: number[] = [];
  /** Set by pagehide: the page said goodbye, so the visibilitychange that follows stays quiet. */
  leaving = false;
  inflight: Promise<void> | null = null;
  destroyed = false;
  vitals: Record<string, number> = {};

  constructor(opts: ActivityOptions) {
    this.opts = opts;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.flushMs = opts.flushMs ?? 5_000;
    this.compiled = compile(opts.catalog ?? []);
    this.tab = ss.get("nga_activity_tab") || shortId();
    ss.set("nga_activity_tab", this.tab);
    const fromCookie = readCookie(COOKIE_DID);
    const fromLs = ls.get(COOKIE_DID);
    this.did = (fromCookie && DID_RE.test(fromCookie) ? fromCookie : fromLs && DID_RE.test(fromLs) ? fromLs : null) || newDeviceId();
    this.dt = readCookie(COOKIE_DT) || ls.get(COOKIE_DT);
    this.persistIdentity();
    this.lastUserKey = opts.userKey?.() ?? null;
    this.restoreQueue();
  }

  log(...a: unknown[]) {
    if (this.opts.debug || ls.get("nga_activity_debug") === "1") console.debug("[nga-activity]", ...a);
  }

  persistIdentity() {
    writeCookie(COOKIE_DID, this.did);
    ls.set(COOKIE_DID, this.did);
    if (this.dt) {
      writeCookie(COOKIE_DT, this.dt);
      ls.set(COOKIE_DT, this.dt);
    }
  }

  adoptIdentity(did?: string, dt?: string) {
    if (did && DID_RE.test(did) && did !== this.did) {
      this.did = did;
      this.dt = null;
    }
    if (dt) this.dt = dt;
    this.persistIdentity();
  }

  async loadConfig() {
    const cacheKey = `nga_activity_cfg_${this.opts.app}`;
    const cached = safe(() => JSON.parse(ss.get(cacheKey) || "null"), null) as { at: number; did: string; cfg: ConfigResponse } | null;
    let cfg: ConfigResponse | null = cached && cached.at > Date.now() - 10 * 60_000 && cached.did === this.did ? cached.cfg : null;
    if (!cfg) {
      try {
        const url = `${this.opts.configUrl}${this.opts.configUrl.includes("?") ? "&" : "?"}did=${encodeURIComponent(this.did)}&dt=${encodeURIComponent(this.dt ?? "")}`;
        const res = await fetch(url, { credentials: this.opts.credentials ?? "same-origin" });
        if (res.ok) {
          const fresh = (await res.json()) as ConfigResponse;
          cfg = fresh;
          this.adoptIdentity(fresh.did, fresh.dt);
          ss.set(cacheKey, JSON.stringify({ at: Date.now(), did: this.did, cfg }));
        }
      } catch {
        /* offline: keep defaults */
      }
    }
    if (cfg) {
      this.enabled = cfg.enabled !== false;
      if (!this.opts.heartbeatMs && cfg.heartbeat_s) this.heartbeatMs = cfg.heartbeat_s * 1000;
      if (!this.opts.flushMs && cfg.flush_s) this.flushMs = cfg.flush_s * 1000;
      if (cfg.idle_after_s) this.idleMs = cfg.idle_after_s * 1000;
      this.precisePolicy = cfg.precise_location || "off";
    }
  }

  // --- visibility / engagement -------------------------------------------------
  isActiveNow() {
    return document.visibilityState === "visible" && safe(() => document.hasFocus(), true);
  }
  /** Fold the running stretch into engagedMs (only time with input in the last idleMs counts). */
  accumulate(now = Date.now()) {
    if (this.activeSince !== null) {
      const end = Math.min(now, this.lastInput + this.idleMs);
      if (end > this.activeSince) this.engagedMs += end - this.activeSince;
      this.activeSince = this.isActiveNow() && now - this.lastInput < this.idleMs ? now : null;
    } else if (this.isActiveNow() && now - this.lastInput < this.idleMs) {
      this.activeSince = now;
    }
  }
  onInput = () => {
    const now = Date.now();
    this.accumulate(now);
    this.lastInput = now;
    if (this.activeSince === null && this.isActiveNow()) this.activeSince = now;
    if (this.idleReported) {
      this.idleReported = false;
      this.beat("visible");
    }
  };
  /** Emit user_engagement for the current page view if anything accrued. */
  flushEngagement() {
    this.accumulate();
    const ms = Math.round(this.engagedMs);
    if (this.pv && ms >= 1000) {
      this.push("user_engagement", { ms }, { pv: this.pv, r: this.route ?? undefined, f: this.feature ?? undefined });
      this.engagedMs = 0;
    }
  }

  // --- queue ---------------------------------------------------------------------
  push(n: string, p?: Params, extra: Partial<QueuedEvent> = {}) {
    if (!this.enabled || this.destroyed) return;
    this.checkUser();
    const ev: QueuedEvent = { id: ulid(), n, t: Date.now(), ...extra };
    if (p && Object.keys(p).length) ev.p = p;
    this.queue.push({ ev, auth: this.opts.authHeader?.() ?? null });
    this.log(n, ev);
    if (this.queue.length >= (this.opts.maxBatch ?? 20)) void this.flush();
  }

  checkUser() {
    const k = this.opts.userKey?.() ?? null;
    if (k !== this.lastUserKey) {
      // Account switch: queued events keep the token they were recorded under.
      this.lastUserKey = k;
      this.ticket = null;
    }
  }

  persistQueue() {
    const keep = this.queue.slice(-MAX_PERSISTED).map((q) => ({ ...q, at: Date.now() }));
    if (keep.length) ls.set(LS_QUEUE + this.opts.app, JSON.stringify(keep));
    else ls.del(LS_QUEUE + this.opts.app);
  }
  restoreQueue() {
    const raw = safe(() => JSON.parse(ls.get(LS_QUEUE + this.opts.app) || "[]"), []) as { ev?: QueuedEvent; auth?: string | null; at?: number }[];
    const fresh = raw.filter((q): q is { ev: QueuedEvent; auth?: string | null; at?: number } => !!q && !!q.ev && Date.now() - (q.at ?? 0) < PERSIST_TTL_MS);
    this.queue = fresh.map((q) => ({ ev: q.ev, auth: q.auth ?? null })).concat(this.queue);
    ls.del(LS_QUEUE + this.opts.app);
  }

  envelope(events: QueuedEvent[], beat?: Record<string, unknown>) {
    const scr = safe(() => `${screen.width}x${screen.height}@${Math.round((window.devicePixelRatio || 1) * 10) / 10}`, undefined);
    return {
      v: 1,
      app: this.opts.app,
      did: this.did,
      dt: this.dt ?? undefined,
      tab: this.tab,
      rel: this.opts.release?.slice(0, 40),
      sent_at: Date.now(),
      tz: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, undefined),
      lang: navigator.language?.slice(0, 35),
      scr,
      vp: `${window.innerWidth}x${window.innerHeight}`,
      env: { auto: navx().webdriver ? 1 : 0, standalone: isStandalone() },
      events,
      ...(beat ? { beat } : {}),
      ...(this.ticket ? { ticket: this.ticket } : {}),
    };
  }

  async send(body: unknown, auth: string | null, unloading: boolean): Promise<boolean> {
    const json = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = auth;
    // While the page unloads:
    //  - same origin (the apps' own relay): keepalive fetch, which keeps the Authorization header;
    //  - cross origin (MIS SPA → api.): Chrome refuses keepalive requests that need a CORS
    //    preflight, and an Authorization header always does. sendBeacon sends text/plain
    //    (no preflight) with cookies, and the signed ticket in the body identifies the user.
    if (unloading && json.length < 60_000) {
      const sameOrigin = safe(() => new URL(this.opts.endpoint, location.href).origin === location.origin, false);
      if (!sameOrigin && navigator.sendBeacon) {
        try {
          if (navigator.sendBeacon(this.opts.endpoint, new Blob([json], { type: "text/plain" }))) return true;
        } catch {
          /* fall through to keepalive */
        }
      }
      try {
        void fetch(this.opts.endpoint, { method: "POST", body: json, headers, keepalive: true, credentials: this.opts.credentials ?? "same-origin" }).catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    }
    try {
      const res = await fetch(this.opts.endpoint, { method: "POST", body: json, headers, credentials: this.opts.credentials ?? "same-origin", keepalive: json.length < 60_000 });
      if (res.status >= 500) return false;
      const data = (await res.json().catch(() => null)) as SyncResponse | null;
      if (data) {
        if (data.did || data.dt) this.adoptIdentity(data.did, data.dt);
        if (data.ticket) this.ticket = data.ticket;
        if (data.disabled) this.enabled = false;
        if (data.cmd?.type === "end") this.opts.onEndCommand?.();
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Send everything queued (grouped by the token each event was recorded under). */
  async flush(opts: { unloading?: boolean; beat?: Record<string, unknown> } = {}): Promise<void> {
    if (!this.enabled && !opts.beat) return;
    // One send at a time (except on unload, which can't wait): a flush requested while
    // another is in flight runs right after it, so an explicit flush never loses events.
    if (this.inflight && !opts.unloading) {
      await this.inflight.catch(() => undefined);
      return this.flush(opts);
    }
    const run = this.doFlush(opts);
    if (!opts.unloading) {
      this.inflight = run.finally(() => {
        this.inflight = null;
      });
    }
    return run;
  }

  private async doFlush(opts: { unloading?: boolean; beat?: Record<string, unknown> }) {
    const items = this.queue;
    this.queue = [];
    const groups = new Map<string, QueuedEvent[]>();
    for (const it of items) {
      const k = it.auth ?? "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(it.ev);
    }
    const currentAuth = this.opts.authHeader?.() ?? null;
    if (opts.beat && !groups.has(currentAuth ?? "")) groups.set(currentAuth ?? "", []);
    if (!groups.size) return;
    try {
      for (const [auth, events] of groups) {
        for (let i = 0; i < Math.max(1, events.length); i += 100) {
          const chunk = events.slice(i, i + 100);
          const beat = (auth || null) === currentAuth && i === 0 ? opts.beat : undefined;
          if (!chunk.length && !beat) continue;
          const ok = await this.send(this.envelope(chunk, beat), auth || null, !!opts.unloading);
          if (!ok) this.queue.unshift(...chunk.map((ev) => ({ ev, auth: auth || null })));
        }
      }
    } finally {
      if (this.queue.length) this.persistQueue();
      else ls.del(LS_QUEUE + this.opts.app);
    }
  }

  beat(vis: "visible" | "hidden" | "gone", unloading = false) {
    if (!this.enabled) return;
    const idle = vis === "visible" && Date.now() - this.lastInput >= this.idleMs;
    this.idleReported = idle;
    this.flushEngagement();
    void this.flush({
      unloading,
      beat: { vis, idle, r: this.route ?? undefined, f: this.feature ?? undefined, standalone: isStandalone(), net: navx().connection?.effectiveType },
    });
  }

  // --- pages -----------------------------------------------------------------------
  page(path: string, nav: "load" | "push" | "pop" | "replace" = "push") {
    const { route, feature } = resolveRoute(this.opts.app, this.compiled, path);
    const concrete = (path.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
    // GA pitfall: replaceState that keeps the same page is not a new view, and neither is
    // a re-render of the same path. /courses/1 → /courses/2 (same pattern) is.
    if (nav === "replace" && route === this.route) return;
    if (concrete === this.path && this.pv && nav !== "load") return;
    this.path = concrete;
    this.flushEngagement();
    const refRoute = this.route;
    this.pv = shortId();
    this.route = route;
    this.feature = feature;
    this.scrolled = false;
    this.errorsThisPage = 0;
    this.engagedMs = 0;
    this.activeSince = this.isActiveNow() ? Date.now() : null;
    const p: Params = { nav };
    if (refRoute) p.ref_route = refRoute;
    if (!this.firstPageSent) {
      this.firstPageSent = true;
      const ref = safe(() => (document.referrer ? new URL(document.referrer).hostname : ""), "");
      if (ref && ref !== location.hostname) p.ref_host = ref;
      const sp = safe(() => new URLSearchParams(location.search), new URLSearchParams());
      for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
        const v = sp.get(k);
        if (v) p[k] = v.slice(0, 100);
      }
      if (path.startsWith("/sso/callback") || sp.has("code")) p.entry = "sso";
      else if (sp.get("source") === "push" || sp.has("nga_push")) p.entry = "push";
    }
    this.push("page_view", p, { pv: this.pv, r: route, f: feature });
    this.beat("visible");
    this.maybeLocate();
  }

  // --- precise location (server policy; the browser always asks the person) ---------
  maybeLocate() {
    const policy = this.precisePolicy;
    if (policy === "off" || !navigator.geolocation) return;
    const signedIn = !!this.opts.authHeader?.();
    const type = this.opts.userType?.() ?? null;
    const allowed =
      policy === "everyone" || (policy === "known_users" && signedIn) || (policy === "staff" && signedIn && !!type && STAFF_TYPES.includes(type));
    if (!allowed || ls.get("nga_loc_state") === "denied" || ss.get("nga_loc_sent") === "1") return;
    ss.set("nga_loc_sent", "1");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        ls.set("nga_loc_state", "granted");
        this.push("location_fix", {
          lat: Math.round(pos.coords.latitude * 1e4) / 1e4,
          lon: Math.round(pos.coords.longitude * 1e4) / 1e4,
          accuracy_m: Math.round(pos.coords.accuracy),
        });
      },
      (err) => {
        if (err.code === 1) {
          ls.set("nga_loc_state", "denied");
          this.push("location_denied");
        }
      },
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 15_000 },
    );
  }

  // --- autocapture -------------------------------------------------------------------
  onClick = (e: MouseEvent) => {
    const el = e.target as Element | null;
    if (!el || !el.closest) return;
    const tracked = el.closest("[data-track]") as HTMLElement | null;
    if (tracked) {
      const key = (tracked.getAttribute("data-track") || "").slice(0, 80);
      if (key) this.push("click", { key }, { pv: this.pv ?? undefined, r: this.route ?? undefined, f: this.feature ?? undefined });
    }
    const a = el.closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const url = safe(() => new URL(a.href, location.href), null);
    if (!url || !/^https?:$/.test(url.protocol)) return;
    const ext = (url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toLowerCase();
    if (a.hasAttribute("download") || DOWNLOAD_EXT.has(ext)) {
      this.push("file_download", { file_ext: ext || null, link_host: url.hostname }, { pv: this.pv ?? undefined, r: this.route ?? undefined, f: this.feature ?? undefined });
    } else if (url.hostname !== location.hostname) {
      this.push("click", { outbound: true, link_host: url.hostname }, { pv: this.pv ?? undefined, r: this.route ?? undefined, f: this.feature ?? undefined });
    }
  };
  onSubmit = (e: Event) => {
    const form = e.target as HTMLFormElement | null;
    const id = form?.getAttribute?.("data-track-form");
    if (id) this.push("form_submit", { form_id: id.slice(0, 80) }, { pv: this.pv ?? undefined, r: this.route ?? undefined, f: this.feature ?? undefined });
  };
  onScroll = () => {
    if (this.scrolled) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max > 200 && (window.scrollY || doc.scrollTop) / max >= 0.9) {
      this.scrolled = true;
      this.push("scroll", { percent: 90 }, { pv: this.pv ?? undefined, r: this.route ?? undefined, f: this.feature ?? undefined });
    }
  };
  onError = (msg: string, src?: string, line?: number) => {
    if (this.errorsThisPage++ >= 5) return;
    this.push("js_error", { msg: String(msg).slice(0, 200), src: src ? genericPattern(safe(() => new URL(src).pathname, src)).slice(0, 120) : null, line: line ?? null }, { pv: this.pv ?? undefined, r: this.route ?? undefined, f: this.feature ?? undefined });
  };

  observeVitals() {
    if (typeof PerformanceObserver === "undefined") return;
    const obs = (type: string, cb: (entries: VitalEntry[]) => void) =>
      safe(() => {
        const o = new PerformanceObserver((l) => cb(l.getEntries() as VitalEntry[]));
        o.observe({ type, buffered: true } as PerformanceObserverInit);
      }, undefined);
    obs("largest-contentful-paint", (es) => {
      const last = es[es.length - 1];
      if (last) this.vitals.LCP = last.startTime;
    });
    obs("layout-shift", (es) => {
      for (const e of es) if (!e.hadRecentInput) this.vitals.CLS = (this.vitals.CLS ?? 0) + (e.value ?? 0);
    });
    obs("event", (es) => {
      for (const e of es) if (e.interactionId) this.vitals.INP = Math.max(this.vitals.INP ?? 0, e.duration);
    });
    const nav = safe(() => performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined, undefined);
    if (nav) this.vitals.TTFB = nav.responseStart;
  }
  reportVitals() {
    const T: Record<string, [number, number]> = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], TTFB: [800, 1800] };
    for (const [name, value] of Object.entries(this.vitals)) {
      const [good, poor] = T[name] ?? [0, 0];
      this.push("web_vital", { name, value: Math.round(value * (name === "CLS" ? 1000 : 1)) / (name === "CLS" ? 1000 : 1), rating: value <= good ? "good" : value <= poor ? "needs-improvement" : "poor" }, { r: this.route ?? undefined, f: this.feature ?? undefined });
    }
    this.vitals = {};
  }

  // --- lifecycle -------------------------------------------------------------------
  onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.accumulate();
      this.activeSince = null;
      this.reportVitals();
      if (this.leaving) {
        void this.flush({ unloading: true });
        return;
      }
      this.beat("hidden", true);
    } else {
      this.lastInput = Date.now();
      this.accumulate();
      this.beat("visible");
    }
  };
  onFocusChange = () => this.accumulate();
  // The tab is leaving: closed, navigated away, or frozen into the back/forward cache.
  // In every case the person is no longer on this page, so say "gone"; if the page is
  // restored from bfcache, `pageshow` reports it visible again.
  onPageHide = () => {
    this.leaving = true;
    this.reportVitals();
    this.flushEngagement();
    void this.flush({ unloading: true, beat: { vis: "gone", r: this.route ?? undefined, f: this.feature ?? undefined } });
  };
  onPageShow = (e: PageTransitionEvent) => {
    this.leaving = false;
    if (e.persisted) {
      this.lastInput = Date.now();
      this.beat("visible");
    }
  };

  start() {
    const on = (t: EventTarget, ev: string, fn: (e: never) => void, opts: AddEventListenerOptions = { passive: true, capture: true }) =>
      t.addEventListener(ev, fn as unknown as EventListener, opts);
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"]) on(window, ev, this.onInput);
    on(window, "scroll", () => {
      this.onInput();
      this.onScroll();
    });
    on(document, "click", this.onClick);
    on(document, "submit", this.onSubmit);
    on(document, "visibilitychange", this.onVisibility);
    on(window, "focus", this.onFocusChange);
    on(window, "blur", this.onFocusChange);
    on(window, "pagehide", this.onPageHide);
    on(window, "pageshow", this.onPageShow);
    window.addEventListener("error", (e) => this.onError(e.message, e.filename, e.lineno));
    window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
      const reason = e.reason as { message?: unknown } | string | null | undefined;
      const msg = typeof reason === "string" ? reason : reason && typeof reason.message === "string" ? reason.message : "";
      this.onError(`Unhandled: ${msg}`);
    });
    this.observeVitals();
    this.timers.push(
      window.setInterval(() => {
        if (document.visibilityState === "visible") this.beat("visible");
      }, this.heartbeatMs),
      window.setInterval(() => {
        if (this.queue.length) void this.flush();
      }, this.flushMs),
    );
  }

  destroy() {
    this.destroyed = true;
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }
}

const DOWNLOAD_EXT = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "zip", "rar", "7z", "mp4", "mp3", "png", "jpg", "jpeg", "odt", "ods"]);

const isStandalone = () =>
  safe(() => window.matchMedia("(display-mode: standalone)").matches || navx().standalone === true, false);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
let tracker: Tracker | null = null;

/** Start tracking. Safe to call once per page load; later calls are ignored. */
export const initActivity = (opts: ActivityOptions) => {
  if (tracker || typeof window === "undefined") return tracker;
  try {
    tracker = new Tracker(opts);
    const t = tracker;
    void t.loadConfig().then(() => {
      if (t.enabled) t.start();
      else t.destroy();
    });
  } catch {
    tracker = null;
  }
  return tracker;
};

/** Record a route change. `nav` is the router's navigation type. */
export const trackPage = (path: string, nav: "load" | "push" | "pop" | "replace" = "push") => {
  try {
    tracker?.page(path, nav);
  } catch {
    /* never break the app */
  }
};

/** Record a named event (e.g. a key event like "tm.quiz.submit"). */
export const track = (name: string, params?: Params) => {
  try {
    if (!/^[a-z][a-z0-9_.]{0,63}$/.test(name)) return;
    tracker?.push(name, params, { pv: tracker.pv ?? undefined, r: tracker.route ?? undefined, f: tracker.feature ?? undefined });
  } catch {
    /* never break the app */
  }
};

/** Send whatever is queued now (call before a full-page redirect such as SSO hand-off). */
export const flushActivity = (unloading = false) => tracker?.flush({ unloading }) ?? Promise.resolve();

/** Tell the server this tab is going away now (logout). */
export const endActivity = () => {
  try {
    tracker?.flushEngagement();
    return tracker?.flush({ unloading: true, beat: { vis: "gone" } }) ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
};

/** The shared device id, e.g. for an `X-NGA-Device` header on login requests. */
export const getDeviceId = () => tracker?.did ?? safe(() => readCookie(COOKIE_DID) || ls.get(COOKIE_DID), null);

/** Tests only. */
export const _resetActivityForTests = () => {
  tracker?.destroy();
  tracker = null;
};
export const _trackerForTests = () => tracker;
