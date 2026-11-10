# Barcode Scanning and Household Library

## Purpose and Scope

This module owns camera/manual barcode capture, household product mappings, product images, and public lookup fallback. Shopping and pantry own the records created after a lookup.

## User-Facing Capabilities

- Manage household barcode mappings at `/library`, shown as a photo-first grid of product cards: the product photo sits on a soft blurred copy of itself that also runs behind the title. Products without a photo, or whose photo fails to load, show a package placeholder with the product's initial (announced as "No product image for <name>").
- See how many products are saved ("1 product", "3 products") and search by name or barcode.
- Scan or enter a barcode when adding shopping or pantry items.
- Create, edit, and delete a barcode-to-product mapping.
- Store a product name and image for household reuse.
- Fall back to Open Food Facts when no household mapping is available.

## Entry Points

- `src/app/library/page.tsx`
- `src/components/barcode-library-client.tsx`
- `src/components/shopping/product-card.tsx`
- `src/components/barcode-scanner.tsx`
- `src/components/image-upload.tsx`
- `src/ai/flows/lookup-barcode-flow.ts`
- Shared `BarcodeLibraryItem` type in `src/lib/types.ts`

## Architecture and Data Flow

`BarcodeScanner` uses the device camera through `react-zxing` and returns a decoded value to its host form. The camera runs only while the scanner is mounted: on unmount (its dialog closed, or the Shopping Center tab that owns it hidden, see [Shopping](../shopping/README.md)) react-zxing resets its reader and `BarcodeScanner` also stops every track of the video's `MediaStream` and clears `srcObject`, so no host can leave the camera on behind a closed or hidden dialog. `lookupBarcode` first attempts the household Firestore mapping and then calls Open Food Facts. The library client manages mappings and uploads images to household-scoped Storage before writing Firestore metadata.

Lookup is an authenticated server action but does not invoke OpenAI generation, does not need `OPENAI_API_KEY`, and remains usable when model configuration is absent. It verifies the Firebase ID token, household membership, and `shopping.view`, then uses Firebase Admin for `households/{householdId}/barcode-library/{barcode}`.

Lookup precedence is household library, Open Food Facts v3, then not found. A household hit prevents any public request. The v3 request asks only for product name, package quantity, normalized quantity/unit, and front image, uses a five-second timeout and HomeHub User-Agent, and treats community data as optional. Tests use emulator-only fixtures and never call production Open Food Facts.

Simple supported quantities (`g`, `kg`, `oz`, `lbs`, `ml`, `L`, `fl oz`, and unambiguous count units) prefill the pantry unit and, for weights and volumes, the size of one package (one package), or for count units the package count. Compound text uses normalized quantity/unit only when both are supported. Serving sizes, unknown measurements, and ambiguous values are not converted; the product name can still prefill and all values remain editable.

## Data Model and Persistence

- Firestore: `households/{householdId}/barcode-library/{barcode}`.
- Storage: `households/{householdId}/barcode-library/{uuid}.{extension}`.
- `BarcodeLibraryItem` contains barcode `id`, `name`, `imageUrl`, optional managed `imagePath`, and ISO `createdAt`.
- The barcode value is the Firestore document ID.

Deleting a mapping removes Firestore metadata first. Storage cleanup runs only for a recognized household barcode path and is best effort; external URLs and empty image values are not passed to Firebase Storage.

## Authentication, Roles, and Security

Routes require an authenticated user and clients derive `householdId` from auth context. Firestore and Storage rules treat `households/{householdId}/members/{uid}` as the only membership authority: the caller needs an approved member record (role `owner`, `admin`, `member`, `child`, or `guest` with `status` `active`), and `households.memberEmails` or user-profile fields never grant access. Pending `newuser` members are blocked. Both rule sets gate by effective permission (role preset plus per-member overrides; owners hold every permission): `shopping.view` to read, `shopping.edit` to create or update, and `shopping.delete` to delete mappings and barcode images.

The server-action lookup receives `householdId` and an ID token from its caller, verifies the token and the caller's member record with Firebase Admin, and requires `shopping.view` before reading the household mapping. Admin reads bypass security rules, so this server-side check is the authorization boundary for lookup.

The library UI follows the same permissions: Add Item and Edit appear with `shopping.edit`, Delete with `shopping.delete`, and without `shopping.view` the page explains that the library is not shared (after membership has loaded, so it never flashes). The Shopping Center hides its Barcode Library link without `shopping.view`.

