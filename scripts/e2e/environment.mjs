import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const E2E_PROJECT_ID = "demo-homehub-e2e";
export const E2E_AUTH_HOST = "127.0.0.1:9099";
export const E2E_FIRESTORE_HOST = "127.0.0.1:8080";
export const E2E_STORAGE_HOST = "127.0.0.1:9199";

const findWindowsJavaBin = () => {
  if (process.platform !== "win32") return null;

  for (const root of [
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Microsoft",
  ]) {
    if (!existsSync(root)) continue;
    const javaExecutables = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "bin", "java.exe"))
      .filter(existsSync)
      .sort()
      .reverse();
    if (javaExecutables[0]) return dirname(javaExecutables[0]);
  }

  return null;
};

const windowsJavaBin = findWindowsJavaBin();

export const e2eEnvironment = {
  ...process.env,
  ...(windowsJavaBin ? {
    JAVA_HOME: dirname(windowsJavaBin),
    PATH: `${windowsJavaBin};${process.env.PATH || ""}`,
  } : {}),
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: E2E_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_API_KEY: "fake-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${E2E_PROJECT_ID}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${E2E_PROJECT_ID}.appspot.com`,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:000000000000:web:e2e",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: E2E_AUTH_HOST,
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: E2E_FIRESTORE_HOST,
  NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: E2E_STORAGE_HOST,
  FIREBASE_AUTH_EMULATOR_HOST: E2E_AUTH_HOST,
  FIRESTORE_EMULATOR_HOST: E2E_FIRESTORE_HOST,
  FIREBASE_STORAGE_EMULATOR_HOST: E2E_STORAGE_HOST,
  GCLOUD_PROJECT: E2E_PROJECT_ID,
  FIREBASE_CONFIG: JSON.stringify({ projectId: E2E_PROJECT_ID }),
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: "true",
  HOMEHUB_AI_TEST_MODE: "deterministic",
};

export const runCommand = (command, args, options = {}) => {
  const { spawnSync } = options.spawnModule;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || e2eEnvironment,
    stdio: "inherit",
    shell: options.shell ?? process.platform === "win32",
    timeout: options.timeoutMs,
  });

  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
};
