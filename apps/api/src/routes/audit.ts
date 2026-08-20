import { Router, type Request, type Response } from 'express';
import { getPool } from '@tupo/db';
import { ok } from '@tupo/shared';
import { authMiddleware } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';

const router = Router();
router.use(authMiddleware);

router.get('/', authorizePermission('AUDIT_VIEW'), async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const { rows } = await getPool().query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata,
            a.ip_address, a.created_at, u.name AS actor_name, u.email AS actor_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.json(ok(rows, { total: rows.length }));
});

export default router;
