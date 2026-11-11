import './utils/asyncErrors.js';
import express from 'express';
import { installProcessGuards } from './utils/asyncErrors.js';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { getPool, pingDb, snowflake, closeDb, startProcessMetrics, guardDbRole } from '@tupo/db';
import { ok, fail, MEETING_FOLDER_PATTERN } from '@tupo/shared';
import type { SessionClaims } from '@tupo/shared';
import { config } from './config.js';
import { effectiveTenant, effectiveTid, forEachActiveTenant, tenantRegistry } from '@tupo/tenancy';
import { overTenantQuota, tenantFromCredential, tenantStorageKey } from './tenancy.js';
import { createStorageDriver } from './storage/driver.js';
import { canReadFile, canDeleteFile, listConversationFiles } from './access.js';
import { makeThumbnail, thumbKey, THUMBABLE, type ThumbResult } from './thumbnails.js';

installProcessGuards('files');

// A superuser / BYPASSRLS role would skip row-level security:
// TENANCY_MODE=enforce refuses to start, shadow warns loudly.
try {
  await guardDbRole('files');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = express();
const storage = createStorageDriver();

app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins, credentials: true }));

// The files service's own numbers (R-04). Downloads can be long streams, so
// latency is measured to the first byte of the answer, not to its end.
const metrics = startProcessMetrics('files');
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => typeof res;
  (res as unknown as { writeHead: (...a: unknown[]) => typeof res }).writeHead = (...a: unknown[]) => {
    if (!req.path.endsWith('/health')) metrics.time('http', Number(process.hrtime.bigint() - started) / 1e6);
    return writeHead(...a);
  };
  res.on('finish', () => {
    metrics.count('http_requests');
    if (res.statusCode >= 500) metrics.count('http_5xx');
    else if (res.statusCode >= 400) metrics.count('http_4xx');
  });
  next();
});
app.use(express.json({ limit: '256kb' }));
// Every credentialed request runs inside its school (tenancy.ts).
app.use(tenantFromCredential);

interface FileRequest extends express.Request { user?: SessionClaims }

/**
 * The account behind a valid token, checked the way the API checks it (A-06):
 * it still exists, it is active, and it has not signed out of NGA (single
 * sign-out) since the token was issued. A signature alone said nothing about
 * any of that — a suspended or signed-out token kept uploading and
 * downloading for the rest of its 24 hours.
 */
async function accountState(userId: string, iatSeconds: number | undefined): Promise<'ok' | 'gone' | 'suspended' | 'signed-out'> {
  const { rows } = await getPool().query<{ status: string; revoked_at: Date | null }>(
    `SELECT u.status, r.revoked_at FROM users u
       LEFT JOIN session_revocations r ON r.user_id = u.id
      WHERE u.id = $1`, [userId]);
  const u = rows[0];
  if (!u) return 'gone';
  if (u.status !== 'active') return 'suspended';
  if (u.revoked_at && (!iatSeconds || iatSeconds * 1000 <= u.revoked_at.getTime())) return 'signed-out';
  return 'ok';
}

