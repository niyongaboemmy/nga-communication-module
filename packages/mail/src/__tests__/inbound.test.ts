import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { messageIdsIn, tupoMessageIdOf, ownDomains, looksLikeSpam, parseBounce } from '../inbound.js';
import { encryptSecret, decryptSecret, mailServerConfig, replyCaptureEnabled } from '../accounts.js';

describe('message ids', () => {
  it('reads every id from a header value, in order', () => {
    expect(messageIdsIn('<a@x.org>  <b@y.org>\r\n <c@z.org>')).toEqual(['<a@x.org>', '<b@y.org>', '<c@z.org>']);
    expect(messageIdsIn(['<a@x>', '<b@y>'])).toEqual(['<a@x>', '<b@y>']);
    expect(messageIdsIn(undefined)).toEqual([]);
  });

  it("recognises Tupo's own ids only on Tupo's domains", () => {
    const domains = ownDomains({ MAIL_FROM: 'NGA Tupo <mis@nga.ac.rw>' } as NodeJS.ProcessEnv);
    expect(domains).toContain('nga.ac.rw');
    expect(tupoMessageIdOf('<1234567890123456789@nga.ac.rw>', domains)).toBe('1234567890123456789');
    expect(tupoMessageIdOf('<1234567890123456789@NGA.AC.RW>', domains)).toBe('1234567890123456789');
    // Someone else's numeric id is not ours.
    expect(tupoMessageIdOf('<1234567890123456789@gmail.com>', domains)).toBeNull();
    expect(tupoMessageIdOf('<CAF=abc@mail.gmail.com>', domains)).toBeNull();
  });
});

describe('spam', () => {
  it('follows the server’s spam headers and the Junk flag', async () => {
    const spam = await simpleParser('X-Spam-Flag: YES\r\nSubject: win\r\n\r\nx');
    const ham = await simpleParser('X-Spam-Status: No, score=0.1\r\nSubject: hi\r\n\r\nx');
    expect(looksLikeSpam(spam)).toBe(true);
    expect(looksLikeSpam(ham)).toBe(false);
    expect(looksLikeSpam(ham, new Set(['$Junk']))).toBe(true);
  });
});

describe('delivery reports', () => {
  const dsn = [
    'From: Mail Delivery System <MAILER-DAEMON@mail.hackflix.net>',
    'Subject: Undelivered Mail Returned to Sender',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B', 'Content-Type: text/plain', '', 'Sorry.', '',
    '--B', 'Content-Type: message/delivery-status', '',
    'Reporting-MTA: dns; mail.hackflix.net', '',
    'Final-Recipient: rfc822; nobody@nowhere.example',
    'Action: failed', 'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 <nobody@nowhere.example>: Recipient address rejected:',
    '  User unknown', '',
    'Final-Recipient: rfc822; ok@fine.example', 'Action: delayed', '',
    '--B', 'Content-Type: text/rfc822-headers', '',
    'Message-ID: <1234567890123456789@nga.ac.rw>', 'Subject: Term dates', '',
    '--B--',
  ].join('\r\n');

  it('names the failed recipients and the original message', () => {
    const r = parseBounce(dsn)!;
    expect(r.recipients).toEqual([{ address: 'nobody@nowhere.example', diagnostic: expect.stringContaining('User unknown') }]);
    expect(r.ids).toContain('<1234567890123456789@nga.ac.rw>');
  });

  it('leaves ordinary mail alone', () => {
    expect(parseBounce('From: a@b.org\r\nSubject: hi\r\n\r\nhello')).toBeNull();
  });
});

describe('stored passwords', () => {
  const env = { MAIL_ACCOUNT_KEY: 'a'.repeat(64) } as NodeJS.ProcessEnv;
  it('round-trips, and every encryption differs', () => {
    const a = encryptSecret('s3cret pass', env);
    const b = encryptSecret('s3cret pass', env);
    expect(a).not.toEqual(b);
    expect(a).not.toContain('s3cret');
    expect(decryptSecret(a, env)).toBe('s3cret pass');
  });
  it('refuses a tampered value and a wrong key', () => {
    const a = encryptSecret('x', env);
    // Flip a real byte of the ciphertext (editing base64 text can land on
    // padding bits and change nothing).
    const buf = Buffer.from(a.slice(3), 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = `v1:${buf.toString('base64')}`;
    expect(() => decryptSecret(tampered, env)).toThrow();
    expect(() => decryptSecret(a, { MAIL_ACCOUNT_KEY: 'b'.repeat(64) } as NodeJS.ProcessEnv)).toThrow();
  });
  it('will not store a password without a key', () => {
    expect(() => encryptSecret('x', {} as NodeJS.ProcessEnv)).toThrow(/not set up/);
  });
});

describe('the school mail server', () => {
  it('defaults to the relay host on 993 and allows only that host', () => {
    const cfg = mailServerConfig({ SMTP_HOST: 'mail.hackflix.net', MAIL_FROM: 'NGA Tupo <mis@nga.ac.rw>' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ imapHost: 'mail.hackflix.net', imapPort: 993, imapSecure: true, domain: 'nga.ac.rw' });
    expect(cfg.allowedHosts).toEqual(['mail.hackflix.net']);
  });
  it('has no server, and reply capture is off, unless configured', () => {
    expect(mailServerConfig({} as NodeJS.ProcessEnv).imapHost).toBeNull();
    expect(replyCaptureEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(replyCaptureEnabled({ MAIL_REPLY_CAPTURE: 'on' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
