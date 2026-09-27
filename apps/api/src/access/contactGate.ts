import { accessMode } from './mode.js';
import { contactDecisions } from './contactPolicy.js';
import { recordShadowDiff } from './shadow.js';

/**
 * Applies the contact policy on a surface (DM start, channel member add,
 * mentions, directory search) according to ACCESS_V2_MODE:
 *
 *   off      nothing is checked; everyone passed in is returned as allowed
 *   shadow   everyone is allowed; would-be denials are recorded (async) as
 *            shadow diffs with route "contact:<surface>"
 *   enforce  only the recipients the policy allows are returned
 *
 * Returns the set of recipient ids that are NOT allowed (empty unless enforcing).
 */
export type ContactSurface = 'dm' | 'member_add' | 'mention' | 'directory' | 'group_create';

export async function contactDenied(
  sender: { id: string; misUserId?: string },
  recipientIds: string[],
  surface: ContactSurface,
): Promise<Set<string>> {
  const mode = accessMode();
  const targets = [...new Set(recipientIds.filter((r) => r && r !== sender.id))];
  if (mode === 'off' || !targets.length) return new Set();

  if (mode === 'shadow') {
    void (async () => {
      try {
        const ds = await contactDecisions(sender.id, targets);
        for (const [to, d] of ds) {
          if (d.allowed) continue;
          await recordShadowDiff({
            userId: sender.id, misUserId: sender.misUserId ?? null,
            capability: 'CONTACT', route: `contact:${surface}`,
            legacyAllowed: true, v2: { allowed: false, depth: null },
            target: { recipientId: to, reason: d.reason },
          });
        }
      } catch { /* never affects the request */ }
    })();
    return new Set();
  }

  const ds = await contactDecisions(sender.id, targets);
  return new Set([...ds].filter(([, d]) => !d.allowed).map(([to]) => to));
}
