# Repository Guidelines

## Project Overview

OMP Switch is a cross-platform Electron desktop app for managing Oh My Pi (OMP) provider, model, role, snapshot, session, prompt, and gateway configuration. It edits user-owned OMP files rather than owning their schema. Configuration safety is therefore a primary invariant: preserve comments and unknown YAML fields, guard writes against external edits, snapshot before commits, and stay read-only for unsupported OMP versions.

The repository also ships a headless JSON CLI, an Ink/React TUI, Windows native helpers, Linux packages, and a local loopback gateway. Do not commit API keys, OAuth tokens, personal paths, full session content, app data, snapshots, or generated binaries.

## Architecture & Data Flow

Dependency direction is strict:

```text
packages/core  ->  packages/shared  ->  electron / src/renderer / packages/tui
       \-> packages/cli
```

- **`packages/core/src`** contains pure Node/TypeScript domain logic: OMP path resolution, config validation, YAML patching, snapshots, discovery, sessions, usage, catalog, gateway, update manifests, and prompt/surface handling. It has no Electron imports and is exported from `packages/core/src/index.ts`.
- **`packages/shared/src`** contains pure UI-facing helpers: provider forms, role resolution, model labels, provider selection, and diff logic. It must not depend on React, DOM, or Electron.
- **`electron/`** owns OS integration: IPC handlers in `main.ts`, preload exposure, credential stores, metadata persistence, window/security policy, native bridge invocation, and lifecycle services. It should delegate domain behavior to core.
- **`src/renderer`** is the sandboxed React UI. Filesystem and OS access go through `window.ompSwitch`; `src/renderer/api.ts` supplies a browser mock API for renderer preview/tests.
- **`packages/cli`** bundles the JSON CLI from `packages/cli/src/main.ts`; **`packages/tui`** bundles the Ink app from `packages/tui/src/main.tsx` and imports core/shared directly.

### Configuration write path

Use `OmpFilesystemAdapter` in `packages/core/src/adapter.ts` for models/settings; do not create alternate write paths for those files.

1. `loadProfile` resolves OMP-compatible paths, loads models/settings concurrently, preserves raw text and hashes, and collects diagnostics.
2. `planPatch` applies the `ConfigPatch` vocabulary to cloned documents and validates without filesystem effects.
3. `previewPatch` runs the same validation and YAML patch pipeline and returns the exact candidate text for the UI diff.
4. `commitPatch` re-checks hashes/existence, refuses conflicts and validation errors, snapshots, writes atomically, records committed hashes, and reloads.
5. `restoreSnapshot` is guarded against external edits; `{ force: true }` is the explicit override.

`yaml-config.ts` patches the parsed YAML AST to preserve comments, key order, unknown fields, anchors, and aliases. Deleting anchored nodes or replacing aliases is intentionally refused. Legacy `models.json` migration requires explicit confirmation. Unknown/unsupported OMP schema versions are read-only; a missing OMP executable still permits file-only mode.

The GUI save is two-step: IPC `omp:preview` renders a diff, then confirmation calls the guarded commit. New IPC capabilities require coordinated changes in core (when applicable), `electron/main.ts`, `electron/preload.ts`, `src/renderer/global.d.ts`, and `createMockApi()`.

MCP uses `OmpMcpAdapter` in `packages/core/src/mcp.ts`: load → preview → save for the selected Profile's primary `agentDir/mcp.json`. Preserve exact raw JSON and unknown fields; validate, recheck the original hash, and snapshot before saving. No project/legacy migration, command execution, server connections, or OAuth-store access. The renderer's `modules/mcp/mcp-module.tsx` keeps drafts across page changes; its save/refresh actions are routed from the shell. `Ctrl+8` opens MCP without renumbering existing shortcuts.

## Key Directories

