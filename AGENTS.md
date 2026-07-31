# HomeHub Repository Instructions

## Module Documentation Contract

`docs/modules/README.md` is the canonical registry for cohesive application modules.

- Before changing application behavior, identify and read the affected module documentation.
- A new cohesive application module requires both `docs/modules/<module-slug>/README.md` and a registry entry.
- Update the affected module README in the same change when behavior, routes, workflows, data models, Firestore paths, roles, permissions, security rules, integrations, AI flows, background processing, configuration, invariants, or failure behavior changes.
- Pure refactors need documentation updates only when documented architecture, ownership, entry points, dependencies, or behavior changes.
- Before completing a coding task, inspect the final diff and update every affected module README.
- Document verified current behavior. Do not retain a stale claim only because it is already documented.
- Final task summaries must name the module documentation created, updated, or reviewed.

Use the [module registry](docs/modules/README.md) for module boundaries and maintenance guidance. Do not duplicate module architecture in this file.
