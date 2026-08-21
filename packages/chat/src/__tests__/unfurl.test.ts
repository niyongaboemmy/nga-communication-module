import { describe, it, expect } from 'vitest';
import { isBlockedAddress, extractUrls } from '../unfurl.js';

/**
 * The SSRF guard.
 *
 * A unit test rather than a gate check, because the interesting cases are
 * addresses the integration environment cannot conjure — cloud metadata,
 * carrier-grade NAT, IPv4-mapped IPv6. Getting any one of these wrong turns
 * link previews into a way for a pupil to make the server read the school's
 * internal network.
 */

describe('isBlockedAddress', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.1.2.3')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('blocks the cloud metadata address', () => {
    // The single most valuable SSRF target there is.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('blocks every RFC 1918 range', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.254')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('does not over-block the edges of those ranges', () => {
    // 172.15 and 172.32 are public; only 172.16–172.31 is private.
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });

  it('blocks carrier-grade NAT and unspecified', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 private and link-local ranges', () => {
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('fd00::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('blocks a private v4 address wearing a v6 hat', () => {
    // The bypass that catches implementations which only check the family.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('blocks anything that is not an address at all', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('extractUrls', () => {
  it('finds links in a sentence', () => {
    expect(extractUrls('see https://example.com/timetable for the dates'))
      .toEqual(['https://example.com/timetable']);
  });

  it('does not swallow the punctuation that ends a sentence', () => {
    expect(extractUrls('it is at https://example.com/page.'))
      .toEqual(['https://example.com/page']);
  });

  it('de-duplicates and caps how many it will unfurl', () => {
    const body = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(extractUrls(body)).toHaveLength(3);
    expect(extractUrls('https://a.test https://a.test')).toEqual(['https://a.test']);
  });

  it('ignores other schemes', () => {
    expect(extractUrls('file:///etc/passwd and ftp://host/x')).toEqual([]);
  });

  it('handles an empty body', () => {
    expect(extractUrls(null)).toEqual([]);
  });
});
