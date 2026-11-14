# Registered Wall Tablets (Devices)

> **Status.** The F1 slice is built: device identity (Firebase custom tokens), pairing (device codes, QR setup link, setup screen, redemption), re-pairing, the device record and the Household **Devices** tab, the heartbeat, removal, household-deletion revocation, the daily sign-out sweep, the principal switch in `AuthProvider`, and the Firestore and Storage read rules for tablets. It **ships dark**: with `HOMEHUB_DEVICES_ENABLED` (server) and `NEXT_PUBLIC_HOMEHUB_DEVICES` (build) unset, nothing changes for anyone (no Devices tab, no setup button, `/setup` is not found, redemption and every device action refuse with `unavailable`). Sections marked **Planned (F2/F3/F4)** describe the contract later pull requests must meet; none of it exists yet. **Release gate (JC-8):** no rules release containing a device read clause may deploy until the four email scrub scripts report zero remaining work in a production dry run, recorded in the tracker (see Authentication, Roles, and Security).

## Purpose and Scope

This module owns the **device principal**: a wall tablet that joins one household with a single-use device code instead of a Google account, has no permissions of its own, and (once F2/F3 land) acts as whoever is standing at it. Built today:

- the device credential (Firebase Auth custom tokens for uid `device_<deviceId>`), its verification, and ending it (removal, re-pair, household deletion);
- pairing (device codes, QR setup link with the code in the URL fragment, the `/setup` screen with typed entry and camera scan, redemption) and re-pairing the same record;
- the device record (`households/{h}/devices/{deviceId}`): settings that live with the household, edited from the Devices tab; the heartbeat (truthful last seen and app version);
- the Firestore and Storage **read** rules for tablets (no device client writes anywhere);
- the principal switch: `AuthProvider` tells a tablet session from a personal one before any profile work, and a tablet session shows a minimal "This tablet is set up" screen.

It does not own the feature data tablets read (chores, pets, shopping, maintenance keep their own modules and rules; this module adds only the separate device read clauses) nor, today, any device write action.

**Planned (F2/F3/F4), not built:** actors ("Who's here?" roster, child identities as `members/kid_<id>` records with `kind: 'identity'`), PINs (server-held scrypt hashes with a versioned pepper, lockouts, PIN sessions), the device action gate `authorizeDeviceAction` with its capability policy (`src/lib/devices/action-policy.ts`) and op ledger (`devices/{d}/ops/{opId}`), comfort edits from the tablet (`updateDeviceComfortAction`, comfort fields only, validated by the same `validateDevicePatch(..., 'comfort')` that exists today), the tablet shell (rail, resting/face/PIN states, idle return, ambient, night dimming, keep-awake, protected exit), the offline face-action queue, revocation clearing in the shell, and device actions (feed and chore complete/take with Undo). Personal accounts are unaffected by all of it.

## User-Facing Capabilities

With both flags on:

