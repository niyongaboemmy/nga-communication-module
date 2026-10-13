/**
 * Is this one emoji, the way a reaction picker would produce it?
 *
 * Allowed: a single pictograph (with skin-tone modifiers, variation
 * selectors and ZWJ joins — 👍🏽, ❤️, 👩‍💻, 🏳️‍🌈), a flag (two regional
 * indicators), or a keycap (1️⃣, #️⃣). Anything else — words, markup, several
 * emoji in a row — is refused, so a reaction can never carry text into
 * notification titles or someone's screen.
 */
const PICTO = '\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F|\\uFE0E|[\\u{E0020}-\\u{E007F}])*';
const EMOJI_RE = new RegExp(
  `^(?:${PICTO}(?:\\u200D${PICTO})*|\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3)$`, 'u');

export function isEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && EMOJI_RE.test(value.trim());
}