/** Whether the person's role grants a permission (read fresh, never from the token). */
async function hasFilePermission(userId: string, key: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = $1 AND p.key = $2 LIMIT 1`, [userId, key]);
  return rows.length > 0;
}

/** Same session token as the API — this service issues no credential of its own. */
async function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json(fail('Authentication required.'));
  let claims: SessionClaims & { iat?: number };
  try {
    claims = jwt.verify(header.slice(7), config.jwtSecret) as SessionClaims & { iat?: number };
  } catch {
    return res.status(401).json(fail('Invalid or expired session token.'));
  }
  const state = await accountState(claims.id, claims.iat);
  if (state === 'suspended') return res.status(403).json(fail('This account has been suspended.'));
  if (state !== 'ok') return res.status(401).json(fail('Your session is no longer valid. Please sign in again.'));
  (req as FileRequest).user = claims;
  next();
}

/** A platform permission, checked on the live role. */
function requireFilePermission(key: string) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as FileRequest).user;
    if (!user || !(await hasFilePermission(user.id, key))) {
      return res.status(403).json(fail('You do not have permission to do that.'));
    }
    next();
  };
}

/**
 * Media tickets.
 *
 * An `<img src>`, a `<video src>` and an `<audio src>` cannot carry an
 * Authorization header. Fetching every image to a blob would work for pictures
 * but destroys range requests, so a 40 MB lesson recording would have to
 * download in full before playing a second of it.
 *
 * So a media ticket: a 60-second JWT bound to **one file and one person**,
 * passed in the query string in place of the header.
 *
 * It is worth being precise about how this differs from the signed URL rejected
 * in access.ts. A signed URL *is* the authorisation — anyone holding it gets the
 * bytes, for as long as it lives, whatever has changed in the meantime. This
 * ticket only carries an **identity**; `canReadFile` still runs on redemption,
 * against live membership. Someone removed from a channel a second after the
 * ticket was issued is refused by the same check as everyone else, and a copied
 * URL is worthless to anyone other than the person it was minted for.
 */
// Long enough to play a voice note or watch a clip — media players keep making
// range requests with the same URL as they buffer and seek, and a 60s ticket
// stopped playback a minute in (A-08). Still bound to one file and one person,
// and canReadFile re-runs on every request, so revoking access still works.
const MEDIA_TICKET_TTL_SECONDS = 15 * 60;

interface MediaTicketClaims { sub: string; fid: string; aud: string }

app.post('/api/files/:id/ticket', requireSession, requireFilePermission('FILE_DOWNLOAD'), async (req, res) => {
  const user = (req as FileRequest).user!;
  // Minting is itself authorised, so a ticket cannot even be obtained for a
  // file the caller may not read.
  const access = await canReadFile(user.id, req.params.id!);
  if (!access.allowed) return res.status(404).json(fail('File not found.'));

  const token = jwt.sign(
    { sub: user.id, fid: req.params.id, aud: 'file', tid: effectiveTid('media ticket') },
    config.jwtSecret,
    { expiresIn: MEDIA_TICKET_TTL_SECONDS },
  );
  res.json(ok({ token, expiresIn: MEDIA_TICKET_TTL_SECONDS }));
});

/**
 * Resolve the caller from either the header or a media ticket.
 *
 * A ticket is accepted only for the exact file in the path, so one minted for a
 * harmless image cannot be replayed against anything else.
 */
async function resolveMediaCaller(req: express.Request): Promise<string | null> {
  let who: { id: string; iat?: number } | null = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const c = jwt.verify(header.slice(7), config.jwtSecret) as SessionClaims & { iat?: number };
      who = { id: c.id, iat: c.iat };
    } catch { return null; }
  } else {
    const ticket = typeof req.query.t === 'string' ? req.query.t : null;
    if (!ticket) return null;
    try {
      const claims = jwt.verify(ticket, config.jwtSecret, { audience: 'file' }) as MediaTicketClaims & { iat?: number };
      if (claims.fid !== req.params.id) return null;
      who = { id: claims.sub, iat: claims.iat };
    } catch {
      return null;
    }
  }
  // A ticket or token is only as good as the account behind it, right now.
  return (await accountState(who.id, who.iat)) === 'ok' ? who.id : null;
}

/**
 * Step 1 of the upload pipeline (SRS §11.1): authorise, reserve a metadata row
 * and hand back a key. In production this returns a presigned URL so bytes go
 * straight to object storage; the local driver uploads through step 2 instead.
 */
app.post('/api/files/tickets', requireSession, requireFilePermission('FILE_UPLOAD'), async (req, res) => {
  const user = (req as FileRequest).user!;
  const { name, size, mime, folder } = req.body ?? {};

  if (!name || typeof name !== 'string') return res.status(400).json(fail('A file name is required.'));
  if (typeof size !== 'number' || size <= 0) return res.status(400).json(fail('A positive file size is required.'));
  if (size > config.maxFileSizeBytes) {
    return res.status(413).json(fail(`Files may not exceed ${Math.floor(config.maxFileSizeBytes / 1024 / 1024)} MB.`));
  }

  // A caller may ask for a folder, but only one that matches a known shape.
  // `meetings/<id>` is the only form accepted today, so a recording lands with
  // the rest of its meeting's media — and a client still cannot write to an
  // arbitrary path, which is the whole reason the key is server-generated.
  if (folder !== undefined && (typeof folder !== 'string' || !MEETING_FOLDER_PATTERN.test(folder))) {
    return res.status(400).json(fail('That is not a folder this service will write to.'));
  }

  // Per-person quota (A-07): what they already store, plus uploads in flight.
  if (!(await hasFilePermission(user.id, 'FILE_QUOTA_MANAGE'))) {
    const { rows: used } = await getPool().query<{ bytes: string }>(
      `SELECT COALESCE(sum(size_bytes), 0)::text AS bytes FROM files
        WHERE owner_id = $1 AND deleted_at IS NULL AND status IN ('ready', 'pending')`, [user.id]);
    if (Number(used[0]?.bytes ?? 0) + size > config.userQuotaBytes) {
      return res.status(413).json(fail(
        `This would go over your storage allowance of ${Math.floor(config.userQuotaBytes / 1024 ** 3)} GB. Delete some files and try again.`));
    }
  }

  // The school's own allowance (per package), on top of the personal one.
  const tenant = effectiveTenant('file upload');
  if (await overTenantQuota(tenant, size)) {
    return res.status(413).json({ ...fail('Your school has used all of its file storage. Ask an administrator to free some space.'), code: 'TENANT_QUOTA' });
  }

  const id = snowflake();
  const now = new Date();
  // Server-generated key — the client never influences the storage path.
  // Namespaced by school: `t<tid>/YYYY/MM/<id>/<name>` (TP-8).
  const safeName = name.replace(/[^\w.\-]/g, '_').slice(0, 120);
  const key = tenantStorageKey(tenant.tid, folder
    ? `${folder}/${id}/${safeName}`
    : `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}/${safeName}`);

  await getPool().query(
    `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [id, user.id, storage.name, key, name, typeof mime === 'string' ? mime : 'application/octet-stream', size]
  );

  res.json(ok({
    fileId: id,
    strategy: storage.name === 'local' ? 'direct' : 'presigned',
    uploadUrl: `/api/files/${id}/content`,
    expiresAt: new Date(Date.now() + config.signedUrlTtlSeconds * 1000).toISOString(),
  }));
});

