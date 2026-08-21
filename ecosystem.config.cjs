// Tupo — pm2 process definitions for the shared NGA EC2 host.
//
// .cjs, not .js: the root package.json declares "type": "module", so a .js
// file here is parsed as ESM and `module.exports` throws. (TaskMentor's
// equivalent is .js only because that package is not an ES module.)
//
// Four long-lived services. The web app is not here: it is a static bundle
// nginx serves straight from apps/web/dist.
//
// Each service reads its own apps/<name>/.env via dotenv, so no secret appears
// in this file and it is safe to commit. `cwd` matters for exactly that reason
// — dotenv resolves .env relative to the working directory, and pm2 otherwise
// inherits whatever directory the deploy happened to run from.
//
// Memory ceilings are deliberately modest: this box has 3.8 GB and already
// runs the MIS, TaskMentor and Tendo. They are a backstop against a leak
// taking the host down with it, not a performance setting.
module.exports = {
  apps: [
    {
      name: 'tupo-api',
      cwd: '/opt/apps/nga-communication-module/apps/api',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'tupo-realtime',
      cwd: '/opt/apps/nga-communication-module/apps/realtime',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'tupo-files',
      cwd: '/opt/apps/nga-communication-module/apps/files',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      // Uploads stream to disk rather than buffering, so this stays low even
      // with the 5 GB MAX_FILE_SIZE_BYTES.
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'tupo-worker',
      cwd: '/opt/apps/nga-communication-module/apps/worker',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
