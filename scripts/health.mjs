#!/usr/bin/env node
/** Curl every service's /health and print a one-line summary per service. */
const SERVICES = [
  ['api', 'http://localhost:5190/health'],
  ['realtime', 'http://localhost:5191/health'],
  ['files', 'http://localhost:5192/health'],
  ['worker', 'http://localhost:5193/health'],
];

let allOk = true;
for (const [name, url] of SERVICES) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    const checks = Object.entries(body.checks ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${res.ok ? '✅' : '⚠️ '} ${name.padEnd(9)} ${body.status.padEnd(9)} ${checks}`);
    if (!res.ok) allOk = false;
  } catch (err) {
    console.log(`  ❌ ${name.padEnd(9)} unreachable  (${err.message})`);
    allOk = false;
  }
}
process.exit(allOk ? 0 : 1);