/** Step 2 — receive the bytes and checksum them on the way past. */
app.put('/api/files/:id/content', requireSession, requireFilePermission('FILE_UPLOAD'), async (req, res) => {
  const user = (req as FileRequest).user!;
  const { rows } = await getPool().query<{
    storage_key: string; owner_id: string; status: string; size_bytes: string; created_at: Date; mime_type: string;
  }>(
    'SELECT storage_key, owner_id, status, size_bytes, created_at, mime_type FROM files WHERE id = $1',
    [req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json(fail('Upload ticket not found.'));
  if (file.owner_id !== user.id) return res.status(403).json(fail('This upload ticket is not yours.'));
  if (file.status !== 'pending') return res.status(409).json(fail('This ticket has already been used.'));
  // The ticket's expiresAt is a promise, not decoration.
  if (Date.now() - file.created_at.getTime() > config.signedUrlTtlSeconds * 1000) {
    return res.status(410).json(fail('This upload ticket has expired. Start the upload again.'));
  }

  // Never more bytes than were declared (and reserved against the quota), and
  // never more than the service allows — counted as they arrive, not trusted
  // from a header (A-07). The limit runs inside the storage pipeline.
  const limit = Math.min(Number(file.size_bytes), config.maxFileSizeBytes);

  try {
    // The driver hashes as it writes — see the comment on hashingStage for why
    // this must not be done with a listener on `req`.
    const { sizeBytes, checksum } = await storage.put(file.storage_key, req, { maxBytes: limit });

    if (sizeBytes === 0) {
      await storage.remove(file.storage_key);
      await getPool().query(`UPDATE files SET status = 'failed' WHERE id = $1`, [req.params.id]);
      return res.status(400).json(fail('Upload contained no data.'));
    }

    // Phase 2 moves the status to 'scanning' here and lets the worker promote
    // it to 'ready' only after ClamAV clears it (SRS FR-FILE-4).
    await getPool().query(
      `UPDATE files SET size_bytes = $2, checksum = $3, status = 'ready' WHERE id = $1`,
      [req.params.id, sizeBytes, checksum]
    );
    // An image gets its thumbnail and placeholder now (P-05), so a message
    // sent straight after the upload already carries them. Waited for up to
    // 4 s; a slower one still finishes and is saved, the answer just goes first.
    let thumb: ThumbResult | null = null;
    if (THUMBABLE.test(file.mime_type)) {
      const work = makeThumbnail(storage, file.storage_key)
        .then(async (t) => { await saveThumbMetadata(req.params.id!, t); return t; });
      thumb = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), 4_000).unref())])
        .catch((err) => { console.warn('[files] thumbnail failed:', err instanceof Error ? err.message : err); return null; });
    }
    res.json(ok({
      fileId: req.params.id, sizeBytes, checksum, status: 'ready',
      ...(thumb ? { width: thumb.width, height: thumb.height, blurhash: thumb.blurhash } : {}),
    }));
  } catch (err) {
    await storage.remove(file.storage_key).catch(() => {});
    await getPool().query(`UPDATE files SET status = 'failed' WHERE id = $1`, [req.params.id]);
    if ((err as { tooLarge?: boolean }).tooLarge) {
      // Tell the client and stop reading; the connection closes after.
      res.setHeader('Connection', 'close');
      return res.status(413).json(fail('The file is larger than declared.'));
    }
    console.error('[files] upload failed:', err);
    res.status(500).json(fail('Upload failed.'));
  }
});

