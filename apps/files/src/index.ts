import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { getPool, pingDb, snowflake, closeDb } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import type { SessionClaims } from '@tupo/shared';
import { config } from './config.js';
import { createStorageDriver } from './storage/driver.js';

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
 * Step 1 of the upload pipeline (SRS §11.1): authorise, reserve a metadata row
 * and hand back a key. In production this returns a presigned URL so bytes go
 * straight to object storage; the local driver uploads through step 2 instead.
 */
app.post('/api/files/tickets', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  const { name, size, mime } = req.body ?? {};

  if (!name || typeof name !== 'string') return res.status(400).json(fail('A file name is required.'));
  if (typeof size !== 'number' || size <= 0) return res.status(400).json(fail('A positive file size is required.'));
  if (size > config.maxFileSizeBytes) {
    return res.status(413).json(fail(`Files may not exceed ${Math.floor(config.maxFileSizeBytes / 1024 / 1024)} MB.`));
  }

  const id = snowflake();
  const now = new Date();
  // Server-generated key — the client never influences the storage path.
  const safeName = name.replace(/[^\w.\-]/g, '_').slice(0, 120);
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}/${safeName}`;

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

/** Step 3 — authorised download. Conversation-scoped ACLs arrive in Phase 2. */
app.get('/api/files/:id/content', requireSession, async (req, res) => {
  const user = (req as FileRequest).user!;
  const { rows } = await getPool().query<{
    storage_key: string; original_name: string; mime_type: string; owner_id: string; status: string;
  }>('SELECT storage_key, original_name, mime_type, owner_id, status FROM files WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]);
  const file = rows[0];

  if (!file) return res.status(404).json(fail('File not found.'));
  if (file.status !== 'ready') return res.status(409).json(fail(`File is not available (status: ${file.status}).`));
  if (file.owner_id !== user.id) return res.status(403).json(fail('You do not have access to this file.'));

  res.setHeader('Content-Type', file.mime_type);
  // Attachment disposition defeats stored-XSS through uploaded HTML (SRS SEC-P6).
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
  (await storage.get(file.storage_key)).pipe(res);
});

app.get('/api/files/:id', requireSession, async (req, res) => {
  const { rows } = await getPool().query(
    `SELECT id, original_name, mime_type, size_bytes, checksum, status, created_at
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
