/**
 * @tupo/chat — the chat domain.
 *
 * It lives in a package rather than inside `apps/api` because two processes
 * need it: the REST API and the realtime gateway, which handles `message:send`
 * on the socket that is already open rather than making the browser pay for a
 * second round trip. Duplicating "send a message" across the two would mean
 * duplicating its authorisation, and the copy that drifts is always the one
 * with the hole in it.
 */
export * from './service.js';
export * from './oversight.js';
export * from './presence.js';
export * from './notifications.js';
export * from './unfurl.js';
export * from './subjects.js';
