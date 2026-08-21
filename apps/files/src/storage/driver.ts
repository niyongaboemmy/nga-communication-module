import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

export interface PutResult {
  sizeBytes: number;
  /** SHA-256 of the bytes actually written. */
  checksum: string;
}

/**
 * Hash the stream as it flows through to storage.
 *
 * This MUST be a pipeline stage rather than a `body.on('data')` listener:
 * attaching a data listener switches the readable into flowing mode and drains
 * it before the write stream is attached, which silently stores a zero-byte
 * file while still producing a correct-looking checksum.
 */
function hashingStage(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk, _enc, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

/**
 * Storage is behind an interface from day one so the S3/MinIO driver can drop
 * in for production without any route changing. Development uses the local
 * driver, which is why `npm run dev` needs no object store running.
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Readable): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  /**
   * A byte range, for HTTP 206 responses.
   *
   * Optional on the interface because not every backing store can do it
   * cheaply, and the route falls back to a whole-file 200. But without it,
   * video and audio are effectively unusable: the browser must download the
   * entire file before playing a second of it, and every seek starts again
   * from the beginning.
   */
  getRange?(key: string, start: number, end: number): Promise<Readable>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root = config.localStoragePath) {
    this.root = resolve(root);
  }

  /**
   * Resolve a storage key to a path, refusing anything that escapes the root.
   * Keys are server-generated, but a traversal bug here would be a file-system
   * read primitive, so it is checked rather than assumed.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + '/')) {
      throw new Error('Invalid storage key');
    }
    return full;
  }

  async put(key: string, body: Readable): Promise<PutResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash('sha256');
    await pipeline(body, hashingStage(hash), createWriteStream(path));
    return { sizeBytes: (await stat(path)).size, checksum: hash.digest('hex') };
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  /** `end` is inclusive, matching both HTTP Range and createReadStream. */
  async getRange(key: string, start: number, end: number): Promise<Readable> {
    return createReadStream(this.pathFor(key), { start, end });
  }

  async remove(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    try { await stat(this.pathFor(key)); return true; } catch { return false; }
  }
}

export function createStorageDriver(): StorageDriver {
  switch (config.storageDriver) {
    case 'local':
      return new LocalStorageDriver();
    case 's3':
      // Phase 2 (SRS §11): presigned multipart + tus against S3/MinIO.
      throw new Error('The s3 storage driver lands in Phase 2. Set STORAGE_DRIVER=local for now.');
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${config.storageDriver}`);
  }
}
