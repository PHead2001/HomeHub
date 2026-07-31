# Shopping Lists

## Purpose and Scope

This module owns shopping-list metadata, list categories, needed/purchased items, barcode-assisted entry, and purchasing handoffs. Pantry inventory and barcode mappings are separate modules even though they share the `/shopping` experience.

## User-Facing Capabilities

- Use the Shopping Lists tab at `/shopping`.
- Create, edit, and delete Grocery, Auto, Hardware, Pets, and Custom lists.
- Customize per-list categories.
- Add/delete items, change quantity, and toggle needed/purchased status.
- Clear purchased items and optionally remove an emptied list.
- Scan a barcode while adding an item.
- Move a purchased Grocery item into a prefilled pantry form.

## Entry Points

- `src/app/shopping/page.tsx`
- `src/components/shopping-center-client.tsx`
- `src/components/shopping-list-client.tsx`
- `src/components/barcode-scanner.tsx`
- `src/ai/flows/categorize-grocery-item-flow.ts`
- Shopping types in `src/lib/types.ts`

## Architecture and Data Flow

`ShoppingCenterClient` coordinates Shopping Lists and Inventory tabs plus the purchased-item handoff. `ShoppingListClient` fetches list metadata/items explicitly, writes Firestore records, and treats the grocery categorization server action as optional enrichment for new items.

Checking a Grocery item marks it purchased before opening the pantry form. Canceling that form leaves the shopping item purchased. Reverting an item to needed does not subtract pantry inventory.

## Data Model and Persistence

- Lists: `households/{householdId}/shopping-lists/{listId}`.
- Items: `households/{householdId}/shopping-lists/{listId}/items/{itemId}`.
- Categories: `households/{householdId}/shopping-lists/{listId}/config/categories`.
- Barcode lookup dependency: `households/{householdId}/barcode-library/{barcode}`.

`ShoppingList`, `ShoppingListType`, `ShoppingListItem`, and `ShoppingListCategory` are defined in `src/lib/types.ts`.

## Authentication, Roles, and Security

The page requires an authenticated user and scopes paths with `householdId`. Navigation uses `shopping.view`. Pending users are blocked.

The `shopping.edit` and `shopping.delete` permissions exist, but the feature and generic Firestore household rule do not enforce them per mutation. Approved members can read/write these collections regardless of role override.

## Integrations and Background Processing

- Grocery categorization calls the shared Genkit/Gemini flow only when the user leaves category selection on Automatic.
- Barcode lookup checks the household library, then Open Food Facts; camera capture uses `react-zxing`.
- There are no shopping Cloud Functions, scheduled jobs, or real-time snapshot listeners.

## Cross-Module Dependencies

- [Pantry Inventory and Recipes](../pantry-recipes/README.md) receives purchased grocery items.
- [Barcode Library](../barcode-library/README.md) owns mappings, scanning, and public fallback.
- [AI and Genkit](../ai-genkit/README.md) owns category generation.
- [Identity and Profile](../identity-profile/README.md), [Household Governance](../household-governance/README.md), and [Firebase Platform](../firebase-platform/README.md) supply scope/security.

## Invariants and Failure Behavior

- A manually selected category bypasses AI. Automatic categorization errors, invalid responses, or a five-second timeout save exactly one item under `Other` and show a non-blocking fallback toast.
- Loaded custom category sets always include `Other`, so fallback items remain visible even when older category configuration omitted it.
- Optional `imageUrl` and `barcode` fields are omitted from Firestore writes when absent; undefined values are never sent.
- List/item refreshes use `getDocs`, not live listeners.
- Deleting a list removes only the parent document; nested items/config can remain orphaned despite destructive dialog wording.
- Purchase-to-pantry is not transactional.
- Barcode lookup failure does not invent product data.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test list/category/item CRUD, each list type, clear-purchased behavior, barcode local/public fallback, AI failure, and purchase-to-pantry cancellation.
- Inspect nested documents after deleting a list and verify cross-household denial.

## When This Document Must Be Updated

Update this README when list/item/category paths or fields, purchasing transitions, pantry handoff, categorization, barcode behavior, deletion cleanup, live-update strategy, or shopping permission enforcement changes.
