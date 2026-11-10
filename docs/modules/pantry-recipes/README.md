# Pantry Inventory and Recipes

## Purpose and Scope

This module owns household pantry, refrigerator, and freezer inventory plus recipe suggestions generated from that inventory. It does not own shopping-list records, barcode mappings, or the shared OpenAI configuration.

## User-Facing Capabilities

- Use the Pantry Inventory tab on `/shopping` (linkable as `/shopping?tab=pantry`). The tab stays mounted while the Shopping Lists tab is shown, so switching back re-reads nothing.
- The pantry is live (SH-1c): another member's additions, edits, moves and deletions show without a reload.
- See the pantry as shelves (default): Pantry, Fridge and Freezer are shelves of product tiles showing a product photo from the barcode library (matched by exact name) or a food emoji. A tile is one product (one name on one shelf) and lists its batches, soonest expiry first: "2 × 450 g · next Fri, 1 × 450 g", "3 cans · tomorrow". Products whose soonest batch expires within three days glow amber, expired ones fade and tilt, freezer tiles have a frost edge, and the header counts products expiring soon or expired. Expiry is counted from today in the household's time zone (D-6) and the page re-keys "today" just after household midnight (and when the page is shown again), so an always-on tablet rolls over on time (SH-10b).
- **Used one** (−) on a tile removes ONE package from the product's soonest-expiring batch (an atomic `increment(-1)`); it never subtracts 1 from a measured amount (17.3, SH-22a). **One more** (+) adds one package to that batch. **Out of this** in the tile's ⋯ menu uses every package up (SH-29). Both show a 10-second **Undo** toast, which adds back exactly what was removed (`increment(+n)`, SH-29c). When the product's total reaches zero the page asks **Add {name} to the list?** with **Add** and **Not now** (D-8): Add puts it on a Grocery list by the same rule as "Put on a shopping list" (one tap when there is a single Grocery list) through the Shopping merge path; Not now adds nothing, and nothing is ever added without that tap (SH-22b, SH-29b). Undo withdraws the question.
- A batch at zero packages is hidden at once. A member with `shopping.delete` deletes it later, online, with a transaction that deletes only if it still has no packages and nobody touched it in the last 60 seconds (`updatedAt`), so an Undo, a +1 or a hand-off in between keeps it.
- Move a product (all its batches) to another shelf by dragging its handle (mouse or touch), by keyboard (focus the handle, Enter or Space to pick up, arrow keys to choose a shelf, Enter or Space to drop, Escape to cancel), by tapping the handle and then **Move here** on a shelf, or from the tile's ⋯ menu.
- Switch to the list view (the previous table on wider screens and stacked rows on phones); the choice is remembered per device in `localStorage["homehub.pantry.view"]`.
- Add, edit, delete, and bulk-delete inventory (bulk delete is in the list view, which shows one row per batch). The form asks for the unit, how many packages, for weights and volumes the optional size of one package, the shelf and an optional expiration date with quick chips **+3 d**, **+1 w**, **+1 mo** and **Freezer +3 mo** (which also moves it to the Freezer), counted from the household's today. Adding stock that matches an existing batch exactly (same name, shelf, unit, package size and expiry) adds packages to it; anything else is a new batch. A tile with several batches offers **Edit** per batch in its menu; tapping the tile edits its soonest batch.
- Start an inventory item from a barcode scan: a weight or volume ("450 g") fills in one package of that size, never 450 packages (BL-1); a counted amount fills in the package count. The barcode is kept on the batch.
- **Put on a shopping list** (tile menu) and **Delete & Add to List** put the product on a Grocery list (`groceryListChoice`): with exactly one Grocery list it goes straight there; with several, a picker (list, name, quantity) opens on the Grocery list this device last used from the pantry (`localStorage["homehub.pantry.recentList.<householdId>"]`, a per-device convenience), else the household's default (a list named "Groceries", else the first Grocery list by name); with none, a "Groceries" list is created. Online, an item already needed on the chosen list with the same name gets that many more (`findMergeTarget` + `mergeIntoNeededItem`), so no duplicate is added (SH-6); offline, a new needed item is queued. The toast names the list; when categorization was unavailable it says the item is under Other (no promise of a later edit, SH-8c).
- Generate a recipe suggestion from usable stock only: products with packages left, with expired batches left out (SH-27e); the button needs at least two usable items, as the server does (H08 recipe reveal). The dialog opens with a loading state; when the recipe arrives in the shelves view and it uses tiles, the dialog and its scrim fade out (150 ms) so the shelves are visible, the used tiles lift off their shelves (the tile card and picture rise 8 px in 200 ms; the controls' hit areas stay put) with an "In the recipe" marker, the first lifted tile is scrolled into view, and after 450 ms (or at once on any key or pointer press) the dialog returns and the recipe card flips in (220 ms). In the list view, with no matching tiles, or under reduced motion, the tiles are marked and the card shows at once with no flip. Screen readers hear a short "Lifting the items…" status, and focus stays in the dialog throughout. The marker stays until the next generation.
- Shelf item counts, the expiring/expired header counts and the list view's shelf counts tick with the shared `NumberTicker` (`animateOnMount={false}`; one text node holding the final value, so "Pantry (3)" always reads exactly that), and each shelf's tiles enter with the shared `Stagger` (instant under reduced motion).
- Receive purchased grocery items in one batch from the shopping trip (see [Shopping](../shopping/README.md)); there is no longer a per-item pantry form after ticking.

## Entry Points

- `src/app/shopping/page.tsx`
- `src/components/shopping-center-client.tsx`
- `src/components/pantry-inventory-client.tsx`
- `src/components/shopping/pantry-shelves.tsx`
- `src/lib/shopping/pantry.ts` (shelf, expiry, emoji, recipe-matching and handoff planning helpers)
- `src/lib/shopping/pantry-batches.ts` (Pantry v2 pure model: `readPantryBatch`, merge key, grouping, used-up choice, zero decision, household-zone days and expiry chips, tile labels, write shapes)
- `src/lib/shopping/pantry-batch-writes.ts` (Pantry v2 writes: package increments, save/merge, move, delete, idle-empty cleanup, `readShoppingLists`, `createGroceriesList`, `addToGroceryList`)
- `src/lib/shopping/use-household-today.ts` (household today, re-keyed at household midnight)
- `src/lib/shopping/pantry-writes.ts` (batch handoff writer)
- `scripts/ops/migrate-pantry-v2.mjs` (one-off M2 migration; pure mapping in `scripts/ops/pantry-v2.mjs`)
- `src/lib/shopping/live.ts` (`useLivePantry`, the shared live-listener helpers)
- `src/ai/flows/generate-recipe-flow.ts`
- Shared types in `src/lib/types.ts`

## Architecture and Data Flow

`ShoppingCenterClient` hosts the inventory tab; `PantryInventoryClient` takes no props. The inventory client reads and writes household-scoped Firestore documents. Recipe generation sends only usable `{name, quantity, unit}` values (`usableRecipeItems`: the package count for counted units, packages × size for measured ones) plus a Firebase ID token to the AI server action and keeps the result only in component state. The server verifies household membership and `shopping.view` before requesting OpenAI.

The dashboard overview uses the same verified `shopping.view` boundary to calculate inventory and expiration counts server-side. It sends only bounded labels/dates and counts to the optional narrative, not full inventory documents.

The inventory is one `onSnapshot` listener ordered by name (`useLivePantry`, with metadata changes, bounded-backoff retry and resubscribe on `online`/visibility; see [Shopping](../shopping/README.md) for `keepListening`). It serves the cache offline. Firestore applies this device's writes to the listener at once and rolls a rejected one back there, so saves, moves and deletes never re-read the pantry. Every document is read through `readPantryBatch` and grouped with `groupPantryBatches`. The shelves view renders `PantryShelves`; moving a tile updates `location` (plus `updatedByUid`/`updatedAt`) on each of its batches in one batch write (shown at once through the listener and Firestore's queue; a rejected write shows a `toastError` and the tile moves back). The shopping lists for "Put on a shopping list" and the zero prompt's Add are read on demand when chosen. Product photos come from one read of `barcode-library`; a failure there only drops photos. The recipe dialog composes the shared dialog parts (`DialogPortal`, `DialogOverlay`, Radix `Content`) itself, only so the scrim can step aside during the lift; it keeps the standard dialog markup, focus trap, Escape and close button. Recipe matching (`matchRecipeIngredients`, on products) marks a product as used when its full name, or the last word of three or more letters in it, appears in one of the recipe's "from your pantry" lines.