- **Sign-in dialog:** a second button, **Set up a wall tablet**, under Sign in with Google, opens `/setup`.
- **`/setup`** (signed out only): "Set up a wall tablet". Scan the QR code with the tablet's camera (front camera first, Switch camera, Type the code instead; camera errors are explained with the shared scanner copy) or type the code (`XXXX-XXXX-XX`, any case, with or without dashes). Opening the QR's setup link on the tablet prefills the code from the URL fragment and removes it from the address bar. Refusals are plain: "That code wasn't found. Check it and try again.", "That code has expired. Ask for a new one.", "That code has already been used. Tell the person who made it, then ask for a new one.", "That code was cancelled. Ask for a new one.", "The person who made this code can no longer add tablets. Ask an owner or admin for a new one.", "This tablet was changed since the code was made. Ask for a new code.", "That tablet was removed. Ask for a new code.", and a member invite typed here: "That's an invite for a person. Use Join a household." (all in `REDEEM_REFUSAL_COPY`, `src/lib/devices/device-codes.ts`). With a personal session it says "Sign out first to set this browser up as a wall tablet" and never calls redemption. After a removal it shows "This tablet was removed." (or "This tablet was set up again on another screen.") once.
- **The tablet after pairing:** "This tablet is set up" with its name and room (live from its own record). Until the tablet shell (F3) lands, that is all a tablet shows on every route. Google sign-in is refused there ("This browser is a wall tablet. An owner or admin can switch it from Tablet settings.").
- **Join a household** with a device code: "That's a wall-tablet code. Use Set up a wall tablet." The code is not redeemed.
- **Household > Devices** (owners and admins by role; members never see it):
  - every tablet with name, room, sections, app version and **Online** (last heartbeat within 15 minutes of the server's time) or **Last seen …**; an unpaired tablet shows **Needs re-pairing**; removed tablets are listed under **Removed tablets (n)**;
  - **Add a wall tablet**: name, room and sections (all on by default) → a code dialog with a QR code of the setup link, the code, its expiry and **Copy code**. The dialog listens to the code: **"Paired: Kitchen tablet, just now. If that wasn't the tablet in front of you, remove it from Devices."** as soon as any tablet uses it;
  - **Settings**: name, room, sections, start page (Home, Chores, Chores for a room, Shopping, a shopping list, Pets, Calendar, Maintenance; only sections that are on are offered), comfort (theme, text size 100/115/130 %, motion, sounds), display (live weather, weather place, °C/°F, seasonal touches), idle times (back to the start page after 30 s–30 min; ambient after up to 2 h, never sooner) and the scanning camera. Only changed fields are sent;
  - **Re-pair**: a new single-use code that reconnects the same record (settings kept);
  - **Remove** (confirmed): the tablet is signed out at once; owners and admins are notified;
  - **Unused tablet codes** with Show and Cancel code.
- **Notifications:** the code's creator gets "Wall tablet paired" (or "Wall tablet set up again") for every use of their code; every active owner and admin gets "Wall tablet removed". Both are `system` notices targeted to one person and link to `/household?tab=devices`.
- **Activity:** `device.code_created`, `device.repair_code_created`, `device.code_revoked`, `device.paired`, `device.repaired`, `device.settings_changed` (admin fields only; field names), `device.removed`, shown with the generic wording ("Device paired").

## Entry Points

- Routes: `src/app/setup/page.tsx` (`notFound()` unless `NEXT_PUBLIC_HOMEHUB_DEVICES === 'true'`), Household page tab `devices` (`/household?tab=devices`).
- Components: `src/components/devices/setup-screen.tsx` (setup form, QR scan via `react-zxing`, redemption, push clearing, `signInWithCustomToken`), `src/components/devices/set-up-landing.tsx` (minimal tablet screen: own-record listener, heartbeat, removal → back to `/setup`), `src/components/household/devices-tab.tsx`, `device-code-dialog.tsx` (QR drawn with `BrowserQRCodeSvgWriter` from `@zxing/library`, live code status), `device-settings-form.tsx`; shared edits in `src/components/login-dialog.tsx` and `src/components/household-management-client.tsx`.
- Auth: `src/contexts/auth-context.tsx` (`principal`, `switchPrincipal`, `DEVICE_GOOGLE_SIGN_IN_REFUSAL`).
- Server actions: `src/app/household/device-actions.ts`: `createDeviceCodeAction`, `createDeviceRepairCodeAction`, `revokeDeviceCodeAction`, `updateDeviceSettingsAction`, `removeDeviceAction`, `reconcileDeviceSessionsAction`, `redeemDeviceCodeAction` (unauthenticated), `deviceHeartbeatAction` (device token).
- Server code: `src/lib/server/device-identity.ts` (`mintDeviceCredential`, `verifyDevice`, `finishDeviceRevocation`, `revokeDeviceSessions`, `verifyRedemptionAppCheck`, `devicesEnabled`), `src/lib/server/device-management.ts` (codes, redemption and its guards, settings, heartbeat, removal, Devices-list reconcile, household-deletion helpers), `src/lib/server/device-audit.ts` (`writeDeviceAudit`).
- Pure modules: `src/lib/devices/types.ts` (record, code, claims, `readDeviceClaims`, refusal codes), `settings.ts` (defaults, `readDeviceSettings`, `validateDevicePatch`), `device-codes.ts` (TTL, setup URL, fragment and scan parsing, refusal copy), `client-address.ts` (`clientAddress`), `push-clear.ts` (`clearPushState`).
- Functions: `functions/src/shared/device-revocation.ts` (`finishRevocationForRecord`, shared with the web server), `functions/src/reminders.ts` (`sweepDeviceRevocations`, `DEVICE_SWEEP_UTC_HOUR`), called from `householdUpkeep` in `functions/src/index.ts`.
- Rules: `firestore.rules` (Identity section: `isDevicePrincipal`, `isDevice`, `deviceActive`, `sectionEnabled`, `deviceNotificationReadable`; `devices/{deviceId}`; `deviceCodes/{code}`), `storage.rules` (`deviceActiveForStorage`, `deviceSectionForStorage`).

## Architecture and Data Flow

### Device identity

A tablet's Firebase uid is `device_<deviceId>` (`deviceId` is the record's 20-character auto id; Google uids never contain `_`). Its ID token carries four developer claims and nothing personal: `hh_kind: 'device'`, `hh_household`, `hh_device` (equals the uid suffix), `hh_gen` (the credential generation, an integer). No email, name or picture; `firebase.sign_in_provider == 'custom'`. `mintDeviceCredential(deviceId, householdId, generation)` creates (or re-enables) the Auth user with no email, stores the claims with `setCustomUserClaims` (the copy every newly issued ID token carries) and returns `createCustomToken(uid, claims)`, used once for the sign-in. The server test proves all four claims are present after a refresh-token exchange at the emulator's `securetoken` endpoint and that `hh_gen` arrives as an integer. **Emulator limit:** the Auth emulator does not check `revokeRefreshTokens` on the refresh-token exchange (it refuses only deleted or disabled users), and re-stamps `auth_time` on it, so after a re-pair the tests prove that the device's refresh tokens were revoked (`tokensValidAfterTime` moved past the old sign-in) and that an ID token the emulator still issues from the old refresh token carries the old `hh_gen` and is refused by `verifyDevice` and the rules; refusal at the exchange itself is production Firebase behaviour, to be confirmed live. The session is Firebase Auth's refresh token in the browser's existing persistence (IndexedDB); nothing else credential-like is stored.

