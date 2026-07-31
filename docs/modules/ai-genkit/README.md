# AI and Genkit

## Purpose and Scope

This module owns shared Genkit configuration and HomeHub server flows. Calling feature modules own their UI, Firestore records, and interpretation of results.

## User-Facing Capabilities

- Categorize a shopping item against a supplied category list.
- Generate a recipe suggestion from pantry inventory.
- Summarize maintenance notes.
- Resolve a barcode through the household library and Open Food Facts.

## Entry Points

- `src/ai/genkit.ts`
- `src/ai/dev.ts`
- `src/ai/flows/categorize-grocery-item-flow.ts`
- `src/ai/flows/generate-recipe-flow.ts`
- `src/ai/flows/summarize-maintenance-log.ts`
- `src/ai/flows/lookup-barcode-flow.ts`
- `npm.cmd run genkit:dev`
- `npm.cmd run genkit:watch`

## Architecture and Data Flow

The shared `ai` instance registers the Google AI plugin and default `googleai/gemini-2.0-flash` model. Each flow defines Zod input/output schemas and exports a `"use server"` action. Shopping, pantry, maintenance, and barcode clients call those actions directly.

The barcode flow is registered with Genkit but performs Firestore/Open Food Facts lookup without invoking a generative model.

## Data Model and Persistence

The AI module does not own persisted result collections.

- Recipe and maintenance-summary outputs remain component state.
- Grocery categories are written only as part of shopping-item records by the Shopping module.
- Barcode lookup reads `households/{householdId}/barcode-library/{barcode}` but does not write it.

Flow-specific inferred input/output types are exported from each flow file; shared product record types live in `src/lib/types.ts`.

## Authentication, Roles, and Security

The exported server actions contain no explicit authenticated-user or permission check. Feature callers supply their inputs. The barcode flow accepts caller-supplied `householdId`; its Firestore access through the web client SDK depends on runtime Auth/rules behavior and falls back publicly when the read fails.

Do not put secret values in documentation. `GEMINI_API_KEY` is the only GenAI configuration name documented by `.env.example`.

## Integrations and Background Processing

- Google AI through `@genkit-ai/googleai`.
- Open Food Facts for barcode fallback.
- No AI Cloud Function or scheduled batch processing exists.
- Genkit development scripts load flows through `src/ai/dev.ts`.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) calls grocery categorization.
- [Pantry Inventory and Recipes](../pantry-recipes/README.md) calls recipe generation.
- [Maintenance Center](../maintenance-center/README.md) calls note summarization.
- [Barcode Library](../barcode-library/README.md) calls barcode lookup.
- [Firebase Platform](../firebase-platform/README.md) supplies Firestore client/config for barcode lookup.

## Invariants and Failure Behavior

- Categorization forces an `Other` fallback in the allowed category set.
- Recipe generation rejects fewer than two pantry items.
- Generated recipe and summary content is not persisted automatically.
- Barcode lookup returns no product for unknown/public failures and silently continues after household-library read errors.
- Model/API errors propagate to feature clients for toast/error handling.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after flow changes.
- Use the Genkit dev command for flow-level checks when credentials are available.
- Manually test schema rejection, model/network errors, one-versus-two-item recipes, allowed-category behavior, unknown barcodes, and authenticated household lookup.

## When This Document Must Be Updated

Update this README when model/plugin configuration, environment names, flow schemas/prompts/outputs, server authentication, persistence of results, external APIs, or calling modules change.
