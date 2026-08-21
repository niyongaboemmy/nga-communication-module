import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getPool } from '@tupo/db';

/**
 * Link unfurling (FR-MSG-22).
 *
 * This is the most dangerous feature in the chat module, and it is worth being
 * explicit about why: it takes a string a *pupil* typed and makes the server
 * fetch it. Without care that is a server-side request forgery primitive
 * pointed at the school's own network — cloud metadata endpoints, the MIS on
 * localhost, a printer's admin page, anything the API container can reach and
 * the author cannot.
 *
 * The defences, in the order they apply:
 *
 *  1. **Scheme allowlist.** http and https only. No `file:`, no `gopher:`, no
 *     `data:`.
 *  2. **DNS resolved *before* connecting, and every returned address checked**
 *     against the private ranges. Checking the hostname string is useless:
 *     `internal.example.com` can resolve to 10.0.0.1, and `127.0.0.1.nip.io`
 *     resolves to loopback by design.
 *  3. **The connection is pinned to the address that was checked.** Resolving,
 *     approving, then handing the *hostname* to fetch leaves a DNS-rebinding
 *     window in which the second lookup returns something else. The request
 *     goes to the vetted IP with the original Host header.
 *  4. **Redirects are followed manually**, with every hop re-validated. A
 *     public URL that 302s to 169.254.169.254 is the standard bypass.
 *  5. **Bounded** — timeout, response size, and redirect count. A slow or
 *     enormous response must not tie up a worker.
 *  6. **HTML only.** The body is parsed for a handful of meta tags and nothing
 *     else is retained.
 *
 * Refusals are cached alongside successes, so a blocked address is not
 * re-resolved every time somebody re-renders the message.
 */

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  status: 'ok' | 'blocked' | 'failed';
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
/** Re-fetch a preview older than this the next time it is needed. */
export const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const urlHash = (url: string) => createHash('sha256').update(url).digest('hex');

/** Bare URLs in a message body. Deliberately the same shape the renderer uses. */
const URL_PATTERN = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g;

export function extractUrls(body: string | null, limit = 3): string[] {
  if (!body) return [];
  // Three at most. A message pasting twenty links is a link dump, and unfurling
  // all of them is both useless to read and twenty outbound requests.
  return [...new Set(body.match(URL_PATTERN) ?? [])].slice(0, limit);
}

/**
 * Is this address one the server should refuse to talk to?
 *
 * Covers loopback, link-local (including the cloud metadata address), every
 * RFC 1918 range, carrier-grade NAT, and the IPv6 equivalents — including
 * IPv4-mapped IPv6, which is how a blocked v4 address sneaks back in.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;

  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;                 // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;                   // 192.0.0.0/24, 192.0.2.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a >= 224) return true;                               // multicast + reserved
    return false;
  }

  const v6 = address.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe80')) return true;                    // link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique local
  if (v6.startsWith('ff')) return true;                      // multicast
  // ::ffff:10.0.0.1 — a v4 address wearing a v6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isBlockedAddress(mapped[1]!);
  return false;
}

/** Resolve a hostname and approve it only if *every* address is public. */
async function resolveSafely(hostname: string): Promise<string | null> {
  // A literal IP skips DNS but not the check.
  if (isIP(hostname)) return isBlockedAddress(hostname) ? null : hostname;

  try {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length) return null;
    // *Every* address must be public. A host that resolves to one public and
    // one private address is a host that can be raced.
    if (addresses.some((a) => isBlockedAddress(a.address))) return null;
    return addresses[0]!.address;
  } catch {
    return null;
  }
}

