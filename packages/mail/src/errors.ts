/** Carries the HTTP status the route should return, so routes stay dumb. */
export class MailError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'MailError';
  }
}
