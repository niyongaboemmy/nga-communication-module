import { describe, it, expect } from 'vitest';
import nodemailer from 'nodemailer';
import { bareAddress } from '../smtp.js';

/** The sender header (S-06): MAIL_FROM may be "Name <addr>", and it must not be wrapped twice. */
describe('bareAddress', () => {
  it('takes the address out of "Name <addr>" and leaves a bare address alone', () => {
    expect(bareAddress('NGA Tupo <mis@nga.ac.rw>')).toBe('mis@nga.ac.rw');
    expect(bareAddress('mis@nga.ac.rw')).toBe('mis@nga.ac.rw');
    expect(bareAddress('  mis@nga.ac.rw ')).toBe('mis@nga.ac.rw');
  });

  it('gives a clean From header with the per-message name', async () => {
    const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await t.sendMail({
      from: { name: 'Ada Teacher via Tupo', address: bareAddress('NGA Tupo <mis@nga.ac.rw>') },
      to: 'ben@example.org', subject: 's', text: 't',
    });
    const from = String(info.message).split(/\r?\n/).find((l) => l.startsWith('From:'));
    expect(from).toBe('From: Ada Teacher via Tupo <mis@nga.ac.rw>');
  });
});
