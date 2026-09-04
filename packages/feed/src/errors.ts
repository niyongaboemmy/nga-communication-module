/**
 * A feed error carries its HTTP status, so both the REST route and the socket
 * handler can map it without a translation table. Anything that is not a
 * `FeedError` is an unexpected 500.
 */
export class FeedError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'FeedError';
  }
}