/** Strip a URL down to something worth caching under. */
function normalise(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Tracking parameters make the same page a different cache key every time.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_eid|ref_?$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

/**
 * Fetch one hop, with the connection pinned to a vetted address.
 *
 * `redirect: 'manual'` is what makes step 4 possible: the platform following a
 * redirect itself would resolve the next hop's hostname with none of this
 * applied.
 */
async function fetchHop(url: URL, address: string): Promise<Response | null> {
  const pinned = new URL(url.toString());
  // Literal IPv6 in a URL needs brackets.
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(pinned.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        // The Host header keeps virtual hosting working even though the
        // connection went to an IP.
        Host: url.host,
        'User-Agent': 'TupoBot/1.0 (+link preview)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most MAX_BYTES, so a huge or endless body cannot exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    chunks.push(value);
    if (total >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(
    chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

/**
 * Pull the handful of tags worth showing.
 *
 * A regex rather than a DOM parser, deliberately. Nothing here is rendered as
 * markup — every value is escaped by React on the way out — so the only job is
 * to extract four short strings, and adding an HTML parser to the dependency
 * tree to do it would be a poor trade.
 */
function parseMeta(html: string): Omit<LinkPreview, 'url' | 'status'> {
  const head = html.slice(0, 100_000);

  const meta = (property: string): string | null => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*>`, 'i');
    const tag = pattern.exec(head)?.[0];
    if (!tag) return null;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    return content ? decodeEntities(content).trim().slice(0, 300) || null : null;
  };

  const titleTag = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(head)?.[1];

  return {
    title: meta('og:title') ?? meta('twitter:title')
      ?? (titleTag ? decodeEntities(titleTag).trim().slice(0, 300) || null : null),
    description: meta('og:description') ?? meta('twitter:description') ?? meta('description'),
    imageUrl: meta('og:image') ?? meta('twitter:image'),
    siteName: meta('og:site_name'),
  };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};
const decodeEntities = (s: string) =>
  s.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);

/** Fetch a preview, following redirects with every hop re-validated. */
export async function fetchPreview(rawUrl: string): Promise<LinkPreview> {
  const url = normalise(rawUrl);
  if (!url) return blocked(rawUrl);

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await resolveSafely(current.hostname);
    if (!address) return blocked(url.toString());

    const res = await fetchHop(current, address);
    if (!res) return { ...empty(url.toString()), status: 'failed' };

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { ...empty(url.toString()), status: 'failed' };
      const next = normalise(new URL(location, current).toString());
      // A redirect to a non-http scheme, or one we cannot parse, is refused
      // rather than followed.
      if (!next) return blocked(url.toString());
      current = next;
      continue;
    }

    if (!res.ok) return { ...empty(url.toString()), status: 'failed' };

    const type = res.headers.get('content-type') ?? '';
    // Only HTML is parsed. A PDF or an image has no meta tags, and downloading
    // half a megabyte of one to discover that is waste.
    if (!/^text\/html|^application\/xhtml/i.test(type)) {
      return { ...empty(url.toString()), status: 'ok' };
    }

    const meta = parseMeta(await readCapped(res));
    // A relative og:image is resolved against the page it came from.
    const imageUrl = meta.imageUrl
      ? (normalise(new URL(meta.imageUrl, current).toString())?.toString() ?? null)
      : null;

    return {
      url: url.toString(),
      ...meta,
      imageUrl,
      siteName: meta.siteName ?? current.hostname.replace(/^www\./, ''),
      status: 'ok',
    };
  }

  return { ...empty(url.toString()), status: 'failed' };
}

const empty = (url: string): LinkPreview => ({
  url, title: null, description: null, imageUrl: null, siteName: null, status: 'ok',
});
const blocked = (url: string): LinkPreview => ({ ...empty(url), status: 'blocked' });

/* ────────────────────────────────────────────────────────────────────────── *
 * Storage
 * ────────────────────────────────────────────────────────────────────────── */

export async function getCachedPreview(url: string): Promise<LinkPreview | null> {
  const normalised = normalise(url);
  if (!normalised) return null;

  const { rows } = await getPool().query<{
    url: string; title: string | null; description: string | null;
    image_url: string | null; site_name: string | null; status: string; fetched_at: string;
  }>('SELECT * FROM link_previews WHERE url_hash = $1', [urlHash(normalised.toString())]);

  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.fetched_at).getTime() > PREVIEW_TTL_MS) return null;

  return {
    url: row.url,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    siteName: row.site_name,
    status: row.status as LinkPreview['status'],
  };
}

export async function savePreview(preview: LinkPreview): Promise<void> {
  await getPool().query(
    `INSERT INTO link_previews
       (url_hash, url, title, description, image_url, site_name, status, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (url_hash) DO UPDATE SET
       title = EXCLUDED.title, description = EXCLUDED.description,
       image_url = EXCLUDED.image_url, site_name = EXCLUDED.site_name,
       status = EXCLUDED.status, fetched_at = now()`,
    [urlHash(preview.url), preview.url, preview.title, preview.description,
     preview.imageUrl, preview.siteName, preview.status],
  );
}

/** Record which links a message carries, so previews can be pushed to it later. */
export async function linkMessage(
  conversationId: string, messageId: string, urls: string[],
): Promise<void> {
  for (const [i, raw] of urls.entries()) {
    const url = normalise(raw);
    if (!url) continue;
    await getPool().query(
      `INSERT INTO message_links (message_id, conversation_id, url_hash, ordinal)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [messageId, conversationId, urlHash(url.toString()), i],
    );
  }
}

/** Previews for a set of messages, for the read path. */
export async function previewsForMessages(
  messageIds: string[],
): Promise<Record<string, LinkPreview[]>> {
  if (!messageIds.length) return {};

  const { rows } = await getPool().query<{
    message_id: string; url: string; title: string | null; description: string | null;
    image_url: string | null; site_name: string | null; status: string;
  }>(
    `SELECT ml.message_id, lp.url, lp.title, lp.description, lp.image_url,
            lp.site_name, lp.status
       FROM message_links ml
       JOIN link_previews lp ON lp.url_hash = ml.url_hash
      WHERE ml.message_id = ANY($1::text[])
        -- A blocked or empty preview is stored so it is not retried, but it has
        -- nothing worth rendering.
        AND lp.status = 'ok'
        AND lp.title IS NOT NULL
      ORDER BY ml.ordinal`,
    [messageIds],
  );

  const out: Record<string, LinkPreview[]> = {};
  for (const r of rows) {
    (out[r.message_id] ??= []).push({
      url: r.url,
      title: r.title,
      description: r.description,
      imageUrl: r.image_url,
      siteName: r.site_name,
      status: 'ok',
    });
  }
  return out;
}

/**
 * Unfurl every link in a message and store the results.
 *
 * Called from the worker rather than the send path: a five-second fetch against
 * somebody else's slow server must never be in the way of a message appearing.
 */
export async function unfurlMessage(
  conversationId: string, messageId: string, body: string | null,
): Promise<number> {
  const urls = extractUrls(body);
  if (!urls.length) return 0;

  await linkMessage(conversationId, messageId, urls);

  let fetched = 0;
  for (const url of urls) {
    if (await getCachedPreview(url)) continue;
    try {
      await savePreview(await fetchPreview(url));
      fetched += 1;
    } catch {
      // One bad link must not stop the others.
    }
  }
  return fetched;
}