/**
 * Attach client-computed media metadata to an upload.
 *
 * Image dimensions, audio duration and a voice note's waveform are all things
 * the browser already knows by the time it uploads — it decoded the file to
 * show a preview, and the waveform comes from the analyser that drew the live
 * recording meter. Recomputing them server-side would mean ffmpeg and a
 * transcoding queue for information we were handed for free.
 *
 * It is only ever *presentation* metadata, and it is whitelisted field by
 * field. A client that lies here makes a thumbnail the wrong shape; that is the
 * entire blast radius. Nothing in this object is used for an access decision.
 */
app.patch('/api/files/:id/metadata', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  const { rows } = await getPool().query<{ owner_id: string }>(
    'SELECT owner_id FROM files WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json(fail('File not found.'));
  if (rows[0].owner_id !== user.id) return res.status(403).json(fail('That upload is not yours.'));

  const body = req.body ?? {};
  const clean: Record<string, unknown> = {};
  const posInt = (v: unknown, max: number) =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max) ? Math.round(v) : undefined;

  const width = posInt(body.width, 100_000);
  const height = posInt(body.height, 100_000);
  const durationMs = posInt(body.durationMs, 24 * 60 * 60 * 1000);
  if (width !== undefined) clean.width = width;
  if (height !== undefined) clean.height = height;
  if (durationMs !== undefined) clean.durationMs = durationMs;

  if (Array.isArray(body.waveform)) {
    // Capped and clamped: a waveform is a few dozen peaks, and this column must
    // not become somewhere to park a megabyte of arbitrary JSON.
    clean.waveform = body.waveform
      .slice(0, 256)
      .map((n: unknown) => (typeof n === 'number' && Number.isFinite(n)
        ? Math.min(Math.max(n, 0), 1) : 0));
  }

  await getPool().query(
    `UPDATE files SET metadata = metadata || $2::jsonb WHERE id = $1`,
    [req.params.id, JSON.stringify(clean)]);

  res.json(ok({ metadata: clean }));
});

/**
 * Step 3 — authorised download.
 *
 * Authorisation is `canReadFile`: the owner, or a live member of a conversation
 * the file is attached to. See access.ts for why this is not a signed link.
 *
 * Two other things this route has to get right:
 *
 * **Disposition.** Uploaded content is served `attachment` by default, which
 * defeats stored XSS through an uploaded HTML or SVG file (SEC-P6). `?inline=1`
 * relaxes that to `inline` — but only for image, video and audio types that the
 * browser renders as media rather than as a document. An `<img src>` pointing at
 * this route must work, and a link to an uploaded `.html` must still download.
 *
 * **Range requests.** Video and audio are unusable without them: without a 206
 * the browser must fetch the whole file before it can play a second of it, and
 * seeking re-downloads from the start.
 */

/** Thumbnail facts go beside the client's own metadata; the decoder's dimensions win. */
async function saveThumbMetadata(fileId: string, t: ThumbResult): Promise<void> {
  await getPool().query(
    `UPDATE files SET metadata = metadata || $2::jsonb WHERE id = $1`,
    [fileId, JSON.stringify({ width: t.width, height: t.height, blurhash: t.blurhash, thumb: true })]);
}

/** MIME types safe to render in the page. Everything else downloads. */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm))$/;

