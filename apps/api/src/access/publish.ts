import { fileURLToPath } from 'node:url';
import { validateManifest } from '../vendor/nga-access/index.js';
import { config } from '../config.js';
import { TUPO_MANIFEST } from './manifest.js';
import { publishManifest } from './misAccess.js';

/**
 * `npm run access:publish -w @tupo/api` — PUT Tupo's capability manifest to
 * MIS (packages/access/README.md §3). Idempotent: an unchanged manifest comes
 * back `unchanged: true`. Authenticates with Tupo's own SSO client credentials
 * (SSO_CLIENT_ID / SSO_CLIENT_SECRET) against NGA_MIS_BASE_URL.
 *
 * Exit codes: 0 published/unchanged, 1 invalid manifest or MIS refused,
 * 2 MIS unreachable. The deploy workflow treats any failure as a warning.
 */
export async function runPublish(log: (msg: string) => void = console.log): Promise<number> {
  const errors = validateManifest(TUPO_MANIFEST);
  if (errors.length) {
    log(`[access:publish] manifest is invalid:\n  - ${errors.join('\n  - ')}`);
    return 1;
  }
  const caps = Object.keys(TUPO_MANIFEST.capabilities).length;
  log(`[access:publish] PUT ${config.misBaseUrl}/access/manifests/${TUPO_MANIFEST.app} (${caps} capabilities, version ${TUPO_MANIFEST.version})`);
  try {
    const { status, body } = await publishManifest(TUPO_MANIFEST);
    const b = body as { message?: string; data?: { unchanged?: boolean } } | null;
    if (status >= 200 && status < 300) {
      log(`[access:publish] ${b?.data?.unchanged ? 'unchanged' : 'published'} (HTTP ${status})`);
      return 0;
    }
    log(`[access:publish] MIS refused the manifest: HTTP ${status} ${b?.message ?? ''}`.trim());
    return 1;
  } catch (err) {
    log(`[access:publish] MIS unreachable: ${(err as Error)?.message ?? err}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPublish().then((code) => process.exit(code));
}
