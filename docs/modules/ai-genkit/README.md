# AI and OpenAI

The folder keeps its historical `ai-genkit` slug; Genkit was removed in favour of direct calls through the official `openai` SDK.

## Purpose and Scope

This module owns the shared OpenAI client and configuration, model-backed task execution, exposed AI server actions, safe provider errors, and deterministic emulator behavior. Calling feature modules own their UI, Firestore records, and interpretation or persistence of results.

Barcode lookup is an authenticated model-free server action owned jointly with the Barcode Library module. It does not require OpenAI configuration.

## User-Facing Capabilities

- Categorize a shopping item against a supplied category list.
- Generate a recipe suggestion from pantry inventory.
- Summarize maintenance notes without changing the original log.
- Generate a permission-filtered dashboard overview from exact server-calculated facts (shown as the AI rewrite of the dashboard's morning brief, on demand).
- Read a command-palette quick-add sentence the deterministic parser could not read, into one structured, previewable intent (no writes).
- Resolve a barcode through the household library and Open Food Facts without calling OpenAI.

## Entry Points

- `src/ai/openai-client.ts`
- `src/ai/model-config.ts`
- `src/ai/structured-generation.ts`
- `src/ai/strict-output-schema.ts`
- `src/ai/system-instruction.ts`
- `src/ai/action-auth.ts`
- `src/ai/household-authority.ts`
- `src/ai/overview-facts.ts`
- `src/ai/overview-types.ts`
- `src/ai/tasks/*`
- `src/ai/flows/*`
- `tests/ai/deterministic-flows.test.ts`
- `tests/ai/parse-command.test.ts`
- `tests/unit/ai-strict-schema.test.ts`
- `tests/unit/ai-openai-provider.test.ts`
- `tests/e2e/ai-openai.spec.ts`
- `tests/e2e/ai-hardening.spec.ts`
- `scripts/ai/openai-live-smoke.ts`
- `npm.cmd run test:ai`
- `npm.cmd run test:ai:openai:live`

## Architecture and Data Flow

`src/ai/openai-client.ts` creates one `openai` SDK client (`maxRetries: 0`, 30-second client timeout) on first use, and only when `OPENAI_API_KEY` exists. The SDK reads the key from the server environment; application code never passes or exposes its value. Model names are resolved centrally in `src/ai/model-config.ts`.

Each model capability is a plain exported async function under `src/ai/tasks/` (`parseCommandFlow`, `categorizeGroceryItemFlow`, `generateRecipeFlow`, `summarizeMaintenanceLogFlow`, `generateHomeOverviewNarrativeFlow`). Each validates its input with its Zod schema first (a failure is `invalid_input` and no model call happens), then calls `generateStructured`, then validates its final output. Public `"use server"` actions under `src/ai/flows/` verify Firebase identity and permissions before invoking those tasks. `src/ai/structured-generation.ts` sends one Chat Completions request with the shared `HOMEHUB_AI_SYSTEM_INSTRUCTION` as the `system` message and the task instruction plus the bounded household input (inside an untrusted-data delimiter) as the `user` message. It applies per-flow timeouts through an abort signal, `max_completion_tokens` and (overview only) `reasoning_effort`, validates structured output with Zod, and logs only flow/model/duration/outcome metadata. Token usage is returned as `{ inputTokens, outputTokens, totalTokens }`.

The homepage overview first uses Firebase Admin to aggregate a bounded facts object from only collections allowed by the caller's effective permissions. Personal chore facts include only assignments to the verified token email. Exact metrics are rendered by the client independently of the optional narrative. The model receives no database handle, credentials, member identifiers, raw documents, Home Assistant credentials, arbitrary routes, or data from omitted sections. Overview output section references are filtered against supplied fact keys and route links come from application-owned mappings.

### Structured output: strict JSON schema

Every request uses `response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } }`, so OpenAI constrains decoding to the schema. `src/ai/strict-output-schema.ts` builds that schema from the task's Zod output schema with zod 4's `z.toJSONSchema` (input view) and rewrites it to the strict-mode subset:

- Every object lists all its properties in `required` and has `additionalProperties: false`.
- An optional or defaulted property (for example the overview's `sectionSummaries`, which defaults to `{}`) is sent as required but nullable (`anyOf: [schema, { type: 'null' }]`); a `null` from the model is removed again before parsing, so the default applies.
- The overview's `sectionSummaries` record (`z.partialRecord` keyed by section) is sent as an object with one required, nullable string per section; `null` entries are removed before parsing.
- `$schema` and `default` are dropped; bounds such as `minLength`, `maxLength`, `minItems` and `maxItems` are kept. Constructs strict mode cannot express (free-form records, `oneOf`/`allOf`, tuples, conditionals) throw at conversion time, and `tests/unit/ai-strict-schema.test.ts` converts every flow's output schema, so a new schema fails in unit tests rather than in production. The deterministic provider runs the same conversion and decode, so emulator E2E exercises it too.

Strict mode with nullable wire fields was chosen over non-strict `json_schema` because strict mode guarantees schema-shaped JSON (non-strict only guides the model), and every current output schema can be represented exactly once optional fields are nullable. `outputSchema.parse` on the decoded value remains the final gate, so trimming and every bound are still enforced in application code. Under Genkit the schema was described in prompt text and JSON was extracted from free text, because Genkit did not recognize the `gpt-5.6-*` model names as supporting constrained output; the prompt no longer carries that schema text.

Response handling: a `refusal` or `finish_reason: 'content_filter'` is `refused`; no choice, `finish_reason: 'length'` (or any other non-`stop` finish), empty content, unparseable JSON, or output that fails the Zod schema is `invalid_response`. `normalizeAiError` maps SDK errors by class: `RateLimitError` (429) is `rate_limited`; `AuthenticationError`/`PermissionDeniedError` (401/403) and `NotFoundError` with code `model_not_found` are `configuration`; `BadRequestError` (400) is `invalid_input`, as under Genkit; `APIConnectionTimeoutError` and `APIUserAbortError` (the per-flow abort) are `timeout`; connection errors, 5xx and every other status are `unavailable`. Missing or malformed output is rejected rather than coerced.

### Command palette reader (`parse-command`)

`src/ai/tasks/parse-command.ts` (`parseCommandFlow`, flow name `command-parse`, model `openAiModels.default`, 8 s timeout, 400 output tokens) is the AI fallback for the palette's quick add ([Application Shell](../application-shell/README.md)). The public action is `parseCommand` in `src/ai/flows/parse-command-flow.ts`. Input (`ParseCommandInputSchema`): the sentence (2-200 characters), today's date, and display names (at most 80 characters each) paired with opaque references: members `m1…` (30), rooms `r1…` (60), pets `p1…` (30), lists `l1…` (30), vehicles `v1…` (20). No emails, document ids or other fields are sent; the client resolves references back (`src/lib/dashboard/quick-add-ai.ts`). Output (`ParseCommandOutputSchema`, strict-schema compatible): `kind` (`chore`, `maintenance`, `shopping`, `feeding` or `none`) and the one matching optional object (chore task, due date, repeat, assignee and room refs; maintenance title, mileage, vehicle ref; shopping items and list ref; feeding pet ref, amount and unit). `sanitizeParseCommandOutput` then keeps only kinds the caller's verified permissions allow, drops unknown references (an unknown pet makes it `none`), invalid calendar dates and repeats without their day, any part other than the chosen kind's, and a mileage whose digits are not in the member's own sentence. The model never writes: the palette shows the result as a preview and writes only on Confirm, through the same document shapes as the module screens.

## Data Model and Persistence

This module owns no persisted result collection.

- Recipe and maintenance-summary outputs remain component state.
- Grocery categories are persisted only as part of Shopping item writes.
- Barcode lookup reads `households/{householdId}/barcode-library/{barcode}` and does not write it.
- Overview facts and narrative are transient component state and are not written to Firestore.
- The palette reader's answer is transient; only a write the member confirms is stored (by the owning module's document contract).

Input limits include 120-character grocery names, at most 60 recipe inventory items, and 8,000-character maintenance notes. Output schemas also bound titles, summaries, ingredient lists, and instruction lengths.

## Authentication, Roles, and Security

Protected clients send the current Firebase ID token and household ID to the server action. Firebase Admin derives UID/email from the verified token, loads `households/{householdId}` and `members/{uid}`, rejects missing/pending/`newuser` membership, and applies member-document role presets and overrides. The approved member record is the only authority: without one (including legacy `memberEmails`, owner email/UID fields or `users/{email}` role data) the request is rejected.

- Categorization requires `shopping.edit`.
- Recipe generation requires `shopping.view`.
- Maintenance summaries require `maintenance.view`.
- Dashboard overview requires `household.view`, then independently gates every fact section by its module permission.
- The palette reader requires at least one of `chores.create`, `maintenance.createLogs`, `shopping.edit` or `pets.addLogs` (`executeAuthorizedAiAction` and `authorizeHouseholdAction` accept a list meaning any one; an empty list grants nothing), and the model may only answer with the kinds those permissions allow. It takes one daily AI request and allows 20 requests per minute per member.
- Barcode lookup requires `shopping.view` before either Admin Firestore or Open Food Facts is accessed.

Per-instance request guards reject overlapping calls for the same user/household/flow and apply a bounded one-minute request window, which stops duplicate UI submissions. A durable daily quota (`src/lib/server/ai-quota.ts`) caps spend across all App Hosting instances: after authorization, each AI request takes one unit from the caller's per-UTC-day counter (`AI_DAILY_USER_LIMIT`, default 150) and the household's (`AI_DAILY_HOUSEHOLD_LIMIT`, default 400) in one Firestore transaction, so concurrent requests cannot overshoot and a refused request is not counted. Reaching either limit returns `quota_exceeded` ("You've used today's AI requests. They reset at midnight UTC."). Barcode lookup never calls a model (household library, then Open Food Facts), so it neither takes nor needs quota. The dashboard overview takes its unit only for the AI narrative, so exact facts stay available with a "used up" note; categorization still saves the item under `Other`. Counters live in server-only `aiUsage/{user|household}_{id}_{day}` documents (per-flow counts in `byFlow`) that rules deny to every client and a TTL policy on `aiUsage.expiresAt` removes three days after the day ends.

Admin SDK reads occur only after this authorization result exists. Altered household IDs fail before aggregation, model generation, or Open Food Facts fallback.

## Integrations and Background Processing

- OpenAI Chat Completions through the official `openai` npm package (7.x), with strict structured outputs.
- Default and per-flow model variables: `OPENAI_DEFAULT_MODEL=gpt-6-luna`, `OPENAI_CATEGORIZATION_MODEL=gpt-6-luna`, `OPENAI_RECIPE_MODEL=gpt-6.1-terra`, `OPENAI_MAINTENANCE_MODEL=gpt-6-luna`, and `OPENAI_OVERVIEW_MODEL=gpt-6-luna`. Overview alone sends `reasoning_effort: medium`.
- `OPENAI_API_KEY` is server-only. App Hosting maps it to Secret Manager secret `openaiApiKey` at runtime.
- Deterministic `command-parse`: a 4-7 digit reading is a maintenance log for the first supplied vehicle; a weekday name is a weekly chore for a member the text names (otherwise an unknown reference, which the sanitizer drops); `ai-test:invented-mileage` returns a mileage the text lacks, to prove it is dropped; anything else is `none`.
- `HOMEHUB_AI_TEST_MODE=deterministic` works only with the exact demo emulator project, loopback Auth/Firestore hosts, and non-production Node environment.
- Open Food Facts is used only by barcode lookup.
- No AI Cloud Function or scheduled batch processing exists.

The manual live smoke command uses fixed non-sensitive inputs and runs the three internal model tasks. It is not part of CI and refuses CI execution unless `RUN_OPENAI_LIVE_SMOKE=true` is explicitly supplied.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) calls grocery categorization.
- [Application Shell](../application-shell/README.md) calls the overview (the brief's sparkle) and the palette reader.
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

- Dependencies: `openai` and `zod` 4 (4.6.6 or later). Genkit (`genkit`, `@genkit-ai/compat-oai`, `@genkit-ai/next`, `genkit-cli`) and its developer UI (`src/ai/dev.ts`, `genkit:dev`/`genkit:watch`) were removed on 2026-11-06. That closed the zod 3 memory-exhaustion advisory ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)) that Genkit's `zod ^3` pin kept open, the `openai` 4.x advisory chain (reported only for its zod 3 dependency) and Genkit's OpenTelemetry 1.x `JaegerPropagator` advisory. `npm ls zod` shows only zod 4. The root `protobufjs` and `@grpc/grpc-js` overrides stay for Firebase's own dependencies (see the [Firebase Platform README](../firebase-platform/README.md)).
- Payload cap (defense in depth): `executeAuthorizedAiAction` rejects any client payload (context + input) whose size, roughly its JSON size, exceeds `MAX_AI_ACTION_PAYLOAD_BYTES` (64 KB) with `invalid_input`, before authorization or any schema validation; real inputs are a few KB. The size comes from `exceedsPayloadBudget`, a bounded walk that stops as soon as the budget is passed, so its work is capped by the budget even for shared references or cycles (which Server Actions can transport); it never builds the JSON string. Then come Firebase identity and household permission checks, the per-minute rate limit and the daily quota, and only then does the task validate its input. Next.js's 1 MB server-action body limit is the outer bound. `tests/server/ai-payload-limit.test.ts` covers the cap and its ordering.

