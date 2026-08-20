#!/usr/bin/env node
/**
 * Verify every Tupo port is free before `npm run dev`.
 *
 * Uses netstat rather than lsof on purpose: lsof run as a normal user cannot
 * see sockets owned by other users, so a root-owned process squatting on a
 * port looks "free" and the service then dies with a confusing EADDRINUSE.
 * That exact case cost us an hour during setup.
 */
import { execSync } from 'node:child_process';

const PORTS = [
  ['api', 5190], ['realtime', 5191], ['files', 5192], ['worker', 5193], ['web', 5194],
];

const listening = new Set(
  execSync('netstat -an', { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes('LISTEN'))
    .map((l) => l.trim().split(/\s+/)[3] ?? '')
    .map((addr) => addr.split(/[.:]/).pop())
    .filter(Boolean)
);

let clash = false;
for (const [name, port] of PORTS) {
  const busy = listening.has(String(port));
  console.log(`  ${busy ? '❌' : '✅'} ${String(port).padEnd(6)} ${name}${busy ? '  — IN USE' : ''}`);
  if (busy) clash = true;
}

if (clash) {
  console.error('\nA port is occupied. Find the owner with:  sudo lsof -nP -iTCP:<port> -sTCP:LISTEN');
  process.exit(1);
}
console.log('\nAll Tupo ports are free.');
