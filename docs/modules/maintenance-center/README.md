# Maintenance Center

## Purpose and Scope

This module owns home assets, vehicles, maintenance logs, embedded service schedules, maintenance attachments, due-state calculation, and maintenance notification creation. It does not own general notification presentation, shared AI configuration, or background push delivery.

## User-Facing Capabilities

- Use Overview, Home Assets, Vehicles, Reminders, and Logs tabs at `/maintenance`.
- Create, view, edit, and delete assets; manage multiple schedules and linked logs.
- Create, view, edit, and delete vehicles; separate sold/retired vehicles; manage multiple service schedules.
- Create general, asset, or vehicle logs; view, edit, delete, attach files, and request an AI summary.
- Complete an asset/vehicle schedule by creating a routine log and advancing due values.
- Upload, open/download, categorize, and delete attachments.
- Review date/mileage reminders and act on them in place: **Mark done**, **Log service**, **Snooze 1 week**, or **Open** the asset/vehicle (see "Reminder actions").
- See a 0-100 **home health score** on Overview (dial, band label and the deductions behind it, each linking to its item from a row at least `--target-min` tall: 44 px, 48 px on touch screens) and a small health ring on every active asset and vehicle card and detail panel (see "Home health score").
- Asset and vehicle cards are photo-first (H30, `PhotoBand`): the newest image attachment of that asset or vehicle (`pickTargetPhoto`, preferring the `photo` category) fills a fixed 80 px band over a blurred copy of itself; without one, the category icon (a car for vehicles) on a token gradient. Vehicles upload photos through the same attachment panel and Storage path as assets (`households/{householdId}/maintenance/vehicle/{vehicleId}/…`, already allowed by the existing `storage.rules` match), so no rule changed.
- **Brand logos** (H30): `BrandLogo` (`src/components/brand/brand-logo.tsx`) matches an asset's `brand` or a vehicle's `make` against a catalog of 223 household brands (`src/lib/maintenance/brands.ts`: cars and motorcycles, appliances, small kitchen, cleaning, HVAC and water, smart home and electronics, tools and lawn, plumbing, pool). 68 brands have a monochrome Simple Icons mark (CC0 path data in `src/components/brand/brand-marks.ts`, loaded once as its own lazy chunk by dynamic import, never in a first-paint bundle and never fetched from the network); the other 155 get one consistent monogram badge (short name or initials in the app's headline type). Both draw in `currentColor`, so they follow every theme. Matching ignores case, accents, punctuation, spaces, "&"/"+"/"and" and trailing company words (Inc, Appliances, Motor Company, Electronics…), knows aliases (Chevy→Chevrolet, VW→Volkswagen, Mercedes/Benz→Mercedes-Benz, GE Appliances→GE, SharkNinja→Ninja, Roomba→iRobot, Kitchen Aid→KitchenAid, Honda Power→Honda…), accepts leading words ("Whirlpool Gold"→Whirlpool), and tolerates typos with optimal-string-alignment Damerau-Levenshtein distance 1 for 5–7 letters and 2 for 8 or more, choosing the single closest brand and refusing ties; names of 4 letters or fewer (GE, LG, Kia) match only exactly, and placeholders ("Generic", "N/A") never match. Logos show once on each asset and vehicle card (beside the title), in the detail panel header and in the Attention Queue. Where the brand is not printed as text (asset cards, Attention Queue assets) the mark is an image named after the brand ("Bosch"); elsewhere it is `aria-hidden`.
- **Warranty countdown ring** (H10): an asset with a warranty end date shows a small ring beside its health ring, filled with the share of the warranty term still left and the days left inside ("9d"; years from 1,000 days, "0d" once ended). Its accessible name reads e.g. "Main HVAC System: Warranty: 9 days left of 1,551". The ring turns amber within 30 days and grey once ended. HomeHub stores no warranty start date, so the term runs from the asset's **purchase date** when it is set and earlier than the end date; otherwise the term is assumed to be **one year** ending on the warranty end date (`warrantyCountdown()` in `src/lib/maintenance/warranty.ts`, `WARRANTY_FALLBACK_DAYS = 365`). Days are counted on the household's local day. The ring sweeps from full on load (550 ms, value only; instant under reduced motion).
- **Odometer** (H10): a vehicle card shows its mileage as odometer wheels (at least six, leading zeros), each rolling to its digit (transform only, 550 ms, wheels a few ms apart; final digits at once under reduced motion). Screen readers get the plain value ("48,750 miles"), which is also part of the card's accessible name; the wheels are `aria-hidden`.
- Detail panels list only the fields that have a value (no "Not recorded"); Edit, "Add details" (its accessible name adds "(N empty)") and Delete share one action row that fits the desktop detail column, with Delete set apart on the right; it wraps only on very narrow screens. The attachment header (category, Upload) wraps by its own width, so it never overflows the narrow detail column.
- Controls follow the member's maintenance permissions: Add/Edit/Complete/Snooze/Upload need `maintenance.edit`, Add Log needs `maintenance.createLogs`, Mark done and Complete need both, Delete (records, logs, attachments) needs `maintenance.delete`. A member without `maintenance.view` sees a "not shared with you" state and no queries run.

## Entry Points

- `src/app/maintenance/page.tsx`
- `src/components/maintenance-log-client.tsx`
- `src/components/maintenance/` (`asset-card.tsx`, `vehicle-card.tsx`, `photo-band.tsx`, `health-ring.tsx`, `health-panel.tsx`, `reminder-list.tsx`, `warranty-ring.tsx`, `odometer.tsx`; library components not yet on the page: `cost-summary.tsx`, `filter-chips.tsx`, `print-label.tsx`, see "Insights, filters and QR labels")
- `src/components/brand/brand-logo.tsx` and `brand-marks.ts` (brand logos; the app's own mark in `logo.tsx` is separate)
- `src/lib/maintenance/` (pure: `health.ts` score, `schedules.ts` completion/snooze/schedule keys, `reminder-copy.ts` card copy, `display.ts` summary/photo/field rules, `warranty.ts` warranty countdown, `odometer.ts` odometer digits, `brands.ts` brand catalog and matcher; library modules not yet used by the page: `links.ts` which logs belong to an item, `costs.ts`, `mileage-prediction.ts`, `history-line.ts`, `filters.ts`, `qr-label.ts`)
- `src/ai/flows/summarize-maintenance-log.ts`
- Maintenance types in `src/lib/types.ts`
- Maintenance-specific matches in `firestore.rules` and `storage.rules`

## Architecture and Data Flow

`MaintenanceLogClient` loads four collections together: assets, vehicles, logs, and attachment metadata. It does not query notifications on load; it reads them only to resolve reminders: when a schedule is completed or snoozed (one `sourceType`, `sourceId` in the schedule id plus its legacy ids) and when a registry record is deleted (the record's source types; the id prefix is matched in the browser). Both queries are audience-constrained (`notificationsBySourceQuery`, `array-contains-any [uid, '*']`); maintenance reminders are household-wide (`['*']`), so every member finds all of them, while a reminder without `audience` (not backfilled) is not found and stays open until it expires. Assets and vehicles embed schedule arrays. Reminder cards and server notifications share one builder (`functions/src/shared/maintenance-reminders.ts`) evaluated in the household timezone. Retired assets and retired/sold vehicles produce no reminders; warranties and vehicle documents "expire" rather than become "overdue". Notification documents are created by the server, not by opening this page.

Completing a schedule creates a routine log and writes the updated embedded schedule. Vehicle completion can also update current mileage. The completion dialog and one-tap Mark done share one implementation (`applyScheduleCompletion`, advancement from `src/lib/maintenance/schedules.ts`).

Motion (H12): asset and vehicle grids enter with `Stagger`; selecting a card morphs it into the detail panel with a View Transition (`useInPageMorph` from `src/components/shopping/use-in-page-morph.ts`: the shared `view-transition-name` sits on the clicked card before the change and on the detail card after it, and is removed when the transition ends). Reduced motion, a browser without View Transitions, or a modified click (Shift/Ctrl/Cmd/Alt) just selects. The Overview and Reminders summary counts and the 30-day spend tick up with `NumberTicker` (`src/components/motion/number-ticker.tsx`): its only text node is always the final value, and the moving digits are painted by CSS, so the text and accessible name never carry an in-between number. Attention Queue links have peek cards (brand/model, health, location or mileage).

Only the first load shows the loading skeleton. Refreshes after a save, delete, completion or snooze are silent: the page stays on screen (so reminder actions stay in place) and a failed refresh shows a `toastError` toast instead of the error card.

### Reminder actions

Reminder cards show the title, a status badge, the related asset/vehicle and one "when" line (for example "Due Jul 1, 2026 · 4 weeks ago" or "At 49,000 mi · 250 mi to go"); the builder's sentence ("... is overdue") is no longer repeated under the badge. Warranties and vehicle documents read "Expired" / "Expires today" / "Expires soon", never "Overdue".

- **Mark done** (schedules and vehicle services only; needs `maintenance.edit` and `maintenance.createLogs`): the H05 completion check (`CompletionCheck` and `useConfetti`, imported from Chores) at the start of the card. One tap fills the box and draws the check at once (150 ms), fires a small confetti burst from it (once per reminder, skippable by any input, none under reduced motion), plays the `complete` feedback, and completes the schedule today, at the vehicle's recorded mileage, with the next due date/mileage advanced by the schedule's interval. It writes the same routine log, schedule update and notification resolution as the completion dialog. When the next due values cannot be worked out (no interval, or a mileage interval with no recorded mileage) the completion dialog opens instead and the check is not drawn; a failed write unchecks it. The drawn check is keyed by the reminder's cycle (`reminderCycleKey`: id, due date and due mileage), so when a schedule completed early shows its next cycle under the same reminder id, that card starts unchecked with its actions enabled.
- **Log service** (schedules and vehicle services only; needs `maintenance.createLogs`): opens the Add Maintenance Log form filled in for that asset or vehicle and schedule (target, schedule name as title, routine type, today, the vehicle's current mileage). When the member can also complete schedules (`maintenance.edit`), the dialog says "Saving marks … done …" and saving writes the log with its details (cost, provider, parts, notes) through the same `applyScheduleCompletion` as Mark done, advancing the schedule from the log's date and mileage and resolving the reminder. Switching the form to another asset, vehicle or General makes it an ordinary log. Like Mark done, Log service never writes a schedule without a next due: a schedule whose next due cannot be advanced from its interval (an explicit date or mileage with no repeat) opens the completion dialog instead of the log form, and a mileage-interval service saved without a mileage gets an inline "Enter the mileage" error (`serviceCompletionValues` in `schedules.ts`, shared with Mark done).
- **Snooze 1 week** (date-driven schedule and service reminders only; needs `maintenance.edit`): sets the schedule's `nextDueDate` to 7 days after the later of today and the current due date (an `updateDoc` of the schedule array and `updatedAt` only), and records `snoozedUntil` on that schedule (the same date), then resolves the current cycle's notifications (best effort). Vehicle services that are due by mileage, warranties and documents cannot be snoozed, because moving a date would not change them.
- **Open**: selects the asset or vehicle and highlights the schedule. Hovering (fine pointer) or keyboard-focusing it for 400 ms shows a peek card (H26) with the item, reminder and due line.
- Cards enter with the shared stagger (≤ 30 ms apart, ≤ 400 ms total). A card that leaves a list fades out in 220 ms, after the check has drawn (instant under reduced motion).

Compatibility with the hourly `householdUpkeep` job: both actions change the schedule's due date, which changes the reminder's `stateKey`, so the next run creates a notification only if the new state is still actionable. A snooze is quiet: the shared builder (`functions/src/shared/maintenance-reminders.ts`) marks a reminder `snoozed` while the schedule's `snoozedUntil` equals its `nextDueDate` and the status is upcoming or due soon, and `actionableReminders` skips snoozed reminders, so no "due soon" push follows a snooze. On the due day the reminder becomes "due today" and notifies as usual. Completing the schedule removes `snoozedUntil` explicitly (`completedAssetSchedule` / `completedVehicleSchedule`), even when the new cycle lands on the snoozed date. Editing the due date changes `nextDueDate`, so a stale `snoozedUntil` never applies. Other edits to the asset or vehicle keep it: the edit form carries `snoozedUntil` through unchanged. A vehicle service that becomes due by mileage still notifies. The resolved old document is never refreshed because upkeep skips documents with `resolvedAt`. A snoozed item still appears under Due Soon in the Maintenance Center, with its new date. Tests: `tests/server/reminders-shared.test.ts` (snoozed maintenance reminders).

### Home health score

`computeHomeHealth` (`src/lib/maintenance/health.ts`) uses the same reminder builder as the Reminders tab and the server, evaluated in the household timezone, over active assets and vehicles (retired assets and retired/sold vehicles are ignored; with none left there is no score and Overview shows the assets empty state).

Deductions per reminder:

| Reminder | Points |
|---|---|
| Schedule/service overdue | 10, plus 2 per full 30 days late or per full 500 miles over (whichever is larger), at most 20 |
| Schedule/service due today | 5 |
| Schedule/service due soon (14 days / 500 miles) | 2 |
| Registration/inspection expired | 15 |
| Registration/inspection expires today | 5 |
| Registration/inspection expires soon | 2 |
| Warranty ends today or soon | 2 (an already expired warranty costs nothing) |
| Asset or vehicle flagged "Needs attention" | 10 |

Bonus: each log linked to the item and dated in the last 90 days adds 2, at most 6 per item.

- Item score = 100 - its deductions + its bonus, clamped to 0-100.
- Home score = 100 - every deduction + the items' bonuses (at most 10 in total), clamped to 0-100.
- Bands: 85 and up "In good shape" (success color), 60-84 "Needs some care" (warning), below 60 "Needs attention" (destructive).

The Overview dial uses `NumberTicker` and a ring that sweeps to the value in 550 ms (value only, never blocking); under reduced motion both show the final value at once. Every ring is `role="img"` with a full text equivalent ("Home health 79 out of 100, needs some care."). The "Why this score" list shows the five largest deductions ("−12 Main HVAC System: Replace air filter is 3 months overdue"), with "Show N more", and each row opens its item.

### Insights, filters and QR labels (library)

Status: library; wired into the page in the integration PR. The modules below are pure and unit tested, and the components take props only; `MaintenanceLogClient` does not use any of them yet, so none of this is visible on `/maintenance` today.

**Which logs count.** `links.ts` (`isLinkedTo`, `linkedLogs`) uses the same rule as the health score: a log's `targetType`, or for legacy logs the one implied by `assetId`/`vehicleId`, and the matching id. Logs of a deleted record are general logs (only `formerTargetName` remains) and are never counted for any item.

**Costs (MA-28, `costs.ts`, `CostSummary`).** Costs are read as US dollars. HomeHub stores no currency per log, so multi-currency households are not supported and nothing is converted. A cost counts when it is a finite number above zero. A missing or non-numeric cost is left out and reported ("2 logs without a cost"). Zero and negative costs are left out silently.
- **Lifetime cost** is the sum of the live-linked logs.
- **Spend per year** groups costs by calendar year in the household timezone (`toDay`), newest first. Logs with a missing or unreadable date go under "Undated", last; they are never dropped. The years always add up to the lifetime total.
- **Cost per mile** (vehicles only) is the lifetime cost divided by the miles between the lowest and highest readings (linked logs' `mileage` plus `currentMileage`). It needs at least two readings spanning more than 500 miles, otherwise "Not enough mileage data"; with no costs it reads "No costs recorded yet".
- **Repair versus replace:** when the counted costs of `repair` and `replacement` logs pass 50% of `purchasePrice`, the summary reads "Repairs have cost about N% of the purchase price" (N rounded). When there are repair costs but the price is missing, zero, negative or not a number, it reads "Add the purchase price to compare".
- **Rounding:** totals show in whole dollars (`formatWholeDollars`); cost per mile shows in cents ("$0.12 per mile"), because whole dollars would read $0.

**Mileage estimate (MA-29, `mileage-prediction.ts`).** This is an estimate shown beside a mileage reminder. It never replaces the due date or mileage trigger in `maintenance-reminders.ts`.
- **Readings** (`vehicleReadings`) are linked logs with both a mileage and a readable date, plus `currentMileage` when the vehicle has a `mileageUpdatedAt`. Nothing writes that field yet (the M1 completion operation adds it); it is not in `types.ts` yet and is read when present. A current mileage without that date is not a dated reading.
- **Cleaning** (`cleanReadings`) keeps readings from the last 365 days and none after today. It then keeps the longest date-ordered chain in which each reading is at or above the previous one and rises no faster than 1,000 mi/day; between equally long chains, the one whose fastest step is slower wins. A backdated reading or a typo, too high or too low, drops out without taking its neighbours with it.
- **Fit:** after cleaning, an estimate needs at least 3 readings spanning at least 30 days. The rate is the Theil-Sen median of the pairwise slopes, and the range uses the 25th to 75th percentile slopes (the slow end is never below half the median).
- **Result:** `predictDueDate(nextDueMileage, readings, today)` counts from the latest cleaned reading and returns `{date, low, high, basis, milesPerDay}`. Otherwise it returns `{insufficient}` with one of `no-due-mileage`, `too-few-readings`, `too-short-span`, `no-increase`, `already-reached` (the reminder already says it is due) or `too-far` (more than 730 days away, decided on the day count before any date is built, so a very slow rate cannot overflow the four-digit-year calendar helpers). An estimate earlier than today is moved to today, and the late end of the range is capped at 730 days.
- **Copy:** "Estimated around Mar 12, based on 6 readings", with the year added when it is not this year.

**Service history line (MA-32, `history-line.ts`).** "Replace air filter last done 3 months ago by Sam". The source is the newest live-linked log dated on or before today in the household zone; on the same day, the later `createdAt` wins, then the id. Relative time reads "today", "yesterday", "N days ago", then weeks, months and years, using the reminder cards' `spanLabel`.
- **Per schedule:** logs carry no schedule id. Completing a schedule writes a log titled with the schedule name, so a schedule's history is its logs whose title (or legacy `item`) matches the name, ignoring case and spacing. An edited Log service title therefore no longer matches.
- **"by …"** comes only from `doneByName`. Nothing writes that field yet: the server-side completion operation (Maintenance M1) will add it to new logs, so until then every log, new or legacy, shows no author. It is not in `types.ts` yet and is read when present. It goes through `publicDisplayName(name, '')`, so an email or a blank name leaves "by …" out. Legacy logs never get a guessed name.

**Filters and search (MA-21, `filters.ts`, `FilterChips`).**
- **URL:** `parseFilters` and `serializeFilters` read and write `?location=`, `?category=` and `?q=` (search capped at 100 characters). Serializing copies the current query and changes only those three keys, so `tab`, `asset`, `vehicle`, `log` and `schedule` are kept.
- **Location** matching ignores case and extra spaces. "Unassigned" matches assets with no location. `matchesRoom(location, roomName)` is the same comparison and is exported for MA-26 (a registered tablet's room).
- **Categories** are the asset categories. Vehicles have neither field: they form the category "Vehicle" and are hidden while a location filter is on.
- **Logs and reminders** follow their asset or vehicle. General logs, including logs of deleted records, are hidden while a location or category filter is on.
- **Search** requires every word to appear in one field of the item: assets by name, brand, model, location and notes; vehicles by nickname, make, model and plate; logs by title (or `item`), provider, parts and notes; reminders by title and the item's name.
- **Chips:** `locationChips` and `categoryChips` list the distinct values with counts. The label is the first spelling seen; "Unassigned" and "Vehicle" come last.
- **Pagination:** `paginateLogs(logs, page)` gives 20 logs per page in a stable order: date newest first (unreadable dates last), then `createdAt` newest first, then id. Out-of-range pages are clamped.
- **`FilterChips`** is one horizontally scrollable row ("All" plus each chip) of `aria-pressed` toggle buttons, each at least `--target-min` (44 px, 48 px on touch). Choosing the selected chip clears it.

**QR labels (MA-31, `qr-label.ts`, `PrintLabel`).**
- **Link:** `maintenanceDeepLink(origin, target)` returns `<origin>/maintenance?asset=<id>` or `?vehicle=<id>` with the id URL-encoded. Only the scheme, host and port of `origin` are kept. A non-http(s) origin or an empty id gives null. The link carries no token, household id or credentials. Opening it still needs a signed-in member with `maintenance.view` (a signed-out visitor gets the in-place sign-in prompt on the same URL; a member without the permission sees "Maintenance isn't shared with you"). An id that is not in the member's household (deleted, or never theirs) selects the list tab and shows "The requested home asset is no longer available." (or the vehicle version), the existing deep-link behavior in `MaintenanceLogClient`.
- **Drawing:** the QR is drawn as an inline SVG path from `@zxing/library`'s encoder, the library already used for the device setup QR, so no dependency was added. It uses error correction M, UTF-8 and a 4-module quiet zone, dark on white in every theme.
- **`PrintLabel`** shows the name, the location, the QR (`role="img"`, "QR code that opens … in HomeHub") and "Scan to open in HomeHub", plus a "Print label" button.
- **Printing:** "Print label" copies the label into a sheet at the end of `<body>`, marks `<html>` (`data-print-label`) and calls `window.print()` (`beginLabelPrint`, `PRINT_LABEL_CSS`). The `@media print` rules apply only while that mark is set: every other child of `<body>` is removed from the layout, so the label prints alone on one page even from a dialog, black on white in a dark theme. The sheet never shows on screen. The sheet and mark are removed on `afterprint` and on unmount, so other printing is unchanged. This was checked once in Chromium (a 4-page page printed as 1 page with black text on white); there is no automated browser test yet.

## Data Model and Persistence

- Assets: `households/{householdId}/home-assets/{assetId}`.
- Vehicles: `households/{householdId}/vehicles/{vehicleId}`.
- Logs: `households/{householdId}/maintenance/{logId}`.
- Attachment metadata: `households/{householdId}/maintenance-attachments/{attachmentId}`. `uploadedByUid` and `uploadedByName` record the uploader; the name is the profile's display name through `publicDisplayName` ("Member" when it is missing or an email), never the email. `scripts/ops/scrub-remaining-emails.mjs` rewrites older names that are an email (see [Household Governance](../household-governance/README.md), "Email copies").
- Reminder notifications: `households/{householdId}/notifications/{notificationId}`.
- Attachment objects: `households/{householdId}/maintenance/{targetType}/{targetId}/{attachmentId}-{sanitizedFileName}`.

Shared types include `HomeAsset`, `HomeAssetSchedule`, `MaintenanceScheduleMode`, `Vehicle`, `VehicleServiceSchedule`, `MaintenanceLog`, and `MaintenanceAttachment`. Schedules carry a stable optional `id` and `mode` of `scheduled` or `checklist`. Legacy name-only schedules normalize to checklist presentation without a destructive migration. Legacy logs fall back from missing `title` to `item`, infer target type from IDs, and default missing log type to `other`.

When an asset or vehicle is deleted, linked historical logs are preserved as general maintenance records. The original relationship is retained in optional `formerTargetType` and `formerTargetName` fields while the live `assetId` or `vehicleId` is removed.

Deep links use `/maintenance?asset={id}`, `?vehicle={id}`, `?log={id}`, or `?tab={overview|assets|vehicles|reminders|logs}`. Choosing a tab replaces the URL with `?tab=` (Overview has no parameter), so refresh and Back keep the tab. A deep link is applied once per URL after data loads; later refreshes do not pull the page back to the linked record. Schedule reminders add a URL-encoded `schedule={ownerId}:{scheduleId}`. Valid links select the matching tab/detail and highlight schedules/logs; missing IDs select the relevant list tab and show a non-destructive status message. Legacy `targetType`/`targetId` links remain accepted.

## Authentication, Roles, and Security

Clients derive household paths from the authenticated user. Pending `newuser` members are denied and legacy members remain supported.

Attachment metadata creation validates matching `householdId`, target/category values, path prefix, and `uploadedByUid == request.auth.uid`. Storage allows approved members, limits files to under 15 MiB, and accepts images, PDF, plain text, Word, and OpenXML documents.

Firestore rules enforce the granular permissions (with per-member overrides): reads need `maintenance.view`; asset/vehicle create and update and attachment metadata create need `maintenance.edit`; log create needs `maintenance.createLogs` and log update `maintenance.edit`; deletes need `maintenance.delete`; resolving a maintenance notification needs `maintenance.edit` and may only change `resolvedAt`/`resolvedBy`. The page hides controls a member cannot use (see capabilities); the rules remain the authority. Reminder actions use only these existing writes.

Shape validation (QA-8): logs, home assets and vehicles may only set the fields of `MaintenanceLog`, `HomeAsset` and `Vehicle` in `src/lib/types.ts` (logs include the legacy `item`, `summary`, `receiptUrl`, `formerTargetType` and `formerTargetName`). A `householdId` field, when present, must equal the household in the path, on create and update. Enums are checked (`targetType`, log `type`, asset and vehicle `status`, `formerTargetType`), numbers must be numbers (no range: the forms accept any finite value), short text is bounded at 1000 characters and notes, parts and summaries at 20000; `schedules` and `serviceSchedules` must be lists of at most 100 entries (their entries are not inspected). On update only added or changed keys are checked, so schedule completion, which re-writes the whole record, keeps working on records with legacy fields.

## Integrations and Background Processing

- AI summaries use the authenticated `summarizeMaintenanceLog` OpenAI action; generated summaries remain client state and original notes are unchanged.
- The homepage overview uses `maintenance.view` to calculate status, schedule/checklist, date, mileage, warranty, registration, and inspection signals server-side. Only bounded labels/dates/counts reach the optional narrative; serial numbers, VINs, plates, costs, notes, and attachment paths are excluded.
- Date due-soon threshold: 14 days.
- Mileage due-soon threshold: 500 miles.
- The hourly `householdUpkeep` Cloud Function (`functions/src/index.ts` → `functions/src/reminders.ts`) runs the same idempotent step for every household; the Chores page also runs it on demand through `syncHouseholdUpkeep` (`src/app/chores/actions.ts`, authorized by `chores.view`) so a new recurring assignment appears immediately. A notification for something still overdue is re-surfaced within two days of expiry rather than allowed to disappear (so the Firestore TTL policy on `expiresAt` never deletes a still-actionable reminder): its `expiresAt` is extended and its `createdAt` moves to the refresh time, so the 7-day notification lists include it again, while an earlier dismissal still stands. A resolved one is reopened only if upkeep still finds it actionable with the same state (for example the completion never reached the schedule) and it was resolved before that run read its data; it sends no new push. Upkeep writes nothing for a household being deleted.
- New notification documents can trigger FCM through the shared Cloud Function.
- Physical notification expiration requires Firestore TTL on `expiresAt`.

## Cross-Module Dependencies

- [Notifications](../notifications/README.md) displays, dismisses, resolves, and pushes maintenance notices.
- [AI and OpenAI](../ai-genkit/README.md) owns OpenAI configuration, authorization, and deterministic test behavior.
- [Identity and Profile](../identity-profile/README.md) and [Household Governance](../household-governance/README.md) supply user and household context.
- [Firebase Platform](../firebase-platform/README.md) owns persistence initialization and rules.
- [Application Shell and Dashboard](../application-shell/README.md) reads assets and vehicles read-only for the dashboard and computes its "next maintenance", HVAC and car states with the shared `buildMaintenanceReminders` (so retired assets and retired or sold vehicles never appear there either), linking to each reminder's own deep link. The command palette logs maintenance directly after the member confirms a preview card ("oil change 48,200 miles", or the same read by its AI fallback), gated by `maintenance.createLogs`, the permission the rules require to create a log. The log is a `maintenance` document shaped like this module's "Add log" form (`quickMaintenanceLog` in `src/lib/dashboard/quick-add-writes.ts`, written by `logMaintenance` in `src/components/command/quick-add-actions.ts`): an id that is always new (a readable slug plus a Firestore auto-id, `quickCreateId`, so a queued offline write can never overwrite a log), `targetType` vehicle, home_asset or general with its `vehicleId`/`assetId`, `title` and legacy `item`, today's date, `type: 'routine'`, `createdAt`/`updatedAt`, and the odometer reading as `mileage` on vehicle logs only (without a vehicle it goes into `notes` so it is not lost). The preview names the vehicle (nickname, make or model in the sentence; the only active vehicle is preselected), and with a reading but several vehicles none named, Confirm waits until one is chosen; Confirm also waits until the palette has loaded the household's vehicles and assets, so a reading is never saved as a general log just because the vehicles were not known yet; if the vehicles or assets could not be read, Confirm stays disabled with a note and a Try again button; a reading below the vehicle's recorded `currentMileage` gets a warning. Like the Add log form it does not change the vehicle's `currentMileage`, schedules or reminders. Offline the write is queued (`awaitWriteUnlessOffline`, "Saved offline"), a rejected write is reported with `toastError` and the preview stays open. Afterwards the palette dispatches `homehub:data-changed` with `module: 'maintenance'`; this page loads with one-time reads and does not subscribe to it yet, so a log added while the page is open appears on its next load.

## Invariants and Failure Behavior

- Invalid/missing dates are ignored; mileage reminders require current and next-due mileage.
- Scheduled entries require a date/frequency or mileage due mechanism appropriate to their owner. Explicit checklist entries may contain only a name and never show a Complete action.
- Notification IDs hash stable source type, persisted owner/schedule identity, and a `stateKey` containing due status plus meaningful due date/mileage. Transactions make overlapping synchronization idempotent.
- Read/dismiss history remains on an existing reminder document. A changed due status/date/mileage produces a new identity; completing a schedule resolves the current cycle and advances the embedded schedule.
- Asset and vehicle photos are plain `<img>` elements on the attachment's `downloadUrl` (`alt=""`, the name is printed next to them) inside a fixed 80 px band, so loading never shifts layout; an image that fails to load falls back to the category art. A brand logo reserves its box while the artwork chunk loads, so a badge never flashes before a logo. Only image content types (PNG, JPEG, WebP, GIF, AVIF) are used, preferring the `photo` category; SVG and PDFs are ignored.
- Field problems are shown inline: schedule rows use `FieldError` (focus moves to the first bad schedule name), and the log dialog's missing asset/vehicle uses the form field's message. Failures use `toastError`/`friendlyError`, except AI summary errors, whose messages are already user-safe from the AI module.
- "Summarize with AI" is offered only for notes with at least two statements (split on `. ! ? ;` or line breaks, each two words or more) or at least 40 words.
- Overview labels: "Logged, Last 30 Days" counts logs dated in the last 30 days; the "Latest Logs" list shows the five newest entries regardless of date.
- Home Assets layout: the asset card grid uses `content-start`, so cards keep their content height instead of stretching to the selected asset's detail panel, and the page never scrolls sideways (regression-tested at 1009 px in `tests/e2e/navigation-layout.spec.ts`). The attachment Upload control is a label around a plain visually hidden `<input type="file">` with `relative overflow-hidden`; the shared `Input` component is not used there because its `w-full` overrides `sr-only` and widened the page.
- Asset and vehicle deletion require confirmation and are blocked while direct attachments exist. Embedded schedules/checklists are deleted with the owning registry document.
- Maintenance summary requests require verified household membership plus `maintenance.view`; provider failures are sanitized and non-destructive.
- Registry deletion reads current logs and the record's audience-constrained reminder notifications immediately before committing one batch. Linked logs become general history, and active schedule/warranty/registration/inspection notifications for the deleted record are resolved. Unrelated records are unchanged.
- Log, attachment, and embedded schedule/checklist removal use target-specific confirmation dialogs; attachment Storage cleanup remains best effort under the existing metadata workflow.
- Storage is deleted before metadata; a missing object is tolerated.
- Loading uses one `Promise.all`; one denied/failed collection query moves the entire center to its error state.
- Schedule completion uses independent parallel writes rather than a transaction, so partial completion is possible.
- Slug-derived asset, vehicle, and ordinary log IDs can collide.
- Deleted asset/vehicle deep links remain on the relevant list tab and report that the requested record is unavailable. New schedule notification source IDs use persisted schedule IDs; legacy schedules receive a deterministic compatibility key.

## Validation

- Run `npm.cmd run lint` and `npm.cmd run typecheck` after implementation changes; run a production build for broad UI/data-flow changes.
- `tests/e2e/tablet-pages.spec.ts` checks `/maintenance` (Overview) on the wall tablet (1263 × 818, touch): no sideways scroll, every control's hit area at least 48 × 48 and none overlapping (see [Application Shell](../application-shell/README.md)).
- Run functions and rules validation when notification delivery or security changes.
- Manually test canonical/invalid/deleted-record deep links, legacy logs/name-only schedules, checklist and date/mileage/combined scheduled entries, ten repeated/overlapping reminder syncs, dismissal persistence, completion advancement, partial failures, attachment allow/deny/delete behavior, inactive vehicles, and cross-household denial.
- `npm run test:unit` should include `tests/unit/maintenance-health.test.ts` (score formula, caps, bands, retired items) and `tests/unit/maintenance-reminders.test.ts` (card copy, schedule matching and legacy keys, Mark done/Snooze eligibility and values, AI-summary rule, field collapsing, photo choice, token-only components), `tests/unit/maintenance-brands.test.ts` (normalization, aliases, typo tolerance and tie refusal, short-name exactness, the owner's brands, catalog integrity, every bundled logo keyed to a brand, vehicle photo choice) and `tests/unit/maintenance-warranty-odometer.test.ts` (countdown math with the purchase-date and one-year fallback terms, odometer digits and accessible text).
- `tests/unit/maintenance-insights-costs.test.ts`, `maintenance-insights-prediction.test.ts`, `maintenance-insights-history.test.ts`, `maintenance-insights-filters.test.ts` and `maintenance-insights-qr.test.ts` cover the insights library: cost edge cases and a property test that year totals add up, mileage cleaning (outliers in each direction, backdated and future readings), minimums and a seeded property test over changing usage, history line names and schedule matching, URL round-trips and chip counts (property), stable pagination, and QR labels decoded back from the rendered SVG to exactly the deep link (ids with special characters included).
- `tests/e2e/maintenance-ux.spec.ts` covers the health dial and its links, the Attention Queue and reminder Open peek cards, `?tab=` links, Snooze and the Mark done check in place (Firestore writes and notification resolution), Log service (prefilled form, log details and schedule completion), vehicle photos and brand logo/badge naming, the asset card → detail morph and a plain modified click, collapsed detail fields and the action row, photo and fallback cards at 1009 px, inline validation, and a guest seeing no change controls. `tests/e2e/maintenance-warranty-odometer.spec.ts` covers the HVAC warranty ring's values and name, no ring without a warranty, the odometer's digits, settled wheels and text value, and instant wheels under reduced motion.
- For asset/vehicle/log/schedule/checklist/attachment deletion, test cancel and confirm, attachment blocking, persistence after reload, historical-log preservation, related reminder resolution, and unrelated-record survival.

## When This Document Must Be Updated

Update this README when asset/vehicle/log/schedule/attachment fields or paths, reminder thresholds or generation, reminder actions, the health score formula, completion advancement, delete cleanup, AI summaries, notification integration, permission enforcement, or maintenance security rules change.

Session restore (release 2.1, SL-11): while the signed-in session is still being restored the page shows its own loading skeleton, never the sign-in prompt; a genuinely signed-out visitor still gets the prompt. The shared gate is described in [Application Shell](../application-shell/README.md).
