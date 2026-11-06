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
- Open the household barcode catalog from the `Barcode Library` inventory action.
- Share a recipe link, product page or text into the installed app (`/share`), pick a list, and confirm to add it as an item, optionally keeping the link.
- Open lists and tick items with no connection; ticks sync when the connection returns.
- Launch the "Add to shopping" home-screen shortcut (`/shopping?quickAdd=1`) to open the add-item dialog directly.

## Entry Points

- `src/app/shopping/page.tsx`
- `src/components/shopping-center-client.tsx`
- `src/components/shopping-list-client.tsx`
- `src/app/share/page.tsx`
- `src/components/share-target-client.tsx`
- `src/lib/share-target.ts`
- `src/lib/shopping-items.ts`
- `src/components/barcode-scanner.tsx`
- `src/ai/flows/categorize-grocery-item-flow.ts`
- Shopping types in `src/lib/types.ts`

## Architecture and Data Flow

`ShoppingCenterClient` coordinates Shopping Lists and Inventory tabs plus the purchased-item handoff. `ShoppingListClient` fetches list metadata/items explicitly, writes Firestore records, and treats the OpenAI-backed grocery categorization server action as optional enrichment for new items. The client sends a Firebase ID token; the action verifies household membership and `shopping.edit` before requesting a model.

Checking a Grocery item marks it purchased before opening the pantry form. Canceling that form leaves the shopping item purchased. Reverting an item to needed does not subtract pantry inventory.

Item creation goes through `buildShoppingListItem` (`src/lib/shopping-items.ts`), shared by the add-item dialog and the share target: document ID `slugify(name)` (a slug plus a random suffix, so the same name added twice creates two items; there is no dedupe), `status: 'needed'`, `createdAt: new Date()`, and optional `imageUrl`, `barcode` and `sourceUrl` omitted when empty.

**Offline.** Lists and items are read with `getDocsOfflineAware`/`getDocOfflineAware`, which use Firestore's persistent cache directly when the browser is offline. Ticking an item updates the screen immediately; the status write is queued by Firestore and syncs on reconnect, even if the page is reloaded in between. Offline, the Grocery purchase-to-pantry handoff is skipped (its form would wait on the network) and a one-time "You are offline" toast explains that ticks sync later; if a queued write is later rejected, the tick reverts and an error toast appears. Items added offline are saved under `Other` once categorization fails (as with any AI fallback) and confirmed with an "Item Added Offline" toast. The `/shopping` page shell itself loads offline from the service worker described in [Application Shell and Dashboard](../application-shell/README.md). Only lists and items this browser has already loaded are available offline.

**Share target.** The manifest declares a GET share target at `/share` with `title`, `text` and `url` parameters. `parseSharedContent` takes the first http(s) URL from `url` or `text` (Android often places it in `text`) and suggests an item name from the title, then the text without the link, then the link's host name, capped at 120 characters. `ShareTargetClient` shows sign-in, no-household, pending-approval and no-permission states; otherwise the member edits the name and quantity, chooses whether to keep the link, and picks a list. Nothing is written until **Add to list** is pressed. The save reads the list's category config, categorizes like the add-item dialog (Automatic; `Other` immediately when offline), and writes one item; offline it reports "Saved offline".

**Quick add.** `/shopping?quickAdd=1` removes the parameter from the address bar once lists load, then opens the add-item dialog on the only list, or on the first Grocery list; otherwise it shows a "Choose a list" toast.

## Data Model and Persistence

- Lists: `households/{householdId}/shopping-lists/{listId}`.
- Items: `households/{householdId}/shopping-lists/{listId}/items/{itemId}`.
- Categories: `households/{householdId}/shopping-lists/{listId}/config/categories`.
- Barcode lookup dependency: `households/{householdId}/barcode-library/{barcode}`.

`ShoppingList`, `ShoppingListType`, `ShoppingListItem`, and `ShoppingListCategory` are defined in `src/lib/types.ts`. `ShoppingListItem.sourceUrl` (optional) holds an http(s) link saved from the share target; the item row shows an external-link button for it and re-checks the scheme before rendering.

## Authentication, Roles, and Security

The page requires an authenticated user and scopes paths with `householdId`. Navigation uses `shopping.view`. Pending users are blocked.

Firestore rules require `shopping.view` to read lists, items and category config, `shopping.edit` to create or update them, and `shopping.delete` to delete them. The Shopping Lists tab does not hide controls by permission; denied writes fail (most paths show an error toast). The share target checks `shopping.view` and `shopping.edit` (and blocks pending members) before loading lists or offering a save.

## Integrations and Background Processing

- Grocery categorization calls the shared authenticated Genkit/OpenAI flow only when the user leaves category selection on Automatic. Household item names are serialized as untrusted data under the centralized AI system instruction. Emulator E2E uses the deterministic provider and never calls OpenAI.
- The dashboard overview reads list/item counts only after server verification of `shopping.view`; omitted permission means no Shopping query or overview section.
- Barcode lookup checks the household library, then Open Food Facts; camera capture uses `react-zxing`.
- There are no shopping Cloud Functions, scheduled jobs, or real-time snapshot listeners.

## Cross-Module Dependencies

- [Pantry Inventory and Recipes](../pantry-recipes/README.md) receives purchased grocery items.
- [Barcode Library](../barcode-library/README.md) owns mappings, scanning, and public fallback.
- [AI and Genkit](../ai-genkit/README.md) owns category generation.
- [Identity and Profile](../identity-profile/README.md), [Household Governance](../household-governance/README.md), and [Firebase Platform](../firebase-platform/README.md) supply scope/security.

## Invariants and Failure Behavior

- A manually selected category bypasses AI. Automatic categorization errors, invalid responses, configuration failures, rate limits, or a five-second client timeout save exactly one item under `Other` and show a non-blocking fallback toast.
- Loaded custom category sets always include `Other`, so fallback items remain visible even when older category configuration omitted it.
- Optional `imageUrl` and `barcode` fields are omitted from Firestore writes when absent; undefined values are never sent.
- List/item refreshes use one-time reads (`getDocsOfflineAware`), not live listeners.
- A tick is never lost offline: local state updates first and the queued write survives reloads. The share target never writes before explicit confirmation.
- `sourceUrl` is stored only when it parses as http(s), and is re-checked before rendering as a link.
- Deleting a list removes only the parent document; nested items/config can remain orphaned despite destructive dialog wording.
- Purchase-to-pantry is not transactional.
- Barcode lookup failure does not invent product data.
- The `/shopping` header action stacks on narrow screens so its label and controls stay inside the viewport.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test list/category/item CRUD, each list type, clear-purchased behavior, barcode local/public fallback, AI failure, purchase-to-pantry cancellation, and the mobile `Barcode Library` action at 360/390/412 px.
- Inspect nested documents after deleting a list and verify cross-household denial.
- `tests/e2e/pwa-share.spec.ts` covers the manifest, the signed-out share page and the confirm-before-write flow; `tests/unit/pwa-share.test.ts` (part of `npm run test:ai`) covers share parsing and the item contract.
- Manually, in a production build: load `/shopping` and open a list once, go offline (DevTools), reload, tick items, reload again, reconnect, and confirm the ticks reach Firestore.

## When This Document Must Be Updated

Update this README when list/item/category paths or fields, the shared item-creation contract, purchasing transitions, pantry handoff, categorization, barcode behavior, deletion cleanup, live-update or offline strategy, the share target or quick-add shortcut, or shopping permission enforcement changes.