app.get('/api/files/:id/content', async (req, res) => {
  const callerId = await resolveMediaCaller(req);
  if (!callerId) return res.status(401).json(fail('Authentication required.'));
  if (!(await hasFilePermission(callerId, 'FILE_DOWNLOAD'))) {
    return res.status(403).json(fail('You do not have permission to open files.'));
  }

  const { rows } = await getPool().query<{
    storage_key: string; original_name: string; mime_type: string;
    size_bytes: string; status: string; metadata: { thumb?: boolean } | null;
  }>(
    `SELECT storage_key, original_name, mime_type, size_bytes, status, metadata
       FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]);
  const file = rows[0];

  if (!file) return res.status(404).json(fail('File not found.'));
  if (file.status !== 'ready') {
    return res.status(409).json(fail(`File is not available (status: ${file.status}).`));
  }

  // Runs whichever way the caller authenticated. A ticket changes *who* is
  // asking, never *whether* they may.
  const access = await canReadFile(callerId, req.params.id!);
  if (!access.allowed) {
    // 404, not 403: confirming that a file id exists is itself a disclosure,
    // and file ids are the one identifier that travels outside the app.
    return res.status(404).json(fail('File not found.'));
  }

  const inline = req.query.inline === '1' && INLINE_SAFE.test(file.mime_type);
  // Private: an authorised response must not be cached by a shared proxy and
  // handed to the next person who asks. Immutable: a file id's bytes never
  // change once uploaded, so this browser may keep them (P-05).
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ?thumb=1 (P-05): the 640 px WebP for lists. Made now if this image
  // predates thumbnails — that is the whole backfill. Anything that cannot
  // have one (a GIF, a video, a failed decode) falls back to the original.
  if (req.query.thumb === '1' && THUMBABLE.test(file.mime_type)) {
    try {
      if (!file.metadata?.thumb) await saveThumbMetadata(req.params.id!, await makeThumbnail(storage, file.storage_key));
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}.webp`);
      return pipeSafely(await storage.get(thumbKey(file.storage_key)), res);
    } catch (err) {
      console.warn('[files] thumbnail unavailable, sending the original:', err instanceof Error ? err.message : err);
    }
  }

  res.setHeader('Content-Type', file.mime_type);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  );
  res.setHeader('Accept-Ranges', 'bytes');

  const total = Number(file.size_bytes);
  const range = req.headers.range;

  if (range && storage.getRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      // `bytes=-N` is a suffix range: the last N bytes, not the first N.
      const suffix = !match[1] && match[2];
      const start = suffix ? Math.max(0, total - parseInt(match[2]!, 10)) : match[1] ? parseInt(match[1], 10) : 0;
      const end = suffix ? total - 1 : match[2] ? parseInt(match[2], 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const last = Math.min(end, total - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${last}/${total}`);
      res.setHeader('Content-Length', String(last - start + 1));
      return pipeSafely(await storage.getRange(file.storage_key, start, last), res);
    }
  }

  res.setHeader('Content-Length', String(total));
  pipeSafely(await storage.get(file.storage_key), res);
});

/**
 * Stream a stored file to the response. A read error (the file vanished from
 * disk, a permissions problem) is an `error` event on the stream; without a
 * listener Node treats it as uncaught and the whole files service exits.
 */
function pipeSafely(stream: NodeJS.ReadableStream, res: express.Response): void {
  stream.on('error', (err) => {
    console.error('[files] read failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(404).json(fail('That file is no longer available.'));
    else res.destroy();
  });
  stream.pipe(res);
}

/**
 * Everything shared in one conversation — the Files tab.
 *
 * Membership is checked here rather than trusted from the client, and the query
 * behind it reads only the named conversation.
 */
/**
 * Service-to-service read of a file's bytes (mail attachments sent by email).
 * Never proxied by nginx, loopback only, and gated by a shared secret: no
 * person is asking, so there is no per-person access check to make.
 */
app.get('/internal/files/:id/content', async (req, res) => {
  const given = Buffer.from(String(req.headers['x-internal-secret'] ?? ''));
  const want = Buffer.from(config.internalSecret);
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  if (!want.length || !loopback || given.length !== want.length || !timingSafeEqual(given, want)) {
    return res.status(404).json(fail('Not found'));
  }
  const { rows } = await getPool().query<{ storage_key: string; mime_type: string; size_bytes: string }>(
    `SELECT storage_key, mime_type, size_bytes FROM files WHERE id = $1 AND deleted_at IS NULL AND status = 'ready'`,
    [req.params.id]);
  const file = rows[0];
  if (!file) return res.status(404).json(fail('File not found.'));
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', file.size_bytes);
  (await storage.get(file.storage_key)).on('error', () => res.destroy()).pipe(res);
});

app.get('/api/files/conversations/:conversationId', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  const { rows } = await getPool().query(
    `SELECT 1 FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [req.params.conversationId, user.id]);
  if (!rows.length) return res.status(404).json(fail('Conversation not found.'));

  const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  res.json(ok({
    files: await listConversationFiles(req.params.conversationId!, {
      kind, limit: Number(req.query.limit ?? 50),
    }),
  }));
});

