import { describe, it, expect } from 'vitest';
import { handshakeClientIp, trackSocketEvent } from '../activity.js';

/**
 * Usage analytics from the gateway (chat messages sent over the socket). The
 * relay itself is tested in apps/api; here, the client address rule and that
 * the test run never forwards anything.
 */
const hs = (address: string, xff?: string) => ({ address, headers: xff ? { 'x-forwarded-for': xff } : {} }) as never;

describe('handshakeClientIp', () => {
  it('believes X-Forwarded-For only from the local proxy, and only its last hop', () => {
    expect(handshakeClientIp(hs('127.0.0.1', '10.0.0.1, 102.22.1.9'))).toBe('102.22.1.9');
    expect(handshakeClientIp(hs('::ffff:127.0.0.1', '41.186.1.1'))).toBe('41.186.1.1');
    expect(handshakeClientIp(hs('::1', '41.186.1.2'))).toBe('41.186.1.2');
    expect(handshakeClientIp(hs('127.0.0.1'))).toBe('127.0.0.1');
    // A client talking to the gateway directly cannot pick its own address.
    expect(handshakeClientIp(hs('::ffff:102.22.5.5', '1.2.3.4'))).toBe('102.22.5.5');
  });
});

describe('trackSocketEvent', () => {
  it('is a silent no-op in the test run', () => {
    expect(() => trackSocketEvent({ handshake: { headers: {}, auth: {} } } as never, '12', 'tupo.chat.send')).not.toThrow();
  });
});
