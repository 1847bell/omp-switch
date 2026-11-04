# Features

This page goes through what OMP Switch can do, section by section. For installing, see [install.md](install.md); for security details, see [security.md](security.md).

## Editing configuration

- **OMP versions:** `16.x`, `17.x`, and `18.x` open read-write. A higher major version it hasn't verified opens read-only, and the files are left alone.
- **Profiles:** default and named profiles, plus OMP's own `PI_CONFIG_DIR`, `OMP_PROFILE`, `PI_PROFILE`, and `PI_CODING_AGENT_DIR`. A legacy `models.json` is protected rather than migrated in place.
- **What you can edit:** providers, models, `modelProviderOrder`, `enabledModels`, `disabledProviders`, thinking settings, and fallback chains. OMP v18.8 model compaction thresholds and usage-aware retry fields are now typed/validated and preserved, but are not all editable in the UI yet.
- **How it writes:** it changes only the YAML nodes involved, so comments and unknown fields stay as they were. The file hash is checked before writing, writes are atomic, and a snapshot is taken first. Restoring a snapshot also refuses to overwrite outside changes.
- **Presets:** 81 built-in provider presets. Some models carry context length, output limit, and a `thinkingLevelMap`. The presets were put together with CC Switch's catalog as a reference.
- **Model discovery:** OpenAI-compatible endpoints, Ollama, llama.cpp, LM Studio, Proxy, LiteLLM, and Apple Foundation Models.

What `thinkingLevelMap` means in a preset is explained in [pi-thinking-profiles.md](pi-thinking-profiles.md). The current OMP sync baseline is v18.8.7; weekly schema-source drift checks require manual review.

## Model roles

- The Roles page has one row per role: a short description, what the role actually resolves to (`@default → provider/model = actual model`), and capability chips. Custom roles from `config.yml` can be viewed and edited.
- `@role` cycles, bad selectors, and misuse of `:off` / `:auto` are flagged on the row they affect.
- The model picker is searchable and grouped by provider, with `@default`, `*`, and "clear" pinned at the top. Thinking levels use a segmented control (a role suffix accepts only the six levels OMP accepts), and everything works from the keyboard. The gateway's upstream rows use the same picker.
- Hover a model row to assign it to any role in one click; the role's existing thinking suffix is kept.
- Provider cards and the role picker show `enabledModels` coverage, and warn you in place if a chosen model would be filtered out by OMP.

## MCP configuration

- Open MCP in the Content group immediately below Skills, at the same navigation level; it is item 5 and `Ctrl+5` opens it directly.
- Create or edit the current profile's primary `mcp.json`: `~/.omp/agent/mcp.json` by default, or its named-profile agent directory, honoring OMP path overrides.
- Each `mcpServers` server has its own card with add, edit, rename, and delete actions. The editor has separate Key and JSON Object fields for that server, not a whole-file editor. Other entries, root fields, and unknown fields remain untouched.
- JSON object syntax, unique keys, and MCP configuration validation precede the line diff and confirmation. Deletion also requires confirmation and diff review. Root enable/disable lists are preserved but not edited by the entry editor.
- Saving rechecks the loaded hash and creates a local snapshot. Invalid JSON and external changes refuse writing. Navigation preserves the draft; refreshing or changing profiles asks before discarding it.
- Only the profile's primary `mcp.json` is edited: no legacy `.mcp.json` migration, project-file changes, or other tools' MCP edits. Saving does not execute commands, connect servers, or read OAuth databases; reload MCP in OMP to apply changes.

## Other pages

