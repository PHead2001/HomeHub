import { defineConfig, devices } from "@playwright/test";

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const emulatorMode = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;

if (
  !emulatorMode
  || !projectId?.startsWith("demo-")
  || !loopbackHost.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || "")
  || !loopbackHost.test(process.env.FIRESTORE_EMULATOR_HOST || "")
  || !loopbackHost.test(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "")
) {
  throw new Error(
    "Playwright requires explicit Firebase emulator mode, a demo- project, and loopback Auth/Firestore emulator hosts."
  );
}

const baseURL = "http://127.0.0.1:9002";
const authFile = "playwright/.auth/e2e-owner.json";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.02,
    },
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
      NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "fake-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:
        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:
        process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
        process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "000000000000",
      NEXT_PUBLIC_FIREBASE_APP_ID:
        process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:000000000000:web:e2e",
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST:
        process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST
        || process.env.FIREBASE_AUTH_EMULATOR_HOST!,
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST:
        process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST
        || process.env.FIRESTORE_EMULATOR_HOST!,
      NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST:
        process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST
        || process.env.FIREBASE_STORAGE_EMULATOR_HOST!,
      // Registered wall tablets (docs/modules/devices/README.md, "Flags"): on for the
      // emulator suite so the device journeys run; production stays dark until both are
      // set deliberately. A test-only PIN pepper (not a secret: emulator data only).
      NEXT_PUBLIC_HOMEHUB_DEVICES: process.env.NEXT_PUBLIC_HOMEHUB_DEVICES ?? "true",
      HOMEHUB_DEVICES_ENABLED: process.env.HOMEHUB_DEVICES_ENABLED ?? "true",
      HOMEHUB_PIN_PEPPER_CURRENT: process.env.HOMEHUB_PIN_PEPPER_CURRENT ?? "E2E",
      HOMEHUB_PIN_PEPPER_E2E: process.env.HOMEHUB_PIN_PEPPER_E2E ?? "e2e-only-pin-pepper-not-a-secret-000000000",
    },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "desktop-chromium",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: authFile,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      use: {
        ...devices["Pixel 7"],
        storageState: authFile,
      },
    },
  ],
});