In the list view, inventory uses compact table rows from `sm` upward and stacked item rows on narrower screens. Location filters and inventory actions wrap into a two-column mobile control grid; long item names wrap instead of widening the document.

Deleting a product (all its visible batches) and adding it back to a shopping list are separate operations: the inventory document is deleted before the shopping write begins. The shopping write is refused by the rules if that list was deleted meanwhile (items may only be written to a list document that exists).

## Data Model and Persistence

- Firestore: `households/{householdId}/pantry-inventory/{itemId}`, **one document per batch** (Pantry v2, audit 17.3).
- New batch IDs are `slugify(name)` (a slug plus a random suffix).
- v2 fields: `name`, `nameKey` (`itemNameKey(name)`), `location` (Pantry, Fridge, Freezer), `unit` (`PantryItemUnit`), `packages` (0 to 10000), `packageSize` (null, or above 0 and at most 100000: the size of one package in `unit`; always null for counted units), `expiryDate` (`yyyy-MM-dd` in the household zone, or null; SH-10a), `barcode` (optional), `addedByUid` (creator, set on create only), `updatedByUid` (last writer), `updatedAt` (server time) and `schemaVersion: 2`. v2 clients also **dual-write** the legacy `quantity` (packages for counted units, the package size for measured ones) so an older page still open shows something sensible; counted-unit package changes increment it too.
- **Legacy documents** (`name`, `quantity`, `unit`, `location`, ISO `expiryDate` of local midnight) are read by `readPantryBatch`: a counted unit's `quantity` is the package count (`packageSize` null); a measured unit's `quantity` is one package of that size (`packages` 1, or 0 when the quantity was 0); the ISO expiry becomes its day in the household zone. The first v2 write to a legacy document writes absolute upgraded values from what is on screen (`upgradeLegacyBatch`), since it has no `packages` to increment; afterwards changes are increments. An older page that later edits a v2 document changes only `quantity` (and may write an ISO expiry), which v2 pages ignore in favour of `packages` until the next v2 edit; the migration rewrites such expiries.
- **Merge key** `nameKey + location + packageSize + unit + expiryDate` (`pantryMergeKey`): batches that differ on any of these stay separate documents, so incompatible units never merge (SH-23a). The tile groups a product's batches.
- `PantryItem` in `src/lib/types.ts` is the stored shape (v2 fields optional, legacy `quantity` optional).
- `PantryItemUnit`, `pantryItemUnitCategories`, and `PantryItemLocation` define supported units and locations.
- Recipe results are not persisted.
- Batch handoff from shopping (`addPurchasesToPantry`) writes one Firestore transaction that first re-reads every chosen shopping item and credits only those confirmed still purchased, with their confirmed name and quantity (an item un-ticked, deleted or already cleared by another member's "Add to pantry, then clear" is skipped and named in the toast). With "then clear", exactly the confirmed items are deleted in the same commit, so two members doing it at once never double-credit. Without clear the items stay on the list as purchased, so repeating a plain handoff on purpose credits again. Merge targets are planned from a pantry read made just before (web transactions cannot query) and re-checked inside the transaction; an entry deleted, moved, renamed or re-unitted meanwhile gets a new entry instead: a purchase is a batch counted in `items` with no package size and no expiry, so it merges only into an existing batch with that merge key (same name, case-insensitive, same shelf, unit `items`, no size, no expiry): a v2 target has `packages` and `quantity` raised with atomic `increment()`s of the amount bought, so two members adding to the same batch at the same time both count; a legacy target is upgraded with absolute values from the transaction's own read. Otherwise a new v2 batch is created (`addedByUid`/`updatedByUid` of the signed-in member, `updatedAt`). Shelves are guessed from the shopping category (Dairy, Meat, Produce, Deli, Seafood, Eggs to Fridge; Frozen to Freezer; everything else to Pantry), except shelf-stable produce (onions, shallots, garlic, potatoes, sweet potatoes, yams, bananas, plantains, squash, pumpkins), which stays in the Pantry (SH-23c); shelves can be changed before confirming.

**Migration M2** (`scripts/ops/migrate-pantry-v2.mjs --project <id>`; dry run by default with counts only, `--apply` to write, `--firebase-tools-login` for auth as in `./credentials.mjs`): converts legacy documents to v2 (derived values, `nameKey`, the ISO expiry as a household-zone day using `households/{id}.timeZone`, default America/Chicago, the dual-written `quantity`, `schemaVersion: 2`) and rewrites ISO expiries on v2 documents. Each write is an update with the document's last update time as a precondition, so a member's concurrent edit is never overwritten: the document is re-read and the mapping recomputed (up to three tries; the rest is counted and left for a re-run). Deleted documents are skipped, converted ones are left alone, so it is resumable. It does not set `updatedAt` or attribution. The mapping is the JavaScript twin of `readPantryBatch` (`tests/unit/pantry-v2-migration.test.ts` checks they agree).

Edits are `updateDoc` of the batch's full v2 fields; package changes are increments; new batches are `setDoc` with `addedByUid`. Editing a batch's name does not rename its Firestore document ID. Offline, writes are queued (`awaitWriteUnlessOffline`); the empty-batch cleanup and the list merge need a connection.

## Authentication, Roles, and Security

The UI requires an authenticated user and derives `householdId` from `useAuth`. Firestore access is covered by the approved-household-member fallback rule in `firestore.rules`; pending `newuser` members are excluded and legacy `households.memberEmails` membership is supported.

Firestore rules require `shopping.view` to read, `shopping.edit` to create or update and `shopping.delete` to delete `pantry-inventory` documents.

**Rules stage S4a (this release, compatible with older pages):** `validPantryFields` allowlists `name` (1 to 500, required on create), `nameKey` (≤500), `location` (Pantry, Fridge, Freezer), `unit` (the twelve `PantryItemUnit` values), `packages` (number 0 to 10000, checked after `increment()`, so a "used one" can never go below zero: a second tap on a batch someone just emptied is refused and rolled back with a `toastError`), `packageSize` (null or above 0 and at most 100000), legacy `quantity` (number 0 to 100000), `expiryDate` (null, `yyyy-MM-dd`, or a legacy ISO string of at most 40 characters), `barcode` (≤128 or null), `addedByUid` (only on create, and only the writer's uid; `pantryAdderUnchanged` keeps it fixed and not removable on update), `updatedByUid` (the writer) and `updatedAt` (`request.time`), and `schemaVersion` (2). On every update the resulting batch is checked (`pantryUpdateAttributed`), not only the changed keys: an update that changes any v2 field (such as `packages`) or removes a field must leave `updatedByUid` equal to the writer and `updatedAt` equal to the request time, so nobody can change a count under another member's `updatedByUid` or an old `updatedAt`, or strip the attribution. The one exception in stage S4a is an older page's update (`pantryLegacyOnlyUpdate`): it changes only `name`, `quantity`, `unit`, `location` or `expiryDate` and removes nothing, and is allowed on legacy and v2 batches alike, leaving `packages` and the v2 attribution as they were (v2 pages read `packages`, not `quantity`); stage S4b removes this exception. Only written keys are checked (`writtenKeys()`), so legacy documents and older pages keep working. **Stage S4b (a later release, after M2 has run and one update cycle has passed):** accept only a date-only or null `expiryDate` (drop the ISO branch of `validPantryExpiry`), so no ISO expiry can be written again. Release order: S4a rules → this client → M2 (`--apply`) → S4b rules.

The UI follows the same permissions and hides what a member cannot do: Add Item, Edit, Used one, One more, Out of this, the move handles and "Put on a shopping list" need `shopping.edit`; Delete, bulk selection and Delete Selected need `shopping.delete`; "Delete & Add to List" needs both. Members without `shopping.view` see an explanation on `/shopping` instead of the tabs.

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

- Recipe generation rejects fewer than two items; the button is disabled until two usable products exist.
- Invalid or missing Firestore dates are handled defensively for display.
- A failed, timed-out, rate-limited, refused, or malformed recipe request leaves inventory unchanged, keeps the dialog open, reports a sanitized error (the AI action's public message for `AiClientError`, otherwise `friendlyError`), and offers retry.
- Delete-and-return-to-shopping is not atomic; a shopping failure can occur after inventory deletion.
- Slug-derived IDs can collide for names that normalize to the same slug.
- Pantry, fridge, and freezer mobile lists must keep item actions and long names within the document bounds at 360 px and wider supported viewports.
- Expiry styling (tilt, glow, frost, lift) is applied to a decorative layer or the whole tile as a state change, never as a hover effect; nothing moves on hover. Expiry states use household-zone calendar days (`daysUntilDay` from `useHouseholdToday`): `soon` is today through three days out.
- Every move has a non-pointer path (keyboard, tap-then-Move here, menu) and is announced through a polite live region.
- Errors use `toastError`, so raw Firebase text never reaches users.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- `tests/unit/pantry-batches.test.ts` covers legacy derivation, the dual-written quantity, the merge key, grouping and tile labels, the used-up batch choice, the zero → ask decision, the idle-empty rule, usable recipe stock, date-only expiry at 23:30 Central, the chips and midnight re-keying, and shelf-stable produce; `tests/unit/pantry-v2-migration.test.ts` covers the M2 mapping; the `content shapes: pantry` suite in `tests/rules/firestore.rules.test.ts` covers stage S4a.
- `tests/unit/shopping-logic.test.ts` covers shelf mapping, handoff planning, expiry states and labels, emoji, recipe matching and photo lookup; `tests/e2e/shopping-trip.spec.ts` covers the shelves view, expiry state, keyboard move, the remembered list view, the batch handoff, and the recipe reveal order (tiles lift while the dialog and scrim are transparent, the card follows at least 300 ms later; instant under reduced motion); `tests/e2e/temporary-chores-maintenance-ui.spec.ts` switches to the list view for the table and phone-row checks.
- Manually test Used one / One more / Out of this with Undo and the Add / Not now prompt (two devices for concurrent taps), a measured batch (one tap removes a package), expiry chips at 23:30 household time, a tablet left open over household midnight, a legacy document's first change, inventory CRUD, drag between shelves with mouse and touch, bulk deletion, expiration display, units and locations, barcode intake, purchased-item intake, return-to-list behavior, and Pantry/Fridge/Freezer layouts at 360/390/412 px with long item names.
- Test recipe generation with zero, one, two, and many items plus an AI/network failure.
- Verify a user cannot read another household's inventory.

## When This Document Must Be Updated

Update this README when inventory fields or paths, recipe inputs/outputs, shopping handoffs, barcode intake, permission enforcement, AI configuration, or inventory failure/cleanup behavior changes.
