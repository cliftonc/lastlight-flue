#!/usr/bin/env node
// `lastlight` launcher — runs the TypeScript CLI (src/cli.ts) through `tsx`,
// because src/cli.ts uses `.ts` import specifiers (the repo-wide convention for
// Flue imports) which Node can't resolve without a TS loader. This keeps the CLI
// runnable in dev (`pnpm cli ...` or `lastlight ...`) WITHOUT a build step.
//
// Phase 2 CLI port. A later slice may emit a plain-JS `dist/cli.js` at build
// time and point `bin` straight at it; for now this dev wrapper is sufficient
// (the CLI is offline, app-independent client code).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'src', 'cli.ts');

// Prefer the locally-installed tsx binary; `tsx` resolves it from node_modules.
const child = spawn(
  process.execPath,
  [resolve(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
