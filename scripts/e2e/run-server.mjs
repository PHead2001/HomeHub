import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { E2E_PROJECT_ID, e2eEnvironment } from './environment.mjs';

// Server-side membership operations against the Firestore emulator through the
// Admin SDK. `react-server` makes the `server-only` guard importable under Node.
const firebaseCli = resolve('node_modules/firebase-tools/lib/bin/firebase.js');
const result = spawnSync(process.execPath, [
  firebaseCli,
  'emulators:exec',
  '--project',
  E2E_PROJECT_ID,
  '--only',
  'firestore,auth,storage',
  'node --conditions=react-server --import tsx --test --test-concurrency=1 tests/server/household-membership.test.ts tests/server/household-management.test.ts tests/server/home-assistant.test.ts tests/server/push-policy.test.ts tests/server/notification-dedup.test.ts tests/server/home-assistant-store.test.ts tests/server/ai-quota.test.ts tests/server/ai-payload-limit.test.ts tests/server/reminders-shared.test.ts tests/server/household-upkeep.test.ts tests/server/overdue-notification.test.ts tests/server/push-media.test.ts tests/server/ai-action-auth.test.ts tests/server/feeding-state-backfill.test.ts tests/server/chore-completion.test.ts tests/server/shopping-delete-list.test.ts tests/server/shopping-trips.test.ts tests/server/household-records.test.ts tests/server/departed-stats.test.ts tests/server/member-privacy-ops.test.ts tests/server/chore-id-rekey.test.ts tests/server/device-identity.test.ts tests/server/device-codes.test.ts tests/server/device-management.test.ts tests/server/pins.test.ts tests/server/child-identities.test.ts tests/server/device-gate.test.ts tests/server/meal-plan-audit.test.ts tests/server/device-tablet.test.ts tests/server/pet-delete.test.ts',
], {
  cwd: process.cwd(),
  env: e2eEnvironment,
  stdio: 'inherit',
  shell: false,
  timeout: 300_000,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
