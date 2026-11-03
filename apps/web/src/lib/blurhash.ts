import { decode } from 'blurhash';

/**
 * A blurhash as a CSS background (P-05): a soft field of the picture's own
 * colours, shown while the thumbnail loads so a list neither jumps nor flashes
 * grey. Decoded once per hash into a 16 px PNG data URL; the browser scales it
 * smoothly. Invalid hashes give null and the caller keeps its plain background.
 */
const cache = new Map<string, string | null>();

export function blurhashUrl(hash: string | undefined | null): string | null {
  if (!hash) return null;
  if (cache.has(hash)) return cache.get(hash)!;
  let url: string | null = null;
  try {
    const size = 16;
    const pixels = decode(hash, size, size);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(size, size);
      img.data.set(pixels);
      ctx.putImageData(img, 0, 0);
      url = canvas.toDataURL('image/png');
    }
  } catch { url = null; }
  if (cache.size > 500) cache.clear();
  cache.set(hash, url);
  return url;
}
