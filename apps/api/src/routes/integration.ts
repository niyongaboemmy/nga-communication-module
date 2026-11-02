import { Router, type Request, type Response, type NextFunction } from 'express';
import { ok } from '@tupo/shared';
import { misBearerAuth, type MisBearerRequest } from '../middleware/misBearerAuth.js';
import { buildHomeSummary, parseSummaryInput, unprovisionedSummary } from '../services/homeSummaryService.js';
import { callTool, listTools } from '../services/mcpTools.js';

/**
 * Server-to-server routes the NGA Central MIS calls on a user's behalf.
 *
 * Authenticated by the user's own MIS token (middleware/misBearerAuth.ts), not
 * a Tupo session, so they sit apart from every other router. Read-only.
 */
const router = Router();
router.use(misBearerAuth);

/**
 * The MIS Home summary for the token's owner. POST carries optional hints
 * (date, tz, lenses); GET is the same with none. A MIS user who has never
 * signed in to Tupo gets `provisioned: false` and empty lists — never an
 * account.
 */
const homeSummary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = req as MisBearerRequest;
    if (!request.user) return res.json(ok(unprovisionedSummary()));
    const input = parseSummaryInput(req.method === 'POST' ? req.body : {});
    res.json(ok(await buildHomeSummary(request, input)));
  } catch (err) {
    next(err);
  }
};

router.post('/home-summary', homeSummary);
router.get('/home-summary', homeSummary);

/**
 * The NGA connector (EXTERNAL_AI_CONTRACT.md §2): the tools the MIS MCP server
 * relays for this person. `[]` / EXTERNAL_OFF while the school has it off.
 * Contract envelope: `{ tools }`, `{ result, summary, openUrl }` or `{ code, message }`.
 */
router.get('/mcp/tools', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await listTools(req)); } catch (err) { next(err); }
});

router.post('/mcp/call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await callTool(req);
    if ('code' in out) return res.status(out.status).json({ code: out.code, message: out.message });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
