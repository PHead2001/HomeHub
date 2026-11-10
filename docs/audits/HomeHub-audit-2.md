# HomeHub audit 2: section by section

> **Public copy.** 18 findings about privacy and permissions are withheld until their fixes are live (NO-2, NO-6, NO-8, NO-15, HO-2, HO-6, HO-8, HO-9, HO-10, HO-11, HO-12, QA-7, QA-8, BL-17, AU-10, AU-11, AU-12, PR-8). Their IDs remain so the numbering and cross-references still work.

One section at a time, nitpicked. The primary device is a **wall-mounted tablet in landscape, one per room** (always on, touch only, read from across the room). Phone portrait comes second, desktop third.

**Each finding gives:**
- what it is and where (file:line in `main`);
- why it matters, especially on the wall tablet;
- a suggested fix;
- effort: **Q** quick (under an hour), **M** medium (a day or less), **B** big (more than a day);
- how it was verified: **Live** (seen on production), **Code** (read in the code), or both.

Nothing here is changed until you pick what to do.

---

## 1. Homepage (`/`): signed-in dashboard and signed-out landing

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:**
- tablet landscape 1280×800, 1340×800 and 1024×768, with touch and no hover;
- phone 390×844;
- desktop 1440×900;
- dark and light presets, and reduced motion.

**Covered:** every tap target on the page; a 70-second idle watch; a code read of `src/app/page.tsx`, `src/components/dashboard/*` and `src/lib/dashboard/*`. Screenshots are in `C:\hh\audit\home-audit\`.

**Verdict:** the bones are good. Nothing leaks, failures are never shown as zeros, and the privacy rules on cached data are right. But the screen is designed as a scrolling desktop page, and the wall tablet sees about a third of it. The biggest wins are a landscape "wall layout", touch-visible room details, and a handful of real bugs, one of which adds "Fed" to the shopping list.

### 1.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| HP-1 | *(Built under QA-1: see 16.4.)* **The pets tile "+" adds "Fed" to the shopping list.** "Log a feeding" (and the F shortcut) opens quick add with the prefix `fed`. The guard against shopping fallback only matches `fed ` with a trailing space (`quick-add.ts:486`), so the top suggestion is "Add Fed to Audit groceries", and Enter saves it. | The one-tap pet action on the wall does the wrong thing. | Treat a bare `fed`/`feed` as a pet command. With one pet, prefill `fed <name>`; with several, show the pets as choices. Or skip the palette (see HP-23). | Q | Live + Code |
| HP-2 | **"0 of 0 done" shows a full green ring next to "1 overdue"** (`bento-grid.tsx:140,198`). With nothing scheduled today, the ring reads as complete. | The biggest tile tells the household "all done" while a chore is overdue. | Empty state when `todayTotal` is 0 ("Nothing scheduled today", with the overdue count as the headline), and never a full ring when the total is 0. | Q | Live + Code |
| HP-3 | **The brief ignores the household on a shared account.** The sentence uses only *your* counts (`brief.ts:252-262`). A tablet signed in as an account with nothing assigned says "Nothing needs you right now. Enjoy the quiet." while the house glows overdue. | That's exactly the wall-tablet setup. | Fall back to household totals (`overdueTotal`, `todayTotal - todayDone`) when your own are 0, or have a device "household view" (see HP-32). | M | Code |
| HP-4 | **At midnight the whole dashboard blanks and reloads.** `today` is part of the data key (`use-dashboard-data.ts:75,87`), so every listener resubscribes and the store resets at 00:00. You see skeleton tiles, the house says "Welcome home." (the snapshot is keyed by day), the brief types itself again, and any AI rewrite is lost. | Every night on every tablet. | Re-key only the day-scoped queries, and keep showing the previous data until the new snapshots answer. | M | Code |
| HP-5 | **A failed section never retries.** `onSnapshot` errors are final and are only cleared when the key changes (`use-dashboard-data.ts:98-103`). One brief permission or network error at 9 am leaves "Unavailable right now" up all day. | Always-on screens hit transient errors. | Resubscribe with backoff, and on `online` / `visibilitychange`. | M | Code |
| HP-6 | **One failed weather fetch wipes a good report** (`use-weather.ts:273-276` stores `null` on failure). It also refreshes about every 60 minutes, not 30, because the interval fires just before the cache expires (`use-weather.ts:335`, `weather.ts:448,499`). | A Wi-Fi blip hides the weather for up to an hour. | Keep the last good report on failure, and schedule the next load at `fetchedAt + TTL`. | Q | Code |
| HP-7 | **Loading says "Welcome home." and the house changes size twice.** While chores load, the house draws as an empty 3-column house with the same copy used for "no chores permission" (`living-house.tsx:480-482,577`). The skeleton is a 4-room house, so it goes 4-room outline → small empty house → real size. | It's the first thing you see on a fresh day (the snapshot misses). | Keep the outline while `facts.chores` is undefined, and use yesterday's snapshot room layout without its counts. | M | Code |
| HP-8 | **The HVAC unit says "Heating and cooling: all good" in homes with no HVAC asset** (`living-house.tsx:604-616`). The car is correctly hidden when there are no vehicles. | It shows a status it can't know. | Count climate assets and hide the unit when there are none. | Q | Live + Code |
| HP-9 | **"Fridge: 0 items" pulses while the fridge looks empty.** The label counts only items with location *Fridge*, but the pulse counts expiring items anywhere in the pantry (`living-house.tsx:442,594-599`, `facts.ts:387-389`). | Households that don't set locations see a contradiction. | Label it "Pantry", or count both the same way. | Q | Live + Code |
| HP-10 | **The room peek can list chores weeks away and cut today's.** A room's top 3 are sorted overdue-first only, then cut, and include the pre-generated future repeats (`facts.ts:318,337-338`). | The peek, and the inline list proposed in HP-13, would show the wrong 3. | Sort overdue, then today, then soonest, and drop anything beyond the upcoming window. | Q | Code |
| HP-11 | **Smaller correctness bugs:** <br>• The "your chores" peek lists everyone's chores (`morning-brief.tsx:46-47`). <br>• The golden roof is counted once per page load, so a tablet that never reloads never turns gold (`dashboard.tsx:23-38`); count it from the listener already running. <br>• Room zoom can get stuck if navigation fails, for example after a deploy (`living-house.tsx:457-464`). <br>• Many hungry pets drift out of the kitchen and overlap (`house-layout.ts:203-205`). <br>• Chores use the device's time zone but maintenance uses the household's (`dates.ts`, `facts.ts:427`): a tablet shipped on UTC shifts "today". | Edge cases, each one visible on a wall that runs for weeks. | One small fix each. | Q–M | Code |

### 1.2 Wall tablet: layout and always-on (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** the wall layout, clock, larger text, keep-awake and kiosk behaviour apply only on a **registered tablet** (WT-12, WT-14), never on a personal account. Shared-screen settings in the hero (HP-18) move to the tablet's record on the Household Devices list (WT-4). Bigger touch targets and room details that show without a mouse (HP-13, HP-14) are for every touch screen (16.2).

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| HP-12 | **At 1280×800 the house fills the screen and everything else is below the fold.** <br>• The dashboard heading starts at y=678 and the tiles at about 720. <br>• The house stage is capped at 672 px wide (`max-w-2xl`, `living-house.tsx:523`), leaving about 290 px empty on each side, and it's the same 431 px tall from 1024 to 1440. <br>• A 4-room house runs past 800 px. | On the wall, the tiles and the brief may as well not exist. | **Wall layout** for landscape at `lg`: <br>• two columns, with the house on the left, its height capped to the screen; <br>• the brief and a 2×N tile stack on the right; <br>• drop the "Welcome Home" heading in this mode. | M | Live + Code |
| HP-13 | **Room details are hover-only, so a touch screen never sees them.** Peek cards need a fine pointer (`peek-card.tsx:20-21,94-99`): room chore lists, "next up", shopping lists, maintenance lists, streak names. On the tablet each room shows only "All clear" / "1 overdue". | The data is computed but invisible on the main device. | On coarse pointers, show the top chores inline in each room. A tablet room is about 190×110 px, room for 2–3 lines, more with the wall layout. Show tile details inline too. | M | Live + Code |
| HP-14 | **Too small to read from across a room.** Room status text is 12 px, labels and badges 11 px, the due dot 8 px; the Fridge, HVAC and pet labels are 11 px. 21 tap targets on the tablet are under 44 px. Examples: <br>• the header nav at 32 px tall; <br>• the health badge, 105×22; <br>• the weather toggle, 126×24; <br>• the tile "+" buttons and the brief sparkle, 32×32. | Arm's length and distance are the whole point of a wall. | A coarse-pointer type scale (rooms 16–18 px, states 14 px), and `pointer-coarse:min-h-11 min-w-11` on every control. | Q | Live |
| HP-15 | **No clock.** There's no time on screen at any size, and the date is truncated on phones ("Mon…"). Weather is opt-in and off by default. | Glancing at the time is the most common thing anyone does with a wall screen. | A large clock and date in the wall layout's header, with weather beside it when on. On phones, keep the date by shortening the household name instead. | Q | Live |
| HP-16 | **It never rests.** <br>• Three infinite animations run nonstop: the aurora background (×2), plus the overdue glow for as long as a room stays overdue. A fed pet walks and the fridge pulses all week. <br>• There's no idle or night mode, no dimming, and no protection against burn-in from static layouts. <br>• Ambient animation pauses only when the tab is hidden, which a kiosk never is (`dashboard.module.css:42-48,77,118,298-311`). | Continuous repaint and heat on a 24/7 screen. A static layout burns into OLED panels. | Attention animations run a few cycles, then hold. An **ambient mode** after about 2 minutes untouched and at night: dimmed, clock plus only alerts, everything else static, with a slow pixel shift. | M | Live + Code |
| HP-17 | **There's no keep-awake and no self-healing.** <br>• No wake lock (the API exists on the device, and the app never asks). <br>• No offline or "last synced" sign. <br>• No new-deploy detection: the page keeps running old code after a rollout, and the next navigation can fail to load a chunk. <br>• Nothing refreshes `now` when the screen wakes. | Tablets sleep, lose Wi-Fi and miss updates, with nobody there to tap reload. | A wake lock when in wall mode (re-acquired on visibility); an offline/last-synced chip; a version check that reloads while idle; refresh on `visibilitychange`. | M | Live + Code |
| HP-18 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **Shared-screen settings sit in the hero.** "Live weather off" and "Seasonal touches" are always visible as small text buttons. Anyone passing can toggle them, and weather is saved to the signed-in person's profile. (Tapping it during this audit switched it on; I switched it back off.) | Accidental changes on a shared screen. | Move them into a small "…" menu on the house, or Profile → Appearance. | Q | Live |
| HP-19 | **Desktop-only UI on the tablet.** "Keyboard shortcuts ?" shows at `md`, so it's on the tablet (`dashboard.tsx:63-72`). The disco easter egg is keyboard-only. "Share" in Home Wrapped downloads a PNG onto the tablet. | Clutter and dead ends on touch. | Gate shortcuts on a fine pointer; add a touch easter egg (for example, 5 taps on the roof); hide download on the wall. | Q | Live + Code |

### 1.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| HP-20 | **The household name shows twice** (heading subtitle and house title), and is cut off twice on phones. | Show it once (on the house), and use the subtitle line for date, time and weather. | Q | Live |
| HP-21 | **The brief greets one person by name on a shared tablet** ("Good afternoon, Sam"). | In wall/household mode, greet the household. | Q | Code |
| HP-22 | **Copy nits:** <br>• "the eggs expires tomorrow", and lower-casing brand names (`brief.ts:278`); <br>• "Morning brief" label at 9 pm (`morning-brief.tsx:146`); <br>• "Good evening" from 00:00 to 04:00 (`ambience.ts:46-48`); <br>• "Expiring soon: 0 this week / Nothing close to expiring" says it twice; <br>• with expired items it reads "2 · 1 expired" and loses "this week" (`bento-grid.tsx:322`). | One-line fixes each. | Q | Live + Code |
| HP-23 | **Tile "+" buttons open the typing palette.** On the tablet that raises the keyboard over a command box, for "add chore", "add item" and "log feeding". | One-tap actions: "Fed" on a hungry pet chip (`pets.addLogs` is already checked), "Done" on a room chore, and a list picker for shopping. Keep the palette for typing. | M | Live |
| HP-24 | **The weather tile links to `#weather-settings`**, so a tap scrolls to the house header or does nothing (`bento-grid.tsx:384`). | Link to a forecast view (HP-35), or make it non-interactive. | Q | Code |
| HP-25 | **The brief's "1 overdue chore" link opens Chores unfiltered.** | Open Chores filtered to overdue (or to you). | Q | Live |
| HP-26 | **Uneven tile grid.** It leaves an empty slot bottom-right at 1280 px; the skeleton shows 4 tiles but the real grid has up to 8 (it grows a row after load); the Notifications tile pops in late with no skeleton. Pets and Next-maintenance tiles are tall with one line each on phones. | Size tiles by content, fill the last row, and match the skeleton. | Q | Live + Code |
| HP-27 | **The bell shows the same overdue chore twice** ("sweep floor is overdue", today and 1 day ago). | Daily reminders for the same chore should update one notification rather than stack. Note this for the Notifications section. | M | Live |
| HP-28 | **Accessibility nits:** <br>• Toggles announce state twice ("Seasonal touches on, pressed", `living-house.tsx:507-514`, `weather-controls.tsx:57-65`): keep a static label with `aria-pressed`. <br>• Room chore titles are never exposed to screen readers (the peek is `aria-hidden`); HP-13 fixes this. <br>• "+N more rooms" is a tiny text link. | Q | Code |
| HP-29 | **Two calls to action on the signed-out landing** ("Login" in the header and "Sign in with Google" at the end), where H03 asked for one. | Drop or restyle the header button on `/` when signed out. | Q | Live |

### 1.4 Wow and value ideas (all built on data the page already loads)

> **Agreed wall tablet design (2026-11-09, see section 15):** HP-30 Wall mode and HP-31 "This tablet is in: Kitchen" are now settled by device registration: the room comes from the tablet's record and can be changed any time (WT-4). HP-32 Household view is the tablet's resting state (WT-5), and HP-33 one-tap actions use "Who's here?" (WT-8).

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| HP-30 | *(Replaced by the tablet design: see section 15 and 16.2.)* **Wall mode** | Turns on automatically for landscape touch screens of 1024 px and wider, or with a per-device switch. Gives: <br>• the HP-12 layout; <br>• a big clock, date and weather; <br>• the HP-14 type scale; <br>• no settings chrome; <br>• the HP-16 ambient/night mode and HP-17 keep-awake; <br>• a return to `/` after a few minutes on another page. <br>This is the umbrella for most of 1.2. | M–B |
| HP-31 | *(Replaced by the tablet design: see section 15 and 16.2.)* **"This tablet is in: Kitchen"** | A per-device room setting. That room is highlighted, its chores listed large, the pantry or pets shown when relevant, and tapping opens `/chores?room=kitchen`. The pet bowl logic already prefers the kitchen. | M |
| HP-32 | **Household view of chores** | "Sam: dishes (overdue) · Alex: trash (today)", with an assignee on each next-up item, so the wall shows who, not just what. | M |
| HP-33 | **One-tap actions on the wall** | "Fed" on a hungry pet; "Done" on a room's chore with the existing completion sparkle; tick a shopping item from the tile. | M |
| HP-34 | **Whole-house celebration** | When every chore today is done, a one-off house-wide sparkle and "House is clean" moment. The room sparkle already exists. | Q |
| HP-35 | **Real weather glance** | Today's high/low and chance of rain from the same Open-Meteo call (add `daily=...`), with geocoded coordinates cached so each refresh is one request. | Q |
| HP-36 | **Shopping list on the wall** | The top 6–8 needed items instead of 3 chips (`facts.ts:373`), tappable to tick off. | Q |
| HP-37 | **Status chip** | "Updated just now" / "Offline · last synced 10:42", from snapshot `fromCache`, re-subscribing on `online`. | Q–M |

### 1.5 Looks good: keep as is

- **Failures are honest:** a failed read is never shown as an empty or zero state (tri-state pets, "could not be loaded" wording).
- **No leaks:** state is keyed per household and member, so another household's data never flashes, and every listener and timer is cleaned up (no leaks over days).
- **Room links:** they match the drawing exactly, with arrow, Home and End navigation.
- **Reduced motion:** handled thoroughly, with zero running animations under it (verified live).
- **Light presets:** they read well (verified live with `light` and `sunrise`).
- **Peeks and the brief:** the peek card is placed inside the viewport and kept out of the accessibility tree; the brief reserves its space while typing and gives screen readers the full sentence.
- **Signed-out landing:** stays light (no Firestore or App Check), with no console errors at any size.
- **Every tap lands somewhere sensible:** room → filtered chores, fridge → pantry, health → maintenance overview, pet → its feeding tab, each tile → its module.

### 1.6 Suggested order

1. **Quick fixes for the broken items:** HP-1, HP-2, HP-6, HP-8, HP-9, HP-10 and the copy nits. One PR, about an hour each.
2. **Wall mode, core:** HP-12 layout, HP-14 sizes, HP-15 clock, HP-13 inline room details, HP-19 and HP-20.
3. **Always-on:** HP-4 midnight, HP-5 retries, HP-16 ambient/night mode, HP-17 keep-awake and self-healing.
4. **Shared-tablet semantics:** HP-3 brief, HP-21 greeting, HP-32 household view, HP-18 settings menu.
5. **Wow:** HP-31 room tablets, HP-33 one-tap actions, HP-34 celebration, HP-35 and HP-36.

---

## 2. Shopping (`/shopping`: lists, an open list, pantry; Barcode Library lightly)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** tablet 1280×800 (touch, no hover), phone 390×844, desktop 1440×900.

**Live flows**, on the audit household with probe items "Probe apples" and "Probe milk", deleted afterwards and verified gone:
- quick add;
- tick by name and by circle, then Undo;
- an offline tick, then reconnect;
- the Clear dialog;
- Add Item, Manage Categories, the list menu, Create List and pantry Add Item (all cancelled).

