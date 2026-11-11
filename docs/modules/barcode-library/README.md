# Barcode Scanning and Household Library

## Purpose and Scope

This module owns camera/manual barcode capture, household product mappings, product images, and public lookup fallback. Shopping and pantry own the records created after a lookup.

## User-Facing Capabilities

- Manage household barcode mappings at `/library`, shown as a photo-first grid of product cards: the product photo sits on a soft blurred copy of itself that also runs behind the title. Products without a photo, or whose photo fails to load, show a package placeholder with the product's initial (announced as "No product image for <name>").
- See how many products are saved ("1 product", "3 products") and search by name or barcode.
- Scan or enter a barcode when adding shopping or pantry items.
- Create, edit, and delete a barcode-to-product mapping; a delete can be undone for 10 seconds.
- Store a product name, and optionally a photo ("Take photo" on touch devices, or "Choose photo"), for household reuse.
- Fall back to Open Food Facts when no household mapping is available.
- An unknown barcode scanned in Shopping or Pantry offers "Save to library", which opens Add here with the code filled in (BL-9). A lookup that cannot answer says so instead of "not found".

## Entry Points

- `src/app/library/page.tsx`
- `src/components/barcode-library-client.tsx`
- `src/components/shopping/product-card.tsx`
- `src/components/barcode-scanner.tsx`
- `src/lib/barcode/scanner-errors.ts` (pure: camera error kinds, their copy, and which errors toast)
- `src/components/image-upload.tsx`
- `src/components/barcode/use-lookup-feedback.tsx` (the shared "not found" / "unavailable" toasts with "Save to library")
- `src/ai/flows/lookup-barcode-flow.ts`
- `src/lib/barcode/lookup-outcome.ts` (pure: Open Food Facts reply classification, misses and their copy)
- `src/lib/barcode/library-writes.ts` (pure: create, edit, restore and photo-cleanup decisions, the `?add=` link)
- `src/lib/images/downscale.ts` (the shared photo downscale)
- Shared `BarcodeLibraryItem` type in `src/lib/types.ts`

## Architecture and Data Flow

`BarcodeScanner` uses the device camera through `react-zxing` and returns a decoded value to its host form. The camera runs only while the scanner is mounted: on unmount (its dialog closed, or the Shopping Center tab that owns it hidden, see [Shopping](../shopping/README.md)) react-zxing resets its reader and `BarcodeScanner` also stops every track of the video's `MediaStream` and clears `srcObject`, so no host can leave the camera on behind a closed or hidden dialog. Camera errors are sorted by kind (`scannerErrorKind`: permission denied, no camera, camera busy, not supported, anything else a scan error) and each kind raises one toast per open scanner (`reportScannerError`): the decoder retrying a camera it cannot start no longer repeats the same toast, a different kind toasts once more, and reopening the scanner starts a new session. The latest camera problem also stays inline under the camera (not a live region, so it is announced once, by its toast) for as long as the scanner is open; a decoded barcode clears it. Every host (list Add Item, Scan to tick, the pantry form, the library) gets this from `BarcodeScanner` itself, since each mounts it only while its dialog is open. `lookupBarcode` first attempts the household Firestore mapping and then calls Open Food Facts. The library client manages mappings and uploads images to household-scoped Storage before writing Firestore metadata.

