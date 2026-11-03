import { profileMedia } from '@tupo/notify';
import { config } from '../config.js';

/**
 * Re-read one person's NGA MIS account status (users.mis_status) right now,
 * through the same profile-media lookup the worker sweeps with. Used after a
 * back-channel logout, which MIS also sends when an administrator disables
 * someone. Without SSO client credentials it is a no-op (the sweep is too).
 */
let override: { transport: profileMedia.MediaTransport; clientSecret: string } | null = null;

/** Tests only: answer the MIS lookup without a network call. */
export function setMisStatusTransport(transport: profileMedia.MediaTransport | null): void {
  override = transport ? { transport, clientSecret: 'test-secret' } : null;
}

export async function recheckMisStatus(misUserId: string): Promise<profileMedia.ProfileMediaSyncResult> {
  const secret = config.ssoClientSecret === 'placeholder_client_secret' ? '' : config.ssoClientSecret;
  return profileMedia.runProfileMediaSync({
    misUserIds: [misUserId],
    config: {
      misBaseUrl: config.misBaseUrl.replace(/\/+$/, ''),
      clientId: config.ssoClientId,
      clientSecret: override?.clientSecret ?? secret,
    },
    ...(override ? { transport: override.transport } : {}),
  });
}
