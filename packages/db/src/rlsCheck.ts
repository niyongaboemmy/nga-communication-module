import 'dotenv/config';
import { runWithoutTenant } from '@tupo/tenancy';
import { getPool, closeDb } from './pool.js';
import { checkRlsCoverage, formatRlsCoverage } from './rlsCoverage.js';

/**
 * `npm run db:rls-check` — run by the deploy right after `npm run db:migrate`
 * and before pm2 reload, with the same DATABASE_URL. Prints one summary line;
 * exits 1 with the offending tables if any school-owned table or partition is
 * not under FORCE RLS with the tenant_isolation policy, so the deploy fails
 * before the new release goes live.
 */
runWithoutTenant('rls-check', () => checkRlsCoverage(getPool()))
  .then(async (result) => {
    const lines = formatRlsCoverage(result);
    (result.ok ? console.log : console.error)(lines.join('\n'));
    await closeDb();
    process.exit(result.ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('RLS check failed to run:', err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