**Add, edit and delete (BL-3, BL-4, BL-10).** Add is create-only. It reads the code first (before any upload, so a taken code never leaves an orphaned photo) and then creates in a transaction that refuses when the document exists; either way an existing product shows "This barcode is already saved as <name>. Edit it instead?" inline with an **Edit <name>** button, and nothing is overwritten. A photo uploaded for a create that is then refused is deleted again (best effort). A new product is `newProductData`: `name`, `imageUrl` (empty without a photo), `imagePath` when managed, `createdAt` (ISO) and `createdByUid` (the writer). Edit is a transaction that reads the product as it is now and updates only what this member changed (`productEdit` against that current copy, so another member's newer photo is neither overwritten unknowingly nor left orphaned; a product deleted meanwhile is reported as "Not saved" and the uploaded photo is removed): `name`, and for the photo either a new `imageUrl`/`imagePath`, or `imageUrl: ''` with `imagePath` removed; it never writes `createdAt` or `createdByUid`. After an edit is saved, the managed photo it replaced or removed is deleted (best effort, `staleProductPhoto`). Shopping rows that stored that photo's URL at scan time do not break: they show the library's current photo for their barcode (see [Shopping](../shopping/README.md)). The name is required (1 to 120 characters); the photo is optional. The library page lists products with a live listener (ordered by `createdAt`, newest first), so another member's add, edit or delete shows at once. Delete reads and deletes the current document in one transaction (`capturedProduct`), so the Undo and the delayed photo cleanup use what was actually deleted, never an older copy on the page (a product already removed elsewhere shows "Already deleted"). It removes the document at once and shows "Item Deleted" with **Undo** for `UNDO_WINDOW_MS` (10 s; Undo needs `shopping.edit`). The managed photo is deleted only after that window, by a module-level registry (`createPendingPhotoDeletes`, `src/lib/barcode/pending-photo-deletes.ts`) rather than page state, because the Undo toast is global and outlives the library page: leaving the page neither deletes the photo early nor drops the delete. Undo restores into the household the product was deleted from (captured at delete time, even if the member switched households since). It first cancels the pending photo delete, then re-creates the product in the same create-only transaction with its name, photo and `createdAt`, and `createdByUid` = the restorer (a create names its writer). Because the restore is a create, it is checked against the create contract first (`restoredProductData`, with `photoUrlAcceptedOnCreate` as the client's copy of the rules' image allowlist): a photo URL a create would refuse (an older URL that predates the allowlist, kept only on edits) is left out together with its path, an `imagePath` outside the household's folder is dropped, and a name over 200 characters is shortened, so the product itself always comes back. If the photo was left out, or its delete already ran (the toast was held open past the window), the product comes back without a photo (instead of pointing at a deleted or refused object) and "Item restored" says the photo could not be restored; a left-out photo's delayed delete is not cancelled. If the code was saved again meanwhile it reports "Not restored", changes nothing, and deletes the kept photo.

**`?add=<barcode>`.** For a member with `shopping.edit`, a 6 to 32 digit `add` parameter (`barcodeToAdd`) opens Add with the code filled in, and the parameter is then removed from the address with `history.replaceState`.

**Photos (BL-11).** `ImageUpload` (with `photoButtons`) shows **Take photo** (an `accept="image/*" capture="environment"` input, only on coarse pointers) and **Choose photo** under the drop zone. A picked photo is shrunk at once by `downscaleImage` (`src/lib/images/downscale.ts`): the longer edge becomes at most 1024 px (ratio kept, never enlarged), PNG and WebP keep their format and everything else is saved as JPEG, lossy output steps its quality down (0.86, 0.76, 0.64, 0.5) until it fits 5 MB, and a photo already within 1024 px and 5 MB (or a GIF within 5 MB, to keep its animation) is kept untouched. A photo the browser cannot decode (for example HEIC outside Safari) is kept when it is within 5 MB. A photo that still does not fit, or cannot be decoded and is over 5 MB, is refused with inline copy under the image field ("This photo is still larger than 5 MB after shrinking it. Choose a smaller photo."); Save waits while a photo is being shrunk, and is blocked while a rejected photo is shown (`productSubmitBlock`): pressing Save moves focus to the photo field (outlined, with the error tied to it by `aria-describedby`) until the member removes the photo or picks a valid one, so a product is never saved without, or with the old instead of, the photo on screen. A save that answers after the dialog closed or switched to another product leaves that dialog alone. The decisions are pure (`planDownscale`, `targetSize`, `outputType`, `qualitySteps`, `fitsLimit`), and the helper takes its own edge and byte limit so other uploads can use it.

Lookup is an authenticated server action but does not invoke OpenAI generation, does not need `OPENAI_API_KEY`, and remains usable when model configuration is absent. It verifies the Firebase ID token, household membership, and `shopping.view`, then uses Firebase Admin for `households/{householdId}/barcode-library/{barcode}`.

Lookup precedence is household library, Open Food Facts v3, then not found. A household hit prevents any public request. The v3 request asks only for product name, package quantity, normalized quantity/unit, and front image, uses a five-second timeout and HomeHub User-Agent, and treats community data as optional. Tests use emulator-only fixtures and never call production Open Food Facts (`000000000404` is unknown; `000000000408`, `000000000429` and `000000000422` simulate a timeout, a rate limit and an unreadable reply).

The result's `source` tells the screens what happened (BL-9, `classifyOpenFoodFactsReply` / `classifyOpenFoodFactsError` in `src/lib/barcode/lookup-outcome.ts`): `household` or `open_food_facts` with a product; `none` when Open Food Facts answered that it does not know the code (HTTP 404, a `failure` status, or a reply without a product name); `unavailable` with `unavailableReason` `timeout` (the five-second abort), `rate_limited` (HTTP 429) or `error` (any other non-2xx status, a network failure, or an unreadable body). On screen: a scan from inside a modal dialog (the Shopping Add Item scanner, the Pantry item scanner) shows the miss inline in that dialog (`LookupMissNotice` / `useScanMiss`, `role="alert"`), because a toast and its action sit behind the modal where they can be neither clicked nor reached with the keyboard; Scan to tick (whose scanner closes first) and a miss that answers after its dialog closed use toasts (`useLookupFeedback`). "Product not found" offers **Save to library** to members with `shopping.edit`, a link to `/library?add=<code>`; "Lookup unavailable" says the lookup could not answer and to try again, never "not found", and offers no save. A thrown lookup that is a capacity or connection problem (the action's `timeout`, `rate_limited`, `busy`, `unavailable` or `invalid_response` codes, a failed fetch, or the browser offline) also reads as unavailable (`lookupErrorMiss`); sign-in and permission errors keep their `toastError` copy.

