# AI and Genkit

## Purpose and Scope

This module owns shared Genkit/OpenAI configuration, model-backed task execution, exposed AI server actions, safe provider errors, and deterministic emulator behavior. Calling feature modules own their UI, Firestore records, and interpretation or persistence of results.

Barcode lookup remains registered as a Genkit flow but is model-free. It does not require OpenAI configuration.

## User-Facing Capabilities

- Categorize a shopping item against a supplied category list.
- Generate a recipe suggestion from pantry inventory.
- Summarize maintenance notes without changing the original log.
- Resolve a barcode through the household library and Open Food Facts without calling OpenAI.

## Entry Points

- `src/ai/genkit.ts`
- `src/ai/model-config.ts`
- `src/ai/structured-generation.ts`
- `src/ai/action-auth.ts`
- `src/ai/tasks/*`
- `src/ai/flows/*`
- `src/ai/dev.ts`
- `tests/ai/deterministic-flows.test.ts`
- `tests/e2e/ai-openai.spec.ts`
- `scripts/ai/openai-live-smoke.ts`
- `npm.cmd run genkit:dev`
- `npm.cmd run test:ai`
- `npm.cmd run test:ai:openai:live`

## Architecture and Data Flow

`src/ai/genkit.ts` registers `@genkit-ai/compat-oai/openai` only when `OPENAI_API_KEY` exists. The plugin reads the key from the server environment; application code never passes or exposes its value. Model names are resolved centrally in `src/ai/model-config.ts`.

Each model capability has an internal Genkit `defineFlow` under `src/ai/tasks/`. Public `"use server"` actions under `src/ai/flows/` verify Firebase identity and permissions before invoking those tasks. `src/ai/structured-generation.ts` applies per-flow timeouts, output limits, Zod structured-output validation, deterministic emulator responses, sanitized errors, and safe diagnostics containing only flow, model, duration, and outcome.

The OpenAI plugin is configured with no automatic retries. The compatibility plugin uses OpenAI JSON response mode while Genkit validates the response against the existing Zod output schema. Missing or malformed output is rejected rather than coerced.

## Data Model and Persistence

This module owns no persisted result collection.

- Recipe and maintenance-summary outputs remain component state.
- Grocery categories are persisted only as part of Shopping item writes.
- Barcode lookup reads `households/{householdId}/barcode-library/{barcode}` and does not write it.

Input limits include 120-character grocery names, at most 60 recipe inventory items, and 8,000-character maintenance notes. Output schemas also bound titles, summaries, ingredient lists, and instruction lengths.

## Authentication, Roles, and Security

Model-backed clients send the current Firebase ID token and household ID to the server action. Firebase Admin verifies the token, loads `households/{householdId}`, `households/{householdId}/members/{uid}`, and `users/{email}`, supports legacy `households.memberEmails`, rejects pending `newuser` membership, and applies existing role presets plus permission overrides.

- Categorization requires `shopping.edit`.
- Recipe generation requires `shopping.view`.
- Maintenance summaries require `maintenance.view`.

Per-instance request guards reject overlapping calls for the same user/household/flow and apply a bounded one-minute request window. This prevents ordinary duplicate UI submissions but is not a distributed quota system across multiple App Hosting instances.

The model-free barcode action still accepts caller-supplied `householdId` and uses the Firebase web SDK. It does not spend OpenAI quota; its private-library server authentication limitation is documented in the Barcode module.

## Integrations and Background Processing

- OpenAI through `@genkit-ai/compat-oai/openai`.
- Default and per-flow model variables: `OPENAI_DEFAULT_MODEL=gpt-5.6-luna`, `OPENAI_CATEGORIZATION_MODEL=gpt-5.6-luna`, `OPENAI_RECIPE_MODEL=gpt-5.6-terra`, and `OPENAI_MAINTENANCE_MODEL=gpt-5.6-luna`. Server environment values can override each fallback independently.
- `OPENAI_API_KEY` is server-only. App Hosting maps it to Secret Manager secret `openaiApiKey` at runtime.
- `HOMEHUB_AI_TEST_MODE=deterministic` works only with the exact demo emulator project, loopback Auth/Firestore hosts, and non-production Node environment.
- Open Food Facts is used only by barcode lookup.
- No AI Cloud Function or scheduled batch processing exists.

The manual live smoke command uses fixed non-sensitive inputs and runs the three internal model tasks. It is not part of CI and refuses CI execution unless `RUN_OPENAI_LIVE_SMOKE=true` is explicitly supplied.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) calls grocery categorization.
- [Pantry Inventory and Recipes](../pantry-recipes/README.md) calls recipe generation.
- [Maintenance Center](../maintenance-center/README.md) calls note summarization.
- [Barcode Library](../barcode-library/README.md) owns model-free barcode behavior.
- [Firebase Platform](../firebase-platform/README.md) supplies Admin credentials, membership records, emulator safety, and App Hosting configuration.

## Invariants and Failure Behavior

- OpenAI credentials never enter client bundles or flow inputs.
- A manually selected Shopping category bypasses AI. Automatic failure, timeout, rate limit, invalid output, or configuration failure still saves exactly one item under `Other`.
- Categorization accepts only a supplied category and adds `Other` without mutating caller input.
- Recipe generation rejects fewer than two inventory items and does not persist results.
- Maintenance summaries do not overwrite notes or persist automatically.
- Provider configuration, timeout, rate limit, refusal, malformed output, authentication, and permission failures return sanitized application errors.
- No normal lint, build, CI, emulator, E2E, or visual command makes a paid OpenAI request.
- Missing `OPENAI_API_KEY` does not break builds; a live model action returns a configuration error.
- Barcode lookup neither invokes OpenAI nor requires its key.

## Validation

- Run `npm.cmd run test:ai` for deterministic task success and failure contracts.
- Run `npm.cmd run test:e2e:ai:local` for authenticated desktop/mobile Shopping, recipe, maintenance-summary, and barcode workflows.
- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build` after AI changes.
- Run `npm.cmd run test:ai:openai:live` only with a replacement key securely loaded into the environment; it is the only provider-live validation command.
- Manually verify server denial for unauthenticated, pending, cross-household, and insufficient-permission callers before changing authorization behavior.

## When This Document Must Be Updated

Update this README when provider/plugin configuration, model variables, secret loading, flow schemas/prompts/outputs, timeouts, error contracts, authorization, rate limits, deterministic scenarios, persistence, external APIs, or calling modules change.
