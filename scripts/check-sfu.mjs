#!/usr/bin/env node
/**
 * Check the Cloudflare Realtime SFU credentials, against the real API.
 *
 * Two values decide whether meetings are capped at four people or hold five
 * hundred, and a wrong one fails at the worst possible moment — mid-join, in
 * front of a class. This proves them in a second, from the command line.
 *
 *   npm run meet:check-sfu                    # read apps/api/.env
 *   npm run meet:check-sfu <appId> <secret>   # try a pair before saving them
 *
 * Creating a session is the only honest test: it is the exact call the API
 * makes when someone joins, so anything that passes here will work in a
 * meeting, and anything that fails here would have failed there.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ENV_PATH = 'apps/api/.env';

function readEnv() {
  try {
    return Object.fromEntries(
      readFileSync(ENV_PATH, 'utf8').split('\n')
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
    );
  } catch {
    return {};
  }
}

const env = readEnv();
const [argAppId, argSecret] = process.argv.slice(2);
const appId = argAppId ?? env.CLOUDFLARE_REALTIME_APP_ID ?? '';
const secret = argSecret ?? env.CLOUDFLARE_REALTIME_APP_SECRET ?? '';

console.log('\n🔎 Cloudflare Realtime SFU\n');

if (!appId || !secret) {
  console.log('  ❌ Not configured.\n');
  console.log('  Create an app:  Cloudflare dashboard → Realtime → SFU → Create app');
  console.log(`  Then put both values in ${ENV_PATH}:\n`);
  console.log('     CLOUDFLARE_REALTIME_APP_ID=<App ID>');
  console.log('     CLOUDFLARE_REALTIME_APP_SECRET=<App Secret>\n');
  console.log('  Or try a pair without saving them first:');
  console.log('     npm run meet:check-sfu <appId> <secret>\n');
  console.log('  Until then meetings run peer-to-peer and are capped at 4 people.\n');
  process.exit(1);
}

// A wrong-shaped value is worth catching before spending a network round trip
// on it, and the mistake it catches is a real one: pasting the TURN key here.
const shapeWarnings = [];
if (!/^[0-9a-f]{16,64}$/i.test(appId)) {
  shapeWarnings.push('The App ID does not look like a Cloudflare app id (hex, 16–64 chars).');
}
if (secret.length < 20) {
  shapeWarnings.push('The App Secret looks too short.');
}
for (const warning of shapeWarnings) console.log(`  ⚠️  ${warning}`);

console.log(`  App ID: ${appId.slice(0, 8)}…${appId.slice(-4)}  (secret hidden)\n`);

let sessionId = null;
try {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/new?correlationId=tupo-preflight`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    },
  );

  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON handled below */ }

  if (res.status === 404 && body.errorCode === 'not_found') {
    console.log('  ❌ That App ID does not exist.\n');
    console.log('     A TURN key is NOT an SFU app — they are separate resources under');
    console.log('     Realtime. Create one at: dashboard → Realtime → SFU → Create app');
    console.log('     (A newly created app can take up to 60 seconds to go live.)\n');
    process.exit(1);
  }

  if (res.status === 401 || res.status === 403) {
    console.log('  ❌ The App Secret was rejected.\n');
    console.log('     Check it against the same app as the App ID above — a secret from a');
    console.log('     different app fails exactly like a wrong one.\n');
    process.exit(1);
  }

  if (!res.ok || body.errorCode) {
    console.log(`  ❌ Cloudflare refused the request (${res.status}).`);
    console.log(`     ${body.errorDescription ?? text.slice(0, 200)}\n`);
    process.exit(1);
  }

  sessionId = body.sessionId;
  if (!sessionId) {
    console.log('  ❌ Cloudflare accepted the call but returned no session id.\n');
    process.exit(1);
  }

  console.log(`  ✅ Credentials work — session ${sessionId.slice(0, 12)}… created.\n`);
} catch (err) {
  const timedOut = err instanceof Error && err.name === 'TimeoutError';
  console.log(`  ❌ ${timedOut ? 'Cloudflare did not respond in time.' : 'Could not reach Cloudflare.'}`);
  console.log(`     ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

// Offer to save a pair that was passed on the command line and proved good.
if (argAppId && argSecret) {
  try {
    let contents = readFileSync(ENV_PATH, 'utf8');
    contents = contents
      .replace(/^CLOUDFLARE_REALTIME_APP_ID=.*$/m, `CLOUDFLARE_REALTIME_APP_ID=${appId}`)
      .replace(/^CLOUDFLARE_REALTIME_APP_SECRET=.*$/m, `CLOUDFLARE_REALTIME_APP_SECRET=${secret}`);
    writeFileSync(ENV_PATH, contents);
    console.log(`  💾 Saved to ${ENV_PATH}.\n`);
  } catch (err) {
    console.log(`  ⚠️  Could not write ${ENV_PATH}: ${err instanceof Error ? err.message : err}`);
    console.log('     Paste the two values in by hand.\n');
  }
}

console.log('  Meetings will now use Cloudflare: up to 500 with video, 2,000 audio-only.');
console.log('  Restart the API for it to take effect (npm run dev).\n');
