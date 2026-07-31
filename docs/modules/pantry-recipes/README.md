# Pantry Inventory and Recipes

## Purpose and Scope

This module owns household pantry, refrigerator, and freezer inventory plus recipe suggestions generated from that inventory. It does not own shopping-list records, barcode mappings, or the shared Genkit configuration.

## User-Facing Capabilities

- Use the Inventory tab on `/shopping`.
- Add, edit, delete, and bulk-delete inventory items.
- Track quantity, unit, storage location, and an optional expiration date.
- Start an inventory item from a barcode scan.
- Move a deleted inventory item back to a selected shopping list.
- Generate a recipe suggestion from the currently loaded inventory.
- Accept purchased grocery items into the pantry form through the shopping workflow.

## Entry Points

- `src/app/shopping/page.tsx`
- `src/components/shopping-center-client.tsx`
- `src/components/pantry-inventory-client.tsx`
- `src/ai/flows/generate-recipe-flow.ts`
- Shared types in `src/lib/types.ts`

## Architecture and Data Flow

`ShoppingCenterClient` hosts the inventory tab and passes shopping-list context into `PantryInventoryClient`. The inventory client reads and writes household-scoped Firestore documents. Recipe generation sends the loaded items as `{name, quantity, unit}` to the Genkit server action and keeps the result only in component state.

Deleting an item and adding it back to a shopping list are separate operations: the inventory document is deleted before the shopping write begins.

## Data Model and Persistence

- Firestore: `households/{householdId}/pantry-inventory/{itemId}`.
- New item IDs are slugified from the item name.
- `PantryItem` in `src/lib/types.ts` defines `id`, `name`, `quantity`, `unit`, `location`, and optional nullable ISO `expiryDate`.
- `PantryItemUnit`, `pantryItemUnitCategories`, and `PantryItemLocation` define supported units and locations.
- Recipe results are not persisted.

Writes use `setDoc(..., { merge: true })`. Editing an item's name does not rename its existing Firestore document ID.

## Authentication, Roles, and Security

The UI requires an authenticated user and derives `householdId` from `useAuth`. Firestore access is covered by the approved-household-member fallback rule in `firestore.rules`; pending `newuser` members are excluded and legacy `households.memberEmails` membership is supported.

The `shopping.view`, `shopping.edit`, and `shopping.delete` permissions exist in `src/lib/permissions.ts`, but the broad Firestore subcollection rule does not enforce the edit/delete permissions and this feature does not gate each mutation with them. Treat role-level mutation restrictions as incomplete until both UI and rules enforce them.

## Integrations and Background Processing

- `generateRecipe` in `src/ai/flows/generate-recipe-flow.ts` uses the shared Genkit Google AI model and `GEMINI_API_KEY`.
- `BarcodeScanner` supplies scanned product data through the barcode module.
- There are no Cloud Functions, scheduled jobs, or persisted recipe records for this module.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) supplies list context and the purchased-item handoff.
- [Barcode Library](../barcode-library/README.md) supplies scanned names and images.
- [AI and Genkit](../ai-genkit/README.md) owns model configuration and flow execution.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply the current user and household.
- [Firebase Platform](../firebase-platform/README.md) owns client initialization and security rules.

## Invariants and Failure Behavior

- Recipe generation rejects fewer than two inventory items, although the UI button can be enabled with one.
- Invalid or missing Firestore dates are handled defensively for display.
- A failed recipe request leaves inventory unchanged and reports an error toast.
- Delete-and-return-to-shopping is not atomic; a shopping failure can occur after inventory deletion.
- Slug-derived IDs can collide for names that normalize to the same slug.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test inventory CRUD, bulk deletion, expiration display, units and locations, barcode intake, purchased-item intake, and return-to-list behavior.
- Test recipe generation with zero, one, two, and many items plus an AI/network failure.
- Verify a user cannot read another household's inventory.

## When This Document Must Be Updated

Update this README when inventory fields or paths, recipe inputs/outputs, shopping handoffs, barcode intake, permission enforcement, AI configuration, or inventory failure/cleanup behavior changes.
