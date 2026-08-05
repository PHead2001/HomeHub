import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { E2E_PROJECT_ID, e2eEnvironment } from './environment.mjs';

const firebaseCli = resolve('node_modules/firebase-tools/lib/bin/firebase.js');
const result = spawnSync(process.execPath, [
  firebaseCli,
  'emulators:exec',
  '--project',
  E2E_PROJECT_ID,
  '--only',
  'firestore',
  'node --import tsx --test tests/rules/firestore.rules.test.ts',
], {
  cwd: process.cwd(),
  env: e2eEnvironment,
  stdio: 'inherit',
  shell: false,
  timeout: 120_000,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