Firestore rules also validate product shapes (QA-8, BL-17): a product may only set `name` (1 to 200 characters), `imageUrl`, `imagePath` and `createdAt`, and the barcode ID is at most 128 characters on create. A written `imageUrl` must be empty, a Firebase Storage download URL for this household's `barcode-library/` folder in this project's bucket (`homehub-j91jb.appspot.com` or `homehub-j91jb.firebasestorage.app`, or the Storage emulator for `demo-` projects), or an Open Food Facts image (`images.` or `static.openfoodfacts.org`/`.net`); `imagePath` must be `households/{householdId}/barcode-library/<file>`. Only changed keys are checked on update, so an existing product whose stored `imageUrl` predates the rule can still be renamed while its image stays as is.

Storage rules accept barcode-image creates and updates only when the object is 5 MB or smaller and its content type is `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, or `image/avif`. The shared upload UI also validates images client-side.

## Integrations and Background Processing

- Camera decoding: `react-zxing` and `@zxing/library`.
- Public fallback: `https://world.openfoodfacts.org/api/v0/product/{barcode}.json`.
- Authorized action and Open Food Facts fallback: `src/ai/flows/lookup-barcode-flow.ts`.
- Quantity normalization: `src/ai/barcode-quantity.ts`.
- No Cloud Function or scheduled processing is involved.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) consumes lookup results for list items.
- [Pantry Inventory and Recipes](../pantry-recipes/README.md) consumes lookup results for inventory and product photos for its shelf tiles.
- [Application Shell](../application-shell/README.md) supplies `EmptyState`, `FieldError` and `toastError`.
- [AI and OpenAI](../ai-genkit/README.md) supplies shared server authorization and sanitized action errors; barcode lookup itself is model-free.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply household context.
- [Firebase Platform](../firebase-platform/README.md) owns Firestore and Storage configuration.

## Invariants and Failure Behavior

- A new mapping requires an image in the current UI. A missing photo is shown inline under the image field (`FieldError`), never as a toast; the barcode must be 1 to 64 characters without `/`, and the scanner's manual entry (6 to 32 digits) also reports problems inline.
- Save, load and delete failures use `toastError`, so raw Firebase text never reaches users.
- Library deletes stay immediate (no confirmation) and metadata deletion stays prompt; image cleanup is still best effort.
- Photos come from stored URLs without a Next.js remote-host allowlist (`unoptimized`); the blurred backdrop is decorative (`aria-hidden`, empty `alt`).
- Shelf tiles in the pantry reuse library photos when a pantry item's name matches a product name exactly (case-insensitive).
- Household data takes precedence over Open Food Facts when the Firestore read succeeds.
- Unknown products and public API failures return no product rather than inventing data.
- Camera permission/decode failures produce an error toast (an outcome, not a field problem).
- Replacing an image does not delete the prior Storage object.
- Missing Storage objects are treated as already cleaned. Other Storage failures can leave an orphaned object and produce a cleanup-specific toast without claiming metadata deletion failed.
- Stored external image URLs render without requiring a Next.js remote-host allowlist and are never treated as managed objects.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- `tests/e2e/shopping-trip.spec.ts` covers the product count wording, product photos and the missing-photo placeholder, search, and the inline missing-photo error; `tests/e2e/verification-findings.spec.ts` keeps covering prompt deletes and the add dialog.
- Manually test camera denial, manual entry, local-library precedence, public fallback, unknown barcodes, and mapping CRUD.
- Camera release: open a scanner (Pantry > Add Item > Scan Barcode, list Add Item > Scan Barcode, the library), then close it, press Escape, or use browser Back to switch Shopping tabs: the browser's camera-in-use indicator turns off at once, and `chrome://media-internals` (or DevTools > Media) shows the video track ended. `tests/unit/shopping-live.test.ts` checks the scanner stops its tracks and that nested scanners close with their dialog and tab.
- Verify image upload/delete behavior for an existing object, missing object, external URL, no image, and unavailable Storage; metadata deletion must remain prompt.
- Runtime-test the server action while authenticated before claiming the private library lookup always succeeds.

## When This Document Must Be Updated

Update this README when lookup order, APIs, scanner behavior, mapping fields or paths, image handling, Storage restrictions, authentication strategy, or shopping/pantry integration changes.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
