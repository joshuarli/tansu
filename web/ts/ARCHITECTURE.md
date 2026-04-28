# Frontend Architecture

This frontend is a Solid app around a framework-agnostic markdown editor package. The main design goal is to keep ownership boundaries explicit while preserving the local-first save/conflict/offline behavior.

## API Contract

Rust owns the API DTOs.

- Define frontend request/response structs in `src/api_types.rs`, or in the owning Rust module for shared types such as `Settings`.
- Derive `Serialize`, `Deserialize`, and `TS` for DTOs sent to or received from the frontend.
- Use `#[ts(optional)]` when a field can be omitted by serde, usually together with `#[serde(skip_serializing_if = "Option::is_none")]`.
- Add new exported DTOs to `src/bin/gen-api-types.rs`.
- Regenerate with `cargo run --quiet --bin gen-api-types`.
- Verify drift with `cargo run --quiet --bin gen-api-types -- --check` or `make check`.

`web/ts/api.generated.ts` is generated. Do not edit it manually.

`web/ts/api.ts` is the handwritten API wrapper. It should provide ergonomic functions, request construction, response normalization, and error handling, but it must not redefine DTO shapes that already come from `api.generated.ts`.

## App Layers

- `main.tsx` mounts the Solid app.
- `app.tsx` should stay mostly composition and startup wiring.
- `app-boot.ts` owns boot/unlock startup flow.
- `app-runtime.ts` wires app services that need cross-feature dependencies.
- `ui-store.ts`, `tab-state.ts`, and `server-store.ts` own app state. Prefer factory functions plus explicit startup wiring over hidden cross-store imports.
- Feature UI should receive dependencies through props or narrow service interfaces rather than importing broad app roots.

## Editor Boundary

`packages/md-wysiwyg` is the editor core. It should stay independent of Solid and `web/ts`.

The package owns markdown rendering, serialization, editor transactions, undo/redo, transforms, cursor restoration, diffing, and merge logic. The app talks to it through its public handle and adapts app-specific behavior in `web/ts/editor-adapter.ts`.

The app owns note lifecycle behavior around the editor: active tab, save/autosave, conflicts, tags/frontmatter, backlinks, revisions, autocomplete, image upload, and app-level preferences.

## Guardrails

`web/ts/architecture.test.ts` enforces two important constraints:

- `packages/md-wysiwyg/src` must not import from `web/ts`.
- Production imports across `web/ts` and `packages/md-wysiwyg/src` must remain acyclic.

`web/ts/renderer.test.ts` enforces renderer-specific DOM safety rules, including keeping markdown HTML rendering out of app source files.
