# HomeHub Module Documentation

This directory is the canonical navigation map for HomeHub's cohesive product and platform capabilities. It lets maintainers and Codex sessions begin with the relevant routes, source areas, data paths, security boundaries, integrations, invariants, and validation checks instead of scanning the whole repository.

An application module is a cohesive user-facing or platform capability with a recognizable ownership boundary, data flow, and maintenance surface. Modules are not individual components, routes, or utility folders.

Executable code, types, Firebase rules, configuration, and Cloud Functions remain the source of truth. These documents must be corrected when implementation and prose disagree.

## Module Registry

| Module | Important routes or interfaces | Primary source areas |
|---|---|---|
| [Application Shell and Dashboard](./application-shell/README.md) | `/`, global layout/header/overlays | `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/header.tsx`, `src/components/household-manager.tsx` |
| [Identity and Profile](./identity-profile/README.md) | Google sign-in, `/profile`, Auth context | `src/contexts/auth-context.tsx`, `src/components/login-dialog.tsx`, `src/components/profile-client.tsx` |
| [Household Governance](./household-governance/README.md) | `/household`, create/join/approve/leave/transfer | `src/components/household-management-client.tsx`, `src/lib/permissions.ts`, `firestore.rules` |
| [Chores](./chores/README.md) | `/chores`, recurrence/completion/reminders | `src/components/chore-chart-client.tsx`, `src/lib/types.ts` |
| [Shopping Lists](./shopping/README.md) | `/shopping` Shopping Lists tab | `src/components/shopping-center-client.tsx`, `src/components/shopping-list-client.tsx` |
| [Pantry Inventory and Recipes](./pantry-recipes/README.md) | `/shopping` Inventory tab | `src/components/pantry-inventory-client.tsx`, `src/ai/flows/generate-recipe-flow.ts` |
| [Barcode Scanning and Household Library](./barcode-library/README.md) | `/library`, embedded scanners | `src/components/barcode-library-client.tsx`, `src/components/barcode-scanner.tsx`, `src/ai/flows/lookup-barcode-flow.ts` |
| [Pets and Care Logs](./pets/README.md) | `/pets`, `/pets/[petId]` | `src/components/pets-client.tsx`, `src/app/pets/[petId]/page.tsx`, pet log clients |
| [Maintenance Center](./maintenance-center/README.md) | `/maintenance`, asset/vehicle deep links | `src/components/maintenance-log-client.tsx`, `src/ai/flows/summarize-maintenance-log.ts` |
| [Home Automation](./home-automation/README.md) | `/automation`, Home Assistant state lookup | `src/components/automation-client.tsx`, `src/app/automation/actions.ts` |
| [Notifications, Reminders, and Push Delivery](./notifications/README.md) | Bell, `/notifications`, `/api/sw`, FCM trigger | `src/components/notification-*.tsx`, `src/lib/notifications.ts`, `functions/src/index.ts` |
| [AI and Genkit](./ai-genkit/README.md) | Authenticated OpenAI server actions, on-demand overview, deterministic provider, Genkit developer UI | `src/ai/genkit.ts`, `src/ai/tasks/*`, `src/ai/flows/*` |
| [Firebase Platform, Persistence, and Security](./firebase-platform/README.md) | Firebase bootstrap, rules, hosting, Functions, emulator E2E/CI harness | `src/lib/firebase.ts`, `firestore.rules`, `storage.rules`, `firebase.json`, `functions/`, `scripts/e2e/`, `tests/e2e/`, `.github/workflows/` |

## Adding a Module

1. Confirm the capability is cohesive and is not already owned by a registered module.
2. Copy `docs/modules/_template/README.md` to `docs/modules/<module-slug>/README.md`.
3. Replace guidance with verified implementation facts and repository-relative paths.
4. Add one registry row with its important routes/interfaces and primary source areas.
5. Run `npm.cmd run docs:check` and review links and claims against code.

Do not create placeholder modules for planned features.

## Documentation Maintenance Policy

- Read the affected module README before changing application behavior.
- Update it in the same change when behavior, routes, workflows, persistence, roles, permissions, rules, integrations, AI, background processing, configuration, invariants, or failure behavior changes.
- Pure refactors require updates only when documented architecture, ownership, entry points, dependencies, or behavior changes.
- Review the final diff for every affected module before completion.
- Final task summaries must name module documentation created, updated, or reviewed.
- Use `AGENTS.md` as the durable repository contract and this registry as the canonical module list.
