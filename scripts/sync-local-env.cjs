#!/usr/bin/env node
/**
 * Brings each local `.env` back in line with its `.env.example`.
 *
 * Every module here is wired to the other modules by URL, so an `.env` written
 * during an earlier setup keeps pointing wherever it pointed then. The modules
 * used to sign in through the deployed MIS; they now sign in through a copy of
 * the MIS on this machine, so those old files send people to production and
 * sign-in fails in a way that looks like a broken app. Creating `.env` only
 * when it is missing never repairs that - the file is always already there.
 *
 * So this runs on every start and repairs rather than warns. It is deliberately
 * narrow: a value is only overwritten when it is an absolute URL leaving this
 * machine while the template's value stays on it, or when it is the SSO
 * identity the local MIS actually registers. Ports, database settings, and
 * anything the template leaves blank (your own API keys) are never touched.
 *
 *   node scripts/sync-local-env.cjs <dir> [<dir> ...]
 *
 * where each <dir> holds a `.env.example` next to its `.env`. Exits non-zero
 * only if something could not be read or written.
 *
 * Vite and dotenv-flow also read `.env.local`, `.env.development` and
 * `.env.development.local`, and those win over `.env`. A stale value in one of
 * them would undo the repair, so they get the same treatment - except that no
 * keys are added to them: they are meant to hold only what they override.
 */
const fs = require("fs");
const path = require("path");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const unquote = (v) =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v;

/** Host of an absolute URL, or null when the value is not one (a port, a path, a word). */
function hostOf(value) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(unquote(value.trim()));
  if (!m) return null;
  return m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
}

const leavesThisMachine = (v) => {
  const h = hostOf(v);
  return h !== null && !LOCAL_HOSTS.has(h);
};

/** KEY from a line, or null for a comment, a blank line, or anything malformed. */
function keyOf(line) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : null;
}

const valueOf = (line) => line.slice(line.indexOf("=") + 1).trim();

/**
 * Why a key has to be taken from the template, or "" to keep what is there.
 * Anything not named here is the developer's own setting and is left alone.
 */
function reasonToReplace(key, mine, theirs) {
  if (theirs === "" || mine === theirs) return "";
  if (leavesThisMachine(mine) && !leavesThisMachine(theirs)) return "pointed off this machine";
  // Only the SSO identity, not every *_CLIENT_ID: a Google OAuth client is the
  // developer's own and has nothing to do with the MIS on this machine.
  if (/(^|_)SSO_CLIENT_ID$/.test(key)) return "must match the client the local MIS registers";
  if (/(^|_)SSO_CLIENT_SECRET$/.test(key) && unquote(theirs).startsWith("local-dev-secret-"))
    return "must match the secret the local MIS registers";
  return "";
}

/** Files that override `.env` in development, most specific last. */
const OVERRIDES = [".env.local", ".env.development", ".env.development.local"];

function syncOne(dir, name = ".env") {
  const examplePath = path.join(dir, ".env.example");
  const envPath = path.join(dir, name);
  const label = path.relative(process.cwd(), envPath) || envPath;
  const isOverride = name !== ".env";

  if (!fs.existsSync(examplePath)) return { label, skipped: true };

  if (!fs.existsSync(envPath)) {
    if (isOverride) return { label, skipped: true };
    fs.copyFileSync(examplePath, envPath);
    return { label, created: true, changes: [] };
  }

  const exampleLines = fs.readFileSync(examplePath, "utf8").split(/\r?\n/);
  const template = new Map();
  for (const line of exampleLines) {
    const key = keyOf(line);
    if (key) template.set(key, valueOf(line));
  }

  const original = fs.readFileSync(envPath, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const changes = [];
  const seen = new Set();

  const next = lines.map((line) => {
    const key = keyOf(line);
    if (!key || !template.has(key)) return line;
    seen.add(key);
    const mine = valueOf(line);
    const theirs = template.get(key);
    const reason = reasonToReplace(key, mine, theirs);
    if (!reason) return line;
    changes.push(`${key}: ${mine} -> ${theirs}  (${reason})`);
    return `${key}=${theirs}`;
  });

  // Keys added to the template since this .env was written: without them the
  // app falls back to a default that no longer exists, so add them as-is.
  for (const [key, value] of template) {
    if (isOverride || seen.has(key)) continue;
    next.push(`${key}=${value}`);
    changes.push(`${key}: added (new setting)`);
  }

  if (changes.length === 0) return { label, changes };

  fs.writeFileSync(`${envPath}.bak`, original);
  fs.writeFileSync(envPath, next.join(eol));
  return { label, changes, backedUp: true };
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: node scripts/sync-local-env.cjs <dir> [<dir> ...]");
    process.exit(2);
  }

  let repaired = 0;
  const targets = dirs.flatMap((dir) =>
    [".env", ...OVERRIDES].map((name) => [path.resolve(dir), name]),
  );
  for (const [dir, name] of targets) {
    const r = syncOne(dir, name);
    if (r.skipped) continue;
    if (r.created) {
      console.log(`  - Created ${r.label}`);
      continue;
    }
    if (r.changes.length === 0) continue;
    repaired += 1;
    console.log(`  - Repaired ${r.label} (previous copy kept as ${path.basename(r.label)}.bak):`);
    for (const c of r.changes) console.log(`      ${c}`);
  }
  if (repaired > 0) {
    console.log("    These settings connect the modules running on this machine.");
    console.log("    Your own keys, ports and database settings were left as they were.");
  }
}

try {
  main();
} catch (err) {
  console.error(`  [X] Could not update .env: ${err.message}`);
  process.exit(1);
}
