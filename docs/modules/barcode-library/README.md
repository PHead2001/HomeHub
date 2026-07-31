# Barcode Scanning and Household Library

## Purpose and Scope

This module owns camera/manual barcode capture, household product mappings, product images, and public lookup fallback. Shopping and pantry own the records created after a lookup.

## User-Facing Capabilities

- Manage household barcode mappings at `/library`.
- Scan or enter a barcode when adding shopping or pantry items.
- Create, edit, and delete a barcode-to-product mapping.
- Store a product name and image for household reuse.
- Fall back to Open Food Facts when no household mapping is available.

## Entry Points

- `src/app/library/page.tsx`
- `src/components/barcode-library-client.tsx`
- `src/components/barcode-scanner.tsx`
- `src/components/image-upload.tsx`
- `src/ai/flows/lookup-barcode-flow.ts`
- Shared `BarcodeLibraryItem` type in `src/lib/types.ts`

## Architecture and Data Flow

`BarcodeScanner` uses the device camera through `react-zxing` and returns a decoded value to its host form. `lookupBarcode` first attempts the household Firestore mapping and then calls Open Food Facts. The library client manages mappings and uploads images to household-scoped Storage before writing Firestore metadata.

The lookup flow is implemented as a Genkit flow/server action but does not invoke a generative model.

## Data Model and Persistence

- Firestore: `households/{householdId}/barcode-library/{barcode}`.
- Storage: `households/{householdId}/barcode-library/{uuid}.{extension}`.
- `BarcodeLibraryItem` contains barcode `id`, `name`, `imageUrl`, and ISO `createdAt`.
- The barcode value is the Firestore document ID.

Deleting a mapping attempts to remove the referenced Storage object, but metadata deletion continues when the object is already missing or Storage deletion fails.

## Authentication, Roles, and Security

Routes require an authenticated user and clients derive `householdId` from auth context. Firestore and Storage rules allow approved household members and legacy members listed in `households.memberEmails`; pending `newuser` members are blocked.

The server-action lookup receives `householdId` from its caller and uses the Firebase web client SDK. Whether server-side Firebase Auth state satisfies Firestore rules requires authenticated runtime verification. A local-library read failure is swallowed and lookup continues to the public API.

Storage rules scope paths by household but do not impose barcode-image size or content-type limits. The shared upload UI performs client-side image validation.

## Integrations and Background Processing

- Camera decoding: `react-zxing` and `@zxing/library`.
- Public fallback: `https://world.openfoodfacts.org/api/v0/product/{barcode}.json`.
- Genkit registration: `src/ai/flows/lookup-barcode-flow.ts`.
- No Cloud Function or scheduled processing is involved.

## Cross-Module Dependencies

- [Shopping](../shopping/README.md) consumes lookup results for list items.
- [Pantry Inventory and Recipes](../pantry-recipes/README.md) consumes lookup results for inventory.
- [AI and Genkit](../ai-genkit/README.md) registers the server flow.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply household context.
- [Firebase Platform](../firebase-platform/README.md) owns Firestore and Storage configuration.

## Invariants and Failure Behavior

- A new mapping requires an image in the current UI.
- Household data takes precedence over Open Food Facts when the Firestore read succeeds.
- Unknown products and public API failures return no product rather than inventing data.
- Camera permission/decode failures produce an error toast.
- Replacing an image does not delete the prior Storage object.
- Deleting metadata can succeed after Storage cleanup fails, leaving an orphaned object.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes.
- Manually test camera denial, manual entry, local-library precedence, public fallback, unknown barcodes, and mapping CRUD.
- Verify image upload/delete behavior and cross-household denial.
- Runtime-test the server action while authenticated before claiming the private library lookup always succeeds.

## When This Document Must Be Updated

Update this README when lookup order, APIs, scanner behavior, mapping fields or paths, image handling, Storage restrictions, authentication strategy, or shopping/pantry integration changes.
