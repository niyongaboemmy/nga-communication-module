import type { Request } from 'express';
import { getPool, activeUserSql } from '@tupo/db';
import * as mail from '@tupo/mail';
import { MailError } from '@tupo/mail';
import { aiAppEnabled } from '../vendor/nga-access/index.js';
import { config } from '../config.js';
import { hasPermission } from '../access/gate.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getAiPolicy } from './aiPolicy.js';
import { holdsExternalCap } from './externalAi.js';
import { audit } from './userService.js';

/**
 * Connector (MCP) tools for Tupo (EXTERNAL_AI_CONTRACT.md §2).
 *
 * The MIS hosts the only MCP endpoint; for "tupo_" tools it relays the call to
 * /api/integration/mcp/* with a short-lived MIS token for the signed-in person
 * (misBearerAuth, the same auth as /home-summary). Tools exist only while the
 * school allows the connector (master + "tupo" switches, policy.external.connector)
 * for staff holding AI_EXTERNAL_CONNECT. Mail content stays out of scope: there
 * are no read tools, and the one write tool only ever saves a DRAFT in the
 * person's own Drafts folder. Nothing here can send.
 */

export interface ToolError { status: number; code: string; message: string }
export interface ToolResult { result: unknown; summary: string; openUrl?: string }

interface ToolDef {
  name: string;
  title: string;
  description: string;
  kind: 'read' | 'draft';
  pupilData: boolean;
  inputSchema: Record<string, unknown>;
  /** Tupo permission needed (any). */
  needs: string[];
}

const MAX_TO = 30;

const TOOLS: ToolDef[] = [
  {
    name: 'tupo_draft_mail',
    title: 'Draft a Tupo mail',
    description:
      "Saves an email in the person's Tupo Mail Drafts folder. It is NEVER sent: the person reviews, edits and " +
      'sends it themselves in Tupo (openUrl). Recipients are NGA MIS user ids or email addresses.',
    kind: 'draft',
    pupilData: false,
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subject line (max 300 characters).' },
        body: { type: 'string', description: 'The message. Plain text; blank lines separate paragraphs.' },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: `Up to ${MAX_TO} recipients: NGA MIS user ids (digits) or email addresses. Optional.`,
        },
      },
      required: ['subject', 'body'],
    },
    // Saving a draft needs what the composer's "Save draft" needs.
    needs: ['MAIL_READ'],
  },
];

const publicTool = ({ needs: _needs, ...t }: ToolDef) => t;

const refuse = (status: number, code: string, message: string): ToolError => ({ status, code, message });

type User = NonNullable<AuthenticatedRequest['user']>;

/** May this person use the connector at all right now? null = yes. */
async function connectorGate(user: User | undefined): Promise<ToolError | null> {
  const policy = await getAiPolicy();
  if (!policy || !aiAppEnabled(policy, 'tupo') || !policy.external.connector) {
    return refuse(403, 'EXTERNAL_OFF', 'The NGA connector is turned off for Tupo.');
  }
  if (!user) return refuse(403, 'TOOL_FORBIDDEN', 'Sign in to Tupo once before using it from your AI.');
  if (!(await holdsExternalCap(user))) {
    return refuse(403, 'TOOL_FORBIDDEN', 'Your role cannot use NGA from your own Claude or ChatGPT.');
  }
  return null;
}

const allowed = (req: Request, t: ToolDef) => t.needs.some((k) => hasPermission(req, k));

/** GET /api/integration/mcp/tools */
export async function listTools(req: Request): Promise<{ tools: ReturnType<typeof publicTool>[] }> {
  const user = (req as AuthenticatedRequest).user;
  if (await connectorGate(user)) return { tools: [] };
  return { tools: TOOLS.filter((t) => allowed(req, t)).map(publicTool) };
}

const isEmail = (v: string) => /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/.test(v);

/** Plain text to the minimal HTML the composer writes. */
function textToHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * The recipients as compose() takes them: a MIS user id becomes the active
 * Tupo user it maps to ("userId:<id>"); an address is passed through and
 * compose() applies Tupo's usual rules to it (internal routing, validity).
 */
async function resolveTo(raw: unknown): Promise<string[] | ToolError> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TO) return refuse(400, 'BAD_ARGUMENTS', `"to" must be a list of up to ${MAX_TO} recipients.`);
  const out: string[] = [];
  for (const item of raw) {
    const v = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : '';
    if (/^\d{1,12}$/.test(v)) {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM users u WHERE mis_user_id = $1 AND ${activeUserSql('u')}`, [v],
      );
      if (!rows[0]) return refuse(400, 'BAD_ARGUMENTS', `No active Tupo user has NGA MIS id ${v}.`);
      out.push(`userId:${rows[0].id}`);
    } else if (isEmail(v)) {
      out.push(v);
    } else {
      return refuse(400, 'BAD_ARGUMENTS', `Not a MIS user id or an email address: ${v.slice(0, 80) || '(empty)'}`);
    }
  }
  return out;
}

/** POST /api/integration/mcp/call */
export async function callTool(req: Request): Promise<ToolResult | ToolError> {
  const user = (req as AuthenticatedRequest).user;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const name = typeof body.name === 'string' ? body.name : '';
  const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
    ? body.arguments as Record<string, unknown> : {};

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return refuse(404, 'TOOL_UNKNOWN', `Tupo has no tool called "${name.slice(0, 80)}".`);
  const gate = await connectorGate(user);
  if (gate) return gate;
  if (!allowed(req, tool)) return refuse(403, 'TOOL_FORBIDDEN', 'You do not have permission to use this tool in Tupo.');

  // tupo_draft_mail
  const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
  const text = typeof args.body === 'string' ? args.body : '';
  if (!subject || subject.length > 300) return refuse(400, 'BAD_ARGUMENTS', 'subject is required (max 300 characters).');
  if (!text.trim() || text.length > 100_000) return refuse(400, 'BAD_ARGUMENTS', 'body is required (max 100,000 characters).');
  const to = await resolveTo(args.to);
  if (!Array.isArray(to)) return to;

  let draft: { messageId: string; threadId: string; draft: boolean };
  try {
    draft = await mail.compose(user!.id, {
      to, cc: [], bcc: [], subject, bodyHtml: textToHtml(text), bodyText: text.trim(),
      attachments: [],
      // Always a draft: this tool never sends.
      draft: true,
    });
  } catch (err) {
    if (err instanceof MailError) return refuse(err.status === 404 ? 400 : err.status, 'BAD_ARGUMENTS', err.message);
    throw err;
  }
  await audit({ actorId: user!.id, action: 'mail.draft_external', targetType: 'mail_message', targetId: draft.messageId });
  return {
    result: { draftId: draft.messageId, threadId: draft.threadId, status: 'draft', recipients: to.length },
    summary: `Saved "${subject.slice(0, 120)}" in your Tupo Drafts. It has not been sent: open it in Tupo to review and send.`,
    openUrl: `${config.appPublicUrl}/app/mail?folder=drafts`,
  };
}