| Path | Purpose |
| --- | --- |
| `packages/core/src/` | Domain contracts and filesystem/network logic; `adapter.ts` is the config write boundary. |
| `packages/shared/src/` | Pure renderer/TUI helpers and form/role/diff logic. |
| `packages/cli/src/` | Headless JSON CLI entrypoint. |
| `packages/tui/src/` | Ink/React terminal UI and screens. |
| `electron/` | Main process, IPC, preload, security, vaults, metadata, gateway lifecycle. |
| `src/renderer/` | React UI, hooks, modules, components, i18n, and tokenized styles. |
| `native/` | Windows secret bridge and console CLI proxy C# projects. |
| `scripts/` | Native build driver, packaging hooks, release verification, manifest rendering, version checks. |
| `docs/` | Security, OMP contract/schema tracking, release, install, and feature documentation. |
| `.github/workflows/` | Windows/Linux/Docker CI, packaging, release, schema-watch, and install-regression automation. |

## Development Commands

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm dev                 # Electron development; predev runs build:native
pnpm preview             # Electron preview
pnpm preview:renderer    # Browser-only renderer preview on port 5199

pnpm typecheck           # strict TypeScript check
pnpm test                # Vitest run
pnpm test:watch          # Vitest watch mode
pnpm build               # native + JSON CLI + Electron build
pnpm build:cli           # packages/cli/dist/main.js
pnpm build:tui           # packages/tui/dist/main.js

pnpm package:win         # NSIS installer + Windows portable ZIP
pnpm package:linux       # AppImage + deb + rpm
pnpm verify:package-cli  # packaged CLI smoke test; Windows PowerShell
pnpm render:packaging    # release-manifest rendering; may update packaging/bucket files
```

There is no dedicated lint script; `pnpm typecheck` is the repository's static check. Focused tests use `pnpm exec vitest run path/to/file.test.ts` or `-t "case name"`.

For manual reads/writes, isolate both the OMP home and app data directory. On Windows set `USERPROFILE` and `HOME`; on Linux set `HOME`. Set `OMP_SWITCH_DATA_DIR` to an isolated directory for vaults, metadata, gateway tokens, and snapshots. Also honor OMP's `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `OMP_PROFILE`, `PI_PROFILE`, and `OMP_MODELS_PATH`; never assume `~/.omp/agent` is the active profile.

Windows native builds require Node 24+, pnpm 11, .NET SDK 10, and Visual Studio/Build Tools with **Desktop development with C++**. `build:native` is a successful no-op off Windows. Linux packaging additionally needs `rpmbuild`/the `rpm` package. Electron output is under `out/`; the packaged main is `out/main/main.js`, and the preload is loaded from `out/preload/preload.cjs`.

## Code Conventions & Common Patterns

- Use strict TypeScript, ESM, ES2022, and workspace imports (`@omp-switch/core`, `@omp-switch/shared`). Core/shared packages expose source directly; new core modules must be re-exported from `packages/core/src/index.ts`.
- Keep domain logic in core, pure UI logic in shared, OS access in Electron, and UI state in renderer hooks/modules. Inject filesystem, fetch, secret resolution, clock, and preference boundaries in tests instead of mocking broad globals.
- Validate every identifier that reaches disk, a URL, or a child process with an anchored format check. Return `Diagnostic[]` for config validation; only error-severity diagnostics block writes. Preserve the distinction between settings thinking levels, role suffix levels, and OMP CLI levels.
- Keep API keys out of OMP config. Store credentials through the platform credential store and write only supported command/environment references. Preserve the Windows vault/bridge file shape and `OMP_SWITCH_DATA_DIR` contract; bridge stdout must contain only the resolved secret.
- Keep the gateway loopback-only, bearer-protected, Host/Origin checked, lazy in credential resolution, and failover-limited to retryable failures before response bytes are relayed.
- Renderer strings belong in `src/renderer/i18n/locales/{zh,en}.json`; Chinese is the fallback/source language, and locale keys/interpolation variables must stay in parity. Reuse Radix-backed UI primitives and existing hooks. Use `tokens.css` for all colors; do not add ad hoc hex colors or duplicate theme selectors. Do not use `window.confirm`.
- Provider cards keep expand/collapse separate from the edit/open-drawer action. The editor drawer is a fixed overlay, not a grid column that squeezes content.
- Use LF line endings. Keep changes focused; preserve user formatting and unknown configuration data rather than reserializing whole documents.