Scanning into a shopping list adds ONE package (BL-1, audit 17.3): `scanToShoppingEntry` (`src/lib/shopping/scan.ts`) maps the lookup to quantity 1 and keeps the package size and unit separately as the item's `size`/`sizeUnit` (only when the size is above 0 and at most 100000 and the unit at most 16 characters), shown as a note on the row ("450 g"). A scan of a name already needed on the list merges and adds 1. The package size is never the count (the e2e fixtures 128 fl oz and 450 g used to become x128 and x450).

Simple supported quantities (`g`, `kg`, `oz`, `lbs`, `ml`, `L`, `fl oz`, and unambiguous count units) prefill the pantry unit and, for weights and volumes, the size of one package (one package), or for count units the package count. Compound text uses normalized quantity/unit only when both are supported. Serving sizes, unknown measurements, and ambiguous values are not converted; the product name can still prefill and all values remain editable.

## Data Model and Persistence

- Firestore: `households/{householdId}/barcode-library/{barcode}`.
- Storage: `households/{householdId}/barcode-library/{uuid}.{extension}`.
- `BarcodeLibraryItem` contains barcode `id`, `name`, `imageUrl` (empty when the product has no photo), optional managed `imagePath`, ISO `createdAt`, and `createdByUid` (written on create by this client; absent on older products).
- The barcode value is the Firestore document ID.

Deleting a mapping removes Firestore metadata first. Storage cleanup runs only for a recognized household barcode path, after the 10 s Undo window, and is best effort; external URLs and empty image values are not passed to Firebase Storage.

## Authentication, Roles, and Security

