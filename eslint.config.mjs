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
