import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { getPool, pingDb, snowflake, closeDb } from '@tupo/db';
import { ok, fail, MEETING_FOLDER_PATTERN } from '@tupo/shared';
import type { SessionClaims } from '@tupo/shared';
import { config } from './config.js';
import { createStorageDriver } from './storage/driver.js';
import { canReadFile, canDeleteFile, listConversationFiles } from './access.js';

const app = express();
const storage = createStorageDriver();

app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '256kb' }));

interface FileRequest extends express.Request { user?: SessionClaims }

/** Same session token as the API — this service issues no credential of its own. */
function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json(fail('Authentication required.'));
  try {
    (req as FileRequest).user = jwt.verify(header.slice(7), config.jwtSecret) as SessionClaims;
    next();
  } catch {
    return res.status(401).json(fail('Invalid or expired session token.'));
  }
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
const MEDIA_TICKET_TTL_SECONDS = 60;

interface MediaTicketClaims { sub: string; fid: string; aud: string }

app.post('/api/files/:id/ticket', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  // Minting is itself authorised, so a ticket cannot even be obtained for a
  // file the caller may not read.
  const access = await canReadFile(user.id, req.params.id!);
  if (!access.allowed) return res.status(404).json(fail('File not found.'));

  const token = jwt.sign(
    { sub: user.id, fid: req.params.id, aud: 'file' },
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
function resolveMediaCaller(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      return (jwt.verify(header.slice(7), config.jwtSecret) as SessionClaims).id;
    } catch { return null; }
  }

  const ticket = typeof req.query.t === 'string' ? req.query.t : null;
  if (!ticket) return null;
  try {
    const claims = jwt.verify(ticket, config.jwtSecret, { audience: 'file' }) as MediaTicketClaims;
    if (claims.fid !== req.params.id) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/**
 * Step 1 of the upload pipeline (SRS §11.1): authorise, reserve a metadata row
 * and hand back a key. In production this returns a presigned URL so bytes go
 * straight to object storage; the local driver uploads through step 2 instead.
 */
app.post('/api/files/tickets', requireSession, async (req, res) => {
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

  const id = snowflake();
  const now = new Date();
  // Server-generated key — the client never influences the storage path.
  const safeName = name.replace(/[^\w.\-]/g, '_').slice(0, 120);
  const key = folder
    ? `${folder}/${id}/${safeName}`
    : `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}/${safeName}`;

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
app.put('/api/files/:id/content', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  const { rows } = await getPool().query<{ storage_key: string; owner_id: string; status: string }>(
    'SELECT storage_key, owner_id, status FROM files WHERE id = $1',
    [req.params.id]
  );
  const file = rows[0];
  if (!file) return res.status(404).json(fail('Upload ticket not found.'));
  if (file.owner_id !== user.id) return res.status(403).json(fail('This upload ticket is not yours.'));
  if (file.status !== 'pending') return res.status(409).json(fail('This ticket has already been used.'));

  try {
    // The driver hashes as it writes — see the comment on hashingStage for why
    // this must not be done with a listener on `req`.
    const { sizeBytes, checksum } = await storage.put(file.storage_key, req);

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
    res.json(ok({ fileId: req.params.id, sizeBytes, checksum, status: 'ready' }));
  } catch (err) {
    await getPool().query(`UPDATE files SET status = 'failed' WHERE id = $1`, [req.params.id]);
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

/** MIME types safe to render in the page. Everything else downloads. */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm))$/;

app.get('/api/files/:id/content', async (req, res) => {
  const callerId = resolveMediaCaller(req);
  if (!callerId) return res.status(401).json(fail('Authentication required.'));

  const { rows } = await getPool().query<{
    storage_key: string; original_name: string; mime_type: string;
    size_bytes: string; status: string;
  }>(
    `SELECT storage_key, original_name, mime_type, size_bytes, status
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
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  );
  // Private: an authorised response must not be cached by a shared proxy and
  // handed to the next person who asks for the same URL.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');

  const total = Number(file.size_bytes);
  const range = req.headers.range;

  if (range && storage.getRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const last = Math.min(end, total - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${last}/${total}`);
      res.setHeader('Content-Length', String(last - start + 1));
      return (await storage.getRange(file.storage_key, start, last)).pipe(res);
    }
  }

  res.setHeader('Content-Length', String(total));
  (await storage.get(file.storage_key)).pipe(res);
});

/**
 * Everything shared in one conversation — the Files tab.
 *
 * Membership is checked here rather than trusted from the client, and the query
 * behind it reads only the named conversation.
 */
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

const shutdown = () => server.close(async () => { await closeDb(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