Routes require an authenticated user and clients derive `householdId` from auth context. Firestore and Storage rules treat `households/{householdId}/members/{uid}` as the only membership authority: the caller needs an approved member record (role `owner`, `admin`, `member`, `child`, or `guest` with `status` `active`), and `households.memberEmails` or user-profile fields never grant access. Pending `newuser` members are blocked. Both rule sets gate by effective permission (role preset plus per-member overrides; owners hold every permission): `shopping.view` to read, `shopping.edit` to create or update, and `shopping.delete` to delete mappings and barcode images.

The server-action lookup receives `householdId` and an ID token from its caller, verifies the token and the caller's member record with Firebase Admin, and requires `shopping.view` before reading the household mapping. Admin reads bypass security rules, so this server-side check is the authorization boundary for lookup.

The library UI follows the same permissions: Add Item, Edit and the delete Undo appear with `shopping.edit`, Delete with `shopping.delete`, and without `shopping.view` the page explains that the library is not shared (after membership has loaded, so it never flashes). The Shopping Center hides its Barcode Library link without `shopping.view`.

Firestore rules also validate product shapes (QA-8, BL-17): a product may only set `name` (1 to 200 characters), `imageUrl`, `imagePath`, `createdAt` (at most 40 characters) and `createdByUid`, and the barcode ID is at most 128 characters on create. `createdAt` and `createdByUid` may be written only on create (`createdByUid` must be the writer's uid, and it is optional, so older clients' creates stay valid); an update may neither change nor remove either, so an Add over an existing product (which writes a new `createdAt`) is refused and an edit must leave both alone (BL-3). A written `imageUrl` must be empty, a Firebase Storage download URL for this household's `barcode-library/` folder in this project's bucket (`homehub-j91jb.appspot.com` or `homehub-j91jb.firebasestorage.app`, or the Storage emulator for `demo-` projects), or an Open Food Facts image (`images.` or `static.openfoodfacts.org`/`.net`); `imagePath` must be `households/{householdId}/barcode-library/<file>`. Only changed keys are checked on update, so an existing product whose stored `imageUrl` predates the rule can still be renamed while its image stays as is.

Storage rules accept barcode-image creates and updates only when the object is 5 MB or smaller and its content type is `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, or `image/avif`. The shared upload UI also validates images client-side.

## Integrations and Background Processing

- Camera decoding: `react-zxing` and `@zxing/library`.
- Public fallback: `https://world.openfoodfacts.org/api/v3/product/{barcode}.json` (with a `fields` list).
- Authorized action and Open Food Facts fallback: `src/ai/flows/lookup-barcode-flow.ts`.
- Quantity normalization: `src/ai/barcode-quantity.ts`.
- No Cloud Function or scheduled processing is involved.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) consumes lookup results for list items (one package per scan, size kept as `size`/`sizeUnit`) and for Scan to tick.
- [Pantry Inventory and Recipes](../pantry-recipes/README.md) consumes lookup results for inventory and product photos for its shelf tiles.
- [Application Shell](../application-shell/README.md) supplies `EmptyState`, `FieldError` and `toastError`.
- [AI and OpenAI](../ai-genkit/README.md) supplies shared server authorization and sanitized action errors; barcode lookup itself is model-free.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply household context.
- [Firebase Platform](../firebase-platform/README.md) owns Firestore and Storage configuration.

## Invariants and Failure Behavior

