// Reads the rulesets that are actually released in a Firebase project and
// compares them with the files in this checkout. A successful `firebase deploy`
// or console save is not proof; this check is.
//
// Usage: node scripts/deploy/verify-live-rules.mjs --project homehub-j91jb [--bucket <bucket>]
// Auth: Application Default Credentials (google-github-actions/auth in CI).
import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const projectId = argValue('project');
if (!projectId) throw new Error('Pass --project <firebase project id>.');
const bucket = argValue('bucket', `${projectId}.firebasestorage.app`);

const normalize = source => source.replace(/\r\n/g, '\n').trim();

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();
const api = 'https://firebaserules.googleapis.com/v1';

const liveSource = async releaseName => {
  const release = await client.request({ url: `${api}/projects/${projectId}/releases/${releaseName}` });
  const ruleset = await client.request({ url: `${api}/${release.data.rulesetName}` });
  const files = ruleset.data.source?.files ?? [];
  if (files.length !== 1) throw new Error(`${releaseName}: expected one rules file, found ${files.length}.`);
  return { source: files[0].content, ruleset: release.data.rulesetName, updated: release.data.updateTime };
};

const checks = [
  { label: 'Firestore', release: 'cloud.firestore', file: 'firestore.rules' },
  { label: 'Storage', release: `firebase.storage/${bucket}`, file: 'storage.rules' },
];

let failed = false;
for (const check of checks) {
  const live = await liveSource(check.release);
  const matches = normalize(live.source) === normalize(readFileSync(check.file, 'utf8'));
  console.log(`${check.label}: ${matches ? 'matches' : 'DOES NOT MATCH'} ${check.file} (${live.ruleset}, released ${live.updated})`);
  if (!matches) failed = true;
}

if (failed) {
  console.error('Live rules differ from this commit. The deploy did not take effect as intended.');
  process.exitCode = 1;
}