## Validation

- Run `npm.cmd run test:ai` for deterministic task success and failure contracts (`tests/ai/parse-command.test.ts` covers the palette reader: strict-schema conversion, references, allowed kinds, invented mileage, input validation and provider failures).
- Run `npm.cmd run test:unit` for the strict-schema conversion of every flow output schema and the OpenAI provider contract (request body, response handling, SDK error mapping) against a stubbed `fetch`; it never reaches the network.
- Run `npm.cmd run test:e2e:ai:local` for authenticated desktop/mobile Shopping, recipe, maintenance-summary, overview, barcode, partial-permission, and cross-household workflows.
- Run `npm.cmd run test:rules` for emulator-only module permissions and Household A/B isolation.
- Run `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build` after AI changes.
- Run `npm.cmd run test:ai:openai:live` only with a replacement key securely loaded into the environment; it is the only provider-live validation command. Local development uses the app itself (`npm.cmd run dev`) or this smoke command; there is no separate AI developer UI.
- Manually verify server denial for unauthenticated, pending, cross-household, and insufficient-permission callers before changing authorization behavior.

## When This Document Must Be Updated

Update this README when provider/SDK configuration, the strict-schema conversion, model variables, secret loading, flow schemas/prompts/outputs, timeouts, error contracts, authorization, rate limits, deterministic scenarios, persistence, external APIs, or calling modules change.
