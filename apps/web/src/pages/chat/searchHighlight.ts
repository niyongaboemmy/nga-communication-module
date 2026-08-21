/**
 * The sentinels the server wraps search matches in.
 *
 * Duplicated here rather than imported from `@tupo/chat`, which is a
 * server-only package the browser bundle must not pull in — it depends on `pg`.
 * Two constants are a smaller price than shipping a database driver to a phone.
 *
 * They are the ASCII control characters STX and ETX. Nothing that reached the
 * server through the API can contain them, so splitting a highlight fragment on
 * them is unambiguous — and unlike `<b>`, they cannot be mistaken for markup by
 * anything downstream.
 */
export const HIGHLIGHT_START = '\u0002';
export const HIGHLIGHT_END = '\u0003';