**Code:** `shopping-center-client`, `shopping-list-client`, `pantry-inventory-client`, `components/shopping/*`, `lib/shopping/*`, recipes, and the library lightly. Screenshots are in `C:\hh\audit\shop-audit\`.

**Verdict:** the data layer is excellent. Transactions are safe for two shoppers at once, offline ticks queue and reconcile, and quick add never loses text. The experience around it is a desktop list.
- Nothing refreshes on its own, so the kitchen tablet and a second shopper drift apart.
- On the in-store phone the first item sits three-quarters of the way down the screen.
- Every target is 16–32 px.
- The after-trip flow can double the pantry, and offers to delete your weekly Groceries list every time it empties.

### 2.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| SH-1 | **No live updates anywhere.** Lists, items and the pantry are read once, with no `onSnapshot`, no refresh on focus or visibility, and no timer. | The kitchen tablet never shows what others added from their phones. Two people in the store don't see each other's ticks, so both buy the milk. A list deleted elsewhere keeps taking ticks. | `onSnapshot` on the open list's items, the lists and the pantry. It serves from cache offline, so the offline contract holds, and the transactions stay as they are. | M | Code (0 listeners) + Live |
| SH-2 | **The pantry can be credited twice.** The receipt's "Add to pantry" doesn't clear the items, and the Clear dialog's primary button is "Add to pantry, then clear" (`shopping-list-client.tsx:917-921,946`). Nothing marks items as already credited. | The normal after-trip path doubles your stock. | Make the receipt's primary action "Put away & clear", and stamp `pantryCreditedAt` so items are never credited twice. | M | Code |
| SH-3 | **"Delete empty list?" appears after every full clear, even on the weekly Groceries list** (`:812-820`). Worse: pressing Esc on that prompt leaves the list marked, and a permanent "Delete {list}?" dialog pops up when you go Back (`:925,934,1173`). | One wrong tap on a shared tablet deletes the household's standing list. | Never offer it for Grocery lists (or make it a non-modal note), and clear the marked list whenever the prompt closes. | Q | Code |
| SH-4 | *(Fix tightened: see section 17.)* **A weak signal in the store hangs adding.** When the phone reports online but nothing gets through, online writes wait for the server forever (`firestore-offline.ts:14,51-61`). The quick-add spinner and the Add Item button spin forever and block further adds. | Store basements are exactly this. Live, the Add spinner already sat over 5 s on a good connection (see SH-16). | Race online writes against about 4 s; on timeout, treat the write as queued (Firestore keeps it) and say "Saved, will sync". | M | Code + Live |
| SH-5 | **A custom list can never be a Grocery list.** The custom form has name, icon and colour only, with no type and no description (`list-dialog.tsx:79,124-200`). | A list named "Costco" gets no pantry hand-off and never appears in the pantry's "Put on a shopping list", which then creates yet another "Groceries" (`pantry-inventory-client.tsx:956-963`). | Add Type and Description fields. | Q | Code + Live (the dialog has no type) |
| SH-6 | **Pantry "Put on a shopping list" doesn't merge duplicates** (`pantry-inventory-client.tsx:842-875` skips `findMergeTarget`). | "We're out of milk" from the kitchen adds a second Milk next to the one already needed. | Reuse the quick-add merge path. | Q | Code |
| SH-7 | **Only one toast at a time** (`use-toast.ts:12`). Rapid ticks replace each other's Undo. "2 items added" is instantly replaced by "Items saved to Other". The first offline tick gets the offline notice instead of Undo (`:682-687`). | Ticking quickly in an aisle means only the last tick can be undone. | Allow 2–3 toasts, or one combined "3 ticked · Undo last"; show Undo with the offline note inside it. | Q | Code + Live |
| SH-8 | **Copy promises edits that don't exist.** "You can update {name} later" (`:573,575`, `pantry-inventory-client.tsx:870`), but rows only tick, delete or link. You can't rename an item or change its quantity or category; quantity only goes up by re-adding. | Dead ends: a typo stays a typo. | An item edit sheet (tap the text or long-press: name, quantity ±, category), or fix the copy. | M (edit) / Q (copy) | Code + Live |
| SH-9 | **"Delete list" says it deletes the items but leaves them behind** (`:467,1178`). | Orphaned data, and untrue copy. | Batch-delete the subcollections, or change the copy. | M | Code |
| SH-10 | **Smaller bugs:** <br>• Expiry is saved as a UTC instant of local midnight, so evenings in Texas can be a day off (`pantry-inventory-client.tsx:884`). <br>• Expiry labels never roll over at midnight on the always-on tablet (`pantry-shelves.tsx:67`). <br>• Two people editing categories overwrite each other (`:112,125`). <br>• "dairy" and "Dairy" make two aisles (`items.ts:164`). <br>• Recipe is enabled with 1 item, but the server needs 2. <br>• An unknown barcode is a dead end: the scanned code is dropped and there's no link to the library (`:625`). <br>• View-only empty state says both "This list is empty" and "Everything is in the cart" (`:1089-1090`). <br>• The quick-add shortcut does nothing with zero lists. <br>• An uncaught "Transition was aborted because of timeout in DOM update" error shows on every page (Live). | Each is visible over weeks of use. | One small fix each. | Q | Code + Live |

### 2.2 Wall tablet and in-store phone (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** on a registered tablet, adding and ticking items needs a face tap only (WT-6), and the item records who added it. Removing an item and put-away-and-clear also need only a face tap; deleting a whole list needs a PIN. A tablet can have Shopping switched off (WT-11); a kitchen tablet can open on the list (WT-4).

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| SH-11 | **The kitchen tablet shows one small list card on an empty screen.** "We're out of X" takes 4–6 taps (Shopping → Open List → field → type → Enter), or 5–6 from the pantry (tile → 28 px ⋮ → Put on list → pick list → Add). | **Kitchen mode** on the overview: the Grocery list's needed items inline, grouped by aisle in 2–3 columns, a big always-visible quick-add field, and the pantry's expiring chips. One tap from the wall. | M | Live |
| SH-12 | **On the phone in the store, the first item is at y≈645 of 844.** Above it: the h1, the description, a full-width Barcode Library button, tabs, Back, the title, a full-width Manage Categories and a full-width Add Item. The floating "+" overlaps the list's own quick-add bar, so two "+" buttons are stacked over the Purchased row. | Inside an open list, hide the page header; move Manage Categories and Barcode Library into a ⋮ menu; make a compact sticky header (Back, name, cart, "n left"); hide the global floating "+" while a list is open. | Q–M | Live |
| SH-13 | **Targets are 16–32 px throughout.** <br>• The tick circle is 16×16, and empty space in the row isn't tappable (tapping the name does tick). <br>• Delete is a 32 px trash icon right beside each row, with no confirmation. <br>• The list ⋮ is 32 px, the pantry ⋮ and move handle 28 px, a category "x" about 16 px, dialog close buttons a 16 px icon. | The whole row is the tick target (48 px tall, a 24 px circle). Delete goes behind a swipe or the edit sheet. Every icon button is 44 px on touch. | M | Live + Code |
| SH-14 | **Inside a list on the tablet,** one single column about 1250 px wide with 14 px rows: half the width is empty, and text is small at arm's length. | Aisle groups in CSS columns (`lg:columns-2 xl:columns-3`), with the base text size one step up on touch. | Q–M | Live |
| SH-15 | **Undo is at the top of the screen, far from the thumb, for 5 s; the Purchased section starts collapsed;** with SH-7, fixing a mis-tick means cart → expand → find. | Bottom snackbar above the quick-add bar while a list is open, for about 8 s. | Q | Live + Code |
| SH-16 | **Quick add waits for AI before showing anything.** One categorization call per entry (`:510-531`, limited to 20 a minute, so a long paste falls back to "Other"), and "Milk" is re-categorized every time. Live, items appeared only after the spinner ran for 5 s or more. | Save at once with the category remembered from an earlier item with the same name, categorize in the background, and batch the calls. | M | Live + Code |
| SH-17 | *(Fix tightened: see section 17.)* **The after-trip flow is a gauntlet.** Last tick → receipt modal → Add to pantry → hand-off dialog → confirm → later Clear → alert → choice → "Delete empty list?". That's up to about 7 taps, two of them dangerous (SH-2, SH-3). | A receipt with one primary "Put away & clear" and one "Done"; remember the choice per household. | M | Code |
| SH-18 | **Long lists have no search or jump:** aisle headings aren't sticky, and there's no filter. | Sticky aisle headers, aisle chips, and a "type to find or add" quick-add field. | M | Code |
| SH-19 | **Dialogs fight the on-screen keyboard.** They're centred with no max height or scroll (`ui/dialog.tsx:43`), so in landscape with the keyboard up the custom-list form (20 icons) and the pantry form (7 fields) can push Save off screen. | `max-h-[100dvh] overflow-y-auto`; bottom sheets on phones. | M | Code (needs a keyboard check) |

### 2.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| SH-20 | **Creating a list doesn't open it,** templates make duplicates ("Groceries" twice), and the custom form can't go back to templates. | Open the new list; warn when the name exists; add a Back link. | Q | Code + Live |
| SH-21 | **Custom aisle order is impossible.** Added categories sort alphabetically, after the built-ins, and there's no reorder UI, so "the order you walk the store" is fixed (`:110`, `items.ts:147,174`). | Keep insertion order, add move up/down, optionally one order per store. | M | Code + Live |
| SH-22 | **Pantry has no one-tap "used one" or "used up";** changing a quantity is edit → − → Save. Recipe "You might need" items show + icons that do nothing (`pantry-inventory-client.tsx:546-556`). | −/+ on each tile, with "Add to list?" at 0; make the recipe's + add to the list, plus "Add all missing". | M / Q | Code |
| SH-23 | *(Fix tightened: see section 17.)* **Hand-off nits:** it merges only into pantry entries with unit `items` (Milk 2 L + Milk = two tiles); it sets no expiry and has no way to add one; Produce goes to the Fridge (onions, potatoes, bananas). | Merge on name and shelf regardless of unit; expiry chips in the hand-off (SH-30). | M | Code |
| SH-24 | **Barcode Library:** delete has no confirmation or undo and also deletes the photo; a photo is required, so you can't map a barcode to just a name. | Confirm or undo; make the photo optional. | Q | Code |
| SH-25 | **Loading shifts the layout three times** (route skeleton → blank → client skeleton → cards); changing tabs unmounts and re-reads everything; each lists reload flashes a skeleton. | One shared skeleton; keep both tabs mounted; reload silently. | Q | Code |
| SH-26 | **Accessibility:** <br>• Focus is lost after a tick or delete (to `<body>`). <br>• "Open List" has the accessible name "Open {list}", so voice control's "tap Open List" fails (WCAG 2.5.3). <br>• Tint swatches are named "Tint 1…8". <br>• Aisle headings sit at the same level as their section. <br>• Decorative recipe icons aren't hidden. <br>• The amber expiry pill is 11 px with a contrast risk. | Move focus to the next row; "Open List: {name}"; colour names; h4 aisles; `aria-hidden`; a tested `warning-foreground` token at 12–13 px. | Q | Code |
| SH-27 | **Performance:** <br>• Every online tick re-reads the whole list (a 200-item list × 60 ticks ≈ 12k reads per trip). <br>• Card counts read every item of every list. <br>• Every row runs layout animation and its own media listener. <br>• Pantry and library photos are full-size and `unoptimized`, drawn up to three times with large blurs. <br>• Recipe sends the whole pantry, expired items included. | `onSnapshot` (SH-1) or count queries; memoise groups and rows; drop `unoptimized`, resize on upload, lazy-load; send only usable items. | M | Code |

### 2.4 Wow and value ideas (built on existing code)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| SH-28 | **Live, attributed lists** | `addedBy`, `purchasedBy` and `purchasedAt` on items: "Sam added · 2d" on rows; "Alex is shopping · 7 left" on the kitchen tablet, live. | M |
| SH-29 | *(Asks "Add to list?" instead of adding automatically: see 16.1 D-8.)* **"Out of this" on pantry tiles** | One tap: decrement or remove, and merge onto the default Grocery list, with Undo. The kitchen tablet's best one-tap action. | M |
| SH-30 | **Expiry chips during put-away** | Per-shelf defaults in the hand-off (Fridge +7d, Freezer +3mo) and +3d/+1w taps, so the expiry glow, the dashboard and the recipes finally have data. | Q–M |
| SH-31 | **"Use it up" recipes** | Send expiry dates to the recipe so it prioritises what's about to go off; one tap adds the missing ingredients to the list. | Q–M |
| SH-32 | **Usuals and history** | A small `trips/{id}` log written in the existing clear and hand-off transactions. That enables suggestion chips in quick add ("Milk · every ~6 days"), receipt history, and remembered categories (SH-16). | M–B |
| SH-33 | **Trip mode on the phone** | Wake lock while a list is open, bigger rows, sticky aisles, an "n left" pill, bottom Undo, and scan-to-tick (the barcode matches a needed item). | M |
| SH-34 | **Per-store aisle order** | Reorderable categories, saved per store. | M |
| SH-35 | **Unknown barcode → save it** | From the scan, open the library with the code prefilled. | Q |

### 2.5 Looks good: keep as is

- **Two shoppers at once:** merge only into still-needed items; Clear deletes only items still purchased; the pantry hand-off re-reads and confirms inside one transaction. Correct for two people shopping at once.
- **Offline:** ticks queue and reconcile, with a clear offline message and a correct sync on reconnect (verified live). No merges happen offline, so nothing is lost.
- **Quick add** never loses typed text: only failed entries return to the field. The parser handles "2 Probe milk" (verified live).
- **Tapping an item's name ticks it**, and the toast has Undo (verified live). Clear counts and warns ("Clear 3 purchased items? … cannot be undone", verified live).
- **List templates** (Groceries, Auto, Hardware, Pet Supplies) are a nice start.
- **URL state:** `?list=` and `?tab=` behave correctly with Back.
- **Motion:** the cart flight and morphs respect reduced motion and never block input. Peeks are hover-only by design, and there are no sticky hovers on touch.
- **Pantry shelves** have keyboard, tap-to-move and menu alternatives to dragging, with spoken announcements.
- **Late results** are scoped to the list still open, so an Undo never lands on another list.

### 2.6 Suggested order

1. **Safety and quick bugs:** SH-3, SH-5, SH-6, SH-7, the SH-10 list, and the copy part of SH-8.
2. **Live data:** SH-1, which also fixes SH-27's reads, plus SH-4 for weak-signal writes.
3. **In-store phone:** SH-12, SH-13, SH-15, SH-16.
4. **After-trip:** SH-2 and SH-17 together, plus SH-30 expiry chips.
5. **Kitchen tablet:** SH-11 kitchen mode, SH-14, SH-29 "Out of this", SH-28 attribution.
6. **Wow:** SH-31, SH-32, SH-33, SH-34, SH-35.

---

## 3. Pets (`/pets` and `/pets/[id]`: Feeding, Medication, Care)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** tablet 1280×800 (touch, no hover), phone 390×844, desktop 1440×900.

**Live flows** on "Audit Rex" in the audit household:
- a one-tap feed (then deleted, history verified back to its earlier state);
- "Log with details", the Medication and Care tabs, the pet menu and Add Pet (all cancelled);
- tapping the card.

**Code:** `pets-client`, `[petId]/page`, `components/pets/*`, `lib/pets/*`, the medication-log and feeding-log clients, the medication reminder rules. Screenshots are in `C:\hh\audit\pets-audit\`.

**Verdict:** the strongest section so far. It updates live (unlike Shopping), the card answers "has he been fed?", feeding is one tap with Undo, failures are never shown as empty history, and the care logic is pure and unit-tested. The gaps are about a shared kitchen tablet and medication safety:
- nothing stops a second feeding;
- most members can't undo a feed;
- leaving "Next dose due" blank silently ends a medication's reminders;
- the fed status is 12–14 px text.

### 3.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| PE-1 | **No double-feed guard.** Feed writes straight away (`quick-feed-button.tsx:99-113`); the only guard stops the same device double-tapping. Two people on two devices, or one person right after another, both log. When the day is complete the button only changes colour (`pet-care-summary.tsx:116`). | The exact kitchen-tablet scenario: one person checks across the room, the second feeds anyway. Live: a single quick tap logged a feeding immediately. | If the last feeding was under about 90 minutes ago, or today is complete, the tap shows "Sam fed Rex 12 min ago. Feed again?". Show the same line in the F-shortcut picker. | M | Live + Code |
| PE-2 | **Most people can't undo a feed.** Members and children can log feedings but not delete them (`permissions.ts`: `pets.addLogs` without `pets.deleteLogs`), so they never see Undo (`quick-feed-button.tsx:90,119`). The README says the reversible tap is the alternative to hold-to-feed. | For most of the household, a mis-tap is permanent. A child's tap on the tablet needs an admin to fix. | Let the author delete their own log for about 10 minutes (a rules change), or give members `pets.deleteLogs` by default. | M | Code |
| PE-3 | *(Fix tightened: see section 17.)* **Leaving "Next dose due" blank silently ends the reminders.** The field is labelled Optional and starts empty every time (`medication-log.tsx:58,165`). The latest entry without a date means no countdown and no reminder (`care.ts:363`). | Someone logs this month's heartworm dose, skips the field, and there are no more reminders: a health risk. | Prefill the next due date from the previous interval (it can be derived from earlier entries), and require an explicit "No more doses" to clear it. | M | Code |
| PE-4 | **A medication can never be finished.** A countdown ends only when a newer entry has no next date; there's no "course finished" action. A typo ("Apoquell") starts a new medication, so the old one stays "Overdue by N days" forever, on the card and in push reminders (`care.ts:367-384`, `medication-reminders.ts:76-99`). | Stale red chips train everyone to ignore them. | A "Mark finished" action on the chip and the tab; name autocomplete from existing medications. | M | Code |
| PE-5 | **Feedings use the device clock.** Logs are written with `new Date()` (`pet-log-api.ts:52`), and status ignores entries more than 1 minute in the future (`care.ts:322`). If the kitchen tablet runs 5 minutes slow, a phone's feeding is invisible there ("Not fed today") for 5 minutes. | A double-feed trigger. | Write `serverTimestamp()` (keep the chosen time only for detailed backdated entries). | M | Code |
| PE-6 | **The schedule parser miscounts feedings per day** (`care.ts:114-126`): <br>• "once in the morning, once at night" counts as 1; <br>• "2 meals a day" counts as 1; <br>• "breakfast (morning) and dinner (evening)" counts as 4; <br>• "8:00 and 18:00" isn't understood; <br>• different portions per meal always quick-feed the first. | "All fed today" after one meal means an underfed pet and a false glance. | Count each "once", accept "meals", merge synonyms into slots, parse `HH:mm`, and show the parsed result in the form ("Reads as: 2 feedings of 1 cup"). | Q–M | Code |
| PE-7 | **"Today" uses the device time zone, but reminders use the household's** (`care.ts:265-292` against `functions/src/reminders.ts:178-179`). The shared calendar helper that's meant to make them agree isn't used here. | A phone travelling or at the vet shows a different fed count and medication state from the tablet and the push. | Use the household time zone for day keys. | M | Code |
| PE-8 | **Smaller bugs:** <br>• Editing a legacy "Other" pet wipes its species (cat art becomes a paw print) (`pet-form.tsx:192`). <br>• The Medication and Care tabs can crash on an unreadable or blank date (`medication-log.tsx:216`, `care-log.tsx:160`). <br>• A pet's name can't be changed (`edit-pet-dialog.tsx:113`), so a typo means delete and re-add, which orphans the history. <br>• A detailed feeding can be logged later today; it shows in history but doesn't count until then (`feeding-log.tsx:175,193`). <br>• `?tab=medication` only applies on first load, so tapping a medication notification while on that pet stays on Feeding (`[petId]/page.tsx:52-53`). <br>• Failed listeners never retry (`pet-log-api.ts:127-131`). <br>• A feeding at 23:00 reads "Fed yesterday" at 00:30. <br>• The toast limit of 1 means feeding the cat erases the dog's Undo. | Each matters on a wall that runs for weeks. | One small fix each. | Q–M | Code |

### 3.2 Wall tablet and phone (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** on a registered tablet, Feed and "Give dose" ask "Who's here?" (face, no PIN), which settles PE-17 ("Fed by" is whoever owns the session) and feeds the double-feed guard (PE-1, PE-23). Undoing a feed you just logged is a face tap; deleting older logs or a pet needs a PIN. PE-11 (the tablet stays on a pet page) is covered by idle-to-home (WT-14).

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| PE-9 | **On the tablet, "fed or not" is the smallest thing on the card.** The 4:3 photo takes about half the card; the status is 14 px ("Fed 2 days ago by Sam") and 12 px ("0 of 2 today") beside a 40 px ring with a 12 px "0/2". With one or two pets, most of the screen is empty, and from the 5th pet on, cards are below the fold. | A landscape **board**: <br>• a short photo or 80 px avatar; <br>• the status as a 20–24 px line plus a full-width colour band (green fed, amber meal due, red overdue med); <br>• bigger cards when there are few pets; <br>• hide the page subtitle. | M | Live + Code |
| PE-10 | **No meal times, so "has dinner happened?" can't be answered.** The card says "0 of 2 today", never "Dinner due 6:00 pm", even though the parser already extracts times and meal words. | Meal slots (PE-22). Even without them, "Next meal: evening" on the card. | Q–M | Live + Code |
| PE-11 | **A brush on the photo opens the pet's page** (the whole card is a link, `living-pet-card.tsx:157-165`), and the tablet then stays there, since nothing returns it to the list. | In wall mode, the photo responds to a hold only; open details from the name or a chevron; return to `/pets` after about 2 minutes idle. | M | Live + Code |
| PE-12 | **Hold-to-feed can't be discovered on touch.** The only hint is screen-reader text (`living-pet-card.tsx:119-121`), and "Log a feeding from anywhere F" is a hover tooltip. Touch holds are untested: the e2e tests use the mouse only, and text selection or a link long-press could cancel the hold. | A one-time "Hold the photo to feed" caption; `select-none` and `touch-action: manipulation` on the card; a touch test. | Q | Code |
| PE-13 | **On a phone, one pet per screen.** A full-width Add Pet sits above a 343×257 photo, so the first Feed button lands around 700 px. On the pet page, the photo and Info cards stack before the tabs, so a `?tab=medication` notification lands with the tab off screen. | A compact row card on phones (64 px avatar, status, Feed); Add Pet into the header; tabs before Info on phones, or scroll to them. | M | Live + Code |
| PE-14 | **Targets are under 44 px:** <br>• Feed is 40 px; <br>• the card and pet-page menus 36 px; <br>• log delete buttons 32 px; <br>• tabs about 32–36 px; <br>• the AM/PM radios are tiny. | `min-h-11` across the pets surfaces. | Q | Live + Code |
| PE-15 | **Logging a medication dose takes about 7 taps plus typing:** open the pet → (phone: scroll) → Medication → Log a dose → type the name → type the dosage → pick the next date → Save. The chip on the card isn't tappable. The reminder says "Log the dose on the Medication tab", and there's no time field for "gave it this morning". | "Give dose" on each chip and on the notification, prefilled with name, dosage and next date (PE-24). | M | Live + Code |

### 3.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| PE-16 | **The medication chip truncates the status, not the name.** "Audit Flea & Tick · Overdue by 2 da…" (`medication-chip.tsx:21`). The due date is only in a hover `title`, and the "+N more" names are hover-only. | Status first (or truncate only the name); show the date on touch. | Q | Live + Code |
| PE-17 | **"Fed by" is whoever owns the tablet's session** (`quick-feed-button.tsx:111`), so it says "Fed by Mom" when a kid did it. | On the household tablet, quick member chips after the tap ("Who fed?"). | M | Code |
| PE-18 | **Copy nits:** <br>• "Back to All Pets" uses a Home icon; <br>• "Not fed today" on the off-day of an every-other-day schedule reads like a warning; <br>• the error state says "Try again → reload" even for permission problems; <br>• Add Pet has no Cancel button; <br>• units are capitalized ("Cups", "Cans"). | One-line fixes. | Q | Live + Code |
| PE-19 | **The F-shortcut picker doesn't show fed status** (`feed-picker-dialog.tsx:60-74`). | Show "Fed 12 min ago · Sam" on each row. | Q | Code |
| PE-20 | **Accessibility:** <br>• Under reduced motion the hold ring shows no progress at all (`hold-to-feed.tsx:155`); step it in 3 discrete steps. <br>• The Feed button's name omits status; add it via `aria-describedby`. <br>• The amber warning chip, 12 px on pale amber, is a contrast risk. <br>• Long names with no spaces are clipped (`living-pet-card.tsx:154`): add `break-words line-clamp-2`. | Q | Code |
| PE-21 | **Performance and loading:** <br>• Up to 5 listeners per pet (10 pets = 50 on the tablet), duplicated on the pet page; the medication query is unbounded. <br>• One timer per card. <br>• Blink and sway animations run forever. <br>• Uploads aren't resized (up to 10 MB), and replaced photos are never deleted from Storage. <br>• /pets shows three different skeletons in a row. | One household-level care hook; a bounded medication query; one shared minute clock; stop ambient motion after a few cycles or when idle; resize uploads; one skeleton. | M | Code |

### 3.4 Wow and value ideas (built on existing data)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| PE-22 | **Meal-slot feeding** | "Breakfast ✓ 7:42 · Sam / Dinner due 6:00 pm". The Feed button becomes "Feed dinner"; the card turns amber after the slot time; per-slot portions. It answers the question from across the room and naturally prevents double feeds. | B |
| PE-23 | **The real double-feed guard plus "who fed?"** | PE-1's confirm, plus PE-17's member chips on shared devices. | M |
| PE-24 | *(Fix tightened: see section 17.)* **"Give dose" in 1–2 taps** | From the chip or the push: medication and dosage prefilled, next due = last date + the usual interval, an optional "given at" time, and "Mark finished". | M |
| PE-25 | **7-day feeding strip** | Dots per day against the target, from logs already loaded; spots skipped days and double feeds. | Q–M |
| PE-26 | **Needs-attention strip** | Overdue meds and unfed-past-slot pets raised to a strip at the top (a border or ring on the card), keeping the alphabetical order below for muscle memory. | Q–M |
| PE-27 | **Twice-daily medications** | Medications are tracked per day only, so "twice daily" can't be tracked; add a time-of-day interval. | B |
| PE-28 | **Vet and weight** | Optional vet contact and weight fields; care logs could carry weight for a trend. | M |

### 3.5 Looks good: keep as is

- **Live updates** on both pages, and keyed snapshots, so switching pet or household never flashes stale data.
- **One-tap feed with Undo** (for those who can delete), with a celebratory "all fed for today" toast. Verified live.
- **"Log with details"** is an inline form prefilled from the pet's plan (1 cup, dry, current time). Verified live.
- **A failed load is never shown as empty history,** and quick feed waits for history so the food type is right.
- **Hold-to-feed** fires exactly once per press, with a 150 ms tap threshold and correct click swallowing. `care.ts` and `hold.ts` are pure and unit-tested.
- **The medication countdown rule** is mirrored on the server, and reminders resolve when a dose is logged.
- **Motion:** reduced motion covers blink, sway, ring, burst, stagger and morph, and ambient motion scales with the intensity setting.
- **Pet IDs** have a random suffix, so names never collide or resurrect old history. Inline field errors focus the first problem.

### 3.6 Owner additions (2026-11-09)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| PE-29 | **Pets have no notes.** The pet stores only name, type, photo and feeding schedule (`lib/types.ts:47-54`); there's nowhere to record behaviours, allergies, vet instructions, quirks or anything else to track over time. | Everyone in the house, and a pet sitter, needs "doesn't share toys with the cat", "allergic to chicken" or "vet says half portion until the 20th". | A **Notes** tab on the pet page with two parts: <br>• **Pinned notes:** a short list of always-true facts (allergies, temperament, vet and microchip), with the most important one shown as a small line on the card and the wall board. <br>• **Behaviour log:** dated entries with who logged them, optionally tagged (behaviour, health, training, vet), listed newest first like the other logs. Reuse the log list, delete-with-confirm, "by {name}" and live-update patterns, with a new `notes` collection under the pet; the rules mirror care logs. | M | Code |
| PE-30 | **Pet names can't be edited** (`edit-pet-dialog.tsx:113` passes `nameDisabled`). Promoted from PE-8. | A typo or a renamed pet means delete and re-add, which orphans the feeding, medication and care history (deletes don't cascade). | Make the name editable. The pet's ID already has a random suffix, so renaming is safe, and history stays attached. Re-check for duplicate names, and update the name shown on existing reminders and notifications if they store it. | Q | Code |
| PE-31 | *(Fix tightened: see section 17.)* **On the living house, a pet stays at its bowl right after being fed.** The house counts a pet as "fed" only when **all** of today's feedings are done (`dashboard/facts.ts:455`, `fed = status.complete`), and anything less sends it to the bowl (`house-layout.ts:203-206`). A 2-a-day pet is at "1 of 2" after breakfast, so it sits at the bowl all day, even though dinner isn't due for hours. | The bowl is meant to say "needs feeding now". Showing it all day makes it noise, and it contradicts the "Fed just now" card. | **Quick fix:** a pet goes to the bowl only when its next feeding is actually due. Without meal times, estimate it from the last feeding and the feedings per day: for example, 2 a day means hungry again after about 8 to 10 hours, or from the evening, rather than straight after breakfast. Until then it wanders happily. Also skip the bowl when the last feeding was less than about 90 minutes ago, whatever the count. **Full fix:** with meal slots (PE-22), the bowl appears only after a slot's time has passed and it hasn't been fed. | Q (heuristic) / B (slots) | Live + Code |

### 3.7 Suggested order

1. **Health and safety:** PE-3 next-dose prefill, PE-4 mark finished, PE-1 double-feed guard, PE-2 undo for everyone.
2. **Owner asks:** PE-30 editable names, PE-31 bowl only when a meal is due, PE-29 notes.
3. **Correct counts:** PE-6 parser, PE-5 server time, PE-7 time zone, and the rest of the PE-8 list.
4. **Wall board:** PE-9, PE-10, PE-11, PE-12, PE-14.
5. **Medication flow:** PE-15 and PE-24 "Give dose"; PE-16 chip.
6. **Wow:** PE-22 meal slots (which also completes PE-31), PE-25 feeding strip, PE-26 needs-attention strip, PE-17 "who fed?".

---

## 4. Maintenance (`/maintenance`: Overview, Home Assets, Vehicles, Reminders, Logs)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** all five tabs at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900.

**Live:** every add and edit form opened and cancelled, with field counts and form height measured; nothing saved; no console errors.

**Code:** `maintenance-log-client.tsx` (3,338 lines, read in full), `components/maintenance/*`, `lib/maintenance/*`, the shared reminder builder and server job, and the rules. Screenshots are in `C:\hh\audit\maint-audit\`.

**Verdict:** the reminder logic is careful.
- The page and the hourly server job share one builder, and they agree on due, overdue and snoozed in the household time zone.
- Quick completion refuses to guess.
- Deleting an asset keeps its history.

But the page is a desktop records app:
- it never updates live;
- it never notices midnight;
- it saves stale copies over newer data;
- what's actually due is two tabs and two cards deep.

### 4.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| MA-1 | **"Today" never changes while the page is open.** `today` is recalculated only when data loads or saves (`maintenance-log-client.tsx:997`, the lint warning deliberately disabled). | On a wall tablet, items never turn overdue overnight, and a Mark done after midnight is recorded with yesterday's date. | Keep `today` in state, update it at the household's local midnight and on `visibilitychange`. | Q | Code |
| MA-2 | **No live updates.** One-time reads only (zero `onSnapshot`; README:121). | The tablet keeps showing a filter someone already changed from their phone. Tapping Done again writes a second log and moves the schedule again. Logs added from quick add don't appear. | `onSnapshot` on the four collections, with retry; at least refetch on focus and on `homehub:data-changed`. | M | Code |
| MA-3 | *(Fix tightened: see section 17.)* **Saves overwrite whole documents from stale copies.** Completion writes the whole asset (`:1659-1664,1674-1680`), snooze the whole schedules array (`:1800,1804`), and the edit dialogs the form snapshot (`:1423,1501`). Schedules are addressed by array position. | With MA-2, a tablet completion erases a rename or new schedule made on desktop, brings back a deleted schedule, or writes into the wrong slot. | A transaction that re-reads, finds the schedule by `id`, and patches only that entry. | M | Code |
| MA-4 | *(Fix tightened: see section 17.)* **Done isn't atomic, so a retry duplicates it.** The log, the schedule and the notification cleanup run in parallel (`:1657-1682`), and the cleanup reads the whole notifications collection, which needs `notifications.view`. | If any part fails, the user sees "Could not mark it done" while part of it was saved, then the retry duplicates it. A member without notification access can never complete anything. Asset delete has the same problem. | The log and schedule in one batch; resolve notifications afterwards, best effort, with a filtered query. | Q | Code |
| MA-5 | **Double-tapping Save writes twice.** No save button is disabled while saving (no `isSubmitting` in the file). | On a slow garage connection, two logs and a double advance. | Disable while submitting, with a spinner. | Q | Code |
| MA-6 | **One-tap Done on a mileage service uses the stored odometer**, which may be months old (`schedules.ts:145-146`). Plain logs never update the odometer, while completions can move it backwards (`:1585,1677`). A vehicle with no current mileage gets no mileage reminders at all. | An oil change marked done records stale mileage, so the next due is too early or already past. Backdating an old service rolls the odometer back and quiets real overdue items. | Always confirm the mileage, with a numeric pad, prefilled. `currentMileage = max(current, logged)`. Warn on a lower reading or a jump of more than 20k. | M | Code |
| MA-7 | **The completion dialog can silently end a schedule's reminders.** Neither the next due date nor the mileage is required (`:196-202`, `schedules.ts:173-182`), despite the comment "Never write a schedule without a next due". | The reminder disappears and nobody notices: the same trap as Pets' next dose (PE-3). | Require the mileage when there's a mileage interval, and at least one next-due value. | Q | Code |
| MA-8 | *(Fix tightened: see section 17.)* **No Undo for an accidental Done.** The toast has no action; deleting the log doesn't roll the schedule back (`:1739,1821`). The Done check is a 40 px tap with no confirmation. | A brush on the shared tablet writes a log and moves the due date; fixing it means editing dates by hand. | Undo on the toast, restoring the previous schedule stored on the log. | M | Code |
| MA-9 | **Snooze looks like it did nothing.** It's 7 days, but the due-soon window is 14 days, so a snoozed overdue item just moves to Due Soon. The snoozed state is never shown, and health still deducts for it. | People tap Snooze again and again. | A "Snoozed until …" badge, hide or mute snoozed items, and no health deduction for them. | Q | Code |
| MA-10 | **The health score is misleading.** <br>• It's 100 "In good shape" with no schedules and no logs (verified live: 1 asset, nothing tracked). <br>• It's an unweighted sum, so 50 assets with a few items due soon reads "Needs attention" while a 1-asset home stays high. <br>• "Due soon" costs points before anything is late. <br>• An expiring warranty costs points, then nothing once it has expired, so the score rises when coverage is lost. <br>• Logs earn up to 10 bonus points, so trivial logging games it. | A headline number that isn't trustworthy. | No score (or "Not enough tracked yet") without schedules; average per item; no penalty for due soon; drop the log bonus. | M | Live + Code |
| MA-11 | **Smaller bugs:** <br>• Delete confirm dialogs close instantly, so their spinners never show (`:3281-3331`). <br>• The default attachment category is "Photo", so a receipt becomes the card's picture (`:516`). <br>• Upload type and size aren't checked in the browser, and HEIC photos never display. <br>• AI summaries aren't saved, so every visit regenerates them (`:823,1963`). <br>• Logs without a `date` are dropped, and the old `receiptUrl` is never shown. <br>• Device time and household time disagree on "today" and "last 30 days". <br>• Schedules anchor to the completion date only, so "gutters every October" drifts. <br>• Warranty and registration get only 14 days' notice, there's no Lifetime or Renewed action, and an expired registration costs 15 points until hand-edited. <br>• Long names overflow. <br>• Retired assets stay in the main grid. <br>• Upload and Done may hang offline. | Each costs trust over months of use. | One small fix each. | Q–M | Code |

### 4.2 Wall tablet and phone (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** on a registered tablet, logging a service, Done and Snooze need a face tap, and the log records who did it (MA-20). Deleting assets, vehicles or logs and editing schedules need a PIN. Maintenance is optional per tablet (WT-11).

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| MA-12 | **Overview never shows what's due.** It shows a health dial, five count cards ("Home Assets: 1"), "Latest Logs" and an "Attention Queue" of manual flags only; the due list is on the Reminders tab, two cards down. | Top of Overview: a **"Needs doing" list** (overdue and today first) with Done, Snooze and Log on each row; the health dial and a "Coming up (30 days)" strip beside it; the counts move below or go. | M | Live + Code |
| MA-13 | **Reminders shows everything twice:** four count tiles, then four big cards with the same names, and a vehicle service or warranty appears in two of them (by status and by kind), with doubled counts. Live, it's 8 boxes of zeros. | One list grouped by urgency, with filter chips for kind. | Q | Live + Code |
| MA-14 | **Two meanings of "attention".** "Needs Attention: 0" and the "Attention Queue" use a manual flag, unrelated to Overdue. | Merge them: the queue shows overdue reminders plus manual flags, labelled as such. | Q | Live |
| MA-15 | **The forms are too long for a tablet.** Add Home Asset has 12 fields plus schedules, Add Vehicle 15, Add Log 8. They're 655–720 px tall on an 800 px screen with Save at 711–743 px, so with the on-screen keyboard up, Save is out of reach. "Add details (7 empty)" opens the same full form instead of just the empty fields. | Quick-add with essentials only (name, room, warranty, one schedule preset), then "More details"; "Add details" opens only the empty fields; full-screen sheets on phones. | M | Live |
| MA-16 | **Logging a service with a receipt photo takes 8+ taps across two places.** The log dialog has no attachment field and no camera hint. | A "Receipt / photos" picker inside the log dialog, camera-first, plus "Add photo" on the success toast. | M | Code |
| MA-17 | **On a phone, tapping an asset shows nothing.** Its detail renders below the whole grid, and nothing scrolls to it. | A sheet or route on phones; on tablet and desktop, a sticky detail column. | Q | Code |
| MA-18 | **Layout on tablet and phone:** <br>• On the tablet Home Assets tab, the list sits on the left, the detail on the right, and the middle third is empty. <br>• On the phone, the 5 tabs wrap into three rows ("Logs" alone). <br>• The warranty ring text is 10 px ("198d"). <br>• Targets are 32–40 px (log edit/delete, attachments, Done, Snooze, Log service). | Fill the grid (2–3 asset columns plus the detail); a scrollable tab row on phones; a 14 px ring caption ("Warranty · 198 days"); 44 px targets on touch. | Q–M | Live + Code |
| MA-19 | **The odometer is buried** in the full Edit Vehicle form. | An "Update mileage" quick action with a numeric pad, and "last updated 94 days ago" nudges. | Q | Code |
| MA-20 | **Nobody is shown as having done the work.** Logs have no author (`types.ts:227-248`). | Write and show "done by" on logs; optionally an assignee per schedule. | M | Code |
| MA-21 | **No filter or search.** No room or category filter for assets, and every log renders at once with its own attachment panel. | Location and category chips with `?location=` deep links (a garage tablet shows the garage); search; paginate logs. | M | Code |

### 4.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| MA-22 | **Delete is blocked until every attachment is removed by hand.** | "Delete with N attachments" in one confirmed action. | M | Code |
| MA-23 | **Hover-only explanations:** the Log service and Snooze buttons explain themselves only in `title`, and the warranty ring only in `title` plus 10 px text. | Visible captions on touch. | Q | Code |
| MA-24 | **Copy:** <br>• "Schedule-ready maintenance metadata"; <br>• "Latest Logs … whatever their date"; <br>• "Unscheduled checklist" items with no action; <br>• "Due soon" in a low-emphasis badge; <br>• lowercase "days"; <br>• no unsaved-changes guard on long forms. | Plain wording, a stronger due-soon badge, and a dirty-form guard. | Q | Code |
| MA-25 | **Loading and performance:** <br>• The route and client skeletons differ, so the header and tabs disappear and reappear on every cold load. <br>• Every keystroke in a schedule row re-renders the whole 3,338-line page. <br>• Every action re-reads all four collections, and resolving notifications reads all of them. <br>• Full-size photos with a large blur on every card. | One skeleton; split the dialogs into their own components; listeners and filtered queries; thumbnails on upload. | M | Code |

### 4.4 Wow and value ideas (built on existing data)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| MA-26 | **Per-room "Needs doing"** | The MA-12 list filtered by asset location, so the garage tablet shows the garage's due items with Done. | M |
| MA-27 | **Coming up and seasonal checklists** | The `upcoming` status is already computed and never shown: a 90-day timeline, plus category presets (HVAC filter every 3 months, smoke-alarm batteries, water-heater flush, gutters each October with calendar anchoring). | M |
| MA-28 | **Costs that mean something** | `cost` is on every log: lifetime cost per asset and vehicle, spend per year, cost per mile, and a "repair vs replace" hint when repairs pass about half the purchase price. | M |
| MA-29 | **Mileage prediction** | Fit miles per day from logged readings: "Oil change predicted around Mar 12". | M |
| MA-30 | **Receipt capture with AI fill** | A camera upload in the log dialog; AI reads cost, provider and parts into the form (the AI setup exists). | M–B |
| MA-31 | **QR stickers** | "Print label" makes a QR code for the furnace or water heater from the existing deep link; scanning it opens that asset with Log and Done ready. | Q–M |
| MA-32 | **Service history line** | "Filter last changed 3 months ago by Sam" on each asset, from linked logs plus MA-20. | Q |
| MA-33 | **Renewal shortcuts** | "Renewed (+1 year)" on registration and inspection; a Lifetime warranty flag; a warranty-claim checklist (provider, serial and receipt are already stored). | Q–M |

### 4.5 Looks good: keep as is

- **One reminder builder** for the page and the hourly job, in the household time zone, so due, overdue and snoozed always agree.
- **Snooze matches the server:** it only quiets an item while its date stands, mileage triggers still notify, and completion clears it.
- **Quick completion refuses to guess,** and opens the form when there's no interval or mileage.
- **Deleting an asset or vehicle keeps its logs** ("General – formerly X") and resolves its notifications in one batch.
- **Permissions:** controls are permission-gated and match the rules; the access check waits for membership, so there's no "no access" flash.
- **Deep links** apply once per URL; `?tab=` uses replace. Peeks are suppressed on touch, and every peeked action also has a real button.
- **Photo band, brands and rings:** the photo band has a fixed height, lazy loading and an error fallback. Brand matching is typo-tolerant but refuses ties. The rings have full text alternatives.
- **Motion:** all animations are finite (no endless motion on an always-on screen) and respect reduced motion.
- **No console errors** on any tab (verified live).

### 4.6 Suggested order

1. **Data safety:** MA-3 patch-don't-overwrite, MA-4 atomic Done, MA-5 save guard, MA-7 never drop the next due, MA-1 midnight.
2. **Trust:** MA-2 live updates, MA-8 Undo, MA-9 snooze state, MA-6 odometer, MA-10 honest health.
3. **Wall tablet:** MA-12 "Needs doing" on Overview, MA-13 one reminders list, MA-14, MA-18 layout and targets, MA-26 per-room.
4. **Phone in the garage:** MA-16 receipt in the log, MA-17, MA-19, MA-15 shorter forms.
5. **Wow:** MA-27 seasonal, MA-28 costs, MA-32 history line, MA-31 QR stickers, MA-29 prediction, MA-30 receipt AI.

---

## 5. Chores (`/chores`, the room filter, the Chore Manager; the Calendar page is its own section)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** all rooms and `?room=garage` at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900.

**Live:**
- the overdue "Audit: sweep floor" completed, then undone (restored exactly, verified after reload, no leftover points);
- Add Chore, the Chore Manager, the room filter, reassign, Select, Future and History, all cancelled;
- load timing: 3 loads each on phone and tablet.

**Code:** `chore-chart-client.tsx` (1,100 lines), `components/chores/*` (not the calendar), `lib/chores/*`, server upkeep and recurrence, the chore rules. Screenshots are in `C:\hh\audit\chores-audit\`.

**Verdict:** the fundamentals are strong:
- completion and Undo are exact;
- the server completion stamp is rule-enforced, so points can't be backdated;
- upkeep is idempotent;
- celebrations are short and skippable;
- day math is DST-safe.

But for a room tablet shared with kids:
- it never updates live;
- a completed or deleted repeat can come back or duplicate;
- points can be farmed by ticking future chores;
- every destructive control is a tap away for whoever is at the screen.

### 5.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| CH-1 | **No live data.** The page reads everything once (`chore-chart-client.tsx:134-195`) and refetches only after this device's own writes; no `onSnapshot`, no refresh on focus or visibility. The leaderboard setting isn't live either. | A room tablet never sees completions, new chores or reassignments from phones; done chores stay open, the leaderboard is frozen, and "House is clean" rarely fires on stale data. | Scoped live listeners (open chores plus recent completions), refetch on visibility or online, and retry on error. | M | Code |
| CH-2 | *(Fix tightened: see section 17.)* **Future chores can be ticked, which farms points.** A row's check is disabled only by permission, not by due date (`chore-list.tsx:99`), and on-time +5 applies whenever completed ≤ due (`stats.ts:56-58`). A daily chore has about 30 generated future instances. | A kid can tick a month of dishes today for about 450 points, and it also wipes those future chores. | Disable completing anything due after today (or give no points until the due day). | Q | Code |
| CH-3 | **Deleting one occurrence of a repeating chore undoes itself.** Generated IDs are fixed by template, room, day and assignee (`functions/src/shared/ids.ts:39-44`), and upkeep recreates any missing ID (`reminders.ts:223`). The dialog says "permanently removes". | "We're away Saturday" → delete → it's back on the next load or hourly run. | Write a skip (a per-template `skippedDays` list, or a `skipped` doc) instead of deleting generated instances. | M | Code |
| CH-4 | **Editing repeats causes wrong deletions and duplicates:** <br>• stopping or editing a repeating schedule also deletes one-time assignments of the same library chore (`:476-493`); <br>• assigning a library chore as "Repeats" ignores the chosen rooms and leaves the old series running, so reassigning A→B gives both 30-instance series (`:378-382`); <br>• changing the assignee mid-day duplicates today's chore when A already did it; <br>• deleting a room leaves up to 30 orphan instances under "Unknown Room" and can start a duplicate "general" series (`:458-474`). | Ghost and duplicate chores that undermine trust in the list. | Filter to generated instances (`!sourceType`); route assignment through `replaceRecurrence` and write the rooms; skip days already completed; move or delete a room's open instances in the same transaction. | Q–M | Code |
| CH-5 | **Two people completing the same chore:** the second write is (correctly) denied by the rules, but the app rolls the row back to *open* and says "Couldn't complete the chore" (`:564-571`). | With CH-1, this is the everyday case on a stale tablet: done, but shown as open with an error. | On a denial, re-read; if it's already done, show it done: "Already done by …". | Q | Code |
| CH-6 | **One tap in Completed silently reopens a chore and removes its points,** with no toast and no Undo (`:594-605`); ticked steps stay ticked. | A stray tap or a sibling erases someone's points. | Undo toast (or confirm); limit reopen to the completer, the assignee or a manager. | Q | Code |
| CH-7 | *(Fix tightened: see section 17.)* **Missed instances never expire** (retention purges only completed chores), and they block "House is clean". Only people with delete permission can clear them, which kids and members don't have. | The celebration never happens in many homes, and documents grow forever. | The server expires open generated instances older than N days; folded "missed" items don't count against clean. | M | Code |
| CH-8 | **A load failure looks like an empty household:** "No chores yet / Add your first chore", with no retry (`:189-194,966-975`). | A tablet that boots before Wi-Fi is up shows a false empty state for good. | An error state with Retry, plus auto-retry on online or visibility. | Q | Code |
| CH-9 | **The To Do heading is visibly broken:** "To Do (           1           )" and "Garage ( 1 )". The accordion trigger's flex layout spreads "To Do (", the number and ")" across the full width (the number itself is 10–12 px). | The first thing anyone reads on the tablet. | Wrap the label in one span (or drop `justify-between` on the label part). | Q | Live |
| CH-10 | **Smaller bugs:** <br>• "Today" uses the device time zone while the server generates in the household's (`use-today.ts:12` against `reminders.ts:178-179`). <br>• Every-2-weeks counts from the raw start date, not the week, so Mon/Fri pairs straddle weeks (`recurrence.ts:84-85`). <br>• Template edits leave orphan step ticks. <br>• Repeats have no end date and no "every N days/weeks". <br>• Steps are written as whole arrays, so two devices overwrite each other. <br>• A room literally named "General" merges with no-room chores. <br>• The empty state says "All done for today" and "Nothing is scheduled" together (Live). <br>• TOAST_LIMIT 1 means a second completion wipes the first one's Undo. | Each visible over weeks of use. | One small fix each. | Q–M | Code + Live |

### 5.2 Room tablet and phone (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** this settles CH-11 and CH-12. On a registered tablet, ticking a chore asks "Who's here?" and records who completed it; trash, reassigning to someone else, the Chore Manager, editing repeats and reopening someone else's completed chore need a PIN (WT-6). The optional per-member PIN (WT-9) is the answer to kids ticking chores as each other. A room tablet opens on its own room (WT-4), which covers CH-13.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| CH-11 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **A tablet signed in as a parent exposes every destructive control to kids:** trash and reassign on every row, the Chore Manager and the leaderboard toggle in the header. There's no "who's at the screen". | **Room kiosk mode** (`?room=kitchen&kiosk=1`, or a device setting): no delete, reassign or manage; "Who did it?" on complete; large type; live data; back to the room view after 60 s idle; night dimming. | M | Live + Code |
| CH-12 | **Points always go to the assignee, and there's no record of who completed it.** Anyone who can complete (kids included) can complete or reopen anyone's chore. | Store `completedByUid` (rules pin it to the signed-in user or a validated member from the "Who did it?" chips); decide credit (assignee keeps it, helper bonus); combine with CH-6. | M | Code |
| CH-13 | **On the tablet the room is barely visible.** The header (title, subtitle, three buttons) and a filter row come before To Do; with `?room=garage` the room name is only on the small filter button, and the leaderboard still shows the whole house. Rows are 14–16 px with a 12 px due label and Overdue pill. | A room layout: a big room title and icon, open chores as large cards (avatar and name prominent), a "done today" strip, compact header actions, and the leaderboard as a ribbon. | M | Live + Code |
| CH-14 | **"What's left today for the whole house, and whose is it?"** To Do is grouped only by room; "whose" means reading a 24 px avatar per row. | A person filter or "group by person" toggle, and avatar chips as quick filters. | M | Live + Code |
| CH-15 | **Tapping a chore's name does nothing:** no detail or edit view, so notes and steps aren't reachable from the list (Live). | Open a detail sheet (notes, steps, history, edit). | M | Live |
| CH-16 | **Targets and text:** <br>• Done, reassign and delete are 40 px side by side, with no confirmation on delete. <br>• The Select checkbox is 20 px clickable. <br>• Step checkboxes are 16 px. <br>• "Clear" on missed items is about 20 px. <br>• The leaderboard ring % is 10 px. <br>• Focus drops to `<body>` after completing. | 48 px on touch; delete behind a menu or swipe; the whole select cell as a label; move focus to the next row. | Q | Live + Code |
| CH-17 | **Slow first load:** about 5.3 s cold even on a fast desktop CPU (Live; 1.4–1.9 s warm), because it's a serial waterfall: household → members → N profiles → the upkeep server action (all chores, templates, assets, reminders) → 3 full reads. Upkeep also runs after every create or edit. | Render from Firestore first, run upkeep in the background and debounce it; read only open plus recent chores. | M | Live + Code |
| CH-18 | **Phone:** the header buttons wrap to a second row, and the leaderboard renders below the whole list, so it's effectively invisible. | Compact header actions; a leaderboard ribbon at the top. | Q | Code |

### 5.3 Motivation and fairness

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| CH-19 | **Streaks punish days with no chores.** A streak needs a completion every calendar day, so a kid with Mon/Wed/Fri chores can never pass a 1-day streak, while early completions (CH-2) keep a streak alive. | A streak is consecutive *due days* where all of that member's due chores were done; days with nothing due don't break it. | M | Code |
| CH-20 | **Self-made chores farm points:** unlimited one-time chores for yourself (15 each), and up to 20 steps on a template (+40). | Cap points per day, or count only template or admin-made chores. | M | Code |
| CH-21 | **The "This week" card:** the copy omits +2 per step; fair share counts ex-members' chores (rings don't sum to 100%) and shows load, not contribution; the Sunday podium shows before the week ends and resets Monday morning. | Fix the copy; exclude unknown assignees; show done/assigned; podium after the week closes. | Q | Code |
| CH-22 | **"House is clean" almost never fires on a tablet** (needs fresh data and no missed items: CH-1, CH-7), and there's no per-person moment. | Fix CH-1 and CH-7, plus a small "Your chores are done, Sam!" when one member's list clears. | Q | Code |

### 5.4 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| CH-23 | **One concept, five names:** "General" (filter and groups), "No room" (Add), "No Room" (library), "Around the house" (dashboard house), "Home" (house moment); "Removed room" vs "Unknown Room". | One name ("Around the house") and one for orphans. | Q | Live + Code |
| CH-24 | **Members hit dead ends:** they can create a repeating chore but not edit or stop it (that needs delete), clear missed items, or delete a mistake, and nothing says why. Guests see disabled checks with no explanation. | Let creators manage their own templates, or show "Ask an admin"; a one-line hint on disabled checks. | M | Code |
| CH-25 | **Add Chore allows only one room;** weekly and daily repeats have no start date; library, assign and rooms dialogs use `max-h-[60–65vh]` inside a centred dialog, so the keyboard may hide their buttons. | Multi-room, a start date, and keyboard-safe sheets. | Q–M | Code |
| CH-26 | **Performance:** every tick re-renders every row (props rebuilt each render, rows not memoised, `layout` animation on all rows), and the whole chores collection is read (30 future instances per series plus 90 days of completions); two different skeletons flash in sequence. | Memoise rows; animate only the changed group; scoped reads (CH-1); one skeleton. | M | Code |

### 5.5 Wow and value ideas (built on existing data)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| CH-27 | **"Who did it?" chips** | After a tick on a shared screen, avatar chips (default: the assignee). It powers fair points, helper bonuses and honest history. | M |
| CH-28 | **Rotations** | `rotation: [members]` on a template; the server assigns by occurrence ("Whose turn is the trash?" answered automatically). IDs already include the assignee, so it fits. | M |
| CH-29 | **Allowance from points** | Owners set cents per point; a weekly payout summary on the Sunday podium, snapshotted in `stats/` so retention can't change it. | M |
| CH-30 | **Photo proof for kids** | `requiresPhoto` on a template: the kid's completion is "pending" until a parent approves, and that approval awards the points (which also closes CH-2 and CH-12). | B |
| CH-31 | **Up for grabs and swaps** | "Anyone" chores claimed by whoever does them (needs CH-27); "offer to swap" through notifications. | M |
| CH-32 | **Away / sick pause and quiet hours** | Pause generation for a date range (the same skip mechanism as CH-3); quiet hours mute celebration sounds and dim the screen. | M |
| CH-33 | **Auto-complete when all steps are ticked,** with Undo. | | Q |

### 5.6 Looks good: keep as is

- **Undo is exact:** it snapshots before the write and restores `completedAt` and steps, deleting fields that were absent. Verified live: complete → Undo → reload, restored, with 0 points.
- **The server completion stamp is rule-enforced:** no backdating, and complete/undo loops gain nothing. Confetti fires once per chore per visit.
- **Server upkeep** is idempotent and guarded by the template's update time; retention rolls purged completions into yearly stats in the same transaction.
- **Missed-instance folding** is a good pattern (it needs expiry, CH-7).
- **Day math** is DST-safe, and the day rolls over at midnight without a reload.
- **Unknown `?room=` falls back to All Rooms;** the room filter and reassign menus work (verified live).
- **Add Chore** is one short dialog (chore, who, room, one time or repeats, due date, notes) and keyboard-safe (`dvh` with an inner scroll).
- **Names:** capped at 120 characters and clamped to 2 lines.
- **Celebrations** are short, non-blocking, skippable and respect reduced motion; sound and haptics are opt-in.
- **Overdue** is shown by text and a border, not colour alone.
- **The UI mirrors the rules** through `choreCapabilities`.

### 5.7 Suggested order

1. **Integrity:** CH-2 no future ticks, CH-3 skips instead of deletes, CH-4 repeat edits, CH-6 reopen with Undo, CH-5 "already done".
2. **Live and correct:** CH-1 listeners, CH-8 error state, CH-7 expire missed, CH-9 heading, the CH-10 list.
3. **Room tablet:** CH-11 kiosk mode with CH-27 "Who did it?" and CH-12 completedBy, CH-13 room layout, CH-14 by person, CH-16 targets, CH-17 load time.
4. **Motivation:** CH-19 fair streaks, CH-20 caps, CH-21, CH-22 per-person moment.
5. **Wow:** CH-28 rotations, CH-29 allowance, CH-32 pause and quiet hours, CH-30 photo proof, CH-31 swaps, CH-33.

---

## 6. Calendar (`/calendar`: Day, Week, Month)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** Day, Week and Month at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900.

**Live:** the chore panel opened (not moved); prev/next/Today and the view toggles; no console errors.

**Code:** `household-calendar.tsx`, `lib/chores/calendar.ts` and the shared date, completion and recurrence helpers, checked against the server generator. Screenshots are in `C:\hh\audit\cal-audit\`.

**Verdict:** a genuinely good foundation.
- One calendar already combines chores, maintenance due dates and pet medications, with an Overdue rail and a colour key.
- Planned repeats match the server's exact IDs, so moved or completed chores never reappear.
- "Move to date" gives touch and keyboard users a way around dragging.
- Midnight rollover works.

For a family wall calendar it needs to:
- update live;
- let you tick things off;
- be readable from across the room (24 px chips, 12 px text);
- show "who" without decoding colours.

### 6.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| CA-1 | **No live updates.** Chores, templates, assets, vehicles and medication logs are each read once (`household-calendar.tsx:268-329`). At midnight "today" rolls over, but the data isn't re-read. | The wall calendar shows the wrong done and overdue state all day. | `onSnapshot` with the dashboard's `listen()` pattern; at minimum refetch on day change and visibility. | M | Code |
| CA-2 | **The Overdue rail doesn't fold missed repeats** (`calendar.ts:167` lists every overdue event; `collapseMissedRecurring` isn't used). A daily chore missed for 9 days shows 9 identical chips and "Overdue (9)", while Chores and the dashboard fold it to one. | Counts disagree across the app, and the rail floods. | Fold by template ("Empty dishwasher ×9"), reusing the helper. | Q | Code |
| CA-3 | **A failed members load silently drops every planned repeat and every colour** (`:273` swallows the error; planned events are skipped without a member, `calendar.ts:299-300`). No error is shown. | Future weeks look empty for no visible reason. | A `members` error state in the alert. | Q | Code |
| CA-4 | **A cancelled drag can later move the wrong chore.** There's no `onDragEnd`, so a cancelled drag leaves the dragged chore set, and a later unrelated drag over a day moves it (`:166-173,405-420`). | Rare, but a silent wrong move. | Reset on drag end; check the dragged id on drop. | Q | Code |
| CA-5 | **Deleted repeat occurrences come back** (same cause as CH-3): the calendar shows the deleted day as "Planned" and the hourly upkeep recreates it. | Holiday weeks can't be cleared. | The skip mechanism from CH-3, respected in planned events too. | M | Code |
| CA-6 | **Slow first paint:** members are loaded before anything else starts (one list plus N profile reads), then the chores task waits for the whole upkeep server action before reading; the skeleton waits for the slowest source (`:273,279,322-326`). The load also runs twice when the household arrives after mount (`timeZone` in the dependencies, `:329`). | Seconds of skeleton on every tablet reload, plus a second full upkeep run. | Load sources in parallel, read chores first and run upkeep in the background, render each source as it arrives, drop the extra dependency. | Q–M | Code |
| CA-7 | **Smaller bugs:** <br>• A signed-in user with no household sees skeletons forever (`:269`). <br>• "Nothing to show" may flash while permissions load. <br>• Undo fails for legacy chores without `originalDueDate` (an `undefined` write, `:374`). <br>• A second quick move wipes the first one's Undo (toast limit 1). <br>• Device vs household time zone for today and medication days (`use-today.ts`, `calendar.ts:110,138`). <br>• Same-named medications collide on React keys. <br>• "Overdue ( 2 )" has the same stretched-count bug as CH-9 (Live). | Each one is small. | One small fix each. | Q | Code + Live |

### 6.2 Wall tablet and phone (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** on a registered tablet, "Mark done" from the calendar (CA-8) uses a face tap; moving a chore to another day is also a face tap, because it has Undo. CA-12 (a swipe leaves the wall on another week) is covered by idle-to-home (WT-14), and CA-22 Wall mode by device registration.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| CA-8 | **You can't tick anything off.** Tapping a chore opens a panel with only "Move to date / Move" and "Open Chores" (Live); the rail and the day agenda don't complete either. On a family wall calendar, "done" is the main action. The completion helpers already exist (`completion.ts:24,36`). | A large "Mark done" (with Undo and confetti) in the panel, the agenda and the rail. Applies CH-2's rule (nothing ahead of its day) and CH-27's "Who did it?" on shared screens. | M | Live + Code |
| CA-9 | **Too small for a wall:** <br>• chips are 24 px tall with 12 px truncated titles ("Audit: sweep…"); <br>• the Month day number is about 16 px tappable, and "+N more" about 16 px; <br>• the view toggles and Today are 36 px; <br>• the "Today" pill is 10 px; <br>• about 230 px of header, subtitle, toolbar and the "Drag a chore…" hint come before the grid; <br>• week columns are about 125 px wide. | A **wall layout**: <br>• collapse the header; <br>• the rail becomes a slim top strip or a count; <br>• the week fills the screen height; <br>• chips are 2-line, 15–16 px, with an avatar; <br>• whole Month cells are tappable; <br>• 44 px+ controls. | M | Live + Code |
| CA-10 | **"Whose is it?" relies on colour alone:** chips show an icon and title, and the owner is only a tint plus a sidebar key. With 5+ members and kids reading from across the room, it doesn't work. The key also doesn't explain dashed = planned or the red border = overdue. | An avatar or initial on each chip, or per-person lanes (CA-21); complete the key. | Q | Live + Code |
| CA-11 | **Drag is advertised on touch, where it barely works.** "Drag a chore to another day" shows for everyone; HTML5 drag doesn't work with touch on Android Chrome, and the swipe handler turns horizontal finger moves over chips into a week change. | Show the hint only for fine pointers; on touch, quick-pick buttons in the panel (Tomorrow, the next weekdays) instead of a bare date field; or pointer-event drag. | M | Live + Code |
| CA-12 | **Swipes navigate away and the wall never comes back:** one kid's swipe leaves the tablet on another week until midnight. | Return to Today after about 2 minutes idle; no swipe in Week view on tablets. | Q | Code |
| CA-13 | **Month view's day detail is below the fold.** Tapping a day or "+N more" sets the selected day, and its detail renders under the roughly 700 px grid (Live: "Monday, November 9 · Nothing planned" at the bottom), so the tap looks like it did nothing. | Open the day as a panel or sheet, or scroll it into view. | Q | Live + Code |
| CA-14 | **Busy days stretch the week** (cells grow without a cap), so a 10-chore day pushes the week past one tablet screen. | Fit the week to the screen; cells scroll internally or show "+N more", like Month. | Q | Code |
| CA-15 | **Planned repeats can't be moved** ("It joins the chart closer to the day"), so next month's chore can't be moved around a holiday. | On move, create the instance with its deterministic ID on the new day (the server skips existing IDs). | M | Code |
| CA-16 | **Week starts on Monday, hard-coded,** while most US family calendars start on Sunday. Stats use the same rule. | A household "Week starts on" setting threaded through the calendar and stats. | M | Code |

### 6.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| CA-17 | **"Open Chores" goes to `/chores` with no context.** | Deep-link with `?room=` or a `?chore=` highlight. | Q | Live + Code |
| CA-18 | **Load errors only say "reload the page",** and a kiosk may have no reload control. Empty weeks are blank on the tablet ("Nothing planned" is phone-only). Month navigation selects the 1st, not today. | Retry with automatic backoff; a "Nothing planned" state at every size; select today in the current month. | Q | Code |
| CA-19 | **Accessibility:** <br>• chips don't announce "planned", and rail chips have no date; <br>• Week and Month have no grid semantics or arrow keys (about 140 tab stops in Month; the Day agenda does have arrows); <br>• status chip colours aren't in the contrast test. | ", planned" plus dates in names; `role="grid"` with a roving tabindex, or at least an `h3` per day; add the chips to the contrast test. | M | Code |
| CA-20 | **Performance:** <br>• every drag-over re-renders every chip (each is a popover, a peek and a layout `motion.div`); <br>• medication history loads every dose ever, and all events re-sort on every navigation; <br>• upkeep runs on every open; <br>• two different skeletons shift the page twice. | Memoised chips and a CSS-only drop highlight; query medication logs from the visible range only; split the memos; background upkeep; one skeleton. | M | Code |

### 6.4 Wow and value ideas (built on existing data)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| CA-21 | **Per-person lanes** | Week rows per member (avatar and colour) plus a "House" row for maintenance and pets: the classic family wall layout, answering "who's doing what" at a glance. | M |
| CA-22 | *(Replaced by the tablet design: see section 15 and 16.2.)* **Wall mode** | Large type, today's agenda pinned beside the week, tap-to-complete with confetti, back to Today when idle, wake lock, live data. Pairs with HP-30. | M |
| CA-23 | **Everything with a date** | Pantry expiry dates (`expiryDate` exists) and pet care history on the calendar too; project maintenance repeats forward (dashed, like planned chores) instead of only the next due date. | Q–M |
| CA-24 | **Filters** | Tap an avatar in the key for "only my stuff"; chips for kind (chores, pets, maintenance). | Q |
| CA-25 | **Phone calendar sync (ICS)** | A per-household secret feed URL so chores (with projected repeats), maintenance, expiries and doses appear in everyone's phone calendar. | M–B |
| CA-26 | **Fair share this week** | A per-member strip of this week's chores, from the existing stats helpers. | Q |
| CA-27 | **Holiday handling** | Move a planned occurrence (CA-15) and skip one (CA-5): "We're away Thu–Sun" in two taps. | M |

### 6.5 Looks good: keep as is

- **One calendar for everything:** chores, maintenance and medications, with an Overdue rail and a colour key (verified live). An expired warranty is treated as information, not overdue.
- **Planned occurrences match the server's exact IDs,** so moved or completed chores never reappear on their old day; the same recurrence rules as the server, and unit-tested.
- **Dates:** a day-key model with a DST-safe date shift; rescheduling writes local noon so older readers agree.
- **Midnight rollover:** a timer plus visibility and focus, and a view showing today follows today.
- **Moving is optimistic with rollback and a 5 s Undo.** "Move to date" has inline validation and is a solid touch and keyboard alternative (verified live).
- **Permissions:** each source is permission-gated and isolates its own errors; Move is never offered without edit permission.
- **Sensible defaults:** Day on phones and Week on tablets, with a swipeable, arrow-key Day agenda. Peeks never show on touch. Member colours are AA-checked and collision-free.
- **Reduced motion** is handled. **No console errors** in any view (verified live).

### 6.6 Suggested order

1. **Correctness:** CA-2 fold the rail, CA-3 members error, CA-4 drag reset, the CA-7 list, CA-5 with CH-3.
2. **Live and fast:** CA-1 listeners, CA-6 load order, CA-12 return to Today.
3. **Wall calendar:** CA-8 Mark done, CA-9 wall layout, CA-10 avatars on chips, CA-11 touch moves, CA-13, CA-14.
4. **Household fit:** CA-16 week start, CA-15 and CA-27 holidays, CA-17.
5. **Wow:** CA-21 lanes, CA-22 wall mode, CA-23 everything with a date, CA-25 ICS, CA-24, CA-26.

---

## 7. Notifications (center, bell, push, and the server that creates them)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** the center at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900; the bell dropdown on tablet and phone; Profile's push and reminder settings.

**Live:** one notification dismissed by its ×, then Undo (Unread 4 → 3 → 4, verified after reload).

**Code:** the center, the bell, push setup, the foreground listener, the service worker, `lib/notifications`, and the server side that creates and sends notifications (chore, maintenance and medication reminders, approvals), plus rules, tokens and TTL. Screenshots are in `C:\hh\audit\notif-audit\`.

**Verdict:** the plumbing is careful:
- deterministic, idempotent reminders;
- one audience function shared by push, bell, center and dashboard;
- recipients from membership only, and invalid tokens removed;
- safe deep links;
- well-built swipe-to-dismiss with Undo.

The experience is noisy and person-centric in a house of shared screens:
- the same overdue chore is pushed every day and never clears;
- pushes fire at midnight;
- a tablet signed in as Mom acts as Mom;
- signing out doesn't stop a device's pushes.

### 7.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| NO-1 | **The same overdue chore is notified every day, often twice, and never clears.** The overdue alert's ID includes the date (`chore-reminders.ts:75-87`, `${uid}-overdue-${today}`), so each day makes a new document and a new push; the daily reminder also counts overdue chores, a second push; chore reminders are never resolved, so finishing the chore leaves the alert for up to 7 days. Live: 4 unread, but only 2 things: "sweep floor is overdue" today *and* yesterday, plus "Flea & Tick is overdue" *and* a stale "is due today". | Noise on every phone and clutter on every tablet; people learn to ignore it. | One stable notification per person ("open chores") updated in place, pushing only when the set grows (at most once a day); resolve it when nothing is overdue; fold overdue into the daily reminder. | M | Live + Code |
| NO-2 | *Withheld from the public copy until the fix is live.* | | | | |
| NO-3 | **Pushes fire around midnight.** Maintenance and medication reminder states change at local midnight, and the first hourly run after it creates documents, which push immediately (`reminders.ts:339-380`, `index.ts:47`). There are no quiet hours. | Every phone in the house (kids included) buzzes between 00:00 and 01:00: "Maple's flea prevention is due today". | Create the document any time, but hold the push until a morning hour (or `notBefore`); per-member quiet hours (NO-24). | Q–M | Code |
| NO-4 | **The overdue alert ignores the reminder setting** (only checks the time is after 07:00, `chore-reminders.ts:75`). | Kids and partners get a 7 am push every day with no way to opt out. | Respect a setting (and the member's reminder time). | Q | Code |
| NO-5 | **Push tokens are never refreshed, and the UI says "active" when it may not be** (`PushNotificationSettings.tsx:27-33,103-108`: permission granted means "active", with no button). Token rotation, a re-registered worker or a server-removed token silently ends push. | The likely cause of "my phone stopped getting notifications", with no way to fix it. | On each signed-in load with permission, get the token and upsert it if it's missing; a real status ("This device is registered" / "Re-connect"). | M | Code |
| NO-6 | *Withheld from the public copy until the fix is live.* | | | | |
| NO-7 | **Counts disagree:** the bell and tile exclude resolved items and cap at 10; the center's Unread doesn't exclude resolved items and isn't capped (an already-given dose shows under Unread with a "Resolved" badge). The bell's "Dismiss all" only dismisses the 10 shown. | "9+" in the bell, "Unread 12" in the center; "Dismiss all" that doesn't. | Exclude resolved items everywhere; count before capping; dismiss everything active. | Q | Code |
| NO-8 | *Withheld from the public copy until the fix is live.* | | | | |
| NO-9 | **Tapping a push opens a new window** instead of reusing the open app: the worker compares paths without the query string (`api/sw/route.ts:128-136`), and most links have one. Opening a push also doesn't mark it read. | A stack of HomeHub windows on phones, and an unread badge that stays. | Match path plus query, or focus and navigate the first window; pass `?n=<id>` and mark it read on landing. | Q–M | Code |
| NO-10 | **Approval notices go to the wrong people and go stale:** the daily "Pending member approval" isn't targeted, so it goes to everyone including kids (the README says owners and admins); "New member needs approval" is never resolved after someone approves. | Noise for kids, and admins told to act on something already done. | Target owners and admins; resolve on approval. | Q–M | Code |
| NO-11 | **Smaller bugs:** <br>• The person who caused a notification gets their own push (ownership transfer pushes the person who tapped it); write and exclude `createdByUid`. <br>• A reopened reminder stays hidden for anyone who dismissed it, and a refresh shows a 3-week-old item as "just now". <br>• Some chore-assignment notifications use random IDs, so a retry duplicates them. <br>• No push TTL, so a phone off for two days gets "due today" for past days. <br>• A push arriving while the app is open replaces the Undo toast (toast limit 1). <br>• Notifications with no link go to `#` from the bell. <br>• "2 minutes ago" never ticks and Today/This week never roll over on an always-on tablet. <br>• The member's time zone is whichever device signed in last. <br>• "Dismissed by" names whoever dismissed first. | Each one is small. | One small fix each. | Q | Code |

### 7.2 Shared tablets vs personal phones (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** this settles NO-12. A registered tablet shows only household-wide notices, never anyone's targeted reminders or approval requests, and gets no push (WT-10). Dismissing a household notice needs a face tap. Personal notifications stay on phones. NO-13 (a household feed and "message the house") becomes the tablet's notification view.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| NO-12 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **A wall tablet signed in as Mom acts as Mom.** It shows her targeted reminders and approval notices; a kid dismissing or opening one on the tablet clears it on Mom's phone; the bell count is hers; with push enabled, the tablet gets all her private pushes. | A per-device **Shared display** mode: only household-wide items, no targeted ones, never write read state, "dismiss" is a local hide (or "Who's this?"), never register a push token. Pairs with HP-30, CH-11 and CA-22. | B | Live + Code |
| NO-13 | **No household feed:** the center is "Last 7 days of household notification history" in one person's view; there's no "message the house" and no banner for shared screens. | **House announcements** (NO-25) and a household-only filter. | M | Live |
| NO-14 | **No "mark all read",** and items only become read when opened, so the phone's app badge stays up. | "Mark all read" in the bell and center (optionally after the bell has been open for 2 s). | Q | Code |
| NO-15 | *Withheld from the public copy until the fix is live.* | | | |
| NO-16 | **Targets and layout:** <br>• the visible × is a 24 px non-button `<div>` inside the card's link (Live; the real "Dismiss …" buttons are hidden layers); <br>• center dismiss is 32 px, bell dismiss 28 px, the badge 10 px; <br>• the center is one full-width column at 1280 px (long lines, the × far away); <br>• the bell dropdown is a fixed 320×256 px (about 3 items on a tablet); <br>• filter chips scroll off-screen on phones with no hint. | A real 44 px dismiss button on touch; `max-w-3xl` or 2 columns with a sticky filter bar; a bell dropdown sized to the screen; a fade on the chip row. | Q | Live + Code |
| NO-17 | **Enabling push on an iPhone dead-ends:** outside an installed home-screen app, Safari has no Notification API and the card just says "This browser does not support push notifications". The setup also shows two toasts ("Permissions granted!" then "Subscription Successful!") and triggers the OS prompt without explaining first. | Detect iOS outside the installed app: "Add HomeHub to your Home Screen, open it from there, then enable." One outcome toast; a short explanation before the prompt (denial is usually permanent). | Q | Code |

### 7.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| NO-18 | **The filter chips ignore permissions** (a child sees always-empty Shopping, Maintenance and Automation chips) and there's no Household/System chip. | Build the chips from viewable categories; add "Household". | Q | Live + Code |
| NO-19 | **Push content is generic** ("Overdue chores", "Daily chore reminder"), text only, with no actions; chore reminders link to the generic Chores page. | Specific titles ("Sweep the floor is 2 days overdue"); deep links to the item (NO-23 actions). | Q–M | Code |
| NO-20 | **Accessibility:** <br>• the bell's dismiss buttons sit inside a Radix menu, where Tab is blocked (keyboard can't reach them); <br>• new notifications aren't announced; <br>• unread in the bell is colour only; <br>• items without a link render as links to `#`; <br>• dismissed cards use `opacity-70` on muted text (contrast risk); <br>• mouse users get a grab cursor they can't use. | A popover with a real list (or menu items); a polite live region; an "Unread" dot; buttons for linkless items; token colours; grab cursor only on touch. | Q–M | Code |
| NO-21 | **Performance:** <br>• the center's query has no limit; <br>• the hourly upkeep reads whole collections (all chores including 90 days completed, every pet's full medication history, every profile) 24 times a day, plus again on every Chores page load. | Audience filter and `limit(100)` with "Load more"; bounded upkeep queries; throttle the on-demand sync. | M | Code |

### 7.4 Wow and value ideas (built on existing code)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| NO-22 | **Morning digest** | Replace the separate daily chore pushes with one morning digest per member (chores due and overdue, their pets' doses), updated in place and resolved as things get done. | M |
| NO-23 | **Actionable pushes** | "Mark done" on a chore, "Logged dose" on a medication, "Snooze till tonight" on maintenance (it already has `snoozedUntil`). Simplest safe version: the action opens a prefilled deep link. | M–B |
| NO-24 | **Per-member preferences** | Muted categories, quiet hours in the member's zone (pushes held until morning; items still in the bell), and "this device is a shared display, don't push". | M |
| NO-25 | **Message the house** | Owners and admins write "Dinner at 6" or "Plumber coming 2 pm" (the rules already allow general/system notifications); it pins as a banner on shared-display tablets until it expires, optionally pushing to phones. | M |
| NO-26 | **My devices** | A list of this member's registered devices (label, last seen) with "Turn off" for each; it lets people retire an old tablet. | M |
| NO-27 | **Background app badge** | The worker updates the phone's icon count when a push arrives (today it only updates while the app is open). | Q |

### 7.5 Looks good: keep as is

- **Reminders** use deterministic IDs and transactional, idempotent upkeep; refreshing before TTL keeps read and dismissed state and sends no push; the TTL policy is versioned.
- **One audience function** drives push recipients, bell, center and dashboard, with a unit test proving it matches the rules. Recipients come from membership only, so removed or pending members get nothing.
- **Tokens:** invalid tokens are removed (private doc and legacy field); tokens live in an owner-only doc, capped at 20 with oldest-first eviction.
- **Safe links and images:** the push-link check is shared by server and worker and tested against hostile input; the push image allowlist is strict and household-scoped.
- **Swipe-to-dismiss** is well built: the target never moves, 6 px slop, touch only, respects reduced motion, a button alternative on touch. Dismiss and Undo work (verified live: 4 → 3 → 4).
- **Push tag** is the notification ID, so repeats replace each other instead of stacking. The worker and FCM load after first paint and only when signed in.
- **Deep links** with `?tab=` on Household, Pets and Maintenance are consumed correctly.
- **The center's grouping** (Today / This week), filters and "Dismiss visible" are clear (verified live).

### 7.6 Suggested order

1. **Stop the noise:** NO-1 one overdue notification per person, NO-4 respect the setting, NO-3 no midnight pushes, NO-10 approvals.
2. **Make push trustworthy:** NO-2, NO-5 refresh tokens, NO-9 reuse windows and mark read, NO-17 iPhone guidance.
3. **Correct counts:** NO-6, NO-15, NO-7, NO-8, the NO-11 list.
4. **Shared screens:** NO-12 shared-display mode, NO-14 mark all read, NO-16 targets and layout, NO-25 message the house.
5. **Wow:** NO-22 digest, NO-24 quiet hours and preferences, NO-23 actionable pushes, NO-26 my devices, NO-27.

---

## 8. Household (`/household`: Overview, Invite Codes, Members, Roles, Activity, Danger Zone; join and onboarding)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** all six tabs at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900.

**Live:** every tab read; the Delete household dialog opened and abandoned (its delete button stays disabled until the name is typed); nothing changed; no console errors.

**Code:** `household-management-client.tsx`, `household-manager.tsx` (create/join and waiting), `components/household/*`, permissions, invite codes, the server membership actions, the auth context's household parts, and the rules. Screenshots are in `C:\hh\audit\house-audit\`.

**Verdict:** the core is careful:
- invite redemption is one transaction (single use, expiry capped from the server's time, no second household);
- the membership document is the only authority, and the owner can't be locked out;
- deletion freezes first and can resume;
- every destructive action has a confirmation, and delete needs the typed name.

The gaps:
- your own role never updates live;
- one item withheld;
- pending and half-deleted states can trap people;
- one item withheld;
- nothing supports shared tablets, kids or babysitters.

### 8.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| HO-1 | **Your own membership never updates live.** It's read once (`auth-context.tsx:293-325`) with no listener, and permissions derive from that snapshot. | An approved person keeps seeing "Waiting for approval" until they reload, and nobody tells them they were approved. A demoted, removed or restricted member keeps the old UI, and every write fails. Other devices never see that the owner started deleting the household. On a wall tablet this lasts for days. | Listen to your own member doc and the household doc; reset on removal or deletion; send a targeted "You're in, as Member" notification on approval. | M | Code |
| HO-2 | *Withheld from the public copy until the fix is live.* | | | | |
| HO-3 | **A pending joiner is stuck.** The waiting screen offers only "Open Profile" and "Sign Out", Profile has no cancel or leave, and joining another household is refused while any membership exists (`household-membership.ts:88-94`). | Someone who typed the wrong code, or was ignored, can never join another household until an admin denies them. | A "Cancel request" button (the server already lets non-owners leave). | Q | Code |
| HO-4 | **Non-owners of a half-deleted household are stuck:** once deletion has started, leaving and joining elsewhere are both refused, and they only get "Sign Out". | If the owner never presses "Finish deleting", everyone else is locked out for good. | Let non-owners leave a household being deleted, or finish deletion on a schedule. | M | Code |
| HO-5 | **Removing a member damages chores:** <br>• completed chores are unassigned too, erasing history and stats, and a long-standing member (about 495+ chores) makes the batch exceed 500 writes so they *can't* be removed (`:441-448`); <br>• repeating chores keep them as the assignee (`:454-456` clears only one of two fields), so removed people still appear on the calendar. | Lost history, unremovable members, ghost assignees. | Unassign only open chores, clear both fields, and do it server-side in chunks. | Q | Code |
| HO-6 | *Withheld from the public copy until the fix is live.* | | | | |
| HO-7 | **The pending-member reminder** fires on the first manager visit (a missing timestamp is treated as "long ago") and goes to everyone, kids and guests included (untargeted). | Noise, and the same issue as NO-10. | Use the join time as the baseline; target owners and admins. | Q | Code |
| HO-8 | *Withheld from the public copy until the fix is live.* | | | | |

### 8.2 Security and privacy, as they show in the UX

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| HO-9 | *Withheld from the public copy until the fix is live.* | | | |
| HO-10 | *Withheld from the public copy until the fix is live.* | | | |
| HO-11 | *Withheld from the public copy until the fix is live.* | | | |
| HO-12 | *Withheld from the public copy until the fix is live.* | | | |

### 8.3 Shared tablets, kids and guests (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** HO-13 is settled: tablets join with a **device code**, not a Google account (WT-1 to WT-3), and are managed from a Devices list (WT-4). HO-11 (destructive admin actions on a shared screen) is settled by the admin PIN (WT-6, WT-9). HO-14 guest passes and HO-15 kid profiles are still open; kid profiles matter more now, because a kid needs a face in the "Who's here?" row even without an email.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| HO-13 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **No shared-tablet account.** A wall tablet must sign in as a real Google account; if it's the owner's, Members (no-confirm role radio, Make owner, Remove) and Danger Zone are one or two taps away for any kid. | A **device role** (like Member with no household management, deletes or Danger Zone) for a dedicated tablet account, plus a "Who's at the screen?" picker (the code itself notes "Chores carry the assignee, not who ticked them"). Ties together HP-30, CH-11, CH-27 and NO-12. | B | Live + Code |
| HO-14 | **No babysitter path:** Guest is permanent, needs a Google account, and has to be removed by hand. | **Guest passes:** an invite option "Guest for 4 h / 1 day / 1 week" with `accessUntil` enforced in the rules, auto-removed and logged. | B | Code |
| HO-15 | **No kid path without email:** chores are assigned by email, so a kid needs their own Google account (Family Link under 13). | Kid profiles (no sign-in), assignable and completable from the shared tablet; needs chore assignment decoupled from email. | B | Code |
| HO-16 | **Inviting someone by phone is many steps:** create a code → paste it into a text → they open the app, sign in with Google and type a 10-character code within 30 minutes → you open Members, pick a role and approve → they reload (HO-1). No link, QR code or share sheet, no role at invite time, no longer or multi-use codes (the rules allow up to 10 uses). | A `/join?code=` link, a big QR code on the Invites tab (scan a new phone from the wall tablet), the system share sheet, an optional role suggested at invite time, and longer or multi-use options. | M | Live + Code |

### 8.4 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| HO-17 | **The approval banner hides what roles mean** (the role summary is screen-reader-only), so an owner picks Child, Guest or Admin blind. | Show the summary under the picker. | Q | Code |
| HO-18 | **The Roles matrix is about 2,000 px of 14 px text** (Live) with no row descriptions ("View household", "Manage roles" vs "Manage members"); the column header scrolls away; unticking "View household" for a member shows them "Waiting for approval" (wrong copy). | One-line descriptions per row; a sticky header; lock no-op cells (HO-2); correct copy. | Q | Live + Code |
| HO-19 | **No household settings:** the time zone can't be changed (the rules allow it; it was captured from the creator's browser), the week start is hard-coded Monday (CA-16), and colours can't be chosen. | A Settings card on Overview: time zone, week start, member colours. | Q–M | Code |
| HO-20 | **Small things:** <br>• Overview shows the internal household ID (Live). <br>• Tabs are 32 px and dropdown items about 32 px (Live). <br>• The full activity timestamp is hover-only. <br>• The delete-confirm input has no visible label and leaves autocorrect on (iPad autocorrect can stop the name matching). <br>• Invite history lists every used or expired code forever. <br>• The phone tab list is cramped (3 columns). | Hide the ID behind "Support details"; 44 px targets; visible timestamps; a labelled input with `autoCorrect=off`; trim the history; a scrollable tab row. | Q | Live + Code |
| HO-21 | **Accessibility:** <br>• matrix group headers use `scope="colgroup"` (should be `rowgroup`); <br>• the "custom" dot is visual only; <br>• the pending count's label sits on a span and isn't read out; <br>• focus is lost after removing a member; <br>• the pending badge contrast needs a check. | Fix the scope; add "(custom)" to labels; sr-only "2 pending"; move focus to the list heading. | Q | Code |
| HO-22 | **Performance:** the audit-log listener and the invites listener are unbounded (they grow forever, and invites are never cleaned up, which also risks the 500-write delete batch); removing or leaving reads every chore the person was ever assigned. | `orderBy` + `limit(50)` with "Load more"; a TTL on invite `expiresAt`; filter to open chores. | Q | Code |

### 8.5 Wow and value ideas (built on existing code)

> **Agreed wall tablet design (2026-11-09, see section 15):** HO-25 Device role plus "Who's at the screen?" and HO-26 Admin PIN are now the agreed design (WT-5 to WT-9). HO-23 Join by QR also covers tablet setup: the phone shows the device code as a QR (WT-2).

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| HO-23 | **Join by QR from the wall** | The household tablet shows a big QR; a new phone scans it, signs in, and lands pre-filled; the owner approves with the role already suggested. | M |
| HO-24 | **Guest passes** | See HO-14: the babysitter and the dog walker get exactly the access they need, for exactly as long as needed. | B |
| HO-25 | *(Replaced by the tablet design: see section 15 and 16.2.)* **Device role plus "Who's at the screen?"** | See HO-13: the foundation for every shared-tablet feature in this audit. | B |
| HO-26 | *(Replaced by the tablet design: see section 15 and 16.2.)* **Admin PIN on shared devices** | A 4-digit household PIN before Members and Danger Zone on touch devices. | M |
| HO-27 | **Kid profiles** | See HO-15. | B |
| HO-28 | **Activity feed upgrade** | Filters (people, invites, roles), from → to diffs, and a targeted "You were approved / your role changed" to the person affected. | M |

### 8.6 Looks good: keep as is

- **Invite redemption is one transaction:** single use, revocation, an expiry cap of 2 h from the server's creation time (it ignores client-claimed expiry), refuses a second household, and targeted approver notices with retry-safe IDs.
- **The membership document is the only authority;** the rules enforce the owner invariant, so the owner can't self-demote or be removed without a transfer. Owner-only overrides are blocked in rules and UI.
- **Deletion freezes the household first, then deletes, and can resume.** Leaving re-reads membership, closing the race with ownership transfer.
- **Confirmations:** remove, deny, transfer and leave all confirm; delete requires the typed name, re-checked on the server (verified live: "Delete forever" stays disabled until the name is typed; the warning lists exactly what's lost; the owner can't leave without transferring first).
- **Roles are explained in plain words** (Owner, Admin, Member, Child, Guest) above the matrix (verified live).
- **Live lists:** member, invite and activity lists are live and fail independently; chore stats never show a fake 0; the permission draft discards itself if the member changes live.
- **Invite code details:** the alphabet excludes ambiguous characters, the code is formatted while typing and normalized on the server, and a blocked clipboard still reports success.
- **Layout and links:** `?tab=` deep links work; long names wrap; reduced motion is respected; the tablet layout is sound.
- **No console errors** on any tab (verified live).

**Test gaps:** no e2e tests for remove, deny, transfer, leave or delete; no rules tests for admin-vs-admin actions or for the unenforced `household.*` overrides.

### 8.7 Suggested order

1. **Truth and safety:** HO-2, HO-9, HO-1 live membership, HO-5 safe removal, HO-6 server actions.
2. **Unstick people:** HO-3 cancel a request, HO-4 the half-deleted household, HO-7 reminder targeting, the HO-8 list.
3. **Privacy for kids and guests:** HO-10, HO-11, HO-12.
4. **Shared home:** HO-13 device role and "Who's at the screen?", HO-16 and HO-23 QR invites, HO-19 settings, HO-14 guest passes, HO-15 kid profiles.
5. **Polish:** HO-17, HO-18, HO-20, HO-21, HO-22, HO-28.

---

## 9. Profile (`/profile`: personal information, appearance, chore reminders, push)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Sizes:** tablet 1280×800 (touch, no hover), phone 390×844, desktop 1440×900. Read only: nothing was changed; no console errors.

**Code:** `profile-client.tsx`, appearance settings and provider, the theme bootstrap, feedback, the login and password dialogs, the auth context's profile parts, and avatar storage rules. Screenshots are in `C:\hh\audit\profile-audit\`.

**Verdict:** appearance is genuinely well done:
- a no-flash theme bootstrap;
- 5 presets that are all contrast-tested to AA;
- reduced motion honoured everywhere;
- sound and haptics marked "This device only";
- forms that wait for the confirmed profile.

The gaps:
- saves can fail and still report success;
- a name or photo edit doesn't reach every screen;
- a wall tablet can only ever be someone's personal account, which any passer-by can rename, re-theme or sign out;
- there's no text size, which is the one setting a wall needs most.

### 9.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| PR-1 | **A failed save still runs the success path.** `updateUser` catches every error, shows "Update Failed" and never tells the caller (verified, `auth-context.tsx:535-546`). Profile then discards the chosen photo and resets the form as if it worked (the uploaded file is orphaned); Chore Reminders shows "Reminder saved" right after "Update Failed". | Lost photos, and contradictory messages. | `updateUser` returns success or throws; gate the success steps on it. | Q | Code |
| PR-2 | **A name or photo edit doesn't reach every screen.** Only the profile is updated; the household member record keeps the join-time name and photo (and members can't update their own). Chores and the calendar show the new one; Household, the command palette, Home Wrapped and notification names show the old one. | Two names and photos for the same person across the app (same root cause as HO-8's frozen names). | A server action or trigger that mirrors name and photo to the member record. | M | Code |
| PR-3 | **The dashboard greeting ignores a renamed display name:** it prefers Google's `firstName`, which Profile never edits (`dashboard.tsx:58`), so renaming yourself "Mom" still greets you as your Google first name. | The page you see most ignores the setting. | Prefer the display name, or add an editable "What should we call you?". | Q | Code |
| PR-4 | **Reminders fire up to about 59 minutes late:** any minute can be chosen and the copy promises "at 5:17 PM", but the server runs hourly. | A broken promise. | An hour-only picker, or "around 5 PM". | Q | Code |
| PR-5 | **The reminder time zone is whichever device loaded the app last** (every load overwrites it, `auth-context.tsx:225-228`); nothing shows which zone is used. | A travelling phone moves everyone's reminder and overdue times, then the wall tablet flips them back. | Set it only when missing or confirmed; show "Reminders use Central time · change". | M | Code |
| PR-6 | **Cross-device theme writes revert each other:** the account theme is applied once per page load, and a toggle writes the whole theme object from that stale state (`appearance-provider.tsx:193-204,241-244`). | A wall tablet toggling Reduce motion silently reverts a preset changed on a phone. | Write only the changed keys, or listen to the profile. | Q–M | Code |
| PR-7 | **Loading and error states:** <br>• "Sign in to see your profile" flashes for a signed-in member while auth restores (`page.tsx:9,20`); <br>• if the profile read fails, the skeleton spins forever with no retry. | First impressions, and a dead end on a wall tablet. | Wait for loading; an error state with Retry. | Q | Code |
| PR-8 | *Withheld from the public copy until the fix is live.* | | | | |
| PR-9 | **Avatar gaps:** <br>• the old photo is never deleted (on replace or remove); <br>• the extension comes from the file name ("IMG" → `.IMG`); <br>• photos aren't resized, so a 5 MB original downloads on every avatar render on every wall tablet; <br>• EXIF data, including GPS, is kept on files readable by any signed-in user with the link; <br>• HEIC is rejected client-side although the rules allow it. | Storage waste, slow tablets, and location leaks from photos. | Resize to 512 px WebP/JPEG in the browser (this also strips EXIF); derive the extension from the type; delete the previous file. | M | Code |
| PR-10 | **Smaller bugs:** <br>• The logout toast never shows in production (the page reloads first), and the up-to-3-second flush has no spinner, so it can be tapped twice. <br>• (One item withheld: NO-2.) <br>• Saving the profile re-reads membership and the household (unnecessary dependencies). <br>• The README says the E2E login endpoint needs a non-production runtime; it doesn't check that, though it's still unreachable in production. | Each one is small. | One small fix each. | Q | Code |

### 9.2 Shared tablets (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** this settles PR-11 to PR-13. A registered tablet has no personal Profile page and no account menu (WT-10, WT-14); a Tablet settings page takes its place, where anyone can change that tablet's theme, text size and motion, while signing out, removing the tablet or signing in with a personal account needs an admin PIN (WT-16); each person's profile, reminders, push and PIN are managed from their own phone. Theme, text size and motion for a tablet live on the tablet's record (WT-4), which fixes PR-12 and delivers PR-14 for walls. PR-22 "This device" becomes the Devices list.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| PR-11 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **Anyone at the wall can change the signed-in person's account:** rename them, replace their photo, turn off their reminders, change their synced theme and Reduce motion (which reach their phone on its next load), subscribe the wall to their pushes, or sign the tablet out. Signing back in needs that person's Google login. None of these has a lock or confirmation. | A per-device **Wall display** flag. When on: <br>• Profile becomes "This display" settings (theme, text size, sound, room name); <br>• personal fields sit behind hold-to-confirm or a PIN; <br>• Log out needs a confirmation plus a long press. <br>The umbrella for HP-30, CH-11, NO-12 and HO-13. | M | Live + Code |
| PR-12 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **Theme and Reduce motion sync per account,** which is wrong for walls (Live: "Theme and motion follow you to other devices"). A dark bedroom tablet and a bright kitchen tablet can't differ, and a phone's Light choice repaints every wall on its next load. Account-level Reduce motion also forces one person's need onto the shared screens. | Per-device override: in wall mode, or with "Use these settings on this device only", don't pull or push the synced keys (sound and haptics already work this way). | Q–M | Live + Code |
| PR-13 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **"Your Profile" on a wall is ambiguous:** whose account is this, and which device? | "Kitchen display · signed in as Alex". | Q | Live |
| PR-14 | **No text size** (Live: there's no such setting), and descriptions are 12 px throughout. The single most useful setting for a screen read from across a room. | A per-device text scale (100/115/130%) applied to `<html>` by the existing bootstrap script. | M | Live + Code |

### 9.3 Friction and polish

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| PR-15 | **Four save models on one page:** Appearance saves instantly; Personal Information has "Save Changes"; Chore Reminders has its own "Save reminder" (flipping the switch and leaving loses it silently); Push is one tap. "Save Changes" is always enabled and toasts "Profile Updated" with nothing changed. | Auto-save reminders like Appearance (or show a dirty state); enable Save only when something changed; warn on leaving with an unsaved photo. | Q | Live + Code |
| PR-16 | **No Log out on the profile page** (it's only in the header menu, Live). | "Signed in with Google as … · Sign out" with a confirmation. | Q | Live |
| PR-17 | **Chore Reminders and Push are separate cards with the same bell icon** (Live), and the reminder card never says it only reaches your phone if push is on. | One "Notifications" section stating the dependency, with "Devices getting your alerts" (NO-26). | Q–M | Live + Code |
| PR-18 | **Layout:** at 1280 px the wide left column holds one short card while the narrow right column stacks Appearance, Reminders and Push (Live: the page is about 1,900 px tall with an empty left column); at 768–800 px the right column is about 240 px wide. | Two equal columns at `lg` with Appearance beside Personal Information, or Appearance under the left card. | Q | Live + Code |
| PR-19 | **Copy and small things:** <br>• the reminder toast uses 24-hour time ("17:00"); <br>• email is a faded disabled input (low contrast); <br>• the avatar hint promises "your member color", which can't be chosen; <br>• the Push card says "active" whenever permission is granted (NO-5). | Locale time; email as read-only text ("Signed in with Google"); fix the hint or allow choosing (PR-24). | Q | Live + Code |
| PR-20 | **Accessibility:** <br>• no headings under the h1 (card titles are divs), so screen readers can't jump between sections; <br>• the sample-sound button and the account avatar are 32 px; <br>• preset radio dots are 16 px (the whole card is the target, which helps); <br>• no high-contrast preset. | h2 for the card titles; 44 px icon buttons on touch; an AAA "High contrast" pair in the same contrast test. | Q–M | Live + Code |
| PR-21 | **Performance:** the appearance context re-renders every consumer on any profile change (dependency chain); push settings statically import Firebase Messaging into the profile chunk. | A ref for `updateUser`; lazy-load messaging. | Q | Code |

### 9.4 Wow and value ideas (built on existing code)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| PR-22 | *(Replaced by the tablet design: see section 15 and 16.2.)* **"This device" card (wall display mode)** | One switch: device-only appearance, text scale, automatic dark at sunset (reuse the time-of-day code), keep the screen awake, sign-out behind a confirmation, personal edits locked, a room name. The highest-value change for the stated use. | M |
| PR-23 | *(Replaced by the tablet design: see section 15 and 16.2.)* **"Who's here?" on wall tablets** | Tap your avatar to act as yourself for chores without a Google sign-in, with per-member preferences (see HO-13 and CH-27). | B |
| PR-24 | **Choose your colour** | Stored on the member record; the existing colour resolver already handles collisions; the avatar hint already promises it. | M |
| PR-25 | **Nickname and birthday (opt-in)** | A nickname used in the greeting (fixes PR-3); an optional birthday, typed by the person, for a household celebration on the dashboard. Google's birthday collection was deliberately dropped, so this must be opt-in and self-entered. | M |
| PR-26 | **Account controls** | Sign out with confirmation, export my data, and delete my account (the rules already allow profile delete). | M–B |

### 9.5 Looks good: keep as is

- **No-flash theme bootstrap:** escaped JSON sets the theme, class, motion and `theme-color` before paint and never throws. The view-transition reveal is ordered correctly and covered by e2e.
- **Presets:** 5 of them, each with a clear description, all contrast-tested to WCAG AA (verified live: Dark, Light and System, then Midnight, Hearth, Forest, Light and Sunrise).
- **Reduce motion** shows as checked and locked when the OS already asks for it; `data-motion=reduce` plus the media query stop all animation.
- **Sound and haptics** are device-only, with a sample button; haptics only appear where vibration exists; feedback never throws (verified live: "This device only").
- **Profile forms wait for the confirmed profile** (from #107), so a cached copy can never write stale values back.
- **Avatar validation** mirrors the storage rules, with inline errors, Undo or Keep photo, and the preview URL released.
- **Profile rules:** a field allowlist, no new demographics, and push tokens in an owner-only private doc.
- **Logout** clears the house snapshot first and flushes queued writes before signing out.
- **The skeleton matches the final layout,** so there's no layout shift. No console errors (verified live).

**Test gaps:** no e2e tests for profile save, avatar upload or remove, reminders, logout, or a failed save; no test for the cross-device theme overwrite (PR-6).

### 9.6 Suggested order

1. **Correctness:** PR-1 honest saves, PR-6 theme writes, PR-7 loading and errors, PR-8 remove the password dialog, PR-3 greeting.
2. **One name everywhere:** PR-2 with HO-8, PR-9 avatar resize and cleanup.
3. **Reminders:** PR-4 hour picker, PR-5 time zone, PR-17 one notifications section.
4. **Wall devices:** PR-22 "This device" card, which brings PR-11, PR-12, PR-13 and PR-14 text size.
5. **Polish and wow:** PR-15, PR-16, PR-18, PR-19, PR-20, PR-24, PR-25, PR-26.

---

## 10. Search and quick add (the command palette, tile "+", phone "+", voice, shortcuts)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Live:** 33 real household sentences and searches typed into the palette on a touch tablet, recording the top suggestion that Enter would act on. Enter was never pressed, so nothing was saved. Also the phone's floating "+" and focus on close.

**Code:** `components/command/*`, the parser (`lib/dashboard/quick-add.ts`), preview, writes, the AI reader and its server task, shortcuts, the tab bar and the tile "+". Screenshots are in `C:\hh\audit\palette-audit\`.

**Verdict:** the safety design is excellent:
- nothing is ever saved without the preview's Confirm, AI reads included;
- ambiguity is asked about, not guessed;
- the AI only sees opaque references, with emails redacted, server checks and quotas;
- offline is honest.

The parser and the touch experience lag behind:
- the A and F shortcuts and the tile "+" buttons produce junk;
- anything unrecognised becomes a grocery item as the top Enter action;
- quantities, mileages and dates misparse in common sentences;
- the wall tablet has no real way in except a 40 px icon and the on-screen keyboard.

### 10.1 What the parser does with real sentences (live)

| Typed | Top suggestion (what Enter would do) | Right? |
|---|---|---|
| milk · milk and eggs · milk, eggs and bread · milk x2 | Add to groceries; lists split; "x2" → 2 × Milk | ✅ |
| trash every Tuesday for Sam · vacuum the stairs tomorrow · mow the lawn every other Saturday | Correct repeating or dated chore, the right person | ✅ |
| fed audit rex · audit rex ate | Log a meal for Audit Rex, 1 cup, now | ✅ |
| oil change 48,200 miles | Log maintenance at 48,200 miles | ✅ |
| dishwasher · eggs · rex · profile · settings · calendar | The right asset, item, pet or page | ✅ |
| **fed** (F key, pets tile "+") · **add** (A key, shopping tile "+") | Add "Fed" / "Add" to groceries | ❌ |
| **gave Rex his pill** · **replaced furnace filter** · **need to call the dentist** · **garage** · **dark mode** · **xyzzy nothing matches** | Add that whole text to groceries | ❌ |
| **oil change 120k miles** | Mileage saved as **120** | ❌ |
| **oil change tomorrow** | Logged as maintenance done **today** | ❌ |
| **1/2 gallon milk** | A chore "Gallon milk" due **Jan 2** | ❌ |
| **add mac and cheese** | Two items, "Mac" and "Cheese" | ❌ |
| **add milk to the list** | An item named "Milk to the list" | ❌ |
| fed Rex | Only "Read with AI" (a partial pet name isn't matched) | ⚠️ |
| 2 gallons of milk · a dozen eggs | "2 × Gallons of milk" · "A dozen eggs" ×1 | ⚠️ |
| fed audit rex wet food | Meal logged; "wet" ignored, and the food type isn't shown | ⚠️ |

The code review traced more: "fed Maple and Oreo" logs Maple only; "every week on Saturday" uses today's weekday; "every month on the 15th" ignores the 15th; "every weekend" becomes a one-time chore; words like "decorate 2 cakes" and "marshmallows 2" become chores dated Dec 2 and Mar 2; accented names ("José") are never assigned.

### 10.2 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| QA-1 | **The shortcut prefixes become grocery items.** F, the pets tile "+" and the phone "Feeding" open the palette with `fed `; A, the shopping tile "+" and the phone "Item" with `add `. The trailing space is trimmed before the guard runs (`quick-add.ts:479,486,490`), so the top Enter option is "Add Fed / Add Add to groceries". | The one-tap actions on every screen produce junk. (Supersedes HP-1.) | Return nothing for a bare verb; better, open a **mode** (QA-15) instead of a text prefix. | Q | Live + Code |
| QA-2 | **Anything unrecognised becomes a grocery item, ranked above "Read with AI"** (`:500-501`, CP:278-287). | A kid pressing Enter, then Confirm, adds "garage" or "gave Rex his pill" to the shopping list. | Guess shopping only for short noun phrases (at most 4 words, no pronouns or verbs like I, we, his, gave, call, take); otherwise put "Read with AI" first, or "Not sure: read with AI". | M | Live + Code |
| QA-3 | **Misparses that write wrong data:** <br>• "120k miles" saves 120, and "48k" saves no reading (`:405`); <br>• future-tense maintenance ("oil change tomorrow") is logged as done today; <br>• "1/2 gallon" is read as Jan 2, and words starting with a month name plus a number become dated chores (`:191,201`); <br>• shopping verbs swallow chores ("pick up dry cleaning for Sam tomorrow", "need to call…"); <br>• "to the list" stays in the name; <br>• " and " splits compound items (mac and cheese; "half and half" merges into "Half ×2"). | Confirm is the only guard, and the preview shows the wrong thing confidently. | Multiply `k`; check dates in maintenance (future → a chore or reminder, or refuse); explicit month names and skip `n/n` before a unit; a date, repeat or assignee means a chore; strip "to the (shopping) list"; split on "and" only with commas or single words, plus an exceptions list (or editable chips, QA-19). | Q–M | Live + Code |
| QA-4 | **Repeats and names:** <br>• "every week on Saturday" and "every month on the 15th" ignore the day; <br>• "every weekend" becomes one-time; <br>• plural "on Tuesdays" isn't matched; <br>• the removal pattern deletes the first "every X", not the matched one; <br>• "fed Maple and Oreo" silently drops Oreo; <br>• "fed Rex" doesn't match "Audit Rex"; <br>• "wet" and "dry" are ignored, and the food type isn't shown; <br>• accented names are never assigned (ASCII-only patterns). | Wrong schedules and quietly missing logs. | Build removal from the actual match; parse "on (the) Nth", plural weekdays and "weekend"; log every named pet (or say "one at a time"); match pet name tokens; parse and show food type; use `\p{L}` with the `u` flag. | M | Live + Code |
| QA-5 | **Smaller bugs:** <br>• interleaved result groups repeat headers and React keys (sorted by score across groups, CP:243-247,391-398); <br>• Ctrl+K inside the open palette remounts it and wipes the text, preview or an in-flight save; <br>• an AI shopping result with no list says "AI could not read that"; <br>• focus goes to `<body>` after closing from the header (Live). | Visible glitches and lost input. | Group, then rank; ignore Ctrl+K while open; honest copy; return focus to the trigger. | Q | Live + Code |

### 10.3 Safety

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| QA-6 | **Every new item asks the AI for a category,** one daily quota request each, with a 5 s race; in a multi-item add, later items likely time out to "Other" while still consuming quota (same as SH-16). | One batched categorize call per submission, or a local keyword map first. | M | Code (needs live check) |
| QA-7 | *Withheld from the public copy until the fix is live.* | | | |
| QA-8 | *Withheld from the public copy until the fix is live.* | | | |
| QA-9 | **No Undo after saving,** and no "already added" or "fed 5 min ago" check (two tablets can log the same meal). | Undo on the success toast (the created IDs are already returned), allowed for 10 s even without delete via a narrow rule; a "Last fed 10 min ago by Sam" line in the feeding preview (QA-17). | M | Code |

### 10.4 Search quality

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| QA-10 | **Not indexed:** members, rooms (Live: "garage" offered "Add Garage to groceries"), chore templates, purchased items, maintenance logs and reminders, calendar, pantry, barcode library, notifications, and settings beyond "Profile" ("dark mode" → groceries). | Add rooms (open `/chores?room=`), members (their chores), pantry, reminders and settings ("dark mode" → Appearance). | M | Live + Code |
| QA-11 | **Weak matching:** labels only (the assignee and list name aren't searched, so "Sam" doesn't find Sam's chores); one substring of the whole query; no typos, no multi-word, no recency ranking; vehicles by nickname only. | Score each token across label and detail, with edit distance 1; rank by recency and frequency; search make and model. | M | Code |
| QA-12 | **Shallow results:** a chore result just opens `/chores`; an item opens its list without highlighting; an empty query shows only pages. The index is a fresh snapshot on every open (7 reads plus one per list), not live. | Deep links that highlight; recent and frequent items when empty (QA-18); reuse the dashboard's live listeners or cache the index for 60 s. | M | Code |

### 10.5 Touch, voice and tablet (the biggest wins)

> **Agreed wall tablet design (2026-11-09, see section 15):** the big Speak and Add buttons (QA-13) are part of the registered-tablet layout (WT-14). Quick add on a tablet asks "Who's here?" at Confirm for anything it saves (WT-7), remembered for a couple of minutes (WT-8). The room default (QA-23) comes from the tablet's record.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| QA-13 | **The wall tablet has almost no way in:** no floating "+" (the tab bar is phone-only), a 40 px magnifier, 32 px tile "+" buttons, and a 36 px mic inside the palette; shortcut hints are hover-only. | A big **Speak** button and a big **Add** button on the dashboard and header at tablet sizes. | M | Live + Code |
| QA-14 | **The palette always raises the on-screen keyboard** (autofocus, even when opened by voice or a tile; focus returns to the input after a voice result). It's a narrow 512 px dialog at top 120 px with results to about 550 px, so a landscape keyboard (about 400–480 px visible) covers them. The footer shows keyboard hints ("↑ ↓ to move · Enter · Esc · ? for shortcuts") and Enter or "G C" badges on touch, and there's no close button (Live). | On touch: no autofocus when opened by voice or a tile; size against `visualViewport` with the top option first; a wider dialog; touch-only footer copy and a close button. | Q–M | Live + Code |
| QA-15 | **Tile "+" and phone actions use text prefixes** (the cause of QA-1). | **Mode chips:** open the palette in Feeding, Item or Chore mode; for Feeding, show the pets as large buttons ("Feed Maple", "Feed Oreo"), no keyboard needed. | Q–M | Code |
| QA-16 | **Voice is thin:** <br>• listening is shown only as a 16 px wave in the button; no "Listening…" text or announcement; <br>• phone voice auto-starts outside a user gesture (iOS may refuse); <br>• the language follows the browser, but the parser is English only; <br>• a final transcript isn't auto-previewed (mic → suggestion → Confirm is three taps); <br>• audio goes to the browser vendor's speech service, undisclosed. | A clear Listening state with a live region; start only from the tap; auto-open the preview for an explicit intent; a one-line disclosure. | M | Code |

### 10.6 Accessibility and performance

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| QA-20 | **Accessibility:** group headers are presentation-only, so their names are never heard; the result count and the top suggestion aren't announced; the preview's Confirm doesn't describe what it confirms; the mic and tile "+" are under 44 px. (The combobox and active-option basics are sound.) | `role=group` with labels; a polite live region ("Quick add: Add Milk to Groceries. 5 results."); `aria-describedby` from Confirm to the preview card; 48 px on the wall. | Q | Code |
| QA-21 | **Performance:** the index costs 7 reads plus one per list on every open (a steady bill on an always-on tablet); AI has an 8 s timeout but no cancel, and closing mid-read still charges. | Shared live listeners or a 60 s cache; a Cancel button. | M | Code |

### 10.7 Wow and value ideas (built on existing code)

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| QA-17 | **"Last fed" in the feeding preview** | "Last fed 10 min ago by Sam (Wet)" plus the food type, using the existing latest-log read, which prevents double feeding across tablets. | Q |
| QA-18 | **Recent and frequent** | On an empty query: "Add again: Milk, Eggs, Bread" chips from purchased items, plus tile actions; a tap goes straight to the preview. | M |
| QA-19 | **Editable preview chips** | Split items, quantities and pets shown as chips to merge or remove: fixes "mac and cheese" and "fed Maple and Oreo" without more regex. | M |
| QA-22 | **Voice-first wall flow** | One tap, speak, Confirm: the big Speak button (QA-13), no keyboard, auto-preview. | M |
| QA-23 | **Per-room context** | "This tablet is in: Kitchen" defaults the chore room and ranks room items first (HP-31). | M |
| QA-24 | **Scan into quick add** | A barcode chip in the palette (the lookup flow and library exist) adds the scanned product through the same preview. | M |
| QA-25 | **Multi-step sentences** | "milk and eggs, and remind Sam to take out the trash Tuesday" splits into clauses with a stacked preview and one Confirm. | B |

### 10.8 Looks good: keep as is

- **Nothing is ever saved without Confirm,** AI reads included ("Read by AI. Check the details"); Confirm disables while saving, which covers a double Enter (verified: the battery never wrote anything).
- **The AI revision guard** prevents stale answers, double charges and late errors.
- **Ambiguity is asked about, never guessed:** two Sams, two Hondas, a mileage with no vehicle. A failed index read is never treated as empty.
- **Honest confirm-time notes:** restricted assignee, the monthly-28th note, a reading below the odometer.
- **Saving:** offline writes queue ("Saved offline") and never overwrite; shopping saves each item independently and retries only failures; items merge into ones still needed.
- **AI privacy:** opaque references, model-safe names, email redaction, server sanitizing, mileage must appear in the text, kinds limited by verified permissions, quotas and rate limits.
- **Shortcuts** never fire while typing (IME-safe, on-screen keyboards ignored) and are permission-filtered, from one source of truth.
- **The good half of the parser:** chores with people, dates and repeats, list splitting, "x2", feeding by full name, odometer service, and searches for pets, assets, items and pages (verified live). The phone's floating "+" speed-dial (Add chore, item, feeding, maintenance, Quick add) is a great pattern (verified live).

### 10.9 Suggested order

1. **Stop the junk:** QA-1 prefixes (with QA-15 mode chips), QA-2 no silent grocery fallback, QA-3 the misparses that write wrong data.
2. **Wall tablet:** QA-13 big Speak and Add buttons, QA-14 keyboard-safe palette, QA-16 voice, QA-22 voice-first flow.
3. **Parser depth:** QA-4 repeats, pets and names; QA-19 editable chips; QA-17 last fed.
4. **Search:** QA-10 index rooms, members and settings; QA-11 matching; QA-12 deep links and cache; QA-18 recent items.
5. **Safety and polish:** QA-6 batched categorize, QA-7, QA-8, QA-9 Undo, QA-20, QA-21, QA-5.

---

## 11. App shell (header, tab bar, layout, theme, service worker, offline, errors, always-on behaviour)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Live:**
- Header, nav and tab bar measured at four sizes: tablet landscape 1280×800 (touch, no hover), tablet portrait 800×1280, phone 390×844 and desktop 1440×900.
- Header widths swept from 1024 down to 600 px.
- The title, main heading and active nav item checked on all 11 routes.
- Back and scroll position, the manifest, service worker, wake lock, the 404 page and the offline page.
- Going offline on the dashboard, then moving to another page and reloading.
- The OS dark-mode preference.
- The account menu: opened and closed only; Log out was never touched.

**Code:** layout, template, manifest, the generated service worker (`/api/sw`), header, tab bar, appearance, motion, toasts, the auth and household gate. Screenshots are in `C:\hh\audit\shell-audit\`.

**Verdict:** the shell is well built for a website:
- no theme flash;
- reduced motion honoured everywhere;
- careful first paint;
- clean listeners;
- honest offline caching;
- a good 404;
- the phone tab bar is excellent.

It isn't yet built for a **screen that never reloads**:
- one render error leaves the screen dead until someone reloads by hand;
- new deploys never reach a tablet that stays open;
- role and approval changes aren't noticed;
- nothing keeps the screen awake;
- the tablet gets the desktop header, with 32 px targets and its useful parts hidden in a 32 px avatar menu next to Log out.

### 11.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| SL-1 | *(Fix tightened: see section 17.)* **No error boundaries anywhere:** there's no `error.tsx` or `global-error.tsx`, and no `onerror` or `unhandledrejection` handlers. One error thrown while rendering unmounts the whole app, leaving Next's plain "Application error" page with no header and no way out. | A wall tablet stays dead until someone climbs up and reloads it. A deploy that changes the data shape (SL-2) makes this more likely. | `global-error.tsx` (logo, Reload, auto-reload after 30 s idle) plus `app/error.tsx` (keeps the header and tab bar, with a Try again button using `reset()`); per-section boundaries for the dashboard, pets and maintenance. | M | Code |
| SL-2 | *(Fix tightened: see section 17.)* **Deploys never reach an always-on screen.** The service worker takes over silently (`skipWaiting` and `clients.claim`), but the open page keeps the old JavaScript. Nothing calls `registration.update()`, listens for `controllerchange` or `updatefound`, or offers a reload (grep: zero hits; `deploymentId` isn't set). Browsers only check for a new worker on navigation or about once a day. | A dashboard tablet can run a weeks-old build against new rules and functions, which breaks quietly (and feeds SL-1). Every future version change is affected, which matters because many are planned. | Check for updates every 30–60 min and when the screen becomes visible; on a new build, show "HomeHub updated: Reload" on phones and reload automatically after idle on wall tablets; set `deploymentId`. | M | Code |
| SL-3 | **Membership, role and household are read once at sign-in** (`auth-context.tsx:296-303`, `getDoc`; the profile too). | On a screen that never reloads: a member "Waiting for approval" never sees the approval; role changes don't change nav or permissions; a household being deleted or a forced password change isn't noticed. | `onSnapshot` on the member, household and user documents inside the existing guard; keep the cache-first fast path. | M | Code |

### 11.2 Wall tablet and phone

> **Agreed wall tablet design (2026-11-09, see section 15):** SL-5 (side rail), SL-8 (keep awake, idle-to-home) and SL-9 (kiosk behaviour) ship as the registered-tablet layout (WT-14). SL-6 is settled differently on a tablet: there is no Log out; a tablet is removed from the Devices list, or on the tablet itself with an owner or admin PIN (WT-16). On personal accounts, Log out gets a confirmation. SL-4 (bigger touch targets) and SL-7 (header overflow) stay for every touch screen and are fixed on their own, not as part of the rail (16.2).

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| SL-4 | **The tablet gets the desktop header: every target is under 44 px.** The six text links are 32 px tall (Pets is 49×32), search and the bell 40×40, the account avatar 32×32. From 768 px up there's no tab bar, so the 72 px tab bar the phone gets disappears on the device used most. | With a coarse pointer at md and up: 48 px links with 16 px text, 48 px icon buttons. Better, SL-5. | Q | Live |
| SL-5 | **Tablets lose quick add, the More grid and easy access to Household, Profile, Library and Notifications.** The phone has a five-tab bar with a big centre "+" (long-press for voice). The tablet has none of that: Household, Profile and Library sit in a 32 px avatar menu (items 214×32), and quick add is only the 40 px magnifier (QA-13). | A **landscape side rail** (or bottom dock) for touch screens 768 px and wider, built from the same permission-filtered `PRIMARY`, `MORE` and `QUICK_ACTIONS` lists as the tab bar: Home, Chores, Shopping, Pets, Calendar, More, and a big "+" / Speak. | M | Live + Code |
| SL-6 | **Log out sits one tap away, 32 px tall, directly under Barcode Library in the account menu, with no confirmation.** | On a shared wall tablet, signing back in needs someone's Google account and keyboard; a mis-tap leaves the room's screen signed out. | Confirm ("Sign out of this tablet?"); in wall mode, move it to Profile behind a hold-to-confirm. | Q | Live + Code |
| SL-7 | **The header just overflows at 768–800 px wide** (iPad mini or portrait tablets): at 768 the header is 794 px wide, so the page scrolls sideways and the avatar sits past the edge (visible in `tablet-portrait-home.png` at 800). Nothing more can be added to it. | Below `lg`: icon-only links or a More menu, or the SL-5 rail. | Q | Live |
| SL-8 | *(Replaced by the tablet design: see section 15 and 16.2.)* **Nothing keeps the screen awake, no return home after idle, no screensaver** (no `wakeLock` anywhere; live: 0 requests). The header and the bright effects are static all day, which risks burn-in. | **Wall mode** (a per-device setting, like appearance): <br>• hold the wake lock and re-acquire it when visible; <br>• after N minutes idle, close dialogs and go to `/`; <br>• after a longer idle, fade to an ambient clock, weather and today's chores with slow drift; <br>• night dimming (SL-14). | M | Live + Code |
| SL-9 | *(Replaced by the tablet design: see section 15 and 16.2.)* **A kiosk still behaves like a web page:** long-press selects text and shows callouts; double-tap zooms (no `touch-action: manipulation`); pull-to-refresh and rubber-banding are on (`overscroll-behavior: auto`, live). | In wall mode: `user-select:none` and `-webkit-touch-callout:none` on the shell only (inputs stay selectable), `touch-action: manipulation`, `overscroll-behavior-y: none`. Keep pinch zoom (correctly not blocked today). | Q | Live + Code |
| SL-10 | **There's no offline indicator in the shell.** Live: 2.5 s after the network dropped, the dashboard looked identical, with no banner and no status message. Shopping still opened offline, which is good. | A slim "Offline: changes will sync" pill in the header when offline, and "Back online" when it returns. | Q | Live |
| SL-11 | **The sign-in prompt flashes on every route except `/`** while sign-in restores (0.3–3 s): pages render "Sign in to manage your chores" when `currentUser` is still null (e.g. `chores/page.tsx:12`), and the header shows a Login button. | Gate on `loading` (show the route skeleton); reuse the `data-session` hint the dashboard already uses to hide Login before paint. | Q | Code |
| SL-12 | **A failed household load waits for a tap:** "Couldn't load your household" only retries on its button. If the profile read throws on a cold cache, loading never ends, leaving a skeleton forever. | Retry automatically on `online` with backoff; wrap the auth callback in try/finally. | Q | Code |

### 11.3 Friction, accessibility and performance

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| SL-13 | **Every page is titled "HomeHub"** (live, all 11 routes; only the 404 has its own). Screen readers announce nothing on navigation, and history entries and tabs all look the same. | A title template `%s - HomeHub` and per-section metadata ("Chores - HomeHub"). | Q | Live |
| SL-14 | *(On tablets the fix is replaced by section 15; see 16.2 for what still applies.)* **Theme follows only Dark, Light or System,** and wall tablets rarely switch their OS theme (the app is dark by default; live with OS dark: dark). | An **"Automatic by time of day"** mode using the existing day-phase data, plus a night dim overlay in wall mode. | Q–M | Live + Code |
| SL-15 | *(Replaced by the tablet design: see section 15 and 16.2.)* **The background effects run nonstop:** two 60vmax blurred blobs animating forever, a full-screen noise layer with a blend mode, the time-of-day gradient and weather loops, all under a `backdrop-filter: blur(16px)` header that must re-blur every frame. They pause only when the tab is hidden, which a wall tablet never is. | In wall mode, or on touch devices with 4 GB of memory or less: static gradient, no grain, a solid header. | Q | Code |
| SL-16 | **Tapping a push notification opens a second app window** when the open window isn't on that exact path (the service worker compares the pathname with a link that may include a query string, `api/sw/route.ts:122`). | Focus any HomeHub window and `navigate()` it; open a new one only if none exist. | Q | Code |
| SL-17 | **One toast at a time** (`TOAST_LIMIT = 1`): a push toast replaces an error toast or an update toast. | Raise to 3 (the same as the cross-cutting theme). | Q | Code |
| SL-18 | **No skip link,** and `main` has no id; focus stays on the clicked link after navigating (live: focus on "Chores"). Landmarks themselves are right (header, main nav, main, primary nav; one h1 per page, live). | A skip link to `#main`, `tabIndex={-1}` on main, and focus the h1 after client navigation. | Q | Live + Code |
| SL-19 | **Manifest polish:** <br>• no `screenshots`, so no rich install sheet; <br>• all three shortcuts use the same icon; <br>• no install prompt (`beforeinstallprompt` isn't handled); <br>• the manifest `theme_color` (#020817) differs from the page meta (#050915). | Wide and narrow screenshots, distinct shortcut icons, an "Install HomeHub on this tablet" button in Profile or wall-mode setup, matching colours. | Q | Live + Code |
| SL-20 | *(Dropped: see 16.2.)* **The tab bar's 11 px labels** are too small to read from across the room. | A wall-mode root text scale of 112.5% (ties to PR text size). | Q | Code |

### 11.4 Wow and value ideas

> **Agreed wall tablet design (2026-11-09, see section 15):** SL-21 "Wall mode setup" is now **device registration** (WT-1 to WT-4): the setup happens when the tablet redeems its code, and every setting can be changed later from the Household Devices list; comfort settings (theme, text size, motion, sound) can also be changed on the tablet itself (WT-16). SL-22 room identity comes from that record.

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| SL-21 | *(Replaced by the tablet design: see section 15 and 16.2.)* **Wall mode setup** | One "Set up this tablet" flow: pick the room (Kitchen), keep awake, idle → home, night dim, effects off, install the app. Every wall item above (SL-8, 9, 14, 15, 20) plus the room identity used by HP-31 and QA-23 hangs off this one per-device setting; this is the "device role" the earlier sections kept asking for. | M |
| SL-22 | **Room identity in the shell** | The header reads "HomeHub · Kitchen"; the start page and quick-add defaults follow the room (the Kitchen opens to shopping, the Hall to chores). | Q |
| SL-23 | **Ambient screen** | After idle: a big clock, weather, the house drawing with pets wandering, and the "next up" line; a tap wakes it to the dashboard. It turns idle tablets into a feature instead of a black screen. | M |
| SL-24 | **"Updated" moment** | After an automatic update, a one-line "HomeHub updated: what's new" toast that links to a short changelog, since many versions are coming. | Q |

### 11.5 Looks good: keep as is

- **No theme flash:** an inline script sets the theme, motion and theme colour before paint; tokens are contrast-tested.
- **Reduced motion is honoured everywhere** (CSS, JS and route transitions); the first page isn't animated; the logo intro plays once per session.
- **First paint:** local fonts with swap; push, toaster and service worker load after idle; the bell, underline and password dialog load on demand; Firestore loads only with a session hint.
- **Long uptime:** App Check token auto-refresh; a persistent Firestore cache that works across tabs; every shell listener cleans up; the clock recomputes each minute, so day rollover works; the navigation progress bar gives up after 10 s.
- **Offline:** network-first navigation with a cached shell (`/`, `/shopping`, `/offline`); hashed assets cache-first with a cap; `/api` is never cached. Live: Shopping opened and reloaded offline, and the offline page is clear and helpful.
- **Navigation:**
  - correct `aria-current` (live: More highlights for its child pages);
  - Back restores scroll (live: 393 px);
  - the tab bar hides what a member can't use.
- **404:** "Page not found · Everything in your home is still a tap away · Go home", with its own title.
- **Phone tab bar:** 55×64 tabs and a 56 px centre "+" with a speed-dial, plus safe-area padding. The model for the tablet rail.
- **Manifest:** correct id, scope and start URL, standalone display, a maskable icon, shortcuts and a share target; it correctly doesn't lock orientation.

### 11.6 Suggested order

1. **Never stuck, always current:** SL-1 error boundaries with auto-reload, SL-2 update detection and reload, SL-3 live membership.
2. **Quick wins:** SL-6 confirm Log out, SL-11 sign-in flash, SL-12 auto-retry, SL-13 titles, SL-16 notification window, SL-17 toast limit, SL-10 offline pill.
3. **Wall mode:** SL-21 setup with SL-8 wake lock, idle and ambient screen, SL-9 kiosk CSS, SL-14 night, SL-15 effects, SL-20 text scale, SL-22 room.
4. **Tablet navigation:** SL-5 side rail (it also fixes SL-4 and SL-7).
5. **Polish:** SL-18, SL-19, SL-23, SL-24.

---

## 12. Barcode Library (library page, scanner, barcode lookup, scans from Shopping and Pantry)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Live** at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900:
- the empty state;
- the Add dialog and its validation;
- the scanner (the test browser has no camera permission, so it shows the denial path);
- one test product ("Audit test product", EAN 4006381333931, with a photo) added to the audit household to measure the grid, search, card tap, a duplicate add and delete. It was **deleted afterwards, and the library is verified back at 0**.

**Code:** the page, the library client, the scanner (`react-zxing`), barcode storage, the lookup flow, and the scan paths in Shopping and Pantry, plus their rules. Screenshots are in `C:\hh\audit\library-audit\`.

**Verdict:** the foundation is right:
- household-scoped data, with permissions that mirror Shopping;
- the lookup reads your own library first, then Open Food Facts, with **no AI**, so it can't invent product names;
- 5 s timeout, rate limit, and it works when the AI quota is used up;
- a manual entry box on the scanner;
- the photo is cleaned up on delete;
- it works on iOS.

The problems are around it:
- scanning into a shopping list uses the **package size as the count** (×450);
- a wall tablet's scanner opens the **camera facing the wall**;
- adding an existing code **silently overwrites** it;
- delete is one 32 px tap, with **no confirmation and no undo** (live).

The page itself is a plain gallery: tapping a card does nothing, and there's no "Add to list".

### 12.1 Broken (fix these first)

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| BL-1 | **Scanning into a shopping list uses the package size as the count:** `quantity: result.quantity \|\| 1` (`shopping-list-client.tsx:623`), where `quantity` is the Open Food Facts package size (the e2e fixture returns 128 for "128 fl oz" and 450 for "450 g"). If the item is already on the list, the merge adds +450. | Scan yogurt, get "Yogurt ×450". It breaks the trust in scanning on the first try. | Use quantity 1 for Shopping (show the size as a note or in the name); Pantry already pairs size with unit correctly. Add an e2e test that scans into a list. | Q | Code |
| BL-2 | **The scanner always asks for the rear camera** (no constraints; react-zxing's default is `facingMode: environment`) and offers no camera switch. | On a wall-mounted kitchen tablet, the rear camera faces the wall, so scanning can never work there. | A "Switch camera" button (enumerate devices), remembered per device; default to the front camera in wall mode (SL-21). | M | Code |
| BL-3 | **Adding a barcode that's already saved silently replaces it:** `setDoc` with no existence check (`barcode-library-client.tsx:257`). The other member's name and photo are overwritten, `createdAt` resets, and the old photo is orphaned. Live: typing the saved code into Add showed no warning. | Quiet data loss across members. | In Add: check first and say "Already saved as *Audit test product*: edit it?" (or a create-only write). | Q | Live + Code |
| BL-4 | **Delete is one tap, with no confirmation and no undo** (live: no confirm dialog; gone after reload), and the photo goes too. The delete button is 32×32 next to a 32×32 Edit. | One mis-tap on a wall tablet removes a product and its photo for the whole household. | An undo toast that delays the database and photo delete by about 10 s (matches the Chores Undo), or a confirm dialog. | Q | Live + Code |
| BL-5 | **Replacing a photo leaves the old file in Storage** (`:244-248` never deletes `itemToEdit.imagePath`). | Storage grows with every photo edit. | After a successful save, delete the old managed path (the helper exists). | Q | Code |

### 12.2 Scanner and wall tablet

> **Agreed wall tablet design (2026-11-09, see section 15):** the default camera (BL-2) is a per-tablet setting on the device record (WT-4): front camera for wall tablets. Scanning into a list needs a face tap; deleting a saved product needs a PIN.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| BL-6 | **Camera errors are confusing.** Live: a denied camera gives a red toast ("enable camera permissions in your browser settings") while the dialog still shows a blank camera box with a **red** aiming frame. Any other camera error (no camera, in use, insecure page) says "Could not decode the barcode" (`barcode-scanner.tsx:34-39`). | Inline messages over the video area for each case (no camera, denied, busy), with focus moved to "Barcode number"; a neutral or teal aiming frame. | Q | Live + Code |
| BL-7 | **Scan feedback is thin:** <br>• no beep or vibration on a scan (`playFeedback` exists); <br>• no "point at a barcode" hint; <br>• no torch, though react-zxing provides one (dim under-cabinet kitchens); <br>• every barcode format is tried (QR, PDF417…), which is slower on cheap tablets, and a scanned QR URL skips validation and fails as "Barcode lookup failed". | Beep, vibrate and flash a check mark on a scan; a torch toggle when supported; limit to EAN-13, EAN-8, UPC-A, UPC-E and Code 128, and validate scanned text. | Q | Code |
| BL-8 | **The camera can stay on** if the scanner closes before the camera starts (a known react-zxing cleanup race). Live: no stream ever started (no permission), so it couldn't be reproduced. | On unmount, also stop the video's tracks ourselves. | Q | Code (needs a real-camera check) |
| BL-9 | **"Product not found" is a dead end:** Shopping says "You can add it to your Barcode Library" but gives no link and discards the code. An Open Food Facts outage, timeout or rate limit also shows as "not found". | A toast action **"Save to library"** that opens Add with the code filled in; separate copy when the lookup service is unavailable. | Q–M | Code |

### 12.3 Library page friction

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| BL-10 | **A photo is required to save** (live: "Add a photo of the product."), although the card already has a no-photo placeholder and Open Food Facts returns an image. The upload says "Drag 'n' drop an image, or click to select", desktop wording on a phone or tablet. | Make the photo optional or prefill it from Open Food Facts; offer "Take photo / Choose photo" on touch. | Q | Live + Code |
| BL-11 | **Big phone photos fail with a generic error:** there's no size check or compression, and Storage rules cap uploads at 5 MB (typical phone photos are 6–12 MB). | Downscale to about 1024 px WebP before upload, with inline copy for anything too large. | Q | Code |
| BL-12 | **The barcode isn't normalised or validated:** <br>• Add accepts any text up to 64 characters (live: "12345" was accepted), while the manual scanner box requires 6–32 digits and lookup does an exact match; <br>• "012345 678905" saves but never matches a scan; <br>• no check digit; <br>• the UPC-A (12-digit) and EAN-13 (leading 0) forms of the same product become two entries. | One `normalizeGtin()` for the form, the scanner and lookup (digits only, check digit, expand UPC-E, pad to 13 digits as the document ID), plus a one-off migration. | M | Live + Code |
| BL-13 | **The gallery is display-only:** <br>• tapping a card does nothing (live); <br>• Edit and Delete are 32×32 (live, tablet and phone); <br>• no "Add to list" or "Add to pantry"; <br>• search is a single substring (live: "audit" and "333931" match, "test audit" finds 0); <br>• sorted only by date added. | Tap a card for a bottom sheet with **Add to list · Add to pantry · Edit · Delete**, each 48 px; search by word; sort by most-scanned or name. | Q–M | Live + Code |
| BL-14 | **No live updates:** a one-time `getDocs` with a full reload after each save, so other members' additions don't appear; and not the offline-aware read that Pantry uses. | `onSnapshot` plus the offline-aware read. | Q | Code |
| BL-15 | **Empty state shows two buttons that do the same thing** ("Add Item" and "Save a product"); "Back to Shopping" is a full-width button above the content on the phone. | Keep the empty-state button only when empty; move Back to a small link or drop it (the tab bar covers it). | Q | Live |
| BL-16 | **Pantry photos are matched by product name, not barcode** (`pantry.ts:234-237`); renaming either side loses the photo. | Store `barcode` on pantry items (shopping items already do) and match on it first. | M | Code |
| BL-17 | *Withheld from the public copy until the fix is live.* | | | |
| BL-18 | **Accessibility:** card titles are `h2` under the "Your Library" `h2`; no status text in the scanner ("Camera ready", "Scanned 4006…"); focus stays put after a scan. | `h3`; a polite live status; move focus to Product Name after a scan. | Q | Code |

### 12.4 Wow and value ideas

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| BL-19 | **Library that fills itself** | When Open Food Facts finds a product, offer "Save to household library" with its photo. The second scan is instant and works offline; the library builds up from normal shopping. | M |
| BL-20 | *(Fix tightened: see section 17.)* **Kitchen scan station** | A full-screen scan mode for the kitchen wall tablet: front camera always on, continuous scanning with debounce and a beep, and three big buttons, **Used up** (pantry −1, offers "add to list"), **Restock** (pantry +1) and **Add to list**. It reuses the lookup, list and pantry logic that exist today. | B |
| BL-21 | *(Asks "Add to list?" instead of adding automatically: see 16.1 D-8.)* **Scan to mark used** | Scan an empty package and its pantry row goes down by one, and onto the list when it hits zero (needs BL-16). | M |
| BL-22 | **Allergen and nutrition chips** | Request Open Food Facts allergens and Nutri-Score in the same call; show "Contains: peanuts" or "Nutri-Score B" on cards and list items. | M |
| BL-23 | **Favourites** | Track how often and how recently each product is scanned; sort the library by it and feed the quick-add "Add again" chips (QA-18). | Q |

### 12.5 Looks good: keep as is

- **Data model:** `households/{id}/barcode-library/{barcode}`; Firestore and Storage permissions mirror Shopping view, edit and delete, and the UI hides controls to match.
- **Honest lookup with no AI:** household library first, then Open Food Facts, with the source labelled. It can't hallucinate a product name. 5 s timeout, limited fields, 30 lookups per minute, no AI quota used, sanitised output, and deterministic e2e fixtures for timeout, 429 and bad data.
- **Manual barcode box** always shown on the scanner, with proper label and inline error (live). ZXing runs in JavaScript, so iOS Safari works.
- **Delete removes the managed photo,** and an already-missing file is handled (live: count back to 0).
- **Pantry scan** keeps fields you've already typed and maps units correctly.
- **Reachable** from the Shopping page, the account menu, the phone More menu and the search palette.
- **Fast:** content visible in about 1 s on every size (live); saving with a photo took 1.4 s (live); the grid of 4 / 3 / 2 columns suits tablet and phone.

### 12.6 Suggested order

1. **Trust:** BL-1 the scan count, BL-3 overwrite, BL-4 delete undo, BL-5 photo leak.
2. **Wall tablet scanning:** BL-2 camera switch, BL-6 errors, BL-7 feedback, torch and formats, BL-8 camera cleanup.
3. **Make it useful:** BL-13 card actions, BL-9 "Save to library" from not-found, BL-10 optional photo, BL-11 compression, BL-19 library that fills itself.
4. **Data quality:** BL-12 barcode normalisation, BL-16 pantry by barcode, BL-14 live updates, BL-17.
5. **Wow:** BL-20 kitchen scan station, BL-21, BL-22, BL-23; BL-15, BL-18 polish.

---

## 13. Automation (Home Assistant connection and device list)

**Audited:** 2026-11-09, production `ccdfa4b`.

**Live** at tablet 1280×800 (touch, no hover), phone 390×844 and desktop 1440×900: the audit household isn't connected to Home Assistant, so I tested:
- the connect screen;
- client validation;
- five inputs the server must reject before anything is saved: http, a private IP, a `.local` host, a public site that isn't Home Assistant, and a fake token.

All were rejected, and after a reload the household was **still not connected**. There's no Home Assistant instance to test against, so the **connected device list was reviewed in code only**.

**Code:** the page, the client (`automation-client.tsx`), server actions, `lib/server/home-assistant*.ts`, state helpers, permissions and rules.

**Verdict:**
- **Security is the best in the app:**
  - the server never contacts private or internal addresses, including tricky IPv6 forms and DNS tricks;
  - no redirects, a 5 MB response cap and an 8 s timeout;
  - the token is stored server-only and never sent to the browser;
  - credentials are saved only after a working test, re-checked in a transaction.
- **As a feature it's thin.** It's a one-time, raw list of every Home Assistant entity (up to 1,000), grouped by technical domain with code-style IDs. It says "Live states" but never refreshes on its own. Nothing appears on the dashboard or the house drawing.
- **It takes a top-nav slot** on tablet and desktop, even in households that will never connect.

The big value is in bringing a few chosen devices to the house drawing and the wall tablet, not in this list.

### 13.1 Broken or misleading

| # | Finding | Why it matters | Fix | Effort | Verified |
|---|---|---|---|---|---|
| AU-1 | **"Live states" aren't live:** one fetch on open plus a Refresh button; no polling, no websocket, no "as of" time (`automation-client.tsx:164-193, 281`). | On a wall tablet the list freezes when it loads; a door shown "Closed" may have been open for an hour. | Refresh every 30–60 s while visible (the server action is cheap), and show "Updated 12 s ago"; later, HA's websocket through a small server relay. | Q | Code |
| AU-2 | **Every entity is shown, raw:** up to 1,000, cut off silently at `MAX_ENTITIES`. That includes `update.*`, `sun`, `zone`, `automation.*`, `script.*`, `button.*`, `number.*` and battery and signal sensors. Each row shows its `entity_id` in code font; most land in "Other". A typical house has 300–1,000 entities. | The useful 20 devices are buried in noise. | Hide system domains by default ("Show all" toggle); show a count when the list is cut off; map more domains (Scenes, Scripts, Updates, Buttons); `entity_id` only in a details view. | Q | Code |
| AU-3 | **States lose their meaning:** <br>• `binary_sensor` door, motion and leak sensors show "On/Off" and are grouped as plain "Sensors" (`device_class` is fetched but unused); <br>• timestamp sensors show raw ISO text; <br>• no last-changed time. | "Front door: On" means nothing; "Front door: Open · 3 min" does. | Use `device_class` for labels and grouping (Doors and windows, Motion, Leaks, Batteries); format timestamps; fetch `last_changed`. | Q–M | Code |
| AU-4 | **The "Control automation" permission does nothing:** it's in the role editor, but nothing reads `automation.control`. There's also an "Automation" notification category that nothing sends. | Owners can grant a power that doesn't exist; a notification setting that never fires. | Hide both until they're built (or build AU-14 and AU-17). | Q | Code |
| AU-5 | **A wrong address gives an unhelpful error:** live, a public non-HA site gives "Home Assistant returned an error (404)". The most common mistake, pasting a dashboard URL such as `…/lovelace/0`, also ends in a 404, because the path is kept and `/api/states` is appended to it. | People give up during setup. | Strip any path to the origin; for a 404, say "That address isn't a Home Assistant server; use the base address, like https://abc.ui.nabu.casa". | Q | Live + Code |

### 13.2 Wall tablet, phone and setup

> **Agreed wall tablet design (2026-11-09, see section 15):** connecting, disconnecting and replacing the Home Assistant token need a PIN on a tablet. Automation is optional per tablet (WT-11). If safe controls are built (AU-14), lights and scenes need a face tap; locks and alarms always need a PIN. AU-11 (who is home) is hidden in the tablet's resting state.

| # | Finding | Fix | Effort | Verified |
|---|---|---|---|---|
| AU-6 | **"Automation" holds one of six top-nav slots** on tablet and desktop, while Household and Notifications sit in the avatar menu. For an unconnected household (like this one) that slot opens a setup form. | Show it in the nav only when connected (or for admins); otherwise put it in More and Profile → Integrations. Ties to SL-5. | Q | Live |
| AU-7 | **Setup is hard for most people:** you need an external https address (Nabu Casa or a reverse proxy) and a long-lived token copied from a nested HA menu. "Read-only" is said twice on the same screen (page subtitle and card text, live). | A short step-by-step with screenshots or links ("Open your HA profile → Security → Create token"); say read-only once; a "Why https?" expander; focus the error after a failed test (live: focus went to the page body). | Q | Live |
| AU-8 | **The list isn't built for touch:** rows are fine (full width, 48 px+), but there's no way to pin favourites, no rooms (HA areas aren't in `/api/states`), and on a 1280 px tablet it's a single long column. | Favourites pinned on top; two or three columns of device tiles at md and up; areas via HA's template or websocket API later. | M | Code |
| AU-9 | **Token rotation needs Disconnect, then Connect** (the error copy even says so); there's no "Replace token". | A "Update token" action that tests the new token before replacing the old. | Q | Code |
| AU-10 | *Withheld from the public copy until the fix is live.* | | | |
| AU-11 | *Withheld from the public copy until the fix is live.* | | | |
| AU-12 | *Withheld from the public copy until the fix is live.* | | | |

### 13.3 Wow and value ideas

| # | Idea | What it would look like | Effort |
|---|---|---|---|
| AU-13 | **Devices on the house drawing** | Map a few entities to rooms (Kitchen → kitchen light, back door). The house drawing lights up the window when the light is on, shows a small open-door mark, or a red drop for a leak. The tablet becomes the house's status board, the most "wow" use of this data. | M |
| AU-14 | **Safe controls (opt-in)** | Behind `automation.control` (already defined): lights, scenes and fans only, as big tap tiles on the wall tablet; never locks or alarms without a PIN. It turns the read-only page into the room's light switch. | B |
| AU-15 | **Dashboard "Home status" card** | "All doors closed · 2 lights on · 71 °F inside", with warnings (door open 10+ min, leak, low battery) feeding the AI overview line. | M |
| AU-16 | **Maintenance from sensors** | A low smoke-detector battery or "filter replace" sensor from HA creates a maintenance reminder; a water-leak sensor creates an urgent notification. | M |
| AU-17 | **Automation notifications** | Use the existing "Automation" notification category for chosen sensor events (garage open after 10 pm), respecting quiet hours. | M |

### 13.4 Looks good: keep as is

- **Strong protection against misuse of the address field:** <br>• only https; <br>• no credentials in the URL; <br>• no `.local`, `.lan` or `localhost`; <br>• DNS checked at save time and again when connecting, so a DNS trick can't reach a private address; <br>• all private, loopback, metadata, CGNAT and IPv6-embedded ranges blocked; <br>• redirects refused; <br>• 5 MB cap and 8 s timeout; <br>• hostile responses can't crash the server. <br>Live: http, a private IP and `.local` were all rejected with clear copy.
- **The token never leaves the server;** the rules deny clients completely; saving happens only after a working test, re-checked in a transaction (household not being deleted, permission still held).
- **Clear copy** for each rejection (live), the token field is a password field, and validation is inline.
- **Disconnect asks first** ("Keep connected / Disconnect"), and the page explains what to do when the token stops working.
- **Permissions:** view, manage and the read only through server actions that verify the sign-in token; children are excluded by default.
- **Fast:** the screen appears in about 1 s on every size (live).

### 13.5 Suggested order

1. **Make the list useful:** AU-2 hide noise, AU-3 meaningful states, AU-1 auto-refresh with an "updated" time, AU-5 clearer setup errors.
2. **Tidy:** AU-4 hide the dead permission and notification category, AU-6 nav slot, AU-7 setup guide, AU-9 replace token.
3. **Wall value:** AU-8 favourites and tiles, AU-15 home status card, AU-13 devices on the house drawing.
4. **Safety for later:** AU-10, AU-11, AU-12.
5. **Bigger:** AU-14 safe controls, AU-16, AU-17.

---

## 14. Where we stand (review of sections 1–13, 2026-11-09)

> **Note (see sections 15 and 16):** this review was written before the wall tablet design. Where it says "wall mode", read "registered tablet" (section 15). Its build order (14.6) is replaced by 16.5.

**Status:** this audit is findings only. Nothing from sections 1–13 has been fixed; production is still `ccdfa4b`, the end of the first audit (PRs #55–#108). Not yet audited as their own sections: the signed-out landing and sign-in flow (touched in section 1), and a dedicated pass on animation and visual effects.

**Totals:** 366 findings across 13 sections, of which 104 are in the "Broken" tables. The rest are tablet and phone layout, friction, and about 80 ideas.

### 14.1 Scorecard by section

| Section | Findings (broken) | Standing |
|---|---|---|
| 1 Homepage | 37 (11) | Good bones and privacy. The tablet sees a third of it; room details are hover-only. |
| 2 Shopping | 35 (10) | Excellent data layer. No live updates; small targets; the first item is low on the phone screen. |
| 3 Pets | 31 (8) | Strongest page: live, one-tap feed with Undo. Needs meal times, a double-feed guard, notes, editable names. |
| 4 Maintenance | 33 (11) | Careful reminder logic. Stale "today", no live updates, saves overwrite, forms too long. |
| 5 Chores | 33 (10) | Strong fundamentals. No live data, points can be farmed, deleted repeats come back. |
| 6 Calendar | 27 (7) | Good foundation. You can't tick anything off; too small for a wall. |
| 7 Notifications | 27 (11) | Careful plumbing. Daily duplicate overdue alerts; one item withheld. |
| 8 Household | 28 (8) | Careful core. one item withheld; no shared-tablet, kid or guest path. |
| 9 Profile | 26 (10) | Appearance is well done. Failed saves look successful; no text size. |
| 10 Search and quick add | 25 (5) | Excellent safety (always Confirm). The parser misreads common sentences; weak on touch. |
| 11 App shell | 24 (3) | Solid as a website. Not built for a screen that never reloads. |
| 12 Barcode Library | 23 (5) | Honest lookup, no AI. Scan count bug, wall camera, silent overwrite, no delete confirm. |
| 13 Automation | 17 (5) | Best security in the app. Thin feature: a raw list that isn't live. |

### 14.2 By platform

| Platform | Standing | What decides it |
|---|---|---|
| **Phone (portrait)** | **Closest to done.** | The tab bar and centre "+" are right. Gaps: Shopping in the store (SH-12, SH-13, SH-15), one pet per screen (PE-13), Maintenance detail below the grid (MA-17), push setup on iPhone (NO-17). |
| **Desktop** | **Good; what it was designed for.** | Hover peeks, shortcuts and the palette all work. Gaps are the shared bugs, not layout. |
| **Wall tablet (landscape)** | **Furthest behind, and the main use.** | It gets the desktop layout with touch: <br>• 32–40 px targets everywhere (SL-4 and every section); <br>• hover-only details (HP-13, MA-23); <br>• no tab bar or "+" (SL-5); <br>• content below the fold (HP-12, CA-13); <br>• dialogs under the keyboard (SH-19, MA-15, QA-14); <br>• no text size (PR-14); <br>• no wall mode. |

### 14.3 The six themes behind most findings

1. **A screen that never reloads.** <br>• A crash leaves it dead (SL-1). <br>• Deploys never arrive (SL-2). <br>• Membership isn't live (SL-3, HO-1). <br>• No live updates on Shopping, Chores, Maintenance, Calendar, Library or Automation (SH-1, CH-1, MA-2, CA-1, BL-14, AU-1). <br>• "Today" and midnight (HP-4, MA-1). <br>• Device against household time zone (PE-7, CH-10, PR-5). <br>• No wake lock or offline notice (SL-8, SL-10).
2. **Who is at the screen?** A tablet signed in as one person acts as that person: feeding and chore credit (PE-17, CH-12), their notifications (NO-12), their profile (PR-11), and owner controls in reach of kids (CH-11, HO-11, SL-6). One fix covers them: a device role with "Who's here?" and an admin PIN (HO-25, HO-26, PR-22, PR-23, SL-21).
3. **Wrong data saved quietly.** <br>• Quick-add junk and misparses (QA-1–QA-4). <br>• Scan ×450 (BL-1). <br>• Pantry credited twice (SH-2). <br>• Double feeds and silently ended medication reminders (PE-1, PE-3). <br>• Maintenance overwrites and duplicates (MA-3, MA-4, MA-7). <br>• Chore repeats (CH-3, CH-4). <br>• Failed profile saves (PR-1). <br>• Member removal damaging chores (HO-5). <br>• Barcode overwrite (BL-3).
4. **Built for a mouse.** Targets under 44 px, hover-only explanations, keyboard hints on touch, drag advertised where it doesn't work (CA-11).
5. **Undo and confirm are uneven.** One toast at a time (SH-7, SL-17). No Undo for maintenance Done, chore reopen or quick add (MA-8, CH-6, QA-9). No confirm on barcode delete, role changes or Log out (BL-4, HO-11, SL-6).
6. **Loading and speed.** Chores 5.3 s cold (CH-17), Calendar waterfalls (CA-6), skeletons that shift (SH-25, MA-25), the sign-in flash (SL-11).

### 14.4 Missing features (the short list)

- **Wall mode** with room identity, keep-awake, idle-to-home, night dim, text size and a clock (HP-15, HP-30, HP-31, SL-21, PR-14).
- **Shared-tablet identity, kid profiles without email, guest passes, admin PIN** (HO-13–HO-15, HO-24–HO-27).
- **Pets:** notes, editable names, bowl logic, meal times, give-dose in two taps, finish a medication (PE-29–PE-31, PE-10, PE-24, PE-4).
- **Chores and Calendar:** tick off from the calendar (CA-8), chore details (CH-15), who did it (CH-27), rotations (CH-28), per-person view (CH-14, CA-21), phone calendar sync (CA-25).
- **Shopping:** live shared lists (SH-28), trip mode (SH-33), "out of this" (SH-29), list editing (SH-8), aisle order (SH-21).
- **Maintenance:** what's due on Overview (MA-12), receipt photo in the log (MA-16), odometer quick update (MA-19).
- **Notifications:** mark all read (NO-14), NO-2, actionable pushes (NO-23), household message (NO-25).
- **Household settings:** time zone and week start (HO-19, CA-16).
- **Shell:** error screens, update flow, offline pill, tablet rail (SL-1, SL-2, SL-10, SL-5).

### 14.5 Animation and effects

**What exists and is good:**
- the living house with rooms, pets that walk around, the fridge, HVAC and car;
- time-of-day sky, weather and seasonal touches;
- the aurora background;
- the logo intro (once per session), page transitions, number tickers and staggered lists;
- the hold-to-feed ring;
- the "House is clean" celebration and the golden roof.

Reduced motion is honoured everywhere.

**Where it falls short:**
- **Most of the delight is ambient or hover-based.** Glow cards and peeks need a mouse (HP-13), so the tablet and phone get the least.
- **The rewarding moments rarely fire.** "House is clean" needs fresh data and no missed chores (CH-22); there's no per-person moment; a tick, a feed or a scan gives little feedback (BL-7, PE-12).
- **The always-on effects cost the most** on the device that never sleeps (HP-16, SL-15) and risk burn-in.
- **Not built yet:** the ambient idle screen (SL-23), devices on the house (AU-13), the whole-house celebration (HP-34), pets leaving the bowl after eating (PE-31).

A dedicated motion pass (tap feedback, completion moments, transitions per page, frame rate on a real tablet) hasn't been done.

### 14.6 Recommended build order

1. **Never stuck, never stale:** SL-1, SL-2, SL-3; live updates on Shopping, Chores, Maintenance and Calendar; midnight and time zone.
2. **Stop wrong data:** the theme 3 list, starting with QA-1–QA-3, BL-1, PE-1, PE-3, MA-3, MA-4, CH-3, NO-1, PR-1.
3. **Wall tablets (see section 15):** device codes and the Devices list (WT-1 to WT-4), "Who's here?" and PINs (WT-5 to WT-10), then the tablet interface (WT-14) with 48 px targets and text size.
4. **Owner requests and top missing features:** PE-29–PE-31, CA-8, CH-15, HP-12 wall layout, SH-11, SH-12.
5. **Undo, confirm and toasts everywhere.**
6. **Delight:** completion moments, the ambient screen, devices on the house, the kitchen scan station.

---

## 15. Wall tablet design (agreed with the owner, 2026-11-09)

**Status:** design only; nothing is built. This section records the decisions made after the audit and supersedes the earlier "Wall mode" proposals (HP-30, HP-31, CA-22, HO-25, HO-26, PR-22, PR-23, SL-21) and the wall-specific fixes in HP-18, CH-11, NO-12, HO-13, PR-11 to PR-13, SL-8, SL-9, SL-14, SL-15 and SL-20. Where an earlier row and this section disagree, this section wins; section 16 lists every such case. Each affected section above carries a short note pointing here.

**The idea in one line:** a wall tablet joins the household with a device code instead of a Google account, has almost no permissions of its own, and borrows the permissions of whoever is standing at it.

### 15.1 Registering and managing tablets

| # | Decision | Detail | Effort |
|---|---|---|---|
| WT-1 | **Device codes** | In Invite Codes, the creator picks **New member** or **New device**. A device code asks for a name and room, is single-use and expires quickly (about 15 minutes). Only owners and admins can create one. | M |
| WT-2 | **Sign-in screen** | A second button under "Sign in with Google": **"Set up a wall tablet"**. The tablet takes the typed code, or scans a QR that the creator's phone shows. No Google account, no email. | M |
| WT-3 | **Device identity** | The server issues the tablet its own identity in that one household, with a "device" record (not a person: no email, no profile, no points). It can't join a second household or redeem a member invite. | M |
| WT-4 | **Devices list, fully editable** | A **Devices** tab in Household lists every tablet: name, room, last seen, app version. Everything about a tablet can be changed there at any time, from any admin's phone or desktop, and **the tablet picks the change up live**, so a tablet moved from a bedroom to the hallway is a two-field edit: <br>• name and room; <br>• start page (Home, Chores for its room, the shopping list…); <br>• which sections it shows (WT-11); <br>• text size, theme, motion, sound and night dimming hours; <br>• live weather and seasonal touches (HP-18); <br>• idle time before returning home and before the ambient screen; <br>• default camera for scanning (front or rear); <br>• **Remove**, which signs that tablet out at once without touching anyone's account. | M |
| WT-13 | **Settings live with the household, not on the tablet** | Tablet settings are stored on the device record, not in the tablet's browser storage, so they survive a browser reset and can be managed remotely. | Q |

### 15.2 Who is at the screen

| # | Decision | Detail | Effort |
|---|---|---|---|
| WT-5 | **Three levels** | **Resting:** the household view (house, everyone's chores for today, lists, pets, calendar), read-only, nothing personal. <br>**Face tapped:** the tablet acts as that member for everyday actions, limited to what their own role allows (a child's face gets a child's options). <br>**PIN entered:** everything that member's role allows, including sensitive actions, but never what WT-10 keeps off tablets; it locks again after about 2 idle minutes or on "Done". | B |
| WT-6 | **The line between face and PIN** | *If one tap can undo it, a face is enough. If it deletes, changes who can do what, or costs someone points, it needs a PIN.* <br>**Face:** complete a chore, feed a pet, give a dose, add, tick or remove a shopping item, put-away-and-clear, mark a pantry item used up, log a service, snooze, dismiss a household notice, scan a product, move a chore to another day, take a chore for yourself, and **Undo of anything you just did** (16.1 D-1). <br>**PIN:** permanent deletes that have no Undo (a list, a pet, an asset, old logs, a saved product); reassigning a chore to someone else; reopen someone else's completed chore; edit repeating chores; the Chore Manager; roles, members, invites and device codes; household settings; Home Assistant connection; the Danger Zone. | M |
| WT-7 | **Enforced on the server** | Without a PIN, a tablet can only perform the everyday set, **whoever's face was tapped**; tapping an admin's face unlocks nothing dangerous. Every tablet action goes through the server and records the device, the member selected, and whether they were verified by face or by PIN (WT-18); a face tap is attribution, not proof of identity. This (this also delivers "who did it" for CH-12, CH-27, MA-20 and PE-17). | B |
| WT-8 | **"Who's here?"** | A row of large member avatars appears only when an action is credited to a person. The choice is remembered for 1–2 minutes, so ticking three chores asks once. | M |
| WT-9 | **PINs** | Each person sets their own PIN **from their own phone**, never on the tablet; an admin sets the PIN for a kid who has no phone (16.1 D-3). Owners and admins need one for sensitive actions. A household setting (**Off by default, Kids only, or Everyone**) adds a per-member PIN for actions that change whether a chore counts as done (WT-22), for homes where kids tick chores as each other. PINs are checked on the server, with a lockout after repeated wrong tries; a reset can never raise anyone's authority (WT-17). | M |
| WT-10 | **Personal things stay on phones** | A tablet has no Profile page, no personal reminders, no targeted notifications and no push. It shows household-wide notices only. | Q |
| WT-11 | **Per-tablet sections** | When creating or editing a device, sections can be switched off for that tablet (for example, a kid's bedroom shows only Chores, Pets and Calendar). Default: everything on. | Q |

### 15.3 Two interfaces, kept separate

| # | Decision | Detail | Effort |
|---|---|---|---|
| WT-12 | **The tablet interface is only for registered tablets** | Signing in with a personal Google account, on a phone, a desktop **or a tablet**, always gives the standard app: no face row, no PIN prompts, no kiosk behaviour. The wall interface appears only on a device that joined with a device code. There is no "wall mode" switch on personal accounts. | — |
| WT-14 | **What the tablet interface is** | • A side rail (Home, Chores, Shopping, Pets, Calendar, More) with big Add and Speak buttons, in place of the desktop header's links. <br>• A slim top bar with the room name and a clock. <br>• The household view at rest; a homepage that fits one screen. <br>• Keep-awake, return to the start page after idle, an ambient clock screen after longer, night dimming. <br>• Kiosk behaviour: no text selection, no double-tap zoom, no pull-to-refresh; heavy background effects off. <br>• Larger text scale by default. <br>• No account menu and no Log out. A **Tablet settings** page replaces Profile (WT-16). | B |
| WT-16 | **Leaving the household is locked behind an admin PIN** | A registered tablet can only stop being that tablet with an **owner or admin PIN**; a member's or child's PIN is not enough. This covers every way out: <br>• **Sign out / Remove this tablet**; <br>• **Sign in with a personal account** on it (which would replace the tablet); <br>• redeeming a different device code or joining another household. <br>**Not locked:** the Tablet settings page lets anyone at the screen change comfort settings for that tablet (theme, text size, motion, sound). Room, name, sections and start page stay admin-only (PIN, or the Devices list). <br>Every removal is written to the household activity log and notifies owners and admins. <br>**Limit to know about:** the app cannot stop someone clearing the browser's data or uninstalling it. That shows up as the tablet going offline in the Devices list and it would need a new device code to return; a kiosk browser or a locked-down tablet is the real fix (15.4). | M |
| WT-15 | **Still for everyone** | Fixes that aren't about identity stay in the standard app too: 48 px touch targets on touch screens, 44 px as the floor elsewhere (16.1 D-2), a per-device text size (D-4), the one-screen homepage on wide screens (D-5), tap-to-open instead of hover-only, dialogs that stay above the on-screen keyboard, live updates, crash recovery and automatic updates. A personal account on a tablet should still be comfortable to use. | — |

### 15.4 Still to decide

- **Guests in the face row:** decided, see WT-21 (17.2).
- **Kids without an email** (HO-15, HO-27): they need a face in the row, so kid profiles move up the list.
- **A removed or offline tablet:** settled in WT-19 (section 17.2).
- **Which actions count as "affects points":** decided, see WT-22 (17.2).
- **Hardware:** still untested. The plan is one test tablet before buying one per room; the checklist is in 17.4.

### 15.5 Build order for the wall tablets

1. **Safe to leave on the wall (helps every device):** SL-1 crash recovery, SL-2 automatic updates, SL-3 live membership, live data on Shopping, Chores, Maintenance and Calendar, midnight and time zone.
2. **Registration:** WT-1, WT-2, WT-3, WT-4, WT-13, WT-19 (removal, offline, re-pairing), child identities and the PIN and session mechanism (WT-17, WT-18), with WT-12 (tablet interface only on registered tablets) and WT-16 (admin PIN to leave).
3. **Identity:** WT-5 to WT-10 (resting view, "Who's here?", PINs, server enforcement), then WT-11.
4. **The tablet interface:** WT-14, with WT-15 touch fixes alongside.
5. **Extras:** a richer ambient screen (SL-23; the basic clock screen ships with WT-14), kitchen scan station (BL-20), devices on the house drawing (AU-13).

The overall order, including what must come before the tablets, is in 16.5.

---

## 16. Consistency review (2026-11-09, before implementation)

The whole file was re-read end to end for contradictions, by an independent reviewer and against my own list. The totals in section 14 check out (366 findings, 104 broken). The review found real conflicts, most of them between older "wall mode" rows and the tablet design in section 15, plus rows written at different times that propose different numbers for the same thing.

**How to read the file from here:** where two items disagree, the ruling in this section wins. 16.1–16.4 are settled; 16.5 is the build order.

**Fixed directly in the text:** four wrong cross-references (HP-3, HP-10, HP-24, CA-10); the NO-2 wording; the notes in 1.2, 10.5, 11.2 and 11.4; WT-4 (added motion, sound, weather and seasonal touches); WT-14 (top bar wording); the list of superseded items in section 15; and the 15.5 steps.

### 16.1 Open choices, settled with the recommended option

The owner asked (2026-11-09) for conflicts to be cleared in line with the agreed design, so each of these uses the recommended option and the affected rows are updated. D-2 and D-4 to D-8 are product choices the design does not dictate; they are the easiest to change later.

| # | Conflict | Options | Applied |
|---|---|---|---|
| D-1 | **"Delete anything needs a PIN" (WT-6) against one-tap flows with Undo:** undoing a feed is a delete (PE-2); "Put away and clear" (SH-2, SH-17); removing a shopping item (SH-13); "used up" on a pantry tile (SH-29). | (a) A face is enough for Undo, removing a list item, and put-away-and-clear; a PIN is for permanent deletes with no Undo. (b) A PIN for every delete. | **(a).** It follows WT-6's own rule (one tap can undo it), and (b) breaks the kitchen tablet's main flow. |
| D-2 | **Touch target size:** seven rows say 44 px (HP-14, PE-14, MA-18, CA-9, NO-16, HO-20, PR-20) and four say 48 px (SL-4, CH-16, BL-13, QA-20). | One number, or two tiers. | **48 px on touch screens, 44 px as the floor everywhere else.** |
| D-3 | **Kids without a phone can't set a PIN.** WT-9 says each person sets their PIN from their own phone, but the optional per-member PIN exists for kids, and kid profiles (HO-15, HO-27) have no sign-in. | (a) An admin sets a kid's PIN from the admin's phone. (b) Kids never have PINs. | **(a).** |
| D-4 | **Text size:** PR-14 says 100 / 115 / 130% per device; SL-20 says 112.5%; the 1.2 note made larger text tablet-only, but PR-14 and section 14 treat it as a gap for everyone. | (a) A text-size setting for personal accounts too (per device), tablets set theirs on the device record. (b) Tablets only. | **(a), with one scale: 100 / 115 / 130%;** tablets default to 115%. Drop 112.5%. |
| D-5 | **Who gets the one-screen homepage and the side rail.** HP-12 was written for every wide landscape screen and SL-5 for every touch screen 768 px and wider; the section 15 notes made both tablet-only. | Tablet-only, or everyone on a wide screen. | **Homepage layout (HP-12) for every wide landscape screen; side rail for registered tablets only.** The header's small targets and overflow (SL-4, SL-7) are then fixed separately for personal accounts. |
| D-6 | **Which time zone drives reminders.** Six rows say use the household's zone (HP-11, PE-7, CH-10, CA-7, MA-11, SH-10); PR-5, NO-11 and NO-24 keep a per-member zone. | Household zone for everything, or household for "today" and per-member for reminders. | **Household zone for everything.** A travelling member gets reminders on home time; simpler and matches the tablets. |
| D-7 | **Who gets the points when someone else completes a chore** (CH-12, left open; CH-27 defaults to the assignee). | Assignee keeps them; the completer gets them; split. | **The completer gets them, and the chore shows who did it.** |
| D-8 | **Pantry item used up:** SH-22 asks "Add to list?"; SH-29 and BL-21 add it automatically with Undo; BL-20 "offers". | Ask, or add automatically with Undo. | **Ask** (owner's choice, 2026-11-09): when an item hits zero, show "Add to list?" with Add and Not now. Nothing is added without a tap. SH-29 and BL-21 follow this instead of adding automatically. |

### 16.2 Rulings: section 15 against earlier rows

| Earlier row | What it said | Ruling |
|---|---|---|
| HP-30, SL-21, SL-8, SL-9, SL-14, SL-15, SL-20, PR-22, CA-22 | "Wall mode" as a per-device or per-account switch, turned on automatically for wide touch screens, stored in the browser. | **Section 15 wins:** these behaviours belong to registered tablets, with settings on the device record (WT-12, WT-13, WT-14). The time-of-day theme option in SL-14 stays available to everyone. |
| HP-18 | Move the weather and seasonal toggles to a "…" menu or Profile → Appearance. | On tablets they are device settings (WT-4). On personal accounts, HP-18's fix stands. |
| HO-26, HO-11, PR-11 | One 4-digit household PIN; "recent sign-in or a household PIN"; "hold-to-confirm or a PIN". | **WT-9 wins:** per-person PINs, used on tablets only. On personal accounts, HO-11's other parts still stand (confirm role and permission changes; hide Leave for children). |
| NO-12 | Never write read state from a shared tablet; dismiss is a local hide. | **WT-6 wins:** dismissing a household notice is a real action as the person whose face was tapped. |
| CH-27, PE-17, HO-13, NO-12 | Five names and two timings for the prompt ("Who did it?", "Who fed?", "Who's this?", "Who's at the screen?"). | **WT-8 wins:** one prompt, "Who's here?", asked at the action and remembered. |
| 2.2 and 10.5 notes | One said adding an item needs a face; the other said quick add asks only for personal actions. | **Every save from a tablet asks "Who's here?"** (WT-5, WT-7); the 10.5 note is corrected. |
| 6.2 note | Moving a chore needs a PIN unless it's your own. | Moving has an Undo, so by WT-6 it is **face-level**. Also face-level: reassigning a chore to yourself. PIN: reassigning to someone else, editing maintenance schedules, hiding the leaderboard. WT-6 is the single list. |
| HP-16, PE-11, CA-12, CH-11, SL-8 | Idle times of 60 s, 2 min and "N minutes"; different places to return to. | **WT-4 wins:** per-tablet settings. Defaults: return to the tablet's start page after 2 minutes, ambient screen after 10; a PIN unlock lasts 2 idle minutes; a face is remembered for 2 minutes. |
| HP-16, SL-8, SL-23, WT-14 | Four descriptions of the ambient screen. | **One spec:** clock, weather, the house with pets moving slowly, and the next-up line, with slow drift against burn-in. The basic version ships with WT-14; SL-23 is the polish. |
| SH-33 | Keep the phone awake while a list is open in the store. | Stays. It's a phone feature, not tablet behaviour; the 1.2 note's "never on a personal account" doesn't apply to it. |
| NO-26, PR-17 against WT-4 | Two different lists called "devices". | **"My devices"** is each person's phones and browsers that get push (NO-26). **"Tablets"** is the household's wall tablets (WT-4). |
| SL-20 | Bigger tab-bar labels for across the room. | Dropped: the tab bar is phone-only; tablets get the rail. |

### 16.3 Rulings: "keep as is" against a finding

In each case the finding stands and the praise applies only to the narrower thing named here.

| Clash | Ruling |
|---|---|
| SH-8 (tap the text to edit) against 2.5 and SH-13 (tapping the name or row ticks it) | Tapping ticks. Editing opens from a long-press or a small chevron. |
| SH-15 (5 s Undo is too short) against 6.5 (5 s Undo praised) | **One Undo window everywhere: 10 seconds,** placed near the thumb on phones. |
| PE-2 (author can delete a feed for about 10 minutes) against QA-9 (10 s) | The 10-second Undo toast for everyone; separately, the author can delete their own log for 10 minutes. |
| SL-3 (a forced password change isn't noticed) against PR-8 (remove that dialog for Google accounts) | **PR-8 wins;** drop it from SL-3. |
| HO-16 (longer or multi-use invite codes) against 8.6 and WT-1 (single use, short expiry) | Keep single-use, short-lived codes; make joining easier with the QR (HO-23), not longer codes. |
| HO-19 (colours in household settings) against PR-24 (each member picks) | Each member picks; an admin can change a clash. |
| CH-32, NO-24, NO-3, WT-4 (three kinds of quiet hours) | Two settings: **household quiet hours** (tablets dim and mute; no household pushes) and **per-member push hours** on phones. |
| CA-11 (bare date field) against 6.5 ("Move to date" praised) | Keep "Move to date"; replace the bare field with day chips and a picker. |
| SH-24 against 12.5 (delete also removes the photo) | Removing the photo is right; the missing piece is Undo (BL-4). |
| MA-4, MA-6 against 4.5; NO-7, NO-10, NO-15 against 7.5; PR-9 against 9.5; HO-11 against the section 8 verdict; QA-2, QA-4 against 10.8; HP-28 against 1.5 | The finding stands. The "keep" line was too broad and covers only the case it names (for example, Maintenance refuses to guess a date, but still uses a stale odometer). |
| HP-34 against CH-22 and 14.5 ("House is clean") | The Chores page moment exists (CH-22 fixes when it fires). HP-34 is the new dashboard-wide version. |

### 16.4 Duplicates: one owner per problem

The same problem appears under several IDs. Build it once, under the ID in the first column; the others are done when it is.

| Build under | Also listed as | Note |
|---|---|---|
| QA-1 + QA-15 | HP-1, HP-23 | QA-1's diagnosis is the correct one (the trailing space is trimmed). |
| SL-3 | HO-1 | Live membership. |
| SL-2 | HP-17 (update part) | Automatic updates. |
| SL-10 | HP-17 (offline part), HP-37 | Offline pill and status. |
| SL-17 | SH-7 and the toast bullets in PE-8, CH-10, CA-7, NO-11 | Toast limit 3. |
| SL-16 | NO-9 | Push opens a second window. |
| SL-11, SL-12 | PR-7, HO-8 (loading bullet) | Sign-in flash and stuck skeleton. |
| NO-1 | HP-27 | Duplicate overdue alerts. |
| NO-10 | HO-7 | Approval notices. |
| PR-2 | HO-8 (name bullet) | Name and photo reach every screen. |
| PE-30 | PE-8 (name bullet) | Editable pet names. |
| HO-19 | CA-16 | Week start setting. |
| BL-9 | SH-10 (bullet), SH-35 | Unknown barcode → save it. |
| BL-4, BL-10 | SH-24 | Library delete and optional photo. |
| SH-34 | SH-21 | Aisle order. |
| QA-6 | SH-16 | One batched categorise call. |
| PE-23 | PE-1, PE-19, QA-9 (feed part), QA-17 | Double-feed guard and "last fed". |
| PE-24 | PE-3, PE-4, PE-15 | Give dose; finishing a course. |
| MA-16 | MA-30 (the AI fill is the extra) | Receipt in the log. |
| MA-19 | MA-6 | Odometer. |
| CH-17 | CA-6, CA-20, NO-21 | The slow serial load. |
| CH-3 | CA-5, CA-27, CH-32 (skip part) | Deleted repeats come back; skips. |
| CA-21 | CH-14 | Per-person view. |
| SL-6 | PR-16, PR-26 | Log out with a confirmation, on Profile too. |
| WT-4 | HP-31, QA-23, SL-22, MA-26 | Room identity. |
| One shared image helper | PR-9 (512 px), BL-11 (1024 px), PE-21, SH-27, MA-25 | Avatars 512 px, product and pet photos 1024 px. |
| HP-33 | HP-36 | One-tap actions on the dashboard. |

### 16.5 Build order (replaces 14.6; the per-section orders only rank items inside a section)

0. **Privacy and permissions (added after the external review, 17.1):** NO-15 with NO-6, HO-9, HO-10, QA-8, HO-2, NO-2, and a server-written activity log (HO-8).
1. **Never stuck, never stale:** SL-1, SL-2, SL-3; live data (SH-1, CH-1, MA-2, CA-1); household time zone and midnight (D-6, HP-4, MA-1).
2. **Stop wrong data:** QA-1 to QA-3, BL-1, BL-3, SH-2, PE-5 **then** PE-23, PE-24, MA-3, MA-4, CH-2 to CH-4, NO-1, PR-1, HO-6 **then** HO-5. Also the broken items no section order had scheduled: HP-7, HP-11, SH-9, MA-11, PR-10.
3. **Undo, confirm and toasts:** SL-17, the 10-second Undo (PE-2, MA-8, QA-9, CH-6, BL-4), confirmations (HO-11, SL-6). *This moved ahead of the tablets, because the face-or-PIN rule depends on Undo existing.*
4. **Touch basics for everyone:** target sizes (D-2), SL-7, tap instead of hover (HP-13, MA-23), dialogs above the keyboard (SH-19, MA-15, QA-14), text size (D-4).
5. **Wall tablets:** section 15.5, steps 2 to 4.
6. **Owner requests and missing features:** PE-29 to PE-31, CA-8, CH-15, SH-11, SH-12, and the rest of 14.4.
7. **Delight:** completion moments, the richer ambient screen, devices on the house, the kitchen scan station.

Two smaller sequencing notes: AU-10 (server cache) ships with AU-1 (auto-refresh), not after it; BL-2's default camera needs the device record (WT-4), so only its "Switch camera" button can ship earlier.

---

## 17. External review and the changes it led to (2026-11-09)

A second model reviewed sections 1–16 from the document only; it did not run the app or read the code. I checked each point against the audit text and the design. Its quotes were accurate and its main points hold, so the changes below are made. Where this section and an earlier row disagree, this section wins; the affected rows carry a pointer here.

### 17.1 Privacy and permissions come first (new step 0 in 16.5)

Section 16.5 had no step for these, and the tablets add a new reader of household data, so they move to the front.

| Finding | What it is | Note on the fix |
|---|---|---|
| NO-15, NO-6 | *Withheld from the public copy until the fix is live.* | |
| HO-9, HO-10 | *Withheld from the public copy until the fix is live.* | |
| QA-8 | *Withheld from the public copy until the fix is live.* | |
| HO-2 | *Withheld from the public copy until the fix is live.* | |
| NO-2 | *Withheld from the public copy until the fix is live.* | |
| HO-8 (activity log part) | *Withheld from the public copy until the fix is live.* | |

These are findings from reading the code; none was exploited in testing.

### 17.2 Changes to the tablet design (section 15)

| # | Decision | Detail |
|---|---|---|
| WT-17 | **A PIN reset can never raise anyone's authority.** | As first written, an admin could reset the owner's PIN, tap the owner's face and act as owner. Now: <br>• nobody can set another adult's PIN to a value they know; an admin can only **clear** the PIN of someone with a lower role, and that person sets a new one from their own signed-in phone; <br>• the owner's PIN can only be changed by the owner, signed in as themselves; <br>• an admin sets PINs only for kid profiles with no sign-in (D-3); <br>• changing or clearing a PIN ends every unlocked tablet session for that person at once. |
| WT-18 | **Three things are recorded separately: the device, the selected member, and how they were verified.** | A face tap is **attribution, not proof of identity**. Every tablet action goes through the server, which checks the device is registered, the selected member belongs to the household, the action is allowed at that level, and (for PIN actions) that an unlocked session exists. The activity log shows "as Alex (face)" or "as Alex (PIN)" and which tablet. <br>This also corrects QA-8: "the author must be the signed-in user" applies to personal accounts; on a tablet the signed-in identity is the device, and a selected kid may have no account. <br>A PIN never unlocks what WT-10 keeps off tablets (personal notifications, profile, push). |
| WT-19 | **Removal, offline and re-pairing** (settles the open item in 15.4). | **Removed tablet:** the server refuses its requests from that moment (checked on the server, not just a sign-out message); the screen shows "This tablet was removed" and the setup screen; any unlocked PIN session ends; cached household data on it is cleared; changes it had queued are discarded. <br>**Offline tablet:** shows the last synced view with an "Offline" marker; face-level actions queue and sync later; anything needing a PIN waits for a connection, because PINs are checked on the server. Queued actions are re-checked when they sync and dropped if the member or tablet has lost access. <br>**Browser reset or replaced hardware:** settings live on the device record, but the tablet's credentials do not survive a reset. The Devices list gets **"Re-pair this tablet"**, which issues a code that reconnects the same record, so no duplicate is created and its settings are kept. |
| WT-20 | **"A face is enough" only where Undo really works.** | An action is face-level only once its Undo exists and has been tested for: another device editing the same thing, a page reload, and a dropped connection. Until then it needs a PIN. This applies first to "put away and clear" (SH-2, SH-17), whose combined reversal (pantry credit and list clear) isn't yet defined. Undo is done on the server and must not overwrite later changes by someone else. <br>Undoing a record does not undo the physical act: feeding and medication still need the "last fed / last dose" check (PE-23), whatever Undo allows. |
| WT-21 | **Guests appear in "Who's here?" only while a guest pass is active** (owner, 2026-11-09). | Hidden by default: the Guest role can only look, so a guest face would do nothing. An admin creates a **guest pass** (HO-24), for example "Babysitter, until 11 pm, can feed pets and tick chores". That adds a temporary face with no account behind it; it disappears when the pass ends, and everything done under it is logged under that name. Until guest passes are built, guests do not appear. |
| WT-22 | **"Affects points" means anything that changes whether a chore counts as done** (owner, 2026-11-09). | Completing a chore (including ticking its steps); undoing or reopening a completed chore; taking a chore for yourself. Feeding, shopping and maintenance carry no points and never ask. <br>The household setting is three-way: **Off (default), Kids only, Everyone.** One PIN entry is remembered for 2 minutes, like a face tap. <br>Limit: this stops someone ticking chores as another person; it does not stop a kid ticking their own chore without doing it. That is photo proof or parent approval (CH-30), a separate feature. |

Child identities and the PIN and session mechanism are designed **with registration** (15.5 step 2), not later, because the "Who's here?" row depends on them.

### 17.3 Tighter acceptance criteria for fixes that were shorthand

| Rows | What "done" must mean |
|---|---|
| MA-3 to MA-8 (one piece of work) | • One maintenance completion produces exactly one log and one schedule advance, from two devices at once or after a retry. <br>• Edits by two people to different fields both survive. <br>• Notification cleanup failing never fails the completion. <br>• Undo reverses only that completion; it does **not** restore an old copy of the whole schedule (MA-8's wording), so someone else's later edit is kept. <br>The same rules apply to pantry credit, chore points and repeating chores. |
| SH-4 | Show "Saved, will sync" only when the change is known to be stored on the device and will survive a reload. A timer alone is not enough: some kinds of save cannot queue offline at all, so each save path needs its own check. |
| SH-23, BL-1, BL-20, BL-21 | **Don't merge quantities across units** (SH-23's "regardless of unit" is withdrawn). The pantry keeps separately: number of packages, size per package, unit, and expiry batch where it matters. "Used up" removes one package; it never subtracts 1 from a measured amount. This is also the proper fix for the scan adding ×450. |
| PE-3, PE-4, PE-24 | A medication has an **explicit schedule** and an explicit "Finish course". The gap between past entries is only a suggestion shown for confirmation, never applied silently (a late dose is not a new schedule). |
| PE-31 | The bowl animation follows meal slots once they exist (PE-22). Until then it is a visual guess and must not read as "needs food". |
| CH-2, CH-3, CH-4, CA-8, D-7 | Completion rules (no early completion for points, who gets points) are enforced on the server, so they hold from Chores, Calendar, quick add, tablets and any future notification action. A completed occurrence keeps its identity through reassignment and schedule edits and is never regenerated. |
| CH-7 | Expiring missed chores needs a stated rule and must stay visible (for example "3 missed this week"); it must not hide undone work just so "House is clean" can fire. |
| SL-1, SL-2 | No automatic reload during a save, while an Undo is showing, or with unsaved input. After repeated crashes, stop reloading and show a plain error with the time and a manual retry, so a persistent fault can't loop. |

### 17.4 What is still unverified

Keep the Live / Code labels when tracking work. These need a real test before being called done:

- The connected Home Assistant device list (no instance was available).
- Barcode scanning with a working camera.
- On a real tablet: the on-screen keyboard, camera, keep-awake, and performance over days (the audit's idle check ran for about 70 seconds).
- Several data-integrity findings were read in code and never triggered.

**First-tablet checklist** (one test tablet before one per room; the planned model is 12.2 in, 2400 × 1600):

- the screen size the app actually reports (likely 1200 × 800; the audit measured at 1280 × 800, so tablet layouts need re-checking);
- a kiosk browser in true fullscreen with keep-awake, left running for a week;
- whether the house animations stay smooth, and how warm it gets;
- the front camera scanning a barcode at wall-mount distance;
- microphone and speaker quality from across the room (the intercom idea depends on it);
- behaviour on permanent power: prefer a model with a charge-limit setting, since a battery held at 100% for years can swell.

The most valuable tests for the build are **two devices and time passing**: the same action from two devices; disconnect and reconnect; midnight; a role change while a session is open; a new deploy reaching an open screen; Undo after another device changed the same thing.

The Q / M / B effort tags are rough groupings, not estimates, especially for anything involving permissions, data migration or simultaneous saves.

### 17.5 Not changed

- Every choice settled in 16.1–16.3 stands (the review agreed).
- The review's advice on how to instruct the model that does the build is about running the work, not about the audit, so nothing in this file changes for it.
- Nothing in the design is still open. Guests (WT-21), points (WT-22) and HO-2 (17.1) are decided. Real hardware behaviour is untested until the first tablet arrives (17.4).
