# AI and Genkit

## Purpose and Scope

This module owns shared Genkit/OpenAI configuration, model-backed task execution, exposed AI server actions, safe provider errors, and deterministic emulator behavior. Calling feature modules own their UI, Firestore records, and interpretation or persistence of results.

Barcode lookup is an authenticated model-free server action owned jointly with the Barcode Library module. It does not require OpenAI configuration.

## User-Facing Capabilities

- Categorize a shopping item against a supplied category list.
- Generate a recipe suggestion from pantry inventory.
- Summarize maintenance notes without changing the original log.
- Generate a permission-filtered dashboard overview from exact server-calculated facts.
- Resolve a barcode through the household library and Open Food Facts without calling OpenAI.

## Entry Points

- `src/ai/genkit.ts`
- `src/ai/model-config.ts`
- `src/ai/structured-generation.ts`
- `src/ai/system-instruction.ts`
- `src/ai/action-auth.ts`
- `src/ai/household-authority.ts`
- `src/ai/overview-facts.ts`
- `src/ai/overview-types.ts`
- `src/ai/tasks/*`
- `src/ai/flows/*`
- `src/ai/dev.ts`
- `tests/ai/deterministic-flows.test.ts`
- `tests/e2e/ai-openai.spec.ts`
- `tests/e2e/ai-hardening.spec.ts`
- `scripts/ai/openai-live-smoke.ts`
- `npm.cmd run genkit:dev`
- `npm.cmd run test:ai`
- `npm.cmd run test:ai:openai:live`

## Architecture and Data Flow

`src/ai/genkit.ts` registers `@genkit-ai/compat-oai/openai` only when `OPENAI_API_KEY` exists. The plugin reads the key from the server environment; application code never passes or exposes its value. Model names are resolved centrally in `src/ai/model-config.ts`.

Each model capability has an internal Genkit `defineFlow` under `src/ai/tasks/`. Public `"use server"` actions under `src/ai/flows/` verify Firebase identity and permissions before invoking those tasks. `src/ai/structured-generation.ts` supplies the shared `HOMEHUB_AI_SYSTEM_INSTRUCTION` through Genkit's explicit `system` field, keeps task instructions separate, serializes bounded household input inside an untrusted-data delimiter, applies per-flow timeouts/output limits, validates Zod structured output, and logs only flow/model/duration/outcome metadata.

The homepage overview first uses Firebase Admin to aggregate a bounded facts object from only collections allowed by the caller's effective permissions. Personal chore facts include only assignments to the verified token email. Exact metrics are rendered by the client independently of the optional narrative. The model receives no database handle, credentials, member identifiers, raw documents, Home Assistant credentials, arbitrary routes, or data from omitted sections. Overview output section references are filtered against supplied fact keys and route links come from application-owned mappings.

The OpenAI plugin is configured with no automatic retries. The compatibility plugin uses OpenAI JSON response mode while Genkit validates the response against the existing Zod output schema. Missing or malformed output is rejected rather than coerced.

## Data Model and Persistence

This module owns no persisted result collection.

- Recipe and maintenance-summary outputs remain component state.
- Grocery categories are persisted only as part of Shopping item writes.
- Barcode lookup reads `households/{householdId}/barcode-library/{barcode}` and does not write it.
- Overview facts and narrative are transient component state and are not written to Firestore.

Input limits include 120-character grocery names, at most 60 recipe inventory items, and 8,000-character maintenance notes. Output schemas also bound titles, summaries, ingredient lists, and instruction lengths.

## Authentication, Roles, and Security

Protected clients send the current Firebase ID token and household ID to the server action. Firebase Admin derives UID/email from the verified token, loads `households/{householdId}` and `members/{uid}`, rejects missing/pending/`newuser` membership, and applies member-document role presets and overrides. If the member document is absent, household owner UID/email evidence alone grants owner; another legacy `memberEmails` entry receives normal member permissions with no authority inherited from `users/{email}`.

- Categorization requires `shopping.edit`.
- Recipe generation requires `shopping.view`.
- Maintenance summaries require `maintenance.view`.
- Dashboard overview requires `household.view`, then independently gates every fact section by its module permission.
- Barcode lookup requires `shopping.view` before either Admin Firestore or Open Food Facts is accessed.

Per-instance request guards reject overlapping calls for the same user/household/flow and apply a bounded one-minute request window. This prevents ordinary duplicate UI submissions but is not a distributed quota system across multiple App Hosting instances.

Admin SDK reads occur only after this authorization result exists. Altered household IDs fail before aggregation, model generation, or Open Food Facts fallback.

## Integrations and Background Processing

- OpenAI through `@genkit-ai/compat-oai/openai`.
- Default and per-flow model variables: `OPENAI_DEFAULT_MODEL=gpt-5.6-luna`, `OPENAI_CATEGORIZATION_MODEL=gpt-5.6-luna`, `OPENAI_RECIPE_MODEL=gpt-5.6-terra`, `OPENAI_MAINTENANCE_MODEL=gpt-5.6-luna`, and `OPENAI_OVERVIEW_MODEL=gpt-5.6-luna`. Overview alone sends `reasoning_effort: medium` through the OpenAI-compatible passthrough config.
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
- Overview provider configuration, 429, timeout, unavailable, refusal, or malformed output returns the already-calculated facts with a sanitized AI status; authentication and database failures remain action failures.
- Prompt injection is reduced through authorization, data minimization, one explicit system instruction, structured untrusted-data boundaries, schemas, bounded output, and post-validation. Household text is never treated as trusted instructions; this is defense in depth, not a claim that prompt injection is impossible.

## Validation

- Run `npm.cmd run test:ai` for deterministic task success and failure contracts.
- Run `npm.cmd run test:e2e:ai:local` for authenticated desktop/mobile Shopping, recipe, maintenance-summary, overview, barcode, partial-permission, and cross-household workflows.
- Run `npm.cmd run test:rules` for emulator-only module permissions and Household A/B isolation.
- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build` after AI changes.
- Run `npm.cmd run test:ai:openai:live` only with a replacement key securely loaded into the environment; it is the only provider-live validation command.
- Manually verify server denial for unauthenticated, pending, cross-household, and insufficient-permission callers before changing authorization behavior.

## When This Document Must Be Updated

Update this README when provider/plugin configuration, model variables, secret loading, flow schemas/prompts/outputs, timeouts, error contracts, authorization, rate limits, deterministic scenarios, persistence, external APIs, or calling modules change.