## Important Files

- `packages/core/src/adapter.ts` — load/plan/preview/commit/restore and snapshot retention.
- `packages/core/src/mcp.ts` — MCP validation, profile-scoped raw JSON, guarded saves and private snapshots.
- `packages/core/src/yaml-config.ts` — AST-preserving YAML, hashes, atomic writes, anchor safety.
- `packages/core/src/paths.ts` — OMP-compatible profile/path resolution.
- `packages/core/src/validation.ts` and `schema.ts` — diagnostics and writable-version gating.
- `packages/core/src/domain.ts` — shared contracts and `ConfigPatch` vocabulary.
- `packages/core/src/cli.ts` and `gateway.ts` — JSON protocol and loopback gateway behavior.
- `electron/main.ts` and `preload.ts` — IPC implementation and capability bridge.
- `electron/metadata-store.ts`, `credential-store*.ts`, `secret-bridge.ts` — persistence and secrets.
- `src/renderer/App.tsx`, `api.ts`, `global.d.ts` — UI shell, browser mock, and IPC type contract.
- `src/renderer/styles/tokens.css`, `i18n/`, `theme.ts` — visual and localization contracts.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `electron.vite.config.ts`, `vite.cli.config.ts`, `vite.tui.config.ts` — runtime, test, and build configuration.
- `docs/security.md`, `docs/releasing.md`, `docs/omp-schema-tracking.md`, `CONTRIBUTING.md` — security, release, compatibility, and contributor rules.

## Runtime/Tooling Preferences

Use Node.js 24+ and the pinned pnpm 11.21.0 via Corepack. Prefer Node built-ins over new runtime dependencies. The CLI and core must remain free of Electron- and Windows-only imports so Linux CI can execute them. Native Windows helpers target `net10.0-windows`/`win-x64`; Linux uses libsecret with an explicitly weaker age fallback when no Secret Service is available.

The main process runs with `contextIsolation`, `sandbox`, and `nodeIntegration: false`; production CSP disables renderer networking. Do not expose raw `ipcRenderer`, filesystem access, secret reads, or arbitrary external URLs to the renderer. External links use the main-process allowlist.

Do not hand-edit `out/`, `dist/`, `packages/*/dist/`, native publish output, `packaging/out/`, or release assets. `pnpm package:*` uses `--publish never`; draft creation and publication are workflow-owned. Release tags must match `package.json` and have matching `docs/releases/vX.Y.Z.md`; release assets are checksummed and attested.

## Testing & QA

Tests are colocated as `*.test.ts`/`*.test.tsx` and discovered by `vitest.config.ts`. Vitest defaults to the Node environment with globals and 30-second test/hook timeouts. Add a file-level jsdom directive only for browser APIs; `.tsx` does not imply jsdom because TUI and server-rendered suites also use Node.

Prefer real `fs.mkdtemp` directories and inline fixtures for filesystem behavior. Inject `fetchImpl`, secret resolvers, clocks, and preferences for network/security boundaries. Exercise both metadata backends where relevant (`node:sqlite` and JSON fallback), and close metadata stores before deleting Windows test directories. Linux credential behavior is platform-specific and not covered by Windows runs.

For behavior changes, run the focused test first, then:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For config/CLI changes, also run a throwaway-home smoke path or `pnpm verify:package-cli`; verify JSON stdout remains pure JSON and usage/errors use stderr. CI additionally tests Linux CLI/TUI, Docker, Electron headless under `xvfb`, Linux packaging, Windows packaging, guarded external-edit restore, forced restore, and the clean-tree invariant. Before manual write/migration/restore testing, redirect `HOME`/`USERPROFILE` and `OMP_SWITCH_DATA_DIR` as described above.
