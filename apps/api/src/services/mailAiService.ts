/**
 * The AI layer for Mail.
 *
 * Drafting, replying, rewriting, summarising and planning — all over the same
 * four-provider fallback chain (openai → gemini → groq → glm) that Meet and the
 * MIS use, so a quota error on one provider falls through to the next without
 * the caller knowing. Every result records which provider answered.
 *
 * The model only ever sees text: the current draft as plain text, the thread
 * rendered as plain text by `@tupo/mail`, and the instruction. It returns
 * either a small JSON object (summaries, replies, subject lines) or a compact
 * HTML fragment (a drafted message body), which is sanitised here before it
 * can reach an inbox.
 */
import {
  generateStructuredContent, generatePlainText, isAnyProviderConfigured,
} from './aiProviders/index.js';
import type { JSONSchema } from './aiProviders/index.js';
import type {
  MailAiAction, MailAiComposeResult, MailAiSubjectResult, MailAiThreadSummary,
  MailAiSmartReplies, MailAiCampaignDraft,
} from '@tupo/shared';
import { htmlToText } from '@tupo/mail';

export { isAnyProviderConfigured };

export class MailAiError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'MailAiError'; }
}

function ensureConfigured(): void {
  if (!isAnyProviderConfigured()) {
    throw new MailAiError(
      'The AI assistant is not configured. An administrator needs to add an API key for at least one provider.',
      503,
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * HTML sanitiser — the model's drafted body must be inbox-safe
 * ────────────────────────────────────────────────────────────────────────── */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'hr', 'span', 'div', 'code', 'pre',
]);

export function sanitizeAiHtml(raw: string): string {
  let html = raw.trim()
    .replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '')
    // Drop dangerous elements *with their content*, not just the tags.
    .replace(/<(script|style|iframe|object|embed|noscript|template)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:html|body|head|meta|title|link|base)[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Drop any tag not on the allowlist; strip every attribute except href on <a>.
  html = html.replace(/<(\/?)([a-z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_m, close, tag, attrs) => {
    const t = String(tag).toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (close) return `</${t}>`;
    if (t === 'a') {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = (href?.[2] ?? href?.[3] ?? href?.[4] ?? '').trim();
      return /^(https?:|mailto:)/i.test(url)
        ? `<a href="${url.replace(/"/g, '%22')}" rel="noopener nofollow" target="_blank">`
        : '<a>';
    }
    return `<${t}>`;
  });

  html = html.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (!/<(p|ul|ol|h[1-4]|blockquote)\b/i.test(html)) html = `<p>${html.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  return html.trim();
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Prompt scaffolding
 * ────────────────────────────────────────────────────────────────────────── */

const GROUND =
  'You are the writing assistant inside NGA Tupo, the communication platform for a school. ' +
  'You help staff write clear, professional institutional email. Never invent facts — names, ' +
  'dates, amounts, policies — that were not given to you; if something is missing, leave a ' +
  'neutral placeholder in [square brackets]. Keep a warm but professional register. ' +
  'Output the message body only: no subject line, no "Here is your draft", no commentary.';

function contextBlock(ctx: {
  subject?: string; recipients?: string[]; senderName?: string; tone?: string;
}): string {
  const bits: string[] = [];
  if (ctx.subject) bits.push(`Subject: ${ctx.subject}`);
  if (ctx.recipients?.length) bits.push(`Writing to: ${ctx.recipients.join(', ')}`);
  if (ctx.senderName) bits.push(`Signed by: ${ctx.senderName}`);
  if (ctx.tone) bits.push(`Requested tone: ${ctx.tone}`);
  return bits.length ? `\n${bits.join('\n')}\n` : '';
}

const ACTION_VERB: Record<MailAiAction, string> = {
  draft: 'Write a new email',
  reply: 'Write a reply to the conversation below',
  improve: 'Rewrite the draft below to be clearer and better organised, keeping its meaning and roughly its length',
  formal: 'Rewrite the draft below in a more formal register',
  friendly: 'Rewrite the draft below to be warmer and more approachable, without becoming unprofessional',
  concise: 'Rewrite the draft below to be significantly shorter while keeping every essential point',
  expand: 'Expand the notes below into a complete, well-structured email',
  grammar: 'Correct only the spelling, grammar and punctuation of the draft below. Do not change wording, tone or structure otherwise',
  translate: 'Translate the draft below',
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Compose / rewrite
 * ────────────────────────────────────────────────────────────────────────── */

export interface ComposeInput {
  action: MailAiAction;
  instruction?: string;
  currentText?: string;
  subject?: string;
  recipients?: string[];
  senderName?: string;
  tone?: string;
  threadText?: string;
}

export async function composeAssist(input: ComposeInput): Promise<MailAiComposeResult> {
  ensureConfigured();

  const rewriteActions: MailAiAction[] = ['improve', 'formal', 'friendly', 'concise', 'expand', 'grammar', 'translate'];
  if (rewriteActions.includes(input.action) && !input.currentText?.trim()) {
    throw new MailAiError('There is nothing in the message to work with yet.');
  }
  if (input.action === 'draft' && !input.instruction?.trim()) {
    throw new MailAiError('Tell the assistant what the email should say.');
  }
  if (input.action === 'translate' && !input.instruction?.trim()) {
    throw new MailAiError('Say which language to translate into.');
  }

  const parts = [GROUND, contextBlock(input), '', ACTION_VERB[input.action] + '.'];
  if (input.action === 'draft') parts.push(`\nWhat it should say:\n${input.instruction}`);
  if (input.action === 'translate') parts.push(`\nTarget language: ${input.instruction}`);
  if (input.action === 'reply') {
    parts.push(input.instruction ? `\nThe reply should: ${input.instruction}` : '');
    parts.push(`\nConversation so far:\n${input.threadText ?? '(no earlier messages)'}`);
  } else if (input.currentText?.trim()) {
    parts.push(`\nDraft:\n${input.currentText}`);
  }
  parts.push(
    '\nReturn the body as minimal HTML: <p> for paragraphs, <ul>/<li> for lists, <strong> for ' +
    'emphasis, <a href> for links. No inline styles, no classes, no <html>/<head>/<body>.',
  );

  const { data, providerUsed } = await generatePlainText(parts.join('\n'), 1400);
  const html = sanitizeAiHtml(data);
  if (!htmlToText(html).trim()) throw new MailAiError('The assistant returned an empty draft. Try rephrasing.', 502);

  const NOTE: Record<MailAiAction, string> = {
    draft: 'Drafted from your instruction', reply: 'Drafted a reply', improve: 'Rewrote for clarity',
    formal: 'Made it more formal', friendly: 'Made it warmer', concise: 'Made it shorter',
    expand: 'Expanded your notes', grammar: 'Fixed spelling and grammar', translate: `Translated to ${input.instruction}`,
  };
  return { html, note: NOTE[input.action], providerUsed };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Subject lines
 * ────────────────────────────────────────────────────────────────────────── */

const SUBJECT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { suggestions: { type: 'array', items: { type: 'string' } } },
  required: ['suggestions'],
};

export async function suggestSubjects(bodyText: string): Promise<MailAiSubjectResult> {
  ensureConfigured();
  if (!bodyText.trim()) throw new MailAiError('Write the message first, then ask for a subject.');
  const { data, providerUsed } = await generateStructuredContent<{ suggestions: string[] }>({
    prompt:
      `${GROUND}\nPropose 3 subject lines for this email. Each under 70 characters, specific, ` +
      `no "Re:"/"Fwd:", no trailing punctuation.\n\nEmail:\n${bodyText.slice(0, 4000)}`,
    schema: SUBJECT_SCHEMA,
    schemaName: 'mail_subjects',
    maxOutputTokens: 300,
  });
  return {
    suggestions: (data.suggestions ?? []).map((s) => s.replace(/^["']|["'.\s]+$/g, '').slice(0, 120)).filter(Boolean).slice(0, 3),
    providerUsed,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Thread summary & planning
 * ────────────────────────────────────────────────────────────────────────── */

const SUMMARY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences.' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          owner: { type: 'string', description: 'Name if the thread names one, else empty string.' },
          due: { type: 'string', description: 'Date/phrase if stated, else empty string.' },
        },
        required: ['text', 'owner', 'due'],
      },
    },
    needsReply: { type: 'boolean' },
  },
  required: ['summary', 'keyPoints', 'actionItems', 'needsReply'],
};

export async function summariseThread(threadText: string, readerName: string): Promise<MailAiThreadSummary> {
  ensureConfigured();
  const { data, providerUsed } = await generateStructuredContent<{
    summary: string; keyPoints: string[];
    actionItems: Array<{ text: string; owner: string; due: string }>; needsReply: boolean;
  }>({
    prompt:
      `${GROUND}\nSummarise this email thread for ${readerName}, who is reading it now. ` +
      `Extract the decisions and the outstanding action items — only things someone committed to ` +
      `do. Say whether it looks like ${readerName} still owes a reply.\n\nThread:\n${threadText}`,
    schema: SUMMARY_SCHEMA,
    schemaName: 'mail_thread_summary',
    maxOutputTokens: 900,
  });
  return {
    summary: data.summary ?? '',
    keyPoints: (data.keyPoints ?? []).filter(Boolean),
    actionItems: (data.actionItems ?? []).map((a) => ({
      text: a.text, owner: a.owner?.trim() || null, due: a.due?.trim() || null,
    })).filter((a) => a.text?.trim()),
    needsReply: !!data.needsReply,
    providerUsed,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Smart replies
 * ────────────────────────────────────────────────────────────────────────── */

const REPLIES_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'A 1–3 word label, e.g. "Confirm", "Decline", "Ask for detail".' },
          text: { type: 'string', description: 'One or two sentences, ready to send.' },
        },
        required: ['intent', 'text'],
      },
    },
  },
  required: ['replies'],
};

export async function smartReplies(threadText: string, readerName: string): Promise<MailAiSmartReplies> {
  ensureConfigured();
  const { data, providerUsed } = await generateStructuredContent<{
    replies: Array<{ intent: string; text: string }>;
  }>({
    prompt:
      `${GROUND}\nSuggest 3 short possible replies ${readerName} could send to the latest message ` +
      `in this thread. Cover genuinely different responses (e.g. agree, decline, ask a question). ` +
      `Each one or two sentences, no salutation, no sign-off.\n\nThread:\n${threadText}`,
    schema: REPLIES_SCHEMA,
    schemaName: 'mail_smart_replies',
    maxOutputTokens: 500,
  });
  return {
    replies: (data.replies ?? []).filter((r) => r.text?.trim()).slice(0, 3),
    providerUsed,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Bulk announcement drafting
 * ────────────────────────────────────────────────────────────────────────── */

const CAMPAIGN_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    bodyHtml: { type: 'string', description: 'Minimal HTML: <p>, <ul><li>, <strong>. Personalise with {{first_name}} etc.' },
    mergeFields: { type: 'array', items: { type: 'string' }, description: 'Every {{field}} the body uses.' },
  },
  required: ['subject', 'bodyHtml', 'mergeFields'],
};

export async function draftCampaign(brief: string, audience?: string): Promise<MailAiCampaignDraft> {
  ensureConfigured();
  if (!brief.trim()) throw new MailAiError('Describe the announcement first.');
  const { data, providerUsed } = await generateStructuredContent<{
    subject: string; bodyHtml: string; mergeFields: string[];
  }>({
    prompt:
      `${GROUND}\nDraft a bulk announcement to be mail-merged to many recipients` +
      `${audience ? ` (${audience})` : ''}. Address each recipient personally using {{first_name}}. ` +
      `Use other merge fields like {{class}}, {{amount}}, {{date}} where the brief implies ` +
      `per-recipient data, and leave any factual gap as a {{merge_field}} rather than inventing it. ` +
      `Keep it under 200 words.\n\nBrief:\n${brief}`,
    schema: CAMPAIGN_SCHEMA,
    schemaName: 'mail_campaign_draft',
    maxOutputTokens: 900,
  });
  return {
    subject: (data.subject ?? '').slice(0, 300),
    bodyHtml: sanitizeAiHtml(data.bodyHtml ?? ''),
    mergeFields: [...new Set((data.mergeFields ?? []).map((f) => f.replace(/[{}]/g, '').trim()).filter(Boolean))],
    providerUsed,
  };
}
