import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import {
  E2E_AUTH_HOST,
  E2E_FIRESTORE_HOST,
  E2E_PROJECT_ID,
  e2eEnvironment,
} from "./environment.mjs";

const updateSnapshots = process.argv.includes("--visual-update");
const firebaseCli = resolve("node_modules/firebase-tools/lib/bin/firebase.js");
const playwrightCli = resolve("node_modules/@playwright/test/cli.js");
const seedScript = resolve("scripts/e2e/seed.mjs");
const emulatorTimeoutMs = 60_000;
const suiteTimeoutMs = 240_000;

const parseHost = (value) => {
  const separator = value.lastIndexOf(":");
  return {
    host: value.slice(0, separator),
    port: Number(value.slice(separator + 1)),
  };
};

const waitForPort = ({ host, port }, timeoutMs) => new Promise((resolvePort, reject) => {
  const deadline = Date.now() + timeoutMs;

  const attempt = () => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePort();
    });
    socket.once("error", () => {
      socket.destroy();
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${host}:${port}.`));
        return;
      }
      setTimeout(attempt, 250);
    });
  };

  attempt();
});

const terminateProcessTree = (child) => {
  if (!child?.pid || child.exitCode !== null) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
};

const runChild = (command, args, label, timeoutMs) => new Promise((resolveChild, reject) => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: e2eEnvironment,
    stdio: "inherit",
    shell: false,
  });
  const timeout = setTimeout(() => {
    terminateProcessTree(child);
    reject(new Error(`${label} exceeded ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
  }, timeoutMs);

  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolveChild();
    } else {
      reject(new Error(`${label} exited with code ${code ?? "unknown"}.`));
    }
  });
});

let emulators;
let interrupted = false;

const stopOnSignal = () => {
  interrupted = true;
  terminateProcessTree(emulators);
};

process.once("SIGINT", stopOnSignal);
process.once("SIGTERM", stopOnSignal);

try {
  emulators = spawn(
    process.execPath,
    [
      firebaseCli,
      "emulators:start",
      "--project",
      E2E_PROJECT_ID,
      "--only",
      "auth,firestore",
    ],
    {
      cwd: process.cwd(),
      env: e2eEnvironment,
      stdio: "inherit",
      shell: false,
      detached: process.platform !== "win32",
    }
  );

  const emulatorSpawnError = new Promise((_, reject) => {
    emulators.once("error", reject);
  });
  await Promise.race([
    Promise.all([
      waitForPort(parseHost(E2E_AUTH_HOST), emulatorTimeoutMs),
      waitForPort(parseHost(E2E_FIRESTORE_HOST), emulatorTimeoutMs),
    ]),
    emulatorSpawnError,
  ]);

  if (updateSnapshots) {
    await runChild(process.execPath, [seedScript], "Firebase emulator seed", 60_000);
    await runChild(
      process.execPath,
      [playwrightCli, "test", "tests/e2e/visual.spec.ts", "--update-snapshots"],
      "Playwright visual baseline update",
      suiteTimeoutMs
    );
  } else {
    await runChild(process.execPath, [seedScript], "Firebase emulator seed", 60_000);
    await runChild(
      process.execPath,
      [playwrightCli, "test", "tests/e2e/visual.spec.ts"],
      "Playwright visual suite",
      suiteTimeoutMs
    );
    await runChild(process.execPath, [seedScript], "Firebase emulator reseed", 60_000);
    await runChild(
      process.execPath,
      [playwrightCli, "test", "tests/e2e/smoke.spec.ts"],
      "Playwright smoke suite",
      suiteTimeoutMs
    );
  }
} catch (error) {
  if (!interrupted) {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
} finally {
  terminateProcessTree(emulators);
  process.removeListener("SIGINT", stopOnSignal);
  process.removeListener("SIGTERM", stopOnSignal);
}