- A product needs a barcode (1 to 64 characters without `/`) and a name; the photo is optional. Photo problems (still too large after shrinking, or unreadable and too large) are shown inline under the image field (`FieldError`), never as a toast, and the scanner's manual entry (6 to 32 digits) also reports problems inline.
- Add never replaces an existing product; Edit never writes `createdAt` or `createdByUid`.
- Save, load and delete failures use `toastError`, so raw Firebase text never reaches users.
- Library deletes stay immediate (no confirmation) and metadata deletion stays prompt, with a 10 s Undo; image cleanup waits for the Undo window and is best effort.
- Photos come from stored URLs without a Next.js remote-host allowlist (`unoptimized`, so uploads are shrunk on the device instead) and `next/image` loads them lazily; the blurred backdrop is decorative (`aria-hidden`, empty `alt`). The card's Edit and Delete buttons are 44 px (48 px on coarse pointers).
- Shelf tiles in the pantry reuse library photos when a pantry item's name matches a product name exactly (case-insensitive).
- Household data takes precedence over Open Food Facts when the Firestore read succeeds.
- Unknown products and public API failures return no product rather than inventing data; an outage, timeout or rate limit is reported as `unavailable`, never as `none`.
- Camera permission/decode failures produce an error toast (an outcome, not a field problem).
- Replacing or removing an image in an edit deletes the prior managed Storage object after the edit is saved (best effort).
- Missing Storage objects are treated as already cleaned. Other Storage failures can leave an orphaned object and produce a cleanup-specific toast without claiming metadata deletion failed.
- Stored external image URLs render without requiring a Next.js remote-host allowlist and are never treated as managed objects.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- `tests/e2e/tablet-pages.spec.ts` checks `/library` on the wall tablet (1263 × 818, touch): no sideways scroll, every control's hit area at least 48 × 48 and none overlapping (see [Application Shell](../application-shell/README.md)).
- `tests/e2e/shopping-trip.spec.ts` covers the product count wording, product photos and the missing-photo placeholder, search, and saving a product without a photo; `tests/e2e/verification-findings.spec.ts` keeps covering prompt deletes and the add dialog; `tests/e2e/barcode-library-scan.spec.ts` covers "Save to library" from an unknown code (code prefilled, name required, saved without a photo with `createdByUid`, the next scan uses it), Add offering Edit for an existing code, the delete Undo, the "Lookup unavailable" copy and Scan to tick; `tests/e2e/ai-hardening.spec.ts` checks the `none` and `unavailable` sources of the fixtures.
- `tests/unit/barcode-lookup.test.ts` (reply classification, misses, copy), `tests/unit/barcode-library.test.ts` (create, edit, restore, photo cleanup, `?add=`, the delayed photo-delete registry and a restore after the photo is gone, a restore that leaves out a photo, path or name length the create would refuse) and `tests/unit/images-downscale.test.ts` (sizes, ratio, format, quality steps, limits).
- `tests/unit/barcode-scanner-errors.test.ts` covers the error kinds, one toast per kind (a repeat does not toast, a different kind does, a new session does again) and the copy.
- The `content shapes: barcode library` rules suite covers the accepted and refused image URLs, a legacy URL kept on edit, and an Undo of a deleted legacy product: the create with the legacy URL is refused and the create without the photo is accepted.
- On a real phone: Take photo opens the rear camera, a 12 MP photo saves well under 5 MB at 1024 px, and a HEIC photo on iOS Safari is converted.
- Manually test camera denial, manual entry, local-library precedence, public fallback, unknown barcodes, and mapping CRUD.
- Camera release: open a scanner (Pantry > Add Item > Scan Barcode, list Add Item > Scan Barcode, the library), then close it, press Escape, or use browser Back to switch Shopping tabs: the browser's camera-in-use indicator turns off at once, and `chrome://media-internals` (or DevTools > Media) shows the video track ended. `tests/unit/shopping-live.test.ts` checks the scanner stops its tracks and that nested scanners close with their dialog and tab.
- Verify image upload/delete behavior for an existing object, missing object, external URL, no image, and unavailable Storage; metadata deletion must remain prompt.
- Runtime-test the server action while authenticated before claiming the private library lookup always succeeds.

## When This Document Must Be Updated

Update this README when lookup order, APIs, scanner behavior, mapping fields or paths, image handling, Storage restrictions, authentication strategy, or shopping/pantry integration changes.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
