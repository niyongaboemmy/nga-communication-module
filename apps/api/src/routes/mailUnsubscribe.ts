import { Router, type Request, type Response } from 'express';
import { suppress, verifyUnsubscribe } from '@tupo/mail';
import { PRIMARY_TENANT_ID, parseTid, runWithTid } from '@tupo/tenancy';

/**
 * The link in a campaign email's List-Unsubscribe header (RFC 8058). Public:
 * the person is outside Tupo. The signed address is the whole credential.
 *
 * GET only shows a button: link scanners and previews open every link, and
 * must not unsubscribe anyone. POST does it, which is also what a mail app's
 * own "Unsubscribe" button sends (List-Unsubscribe=One-Click).
 */
const router = Router();

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#2563eb;color:#fff;cursor:pointer}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Links name their school (`tid`, signed with the address); older links are tenant 1. */
const tidOfLink = (req: Request) => parseTid(req.query.tid) ?? PRIMARY_TENANT_ID;
const addressOf = (req: Request) =>
  verifyUnsubscribe(String(req.query.a ?? ''), String(req.query.t ?? ''), process.env, tidOfLink(req));

router.get('/', (req: Request, res: Response) => {
  const address = addressOf(req);
  if (!address) return res.status(400).type('html').send(page('Link not valid', '<p>This unsubscribe link is not valid.</p>'));
  res.type('html').send(page('Unsubscribe',
    `<p>Stop school announcement emails to <strong>${esc(address)}</strong>?</p>
     <form method="post"><button type="submit">Unsubscribe</button></form>`));
});

router.post('/', async (req: Request, res: Response) => {
  const address = addressOf(req);
  if (!address) return res.status(400).type('html').send(page('Link not valid', '<p>This unsubscribe link is not valid.</p>'));
  await runWithTid(tidOfLink(req), () => suppress(address, 'unsubscribe', 'one-click unsubscribe link'));
  res.type('html').send(page('Unsubscribed', `<p><strong>${esc(address)}</strong> will not get school announcement emails any more.</p>`));
});

export default router;