`verifyDevice(idToken, householdId)` runs `verifyIdToken(token, true)` (revoked, disabled or deleted users fail: `device_revoked`; anything else `unauthenticated`), checks the claims (`readDeviceClaims`; a personal token is `not_a_device`), that the token's household is the requested one (`wrong_household`), that the household exists without `deletingAt` (`household_deleting`), and that the record is `active` at the token's generation (`device_revoked`).

**Revocation.** New requests are refused as soon as the record's `status` leaves `active` or its `generation` moves past the token's `hh_gen`: the rules compare them on every read, query or listener start, and `verifyDevice` on every server call. After the record's transaction commits, the Auth side follows (`finishRevocationForRecord`): refresh tokens revoked, then the user deleted (`removed`) or disabled (`unpaired`); an `active` record whose Auth user still carries an older `hh_gen` gets its refresh tokens revoked. It is idempotent and re-run by a retry of Remove, by opening the Devices list (`reconcileDeviceSessions`, at most once a minute per household per instance) and by the daily sweep. **Already-open listeners (JC-25):** Firestore does not document re-evaluating an open listener when a document its rules `get()` changes; `tests/server/device-identity.test.ts` holds a listener across a removal and records what it receives: on the Firestore emulator (2026-11-14) the listener got `permission-denied` when the next change to the document arrived after the removal, instead of the new data. That is the emulator; production behaviour is not documented and still needs the live check. Without it, a tampered tablet could keep an open listener until its ID token expires (at most an hour), after which the refresh fails. An honest tablet tears its listeners down as soon as it sees its record change (`set-up-landing.tsx` today; the F3 shell later).

### Pairing and redemption