- **Prompts / Skills / Sessions:** browse the index and read the raw content on demand. The Prompts page also has a local prompt library: add dedicated Markdown folders explicitly, search file names or text, favorite/tag/copy entries, and keep external sources read-only. A selected material can be previewed and adopted as a one-time copy into the current Profile; the source is never edited or synced, and adoption keeps a guarded recovery snapshot.
- **Session deletion:** delete a single row or select several for batch deletion. Select-all covers only loaded rows matching the current filter, never all history implicitly. Confirmation moves primary session JSONL files to the system trash and removes their list, full-text search, and usage records; attachment directories remain untouched. Stop OMP using the target sessions first. Externally changed files are refused and failed batch items remain selected. Unavailable trash never falls back to permanent deletion; restore files from trash and rebuild the index to recover them.
- **Usage:** spend, requests, tokens, and a per-day trend, grouped by model or provider. Costs say where the numbers came from.
- **Local gateway:** listens on loopback only and serves `/healthz`, `/v1/models`, chat, and responses, with failover before streaming starts. A Bearer token is required, the `Host` header is checked, and cross-origin requests are refused.
  - The default upstream idle deadline is 255 seconds, active only while awaiting headers or the next upstream body read rather than limiting total stream duration. Downstream backpressure or delayed consumption of received data pauses the deadline, but explicit cancellation remains active. Cancellation or upstream inactivity releases the connection; body errors after selecting a response terminate that stream without failover.
  - After Node fetch decodes compressed upstream JSON/SSE, the gateway removes stale `Content-Encoding` and compressed-length headers to prevent double decompression. Undecoded coding chains retain their original bytes and encoding metadata; SSE frames are relayed without waiting for the body to finish.
  - Health probes return from response headers without waiting for the body. Completed probes and discarded retry responses abort their upstream fetches to release unread or infinite bodies. The final selected JSON/SSE keeps its caller/stream-controlled lifetime and is not aborted by retry cleanup.
  - New upstreams receive independent UUIDs; deleting, adding, or reordering does not reuse a deleted upstream's identity. Draft row keys are separate from editable IDs, so ID edits and repeated selection of the current pool preserve input nodes and focus. Both the editor and save boundary reject duplicate IDs within a pool, including disabled upstreams, to keep probes, health history, and runtime statistics separate. Existing IDs are not renamed automatically.
  - Probes use saved configurations only: save new or edited drafts first. Every target rechecks the saved version, and the main process checks it and the enabled upstream again after asynchronous resolver preparation, without saving a draft or changing live routes. Save/start are disabled while probing. Leaving the page abandons the batch, preventing subsequent probes or late notices; already dispatched probes may complete. Stored health is labelled historical. Batch probes count enabled upstreams only and report successes, failures, and errors; no enabled targets does not report success.
  - The live connection is restored when entering or refreshing the gateway page, without selecting a pool. Internal status queries return the applied bearer token only to the viewed Profile that owns the running service; other Profiles and stopped services receive no token. Failed refreshes hide unconfirmed tokens, while failed restarts can recover a still-active connection after checking its actual status. Recovery neither rereads the token file nor exposes it over HTTP.
  - Each Profile has one shared listener port for all pools, saved independently at the top of the page rather than on a pool. Save port edits before starting; stop the running service before changing its port. An occupied port reports an error without silently choosing another address. SQLite/JSON migration preserves a unanimous legacy pool port; conflicting or invalid values require an explicit saved selection. Other pool fields and unrelated data are preserved. Other Profiles may be configured independently, but switching to a different port still requires stopping the active service.
  - Delete a saved pool after confirmation to remove its current-Profile routes, runtime statistics and probe history, without deleting shared credentials, same-ID pools in other Profiles or independent listener settings. Already admitted requests may finish, but late probes/requests cannot recreate deleted records or attach old results to a reused pool ID. Deleting the last pool returns to the empty state while the listener remains running with an empty model catalog; use Stop explicitly.
  - Each upstream has an enable control. Toggles edit the draft first; saving applies them to the running routes for that Profile. Disabled upstreams do not forward traffic or participate in UI probes. An all-disabled pool remains saved but returns HTTP 503; re-enable and save to restore forwarding.
  - Saving a running pool prepares a fresh provider snapshot for its Profile before persisting and applying routes, so providers added after startup are usable immediately. Resolver or write failures retain the previous configuration; admitted requests keep their original snapshot. JSON metadata publishes changes only after successful atomic replacement: failed deletion or port saves cannot affect a later start, and migration failures report errors rather than silently clearing unrelated data.
- **Credentials and login:** the Windows DPAPI helper, the Linux libsecret / age vault (since v0.6.0), and OMP OAuth status and login entry points. Orphaned credentials and reference tracking behave the same on both systems.
- **CLI:** stable JSON output; commands are `list`, `get`, `validate`, `plan`, `apply`, `snapshot`, `snapshots`, and `restore`. Restore checks snapshot hashes by default; `--force` is required to overwrite external edits. `get --reveal-secrets` prints plaintext credentials and should only be used in a trusted local terminal.
- **TUI:** `omp-switch-tui` has four screens (providers, roles, snapshots, diagnostics) and a two-step save (diff first, then confirm). The `list` and `validate` subcommands can go straight into scripts. It's built from source; see [install.md](install.md).

## Interface details

- **Look** (internally called "Quiet Instrument"): mostly neutral grays, with teal reserved for selection and focus; primary buttons are dark with white text; status is a dot plus quiet text.
- **Theme and language:** light, dark, or follow the system, with the native title-bar buttons following along; Chinese, English, or follow the system, and the first paint already uses the saved language. Windows 11 22H2 and later get a Mica window material; everything else uses solid surfaces.
- **Title bar:** the top bar drags the window, and the window buttons are the native ones (Snap Layouts are kept).
- **Provider cards:** clicking the card header only expands or collapses the model list; an edit button appears on hover; the detail and editor drawers slide in as a floating sheet instead of squeezing the workspace.
- **Saving:** roles and settings save independently; a dot appears in the navigation when something is unsaved, and `Ctrl+S` saves; switching profiles asks before discarding edits.
- **Preview before write:** every save shows a line-by-line diff of `models.yml` / `config.yml` first, and nothing is written until you confirm. The snapshot timeline can be browsed and restored; if an outside edit causes a conflict, a dialog offers a one-click reload.
- **Shortcuts:** `Ctrl+K` opens the command palette (pages, profiles, providers, actions). `Ctrl+1` through `Ctrl+8` follow navigation order: Models, Roles, Prompts, Skills, MCP, Sessions, Usage, Gateway. `?` lists every shortcut.
