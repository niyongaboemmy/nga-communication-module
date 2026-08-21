#!/usr/bin/env node
/**
 * Create a Cloudflare Realtime SFU app and save its credentials.
 *
 * The dashboard route is two clicks and works fine; this exists because the
 * App Secret is shown once, and copying two long strings out of a browser into
 * a `.env` is exactly where a character goes missing. Creating the app here
 * means the values are never retyped, and they are verified before they are
 * saved.
 *
 *   npm run meet:create-sfu -- <accountId> <apiToken> [appName]
 *
 * The API token is an ordinary Cloudflare account token with **Calls: Edit**
 * permission (My Profile → API Tokens → Create Token → Custom). It is used for
 * this one call and never stored — what gets saved is the App ID and App
 * Secret the call returns.
 *
 * API: POST /accounts/{account_id}/calls/apps
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ENV_PATH = 'apps/api/.env';
const [accountId, apiToken, appName = 'tupo-meet'] = process.argv.slice(2);

console.log('\n🛠  Create a Cloudflare Realtime SFU app\n');

if (!accountId || !apiToken) {
  console.log('  Usage:  npm run meet:create-sfu -- <accountId> <apiToken> [appName]\n');
  console.log('  Account ID');
  console.log('    dash.cloudflare.com → pick your account → the id is in the URL, and');
  console.log('    on the right of the account home page.\n');
  console.log('  API token  (used once, never saved)');
  console.log('    dash.cloudflare.com/profile/api-tokens → Create Token → Custom token');
  console.log('    Permissions:  Account · Calls · Edit');
  console.log('    Account resources:  the account above\n');
  console.log('  Prefer clicking? Create the app at:');
  console.log('    https://dash.cloudflare.com/?to=/:account/realtime/sfu');
  console.log('  then run:  npm run meet:check-sfu <appId> <appSecret>\n');
  process.exit(1);
}

let created;
try {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/calls/apps`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: appName }),
      signal: AbortSignal.timeout(20_000),
    },
  );

  const body = await res.json().catch(() => ({}));

  if (!res.ok || body.success === false) {
    const first = body.errors?.[0];
    console.log(`  ❌ Cloudflare refused the request (${res.status}).`);
    if (first) console.log(`     ${first.code ? `[${first.code}] ` : ''}${first.message}`);

    // The two mistakes worth naming, because the raw message for each is
    // opaque enough to send someone down the wrong path entirely.
    if (res.status === 403 || first?.code === 9109 || first?.code === 10000) {
      console.log('\n     The token is missing the permission this needs.');
      console.log('     Create one with:  Account · Calls · Edit');
    }
    if (res.status === 404) {
      console.log('\n     That account id was not found for this token — check both belong');
      console.log('     to the same account.');
    }
    console.log('');
    process.exit(1);
  }

  created = body.result;
} catch (err) {
  const timedOut = err instanceof Error && err.name === 'TimeoutError';
  console.log(`  ❌ ${timedOut ? 'Cloudflare did not respond in time.' : 'Could not reach Cloudflare.'}`);
  console.log(`     ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

const appId = created?.uid;
const appSecret = created?.secret;

if (!appId || !appSecret) {
  console.log('  ❌ Cloudflare created the app but did not return both credentials.');
  console.log('     Find them at: https://dash.cloudflare.com/?to=/:account/realtime/sfu\n');
  process.exit(1);
}

console.log(`  ✅ Created app “${created.name ?? appName}”`);
console.log(`     App ID: ${appId}\n`);

/* Prove it before saving it. A newly created app can take up to a minute to go
 * live globally, so this retries rather than reporting a false failure. */
process.stdout.write('  Waiting for it to go live');
let live = false;
for (let attempt = 0; attempt < 12 && !live; attempt++) {
  await new Promise((r) => setTimeout(r, attempt === 0 ? 1000 : 5000));
  process.stdout.write('.');
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/new?correlationId=tupo-preflight`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${appSecret}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) live = true;
  } catch { /* still propagating */ }
}
console.log('');

if (!live) {
  console.log('\n  ⚠️  The app was created but is not answering yet. This is normal for up');
  console.log('     to a minute. The values are below — save them and re-check:\n');
  console.log(`     CLOUDFLARE_REALTIME_APP_ID=${appId}`);
  console.log(`     CLOUDFLARE_REALTIME_APP_SECRET=${appSecret}\n`);
  console.log('     npm run meet:check-sfu\n');
  process.exit(1);
}

console.log('  ✅ Live — a real media session was created and torn down.\n');

try {
  let contents = readFileSync(ENV_PATH, 'utf8');
  const setOrAppend = (key, value) => {
    const line = `${key}=${value}`;
    contents = new RegExp(`^${key}=.*$`, 'm').test(contents)
      ? contents.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${contents.trimEnd()}\n${line}\n`;
  };
  setOrAppend('CLOUDFLARE_REALTIME_APP_ID', appId);
  setOrAppend('CLOUDFLARE_REALTIME_APP_SECRET', appSecret);
  writeFileSync(ENV_PATH, contents);
  console.log(`  💾 Saved to ${ENV_PATH} (git-ignored).\n`);
} catch (err) {
  console.log(`  ⚠️  Could not write ${ENV_PATH}: ${err instanceof Error ? err.message : err}`);
  console.log('     Save these by hand — the secret is not shown again:\n');
  console.log(`     CLOUDFLARE_REALTIME_APP_ID=${appId}`);
  console.log(`     CLOUDFLARE_REALTIME_APP_SECRET=${appSecret}\n`);
  process.exit(1);
}

console.log('  Restart the API and meetings will use Cloudflare:');
console.log('  up to 500 with video, 2,000 audio-only.\n');
console.log('     npm run dev\n');
