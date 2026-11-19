/**
 * Runtime flags for the web client (chat experience plan, task 0.6).
 *
 * A flag turns a new piece of UI on or off without a deploy, so a feature can
 * reach staff first and everyone a few days later, and can be switched off
 * the moment it misbehaves.
 *
 *   TUPO_FLAGS="chat.inlineReplies=staff,chat.threadPage=all,chat.actionSheet=off"
 *
 * Each value is `all`, `off`, or a `|`-separated list of roles
 * (`staff|admin`). A known flag that is not listed is **on for everyone**: an
 * unset variable means "ship it", and staging a rollout is the operator's
 * explicit choice. Unknown names are ignored, so a typo cannot invent a flag.
 */

export const CLIENT_FLAGS = ['chat.inlineReplies', 'chat.threadPage', 'chat.actionSheet'] as const;
export type ClientFlag = (typeof CLIENT_FLAGS)[number];

type Rule = 'all' | 'off' | string[];

export function parseFlagRules(raw: string | undefined): Map<ClientFlag, Rule> {
  const rules = new Map<ClientFlag, Rule>();
  for (const part of (raw ?? '').split(',')) {
    const [name, value] = part.split('=').map((s) => s.trim());
    if (!name || !(CLIENT_FLAGS as readonly string[]).includes(name)) continue;
    const v = (value ?? 'all').toLowerCase();
    rules.set(name as ClientFlag, v === 'all' || v === 'on' ? 'all'
      : v === 'off' ? 'off'
        : v.split('|').map((r) => r.trim()).filter(Boolean));
  }
  return rules;
}

/** The flags that are on for someone with this role. */
export function flagsFor(role: string | null | undefined, raw = process.env.TUPO_FLAGS): ClientFlag[] {
  const rules = parseFlagRules(raw);
  const who = (role ?? '').toLowerCase();
  return CLIENT_FLAGS.filter((f) => {
    const rule = rules.get(f) ?? 'all';
    if (rule === 'all') return true;
    if (rule === 'off') return false;
    return rule.includes(who);
  });
}

/**
 * Counters a browser may report (task 0.7). A fixed list: the endpoint is open
 * to every signed-in person, and an open-ended name would let anyone write
 * arbitrary series into the metrics table.
 */
export const CLIENT_COUNTERS = [
  'chat.draft.conflict_dropped',
  'chat.draft.remote_offered',
  'chat.send.ack_timeout',
  'chat.send.rest_fallback',
  'chat.outbox.flush_joined',
  'chat.edit.rollback',
  'chat.delete.rollback',
  'chat.request.timeout',
] as const;
