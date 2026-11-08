# Pantry Inventory and Recipes

## Purpose and Scope

This module owns household pantry, refrigerator, and freezer inventory plus recipe suggestions generated from that inventory. It does not own shopping-list records, barcode mappings, or the shared OpenAI configuration.

## User-Facing Capabilities

- Use the Pantry Inventory tab on `/shopping` (linkable as `/shopping?tab=pantry`).
- See the pantry as shelves (default): Pantry, Fridge and Freezer are shelves of item tiles showing a product photo from the barcode library (matched by exact name) or a food emoji. Items expiring within three days glow amber, expired items fade and tilt, freezer tiles have a frost edge, and the header counts what is expiring soon or expired.
- Move an item to another shelf by dragging its handle (mouse or touch), by keyboard (focus the handle, Enter or Space to pick up, arrow keys to choose a shelf, Enter or Space to drop, Escape to cancel), by tapping the handle and then **Move here** on a shelf, or from the tile's ⋯ menu.
- Switch to the list view (the previous table on wider screens and stacked rows on phones); the choice is remembered per device in `localStorage["homehub.pantry.view"]`.
- Add, edit, delete, and bulk-delete inventory items (bulk delete is in the list view).
- Track quantity, unit, storage location, and an optional expiration date.
- Start an inventory item from a barcode scan.
- Move a deleted inventory item back to a selected shopping list.
- Generate a recipe suggestion from the currently loaded inventory (H08 recipe reveal). The dialog opens with a loading state; when the recipe arrives in the shelves view and it uses tiles, the dialog and its scrim fade out (150 ms) so the shelves are visible, the used tiles lift off their shelves (the tile card and picture rise 8 px in 200 ms; the controls' hit areas stay put) with an "In the recipe" marker, the first lifted tile is scrolled into view, and after 450 ms (or at once on any key or pointer press) the dialog returns and the recipe card flips in (220 ms). In the list view, with no matching tiles, or under reduced motion, the tiles are marked and the card shows at once with no flip. Screen readers hear a short "Lifting the items…" status, and focus stays in the dialog throughout. The marker stays until the next generation.
- Shelf item counts, the expiring/expired header counts and the list view's shelf counts tick with the shared `NumberTicker` (`animateOnMount={false}`; one text node holding the final value, so "Pantry (3)" always reads exactly that), and each shelf's tiles enter with the shared `Stagger` (instant under reduced motion).
- Receive purchased grocery items in one batch from the shopping trip (see [Shopping](../shopping/README.md)); there is no longer a per-item pantry form after ticking.

## Entry Points

- `src/app/shopping/page.tsx`
- `src/components/shopping-center-client.tsx`
- `src/components/pantry-inventory-client.tsx`
- `src/components/shopping/pantry-shelves.tsx`
- `src/lib/shopping/pantry.ts` (shelf, expiry, emoji, recipe-matching and handoff planning helpers)
- `src/lib/shopping/pantry-writes.ts` (batch handoff writer)
- `src/ai/flows/generate-recipe-flow.ts`
- Shared types in `src/lib/types.ts`

## Architecture and Data Flow

`ShoppingCenterClient` hosts the inventory tab; `PantryInventoryClient` takes no props. The inventory client reads and writes household-scoped Firestore documents. Recipe generation sends only loaded `{name, quantity, unit}` values plus a Firebase ID token to the AI server action and keeps the result only in component state. The server verifies household membership and `shopping.view` before requesting OpenAI.

The dashboard overview uses the same verified `shopping.view` boundary to calculate inventory and expiration counts server-side. It sends only bounded labels/dates and counts to the optional narrative, not full inventory documents.

Inventory reads use `getDocsOfflineAware`. The shelves view renders `PantryShelves`; moving a tile updates only `location` (optimistic, through Firestore's queue; a rejected write shows a `toastError` and re-reads). Product photos come from one read of `barcode-library`; a failure there only drops photos. The recipe dialog composes the shared dialog parts (`DialogPortal`, `DialogOverlay`, Radix `Content`) itself, only so the scrim can step aside during the lift; it keeps the standard dialog markup, focus trap, Escape and close button. Recipe matching (`matchRecipeIngredients`) marks an item as used when its full name, or the last word of three or more letters in it, appears in one of the recipe's "from your pantry" lines.

In the list view, inventory uses compact table rows from `sm` upward and stacked item rows on narrower screens. Location filters and inventory actions wrap into a two-column mobile control grid; long item names wrap instead of widening the document.

Deleting an item and adding it back to a shopping list are separate operations: the inventory document is deleted before the shopping write begins.

## Data Model and Persistence

- Firestore: `households/{householdId}/pantry-inventory/{itemId}`.
- New item IDs are slugified from the item name.
- `PantryItem` in `src/lib/types.ts` defines `id`, `name`, `quantity`, `unit`, `location`, and optional nullable ISO `expiryDate`.
- `PantryItemUnit`, `pantryItemUnitCategories`, and `PantryItemLocation` define supported units and locations.
- Recipe results are not persisted.
- Batch handoff from shopping (`addPurchasesToPantry`) writes one Firestore transaction that first re-reads every chosen shopping item and credits only those confirmed still purchased, with their confirmed name and quantity (an item un-ticked, deleted or already cleared by another member's "Add to pantry, then clear" is skipped and named in the toast). With "then clear", exactly the confirmed items are deleted in the same commit, so two members doing it at once never double-credit. Without clear the items stay on the list as purchased, so repeating a plain handoff on purpose credits again. Merge targets are planned from a pantry read made just before (web transactions cannot query) and re-checked inside the transaction; an entry deleted, moved, renamed or re-unitted meanwhile gets a new entry instead: an existing entry with the same name (case-insensitive), the same location and unit `items` has its `quantity` raised with an atomic Firestore `increment()` of the amount bought, so two members adding to the same entry at the same time both count; otherwise a new document is created with `name`, `quantity`, `unit: 'items'`, `location` and `expiryDate: null` (the same fields as the form). Shelves are guessed from the shopping category (Dairy, Meat, Produce, Deli, Seafood, Eggs to Fridge; Frozen to Freezer; everything else to Pantry) and can be changed before confirming.

Writes use `setDoc(..., { merge: true })`. Editing an item's name does not rename its existing Firestore document ID.

## Authentication, Roles, and Security

The UI requires an authenticated user and derives `householdId` from `useAuth`. Firestore access is covered by the approved-household-member fallback rule in `firestore.rules`; pending `newuser` members are excluded and legacy `households.memberEmails` membership is supported.

Firestore rules require `shopping.view` to read, `shopping.edit` to create or update and `shopping.delete` to delete `pantry-inventory` documents. The UI follows the same permissions and hides what a member cannot do: Add Item, Edit, the move handles and "Put on a shopping list" need `shopping.edit`; Delete, bulk selection and Delete Selected need `shopping.delete`; "Delete & Add to List" needs both. Members without `shopping.view` see an explanation on `/shopping` instead of the tabs.

## Integrations and Background Processing

- `generateRecipe` uses the shared OpenAI task and `OPENAI_RECIPE_MODEL`; `OPENAI_API_KEY` remains server-only.
- `BarcodeScanner` supplies scanned product data through the barcode module.
- There are no Cloud Functions, scheduled jobs, or persisted recipe records for this module.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) supplies the batch purchased-item handoff.
- [Barcode Library](../barcode-library/README.md) supplies scanned names and images, and product photos for shelf tiles.
- [Application Shell](../application-shell/README.md) supplies `EmptyState`, `toastError`/`friendlyError` and the motion tokens.
- [AI and OpenAI](../ai-genkit/README.md) owns model configuration and flow execution.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply the current user and household.
- [Firebase Platform](../firebase-platform/README.md) owns client initialization and security rules.

## Invariants and Failure Behavior

- Recipe generation rejects fewer than two inventory items, although the UI button can be enabled with one.
- Invalid or missing Firestore dates are handled defensively for display.
- A failed, timed-out, rate-limited, refused, or malformed recipe request leaves inventory unchanged, keeps the dialog open, reports a sanitized error (the AI action's public message for `AiClientError`, otherwise `friendlyError`), and offers retry.
- Delete-and-return-to-shopping is not atomic; a shopping failure can occur after inventory deletion.
- Slug-derived IDs can collide for names that normalize to the same slug.
- Pantry, fridge, and freezer mobile lists must keep item actions and long names within the document bounds at 360 px and wider supported viewports.
- Expiry styling (tilt, glow, frost, lift) is applied to a decorative layer or the whole tile as a state change, never as a hover effect; nothing moves on hover. Expiry states use local calendar days: `soon` is today through three days out.
- Every move has a non-pointer path (keyboard, tap-then-Move here, menu) and is announced through a polite live region.
- Errors use `toastError`, so raw Firebase text never reaches users.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- `tests/unit/shopping-logic.test.ts` covers shelf mapping, handoff planning, expiry states and labels, emoji, recipe matching and photo lookup; `tests/e2e/shopping-trip.spec.ts` covers the shelves view, expiry state, keyboard move, the remembered list view, the batch handoff, and the recipe reveal order (tiles lift while the dialog and scrim are transparent, the card follows at least 300 ms later; instant under reduced motion); `tests/e2e/temporary-chores-maintenance-ui.spec.ts` switches to the list view for the table and phone-row checks.
- Manually test inventory CRUD, drag between shelves with mouse and touch, bulk deletion, expiration display, units and locations, barcode intake, purchased-item intake, return-to-list behavior, and Pantry/Fridge/Freezer layouts at 360/390/412 px with long item names.
- Test recipe generation with zero, one, two, and many items plus an AI/network failure.
- Verify a user cannot read another household's inventory.

## When This Document Must Be Updated

Update this README when inventory fields or paths, recipe inputs/outputs, shopping handoffs, barcode intake, permission enforcement, AI configuration, or inventory failure/cleanup behavior changes.