1. An owner or admin (role) creates a code (`createDeviceCode`): name and room (1–40 characters after trimming), optional sections. One transaction checks the caller's role and the household (not being deleted), refuses an 11th live code (`too_many_codes`), reserves a code never used by a device code or a member invite (`INVITE_CHARS`, `XXXX-XXXX-XX`, about 50 bits, `randomInt`), writes `deviceCodes/{code}` and `device.code_created` (kind, name, room; never the code).
2. The dialog shows `https://<origin>/setup#code=ABCD-EFGH-JK` as a QR code. The code is in the fragment, so it never reaches a server, proxy or log.
3. The tablet (signed out) types or scans the code. `/setup` keeps `{ code, nonce }` in `sessionStorage` (`homehub.device-setup`; nonce = 32 random bytes, base64url) until the sign-in finishes, asks for a limited-use App Check token when App Check runs on the page (`appCheck` exported from `src/lib/firebase.ts`, `getLimitedUseToken`), and calls `redeemDeviceCodeAction` with the code in the request body.
4. The action takes the client address (`clientAddress`, below), then `redeemDeviceCodeGuarded`: server flag, rate limits, App Check (consumed), then `redeemDeviceCode`, one transaction:
   - read the code. Missing: `wrong_kind` when a member invite has that code, else `not_found`. `revokedAt`: `revoked`. Past `min(expiresAt, createTime + 15 min)`: `expired` (a stored `expiresAt` is never trusted further).
   - already used: if `redemptionNonceHash == sha256(nonce)` and the record it created is still `active` at the generation it created, this is the same tablet retrying after an uncertain answer and gets a fresh credential for that record; otherwise `used`.
   - the household exists (`not_found`), is not being deleted (`household_deleting`) and carries no legacy `memberEmails`/`ownerEmail` (`household_needs_upkeep`); the code's creator is still an active owner or admin (`creator_lost_access`, D-T14).
   - `pair`: creates the record (defaults plus the code's name, room and sections, `status: 'active'`, `generation: 1`). `repair`: the target record must not be `removed` (`not_repairable`) and its generation must still equal the code's `targetGeneration` (`superseded`); then `generation + 1`, `status: 'active'`, `pairedAt`, `pairedByUid`, the end fields cleared, settings untouched.
   - marks the code used (`usedAt`, `usedByDeviceId`, `usedDeviceName`, `usedGeneration`, `redemptionNonceHash`), writes `device.paired`/`device.repaired` (actor: the code's creator) and the creator's notification (`device-paired-<deviceId>-<generation>`).
5. After the commit: every earlier credential of the device is revoked, the new one minted, and the record re-read; if it moved on in between (a removal or another re-pair that committed after this one), what was just issued is ended and the redemption refused, so a race never leaves an enabled Auth user behind.
6. The tablet clears leftover push state (`clearPushState`: FCM `deleteToken`, then any push subscription of the service worker, then the stored push-device record; failures are logged and retried at the next start), calls `signInWithCustomToken`, and drops the pending nonce.

Two tablets redeeming one code race on the code document: Firestore serializes the transactions, exactly one commits and the others re-run, see `usedAt` with a different nonce hash and get `used`. The record is created inside the winning transaction, so no partial record exists. A re-pair racing a removal or another re-pair loses on the generation check (or on the re-pair code the removal revoked).

**Re-pair codes** (`createDeviceRepairCode`): same authority and limit; the target must be `active` or `unpaired`; older unused re-pair codes of that tablet are revoked (`superseded`) in the same transaction; the code stores `deviceId`, `targetGeneration`, and the record's name and room. **Cancel** (`revokeDeviceCode`): owners and admins, this household's codes only (another household's code is reported as not found), idempotent.

### Principal switch (S4)

`AuthProvider`'s Auth listener first asks `devicePrincipalOf(user)`: the ID token's claims (`getIdTokenResult`, `readDeviceClaims`). A user with no email and a `device_` uid is treated as a tablet even when the claims cannot be read (offline restore). For a tablet, `switchPrincipal` resets membership state, clears the previous person's household data on the device, sets `principal = { kind: 'device', deviceId, householdId, generation }` and returns before any profile work: no `users/{email}` read or creation, no profile listener, no membership listeners, no push sync (`currentUser` stays null, so the push manager never mounts), no member sync, no "No email address found" toast. The provider then renders the lazily loaded `set-up-landing.tsx` instead of the page (so a tablet never sees personal screens or `/setup`). `signInWithGoogle` refuses while the principal is a tablet. Personal sessions are unchanged (`principal = { kind: 'personal' }`).

### Settings, heartbeat, removal

- **Edits** (`updateDeviceSettings`, owners and admins by role): one transaction re-reads the household, the caller's membership and the record; a record not `active` refuses (`device_not_active`); `validateDevicePatch` (shared with the form) checks every named field and writes only fields whose value changes, as dotted paths, with `updatedAt`, `updatedByUid`, `updatedVia: 'devices-list'`. Two people editing different fields both keep their change. A start page in a section that is off is refused (`start_page_section_off`, D-T18); switching off the section that holds the start page resets it to Home in the same write. Admin-field edits write `device.settings_changed` (field names); comfort-only edits are not logged. The tablet listens to its own record, so edits reach it without a reload.
- **Heartbeat** (`recordDeviceHeartbeat`, device token): `verifyDevice`, at most 6 a minute per tablet, then a transaction that writes `lastSeenAt` (the server's clock) and `appVersion` (the running build id if it matches `^[0-9]{8}T[0-9]{9}Z$`, else `unknown`) only when the stored one is at least 60 s old or the version changed. The minimal tablet screen sends it at start, when it becomes visible, on reconnect and every 5 minutes while visible. The Devices list judges Online against the server's time (`reconcileDeviceSessions` returns `serverNow`; the list keeps the offset), never the viewer's clock.
- **Removal** (`removeDevice`, owners and admins): one transaction sets `status: 'removed'`, `generation + 1`, `removedAt`, `removedByUid`, `endedReason: 'removed'`, revokes the tablet's unused codes, writes `device.removed` and one notification per active owner and admin (`device-removed-<deviceId>-<generation>-<uid>`). After the commit, `finishDeviceRevocation` revokes and deletes the Auth user; if that fails the result says `authCleanup: 'pending'` and the record already refuses everything. A retry of Remove on a removed record changes nothing in Firestore and finishes the Auth side. Removed records stay (history) and can never be re-paired. Nobody's account is touched.

### Household deletion (B2)

`deleteHousehold` (`src/lib/server/household-membership.ts`): its first transaction also reads every device record and every device code of the household, marks each device `removed` (`generation + 1`, `endedReason: 'household-deleted'`) and revokes each unused code (`household-deleted`). Immediately after it commits, before any file or data deletion, every tablet of the household has its refresh tokens revoked and its Auth user deleted (3 tries each; failures are logged and left to the daily sweep). Data deletion then removes `devices/**` with the other subcollections, and the final batch deletes the household's `deviceCodes` with its invites. The rules refuse every device read once `deletingAt` is set, even if a later step fails and the household stays frozen.

### Daily sweep

`householdUpkeep` (hourly) calls `sweepDeviceRevocations(db, getAuth(), now)`, which runs in the hour `DEVICE_SWEEP_UTC_HOUR` (03 UTC) only: for every household's device records it runs `finishRevocationForRecord`, then it lists Auth users and deletes every `device_` user whose `hh_household` no longer exists. A failure counts as a failed household in the upkeep totals; it never blocks household upkeep.

## Data Model and Persistence

`households/{householdId}/devices/{deviceId}` (server-written only):

| Field | Value |
|---|---|
| `id` | the doc id |
| `name`, `room` | 1–40 characters |
| `status` | `active` · `unpaired` · `removed` |
| `generation` | integer ≥ 1, bumped by re-pair, removal and household deletion |
| `sections` | `{ chores, shopping, pets, calendar, maintenance }`, every key a boolean (default all on). Home and household notices are always on |
| `startPage` | `{ kind: 'home' \| 'chores' \| 'shopping' \| 'pets' \| 'calendar' \| 'maintenance' }`, `{ kind: 'chores-room', roomId }`, `{ kind: 'shopping-list', listId }` (default Home) |
| `comfort` | `theme` (`system`/`light`/`dark`), `textScale` (100/115/130, default 115), `motion` (`system`/`reduced`/`full`), `sound` (default true) |
| `display` | `weather` (default false), `weatherPlace` (1–80 or null), `temperatureUnit` (`C`/`F`), `seasonal` (default true) |
| `idle` | `homeAfterSec` 30–1800 (120), `ambientAfterSec` ≥ home, ≤ 7200 (600) |
| `camera` | `front` (default) / `rear` |
| `createdAt`, `createdByUid`, `pairedAt`, `pairedByUid` | server time; the code creator |
| `lastSeenAt`, `appVersion` | heartbeat |
| `updatedAt`, `updatedByUid`, `updatedVia` | last settings edit |
| `removedAt`, `removedByUid`, `endedReason` | `removed` · `household-deleted` (later: `personal-sign-in`, `new-code` from the F3 exits) |

No credential material, uid list or PIN data on the record. `readDeviceSettings` reads missing or malformed fields as defaults. Planned subcollections (`ops`, `pinSessions`, `pinGuards`, F2) are already unreadable to every client (catch-all).

`deviceCodes/{code}` (top level, server-written only): `code`, `householdId`, `kind` (`pair`/`repair`), `deviceId` and `targetGeneration` (repair), `name`, `room`, `sections` (pair), `createdByUid` (no email), `createdAt`, `expiresAt` (display only; authority is `min(expiresAt, createTime + 15 min)`), `usedAt`, `usedByDeviceId`, `usedDeviceName`, `usedGeneration`, `redemptionNonceHash` (sha256 hex; the nonce itself is never stored), `revokedAt`, `revokedByUid`, `revokedReason` (`manual`/`superseded`/`household-deleted`).

Auth: users `device_<deviceId>` with no email, custom claims as above. Browser: `sessionStorage` `homehub.device-setup` (pending code + nonce until sign-in), `homehub.device-ended` (one-shot removal note). Activity entries (`auditLogs`, via `writeDeviceAudit`): `{ actorUid, actorEmail: null, actorName, action, deviceId, deviceName, targetName, via: 'devices-list' | 'device', createdAt (ISO), details }`; detail keys that look like codes, nonces, tokens, PINs, hashes or sessions are dropped.

## Authentication, Roles, and Security

**Server authority.** Codes, re-pair, settings, removal and the Devices-list reconcile authenticate a personal caller with `verifyCaller` (a verified ID token with an email, so a device token is refused) and require the **role** owner or admin, active, inside the transaction (a member granted `household.manageInvites` is refused; JC-22). Redemption is unauthenticated and guarded (below). The heartbeat takes the device's own token through `verifyDevice`. Every existing personal server action (household, chores, shopping, automation, AI flows) authenticates through `verifyCaller` or `authorizeHouseholdAction`, both of which require an email, so each refuses a device token; `tests/server/device-identity.test.ts` calls every exported action of those modules with a device token.

**Firestore rules** (`firestore.rules`, Identity section). A device token has no email, so `signedIn()`, `hasMemberDoc`, `hasHouseholdPermission`, `isOwnerOrAdmin` and everything built on them stay false for it; device access is only separate `||` clauses on reads. Helpers take the household from the **path** and require the token to name it:

- `isDevicePrincipal()`: `hh_kind == 'device'`, `sign_in_provider == 'custom'`, no `email` claim, string `hh_device`, `uid == 'device_' + hh_device`, numeric `hh_gen`.
- `isDevice(h)`: plus `hh_household == h` (no read).
- `deviceActive(h)`: plus the record `households/h/devices/<hh_device>` is `active` at `hh_gen`, and the household has no `deletingAt` (two lookups).
- `sectionEnabled(h, s)`: plus `sections[s] == true`.

| Path | Tablet read |
|---|---|
| `households/{h}` | get, when `deviceActive(h)` and the document has no `memberEmails`/`ownerEmail` |
| `members/{uid}` | get and list, `deviceActive(h)` |
| `members/{uid}/private/*` | never |
| `devices/{d}` | its own record only, in every status (`isDevice(h) && d == hh_device`); owners and admins get and list; no client writes |
| `devices/{d}/**` | never (catch-all) |
| `notifications/{id}` | `*` audience only, through `where('audience','array-contains','*')` + `where('category','==',c)`: `system` and `general` always, `chores`/`pets`/`shopping`/`maintenance` when that section is on (`deviceNotificationReadable`). Queries without the category filter, with `array-contains-any [uid,'*']` or `array-contains <uid>`, with a `category in [...]` filter that includes a category the tablet may not read, a `get` of a targeted notice, and the `automation` category are refused (tested) |
| `chores`, `chore-settings`, `chore-templates`, `rooms`, `stats` | `sectionEnabled(h,'chores')` |
| `shopping-lists` (+ `items`, `config`), `pantry-inventory`, `barcode-library`, `stores`, `shopping-settings`, `trips`, `shopping-usuals` | `sectionEnabled(h,'shopping')` |
| `pets`, `feeding-logs`, `feeding-state`, `medication-logs`, `care-logs` | `sectionEnabled(h,'pets')` (every new Pets path must get the clause in the PR that adds it) |
| `home-assets`, `vehicles`, `maintenance`, `maintenance-attachments` | `sectionEnabled(h,'maintenance')` |
| `auditLogs`, `home-automation`, unknown paths, `inviteCodes`, `deviceCodes`, `users/**`, `aiUsage` | never |

`deviceCodes/{code}`: owners and admins (role) of the code's household read it; no client writes. **No device client writes anywhere**: no write rule has a device clause.

**Storage rules** (`storage.rules`): `deviceActiveForStorage(h)` (claims as above, `hh_household == h`, the record under the path's household `active` at `hh_gen`; one Firestore lookup, Storage allows two) and `deviceSectionForStorage(h, s)`. Tablets read `households/{h}/pets/**` (pets on), `households/{h}/barcode-library/**` (shopping on), `households/{h}/maintenance/**` (maintenance on), and profile photos in account-ID folders `users/{uid}/avatars/**` only (never an email-named folder). No device uploads or deletes. Household A's tablet never reads household B's files, even when B has a record with its id (tested per clause).

**Release gate (JC-8, B3).** Tablet reads expose whatever fields shared documents hold. No rules release containing a device read clause deploys until `scripts/ops/scrub-shared-emails.mjs`, `scrub-member-emails.mjs`, `scrub-remaining-emails.mjs` and `migrate-avatars-to-uid.mjs` all report zero remaining work in a production dry run, recorded in the tracker with date and counts. Pairing also refuses a household still carrying `memberEmails`/`ownerEmail`.

**Redemption guards (3.4).** Server flag; in-memory windows of 10 attempts per minute per client address and 300 per minute per instance (`takeRateSlot`); a limited-use App Check token verified with `consume: true`, failing closed outside emulator mode (missing, invalid, over-long or already consumed tokens are `app_check_failed`). The client address is never the first `X-Forwarded-For` entry: `clientAddress(headers, hops)` takes the entry `hops` places left of the rightmost one (default 1: next-to-last, the App Hosting / Cloud Run shape), and a header with any entry that is not a bare IP gives no address (the per-instance limit still applies). **Pending live check:** the hop count must be confirmed on a deployment (set `HOMEHUB_LOG_FORWARDED_SHAPE=true` to log the entry count of each redemption, no addresses) and `HOMEHUB_TRUSTED_PROXY_HOPS` set if it differs.

**Privacy.** Codes store no email; activity entries store no email, code, nonce or token; the creator's notification names the tablet, not a person. The redemption result returns only `{ customToken, householdId, deviceId }`.

## Integrations and Background Processing

- Firebase Auth custom tokens and the Admin Auth API (create/update/delete users, custom claims, refresh-token revocation); Firebase App Check (`firebase-admin/app-check` `verifyToken(..., { consume: true })`, client `getLimitedUseToken`).
- `householdUpkeep` (Cloud Functions, hourly) runs the daily sweep at 03 UTC.
- No new third-party requests and no new dependencies (`react-zxing` and `@zxing/library` were already used for barcodes).
- Environment: `HOMEHUB_DEVICES_ENABLED` (server, read on every call; `true` turns device actions on), `NEXT_PUBLIC_HOMEHUB_DEVICES` (build; `true` shows the Devices tab, the setup button and `/setup`), `HOMEHUB_TRUSTED_PROXY_HOPS` (0–5, default 1), `HOMEHUB_LOG_FORWARDED_SHAPE` (diagnostic), `NEXT_PUBLIC_HOMEHUB_BUILD_ID` (heartbeat version), `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY` (App Check; without it production redemption fails closed).

## Cross-Module Dependencies

- [Household Governance](../household-governance/README.md): the Devices tab lives in the Household page; `deleteHousehold` signs tablets out at step 1; `redeemInvite` points device codes to tablet setup.
- [Identity and Profile](../identity-profile/README.md): `AuthProvider` principal switch, Google sign-in refusal on a tablet, the sign-in dialog's setup button.
- [Notifications](../notifications/README.md): targeted `system` notices for pairing and removal; the tablet's notification read clause.
- [Firebase Platform](../firebase-platform/README.md): rules, App Check instance (`appCheck` export), emulator suites.
- Feature modules (Chores, Shopping, Pets, Maintenance, Barcode Library): their read rules gain the separate device clause; their data and writes are unchanged.

## Invariants and Failure Behavior

- A device principal is never a member: no membership record, never in member lists, pickers, audiences or push recipients; it holds no push subscription (cleared before sign-in and at every tablet start).
- Every credential is bound to one household and one generation; a bumped generation or a non-active status refuses new requests in the rules and on the server at once, whatever the ID token's expiry.
- Codes are single use, expire 15 minutes after the server stored them, and are redeemed only in their own flow; member invites never pair a tablet, and device codes never join a person.
- Redemption is idempotent per nonce and has exactly one winner per code; a re-pair has exactly one winner per generation.
- If the Auth calls after a removal fail, the action still succeeds (`authCleanup: 'pending'`), the record already refuses everything, and a retry, the Devices list or the daily sweep finish it.
- With the flags off: Devices tab hidden, setup button hidden, `/setup` not found, every device server function refuses with `unavailable`.
- The minimal tablet screen ends the session (Firestore cache cleared, push cleared, signed out, back to `/setup` with a one-shot note) when, from the server, its record is missing, not active, at another generation, unreadable, or when the heartbeat answers `device_revoked`, `household_deleting` or `unauthenticated`. Cached snapshots never decide.

## Validation

- `npm run test:unit` (includes `tests/unit/devices-settings.test.ts`: defaults, stored-record reading, every patch rule incl. start page vs sections and comfort scope, claims shape, setup URL fragment and scan parsing, push clearing; `tests/unit/devices-client-address.test.ts`).
- `npm run test:rules` (includes `tests/rules/devices.rules.test.ts`: every read row above positive and refused for unauthenticated, older and newer generation, removed, unpaired, unregistered, household being deleted, other household with the same device id registered there, section off, forged claims (uid mismatch, no prefix, no or Google provider, email beside device claims, string `hh_gen`, wrong kind), every device write denied, the six notification queries and the refused shapes, private member docs, `users/*`, codes; `tests/rules/storage-devices.rules.test.ts`).
- `npm run test:server` (includes `tests/server/device-identity.test.ts`, `device-codes.test.ts`, `device-management.test.ts`: real ID tokens from the Auth emulator, claims after refresh, the old credential refused after re-pair (refresh tokens revoked, old generation refused; see the emulator limit above) and its refresh refused after removal, concurrent redemption, nonce retry, every refusal, creator lost access, removal then reads refused (client SDK under the rules), the listener held across removal, every personal server action refusing a device token, settings concurrency, heartbeat, unpaired → re-pair, daily sweep, household deletion with a forced failure after the tablet step).
- `npm run docs:check`.
- Live checks still owed (record in the tracker): on the first production pairing, `getIdTokenResult(true)` on the tablet after a forced refresh shows the four claims with an integer `hh_gen`; the `X-Forwarded-For` shape on App Hosting; the JC-8 release gate.

## When This Document Must Be Updated

Update this README when the device record or code fields, the claims, the uid shape, pairing or redemption steps or refusal codes, the rate limits or App Check handling, the read rules for tablets (any new collection or Storage path a tablet reads), the flags, the revocation paths (removal, re-pair, household deletion, sweep), the principal switch, or the Devices tab change; and when F2/F3/F4 land, move their parts from "Planned" to verified behaviour.
