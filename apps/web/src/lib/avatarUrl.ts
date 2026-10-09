/**
 * The largest (512 px) rendition of an NGA MIS profile photo. MIS signs one URL per
 * photo version for all three sizes, so swapping the size segment keeps the link
 * valid. Any other URL is returned unchanged.
 */
export function largeAvatarUrl(src: string): string {
  return src.replace(/(\/avatars\/\d+\/\d+\/)(sm|md)\.webp/, '$1lg.webp');
}
