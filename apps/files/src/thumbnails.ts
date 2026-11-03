import { Readable } from 'node:stream';
import sharp from 'sharp';
import { encode } from 'blurhash';
import type { StorageDriver } from './storage/driver.js';

/**
 * Image thumbnails and placeholders (P-05).
 *
 * A phone photo is several megabytes; a chat or feed list shows it in a box a
 * few hundred pixels wide. Each image gets one 640 px WebP (tens of kB) for
 * lists, and a blurhash — a ~30-character string the client paints as a soft
 * colour field while the thumbnail loads, so nothing jumps and nothing is blank.
 * The original stays what the full-screen viewer opens.
 *
 * Made when the upload completes, so a message sent straight away already
 * carries the placeholder; and again on first request for older images, which
 * is the whole backfill. One at a time: this host is shared, and libvips with
 * several large decodes in parallel would compete with everything on it.
 */

export const THUMB_MAX = 640;
const THUMB_SUFFIX = '.thumb.webp';
/** GIFs are left alone: a thumbnail would freeze the animation. SVG never reaches here (not inline-safe). */
export const THUMBABLE = /^image\/(png|jpeg|webp|avif|bmp)$/;

sharp.cache(false);
sharp.concurrency(1);

export const thumbKey = (storageKey: string) => `${storageKey}${THUMB_SUFFIX}`;

export interface ThumbResult { width: number; height: number; blurhash: string; thumb: true }

let chain: Promise<unknown> = Promise.resolve();
/** Run image work one job at a time, process-wide. */
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => {});
  return next;
}

async function readAll(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    n += chunk.length;
    if (n > maxBytes) throw new Error('image too large to thumbnail');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/**
 * Make the thumbnail and blurhash for a stored image. The real dimensions come
 * from the decoder (EXIF rotation applied), not from what the client said.
 */
export function makeThumbnail(storage: StorageDriver, storageKey: string): Promise<ThumbResult> {
  return serial(async () => {
    // 40 MB: beyond any real photo; refuses a decompression-bomb file early.
    const input = await readAll(await storage.get(storageKey), 40 * 1024 * 1024);
    const image = sharp(input, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate();

    const thumb = await image.clone()
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 74 })
      .toBuffer({ resolveWithObject: true });
    await storage.put(thumbKey(storageKey), Readable.from(thumb.data));

    const { data, info } = await image.clone()
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const blurhash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);

    const meta = await sharp(input).rotate().metadata();
    // After .rotate() sharp reports the stored orientation; swap for 90°/270° EXIF.
    const turned = (meta.orientation ?? 1) >= 5;
    return {
      width: (turned ? meta.height : meta.width) ?? thumb.info.width,
      height: (turned ? meta.width : meta.height) ?? thumb.info.height,
      blurhash,
      thumb: true,
    };
  });
}
