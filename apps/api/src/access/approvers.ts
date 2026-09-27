import { getPool } from '@tupo/db';
import { notifyAndPush } from '@tupo/notify';
import { accessMode } from './mode.js';
import { fetchHolders } from './misAccess.js';
import { recordShadowDiff } from './shadow.js';

/**
 * Bulk-mail approver pool (plan §10 "Bulk mail approval": the holders of
 * `tupo:MAIL_APPROVE`, approver ≠ sender).
 *
 *   off      nothing happens (today's behaviour: the campaign simply waits in
 *            the approval queue every MAIL_APPROVE holder can see)
 *   shadow   the v2 pool (MIS /access/holders) and the local pool (users whose
 *            Tupo role grants MAIL_APPROVE) are compared; a difference is
 *            recorded. Nobody is notified.
 *   enforce  the v2 pool — minus the sender — is notified in-app. MIS
 *            unreachable → nobody is notified (the queue still shows it).
 *
 * The self-approval block (packages/mail approveCampaign) is independent of
 * this and always applies.
 */

export async function legacyApproverPool(senderId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE p.key = 'MAIL_APPROVE' AND u.status = 'active' AND u.id <> $1`,
    [senderId],
  );
  return rows.map((r) => r.id).sort();
}

/** Tupo ids of the MIS holders of MAIL_APPROVE, sender excluded. null = MIS unavailable. */
export async function v2ApproverPool(senderId: string, senderMisId?: string | null): Promise<string[] | null> {
  const holders = await fetchHolders('MAIL_APPROVE');
  if (!holders) return null;
  const misIds = [...new Set(holders.map((h) => String(h.user_id)))]
    .filter((id) => !senderMisId || id !== String(senderMisId));
  if (!misIds.length) return [];
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM users WHERE mis_user_id = ANY($1::text[]) AND status = 'active' AND id <> $2`,
    [misIds, senderId],
  );
  return rows.map((r) => r.id).sort();
}

export async function routeCampaignForApproval(
  sender: { id: string; misUserId?: string | null },
  campaign: { id: string; subject?: string | null; status: string },
): Promise<string[]> {
  if (campaign.status !== 'pending_approval') return [];
  const mode = accessMode();
  if (mode === 'off') return [];

  if (mode === 'shadow') {
    void (async () => {
      try {
        const [legacy, v2] = await Promise.all([
          legacyApproverPool(sender.id), v2ApproverPool(sender.id, sender.misUserId),
        ]);
        if (!v2) return;
        const same = legacy.length === v2.length && legacy.every((id) => v2.includes(id));
        if (same) return;
        await recordShadowDiff({
          userId: sender.id, misUserId: sender.misUserId ?? null,
          capability: 'MAIL_APPROVE', route: 'mail:approver_pool',
          legacyAllowed: legacy.length > 0, v2: { allowed: v2.length > 0, depth: null },
          target: {
            campaignId: campaign.id,
            legacyPool: legacy.length, v2Pool: v2.length,
            onlyInV2: v2.filter((id) => !legacy.includes(id)).slice(0, 20),
            onlyInLegacy: legacy.filter((id) => !v2.includes(id)).slice(0, 20),
          },
        });
      } catch { /* never affects the request */ }
    })();
    return [];
  }

  const pool = await v2ApproverPool(sender.id, sender.misUserId);
  if (!pool?.length) return [];
  await notifyAndPush(pool, {
    kind: 'mail.campaign',
    title: 'A bulk send needs your approval',
    body: campaign.subject ?? null,
    link: '/app/mail/campaigns',
    subjectType: 'mail_campaign_approval',
    subjectId: campaign.id,
  }, { exclude: [sender.id] }).catch(() => []);
  return pool;
}