/** Soft-delete an upload. The owner, or a moderator where it was shared. */
app.delete('/api/files/:id', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  // The files service sees the session token, not the RBAC permission set, so
  // FILE_DELETE_ANY is resolved from the database rather than read from a claim.
  const { rows: perms } = await getPool().query<{ has: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = $1 AND p.key = 'FILE_DELETE_ANY') AS has`,
    [user.id]);

  if (!(await canDeleteFile(user.id, req.params.id!, perms[0]?.has === true))) {
    return res.status(404).json(fail('File not found.'));
  }

  await getPool().query(
    `UPDATE files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]);
  res.json(ok({ deleted: true }));
});

app.get('/api/files/:id', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  // Metadata is behind the same check as content: a file name can be as
  // revealing as the file ("suspension-letter-<pupil>.pdf").
  const access = await canReadFile(user.id, req.params.id!);
  if (!access.allowed) return res.status(404).json(fail('File not found.'));

  const { rows } = await getPool().query(
    `SELECT id, original_name, mime_type, size_bytes, checksum, status, metadata, created_at
       FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json(fail('File not found.'));
  res.json(ok(rows[0]));
});

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { storage: `${storage.name} ok` };
  let healthy = true;
  try { await pingDb(); checks.database = 'ok'; }
  catch (err) { checks.database = err instanceof Error ? `error: ${err.message}` : 'error'; healthy = false; }

  res.status(healthy ? 200 : 503).json({
    service: 'tupo-files',
    status: healthy ? 'healthy' : 'degraded',
    checks,
    uptime: Math.round(process.uptime()),
    date: new Date().toISOString(),
  });
});

app.use((_req, res) => res.status(404).json(fail('Not found')));

/**
 * Housekeeping (A-07): uploads that were started and never finished, and
 * uploads that failed, are removed from storage after a day, so abandoned
 * bytes do not quietly fill the disk. Their rows are marked deleted.
 */
async function collectAbandonedUploads(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM files
        WHERE deleted_at IS NULL AND status IN ('pending', 'failed') AND created_at < now() - interval '24 hours'
        LIMIT 500`);
    for (const r of rows) {
      await storage.remove(r.storage_key).catch(() => {});
      await getPool().query('UPDATE files SET deleted_at = now() WHERE id = $1', [r.id]);
    }
    if (rows.length) console.log(`[files] cleaned up ${rows.length} abandoned upload(s)`);
  } catch (err) {
    console.error('[files] clean-up failed:', err instanceof Error ? err.message : err);
  }
}
if (process.env.NODE_ENV !== 'test') {
  // Once per school, inside its tenant.
  const sweep = () => void forEachActiveTenant(tenantRegistry(), () => collectAbandonedUploads());
  setInterval(sweep, 30 * 60_000).unref();
  setTimeout(sweep, 60_000).unref();
}

// Every error a route passes on (including rejected async handlers, see
// utils/asyncErrors) ends here: a clean status, no internals, never a crash.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json(fail(err.message));
    return;
  }
  const pgCode = (err as { code?: unknown }).code;
  if (typeof pgCode === 'string' && /^22/.test(pgCode)) {
    res.status(400).json(fail('One of the values sent is not valid.'));
    return;
  }
  console.error(`[files] unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json(fail('An unexpected error occurred.'));
});

const server = app.listen(config.port, () => {
  console.log(`📁 tupo-files listening on http://localhost:${config.port}  (driver: ${storage.name})`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[files] port ${config.port} is already in use. Stop whatever is on it, or set PORT in apps/files/.env`);
    process.exit(1);
  }
  throw err;
});

const shutdown = () => server.close(async () => { await metrics.stop(); await closeDb(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
