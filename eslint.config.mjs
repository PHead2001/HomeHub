import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 ships native flat configs (no FlatCompat bridge needed).
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // New in eslint-config-next 16 (react-hooks v7, written for the React Compiler,
    // which this app does not use). They flag long-standing patterns such as setting
    // loading state inside data-fetching effects, not upgrade regressions. Reported as
    // warnings so they stay visible; converting those components is separate work.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  {
    // First-paint budget (H03): the root layout and the auth shell load for every
    // visitor, signed out included. They may only import the app and Auth
    // (`@/lib/firebase-app`); Firestore, Storage, Messaging, App Check and
    // `@/lib/firebase` load with a dynamic `import()` once a user is known, and
    // `motion` loads lazily. See docs/modules/firebase-platform/README.md.
    files: [
      "src/app/layout.tsx",
      "src/app/template.tsx",
      "src/contexts/auth-context.tsx",
      "src/lib/firebase-app.ts",
      "src/components/header.tsx",
      "src/components/command/command-center.tsx",
      "src/components/deferred-push-notification-manager.tsx",
      "src/components/PushNotificationManager.tsx",
      "src/components/motion/page-transition.tsx",
      "src/components/dashboard/time-of-day.tsx",
      "src/lib/dashboard/use-weather.ts",
      "src/components/password-change-handler.tsx",
      "src/components/login-dialog.tsx",
      "src/components/dashboard/dashboard-skeleton.tsx",
      "src/components/dashboard/tile-grid-skeleton.tsx",
      "src/components/dashboard/dashboard-loading.tsx",
      "src/lib/dashboard/tiles.ts",
      "src/lib/dashboard/house-layout.ts",
      "src/lib/auth/cached-session.ts",
      "src/lib/dashboard/house-snapshot.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@/lib/firebase", message: "Load it with a dynamic import() once a user is known (first-paint budget)." },
          { name: "firebase/firestore", message: "Load Firestore with a dynamic import() (first-paint budget)." },
          { name: "firebase/storage", message: "Load Storage with a dynamic import() (first-paint budget)." },
          { name: "firebase/messaging", message: "Load Messaging with a dynamic import() (first-paint budget)." },
          { name: "firebase/app-check", message: "App Check starts in @/lib/firebase, before Firestore and Storage." },
          { name: "@/lib/firestore-offline", message: "It imports Firestore; load it with a dynamic import()." },
          { name: "motion/react", message: "Load motion lazily (next/dynamic) on first-paint paths." },
        ],
        patterns: [{ group: ["**/lib/firebase", "./firebase", "../firebase"], message: "Use @/lib/firebase-app, or a dynamic import() of @/lib/firebase." }],
      }],
    },
  },
  globalIgnores([
    "playwright-report/**",
    "test-results/**",
    ".next/**",
    "functions/**",
    "next-env.d.ts",
    "src/functions/**",
    "node_modules/**",
    "tsconfig.tsbuildinfo",
  ]),
]);

export default eslintConfig;
