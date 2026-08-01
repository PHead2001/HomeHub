import * as childProcess from "node:child_process";
import { resolve } from "node:path";
import { e2eEnvironment, runCommand } from "./environment.mjs";

const seedScript = resolve("scripts/e2e/seed.mjs");
const playwrightCli = resolve("node_modules/@playwright/test/cli.js");

const run = (args, timeoutMs) => runCommand(process.execPath, args, {
  cwd: process.cwd(),
  env: e2eEnvironment,
  shell: false,
  timeoutMs,
  spawnModule: childProcess,
});

let status = run([seedScript], 60_000);
if (status === 0) {
  status = run([playwrightCli, "test", "tests/e2e/visual.spec.ts"], 240_000);
}
if (status === 0) {
  status = run([seedScript], 60_000);
}
if (status === 0) {
  status = run([playwrightCli, "test", "tests/e2e/smoke.spec.ts", "tests/e2e/verification-findings.spec.ts"], 360_000);
}

process.exit(status);
