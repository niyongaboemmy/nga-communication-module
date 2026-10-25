import { Router, type Request, type Response } from 'express';
import { ok } from '@tupo/shared';
import { authMiddleware } from '../middleware/auth.js';
import { tupoAiState } from '../services/aiPolicy.js';

/**
 * GET /api/ai/policy — is AI on for Tupo right now?
 *
 * The school-wide switch only (MIS ai_policy). Any signed-in user may ask: it
 * says nothing about who holds MAIL_AI_USE or MEET_AI_USE, only whether the
 * super admin has turned AI off, so the Mail and Meet panels can say so instead
 * of offering a button that will be refused.
 */
const router = Router();
router.use(authMiddleware);

router.get('/policy', async (_req: Request, res: Response) => {
  const state = await tupoAiState();
  res.json(ok({ enabled: state.enabled, reason: state.reason, message: state.message }));
});

export default router;
