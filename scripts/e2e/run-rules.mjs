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
  'firestore,storage',
  'node --import tsx --test --test-concurrency=1 tests/rules/firestore.rules.test.ts tests/rules/storage.rules.test.ts tests/rules/pets-feed-operation.test.ts tests/rules/devices.rules.test.ts tests/rules/storage-devices.rules.test.ts',
], {
  cwd: process.cwd(),
  env: e2eEnvironment,
  stdio: 'inherit',
  shell: false,
  timeout: 300_000,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
