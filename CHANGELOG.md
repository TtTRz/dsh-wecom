# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.13] - 2026-08-17

### Changed

- Agent working directory (`cwd`) now defaults to `~/.wecom-sessions` instead
  of the process cwd, keeping WeCom sessions, uploads, and state files out of
  wherever `dsh web` was launched. The field is optional in the row config;
  resolution order is explicit `cwd` → `DSH_WECOM_CWD` environment override →
  `~/.wecom-sessions`, and a relative value rejects loudly. Existing persisted
  conversations keep their stored cwd (they stay under the old workspace until
  `/new` starts a fresh session in the new directory).

## [0.1.12] - 2026-08-17

### Changed

- Sidebar-foot WeCom button: the session summary (`6 WeCom · 29 total`) now
  sits right-aligned on the far side of the row instead of a pill hugging the
  "WeCom" label.

## [0.1.11] - 2026-08-17

### Changed

- Sidebar-foot WeCom button polish: slightly more line height/padding, and a
  live count pill next to the "WeCom" label showing the number of currently
  running WeCom conversations.

## [0.1.10] - 2026-08-17

### Fixed

- A turn no longer fails with `cannot create effect on inactive context` when the conversation's agent is disposed between being resolved and the turn subscribing to it (e.g. a `/new`/`/clear`, or the user closing the session in the web UI, while the message was still queued). The pool now re-resolves a live agent right before driving the turn.

## [0.1.9] - 2026-08-17

### Added

- `/clear` command: an alias of `/new` that drops the current conversation and starts a fresh one, so users get the expected "clear context" spelling alongside `/new`.

## [0.1.8] - 2026-08-17

### Fixed

- `/new` now survives a process restart: the per-conversation reset counter is persisted to `.dsh-wecom-state.json` in the agent cwd and reloaded on start. Previously the counter was in-memory only, so after a restart the next message resumed the ORIGINAL session with its full history instead of opening a fresh conversation.

## [0.1.7] - 2026-08-17

### Fixed

- A successful (re)authentication now clears the sticky `lastError` in the channel status: the sidebar panel no longer keeps showing a failure the channel already recovered from (e.g. a transient `write EPROTO` during a reconnect). The recovered message is logged before clearing, so the incident stays traceable.

## [0.1.6] - 2026-08-15

### Changed

- READMEs (EN/ZH) rewritten in the popular GitHub style: badges, quick-start-first layout, feature cards, and compact config/command tables; `showToolCalls` description updated to the 0.1.5 think-card rendering.

## [0.1.5] - 2026-08-15

### Changed

- Tool-call activity is now rendered as a compact list inside the native
  `<think>` card (arguments previewed from their most informative field)
  instead of a markdown footer in the reply body, keeping the visible answer
  clean.

## [0.1.4] - 2026-08-15

> Superseded: the 0.1.4 npm tarball was published from a stale base that missed
> the 0.1.2 changes; use 0.1.5 instead.

## [0.1.3] - 2026-08-15

### Changed

- Package metadata: added the `author` field (`TtTRz <romc1224@gmail.com>`) so npm surfaces the correct author on the registry page instead of the publishing account.

## [0.1.2] - 2026-08-15

### Added

- `/compact` command: summarizes the conversation's older history into one summary through the optional `ctx.compaction` seam, when that capability is mounted in the running harness.

### Changed

- Bot commands renamed to the industry-standard set — `/ping`, `/help`, `/status`, `/stop`, `/new` — matching common Discord/Slack bot and AI assistant conventions. The old `/bot-*` names are removed.

## [0.1.1] - 2026-08-15

### Added

- Token-level streaming: model text and reasoning deltas are flushed to WeCom
  as they are produced (`streaming`, default on; `streamFlushMs` controls the
  cadence), instead of a single "Working…" ack + final answer.
- Native thinking card: reasoning rides inside a `<think>` block that stays
  open while the model thinks and closes when the answer starts, which the
  WeCom client renders as its collapsible "思考过程" card (`showReasoning`,
  default on). Nested/foreign think tags are stripped so exactly one block is
  sent.
- Optional tool-call activity list on the final reply (`showToolCalls`, default
  on), budgeted under the WeCom reply byte cap.
- Runtime overview in `GET /api/wecom/status` and the sidebar panel: live
  agents (running first, WeCom-flagged, with model), session counts (total and
  WeCom), and process/machine load (RSS, uptime, load average).

### Fixed

- A WeCom message no longer fails with `cannot prepare session ... while it is
  live` when the conversation's session is already open elsewhere (e.g. the
  user opened it in the web UI, which resumes the persisted session). The pool
  now adopts the live agent instead of resuming it a second time, and re-opens
  the conversation when an agent it tracked was disposed by its owner.
- Continuing a chat after its session was archived in the web UI no longer
  keeps the conversation invisible forever: the harness has no unarchive API,
  so the pool skips archived session ids and starts a fresh, visible session
  for new WeCom activity.
- Restart loop (`runChannelLoop`): the channel restarts itself after every
  unrecoverable end — auth failure, reconnect exhaustion, or replacement by
  another client — after `restartIntervalMs` (default 10s), instead of leaving
  a failed fiber and a dead bot.
- Workspace grouping: the pool claims a workspace on `cwd` (title
  `workspaceTitle`, default `WeCom`) and adds every WeCom conversation session
  to it, so chats stop landing in the sidebar's "Ungrouped" bucket.
- Host-wide `wecomChannelStatus` service exposing a scalar-only `snapshot()`
  (`connected`, `stopping`, `conversations`, `authenticatedAt`, `lastError`).
- `GET /api/wecom/status` route (registered only when a web server is present)
  serving the JSON status payload for dashboards and the bundled browser UI.
- Browser client half (`dsh.client`, served as `/plugins/dsh-wecom/client.js`):
  a WeCom status action with a connection dot in the sidebar foot and a
  floating status panel over `shell.overlay`, polling the status route.
- Initial WeCom AI Bot long-connection channel plugin for DeepSeek Harness.
- Per-conversation persistent agents with a mounted `preset` (default `standard`).
- Persistent `systemPrompt.section` instructions layered on the persona.
- Single-chat and group text handling plus voice transcription.
- Inbound images: download + AES decryption via the official SDK, durable Harness
  attachments, and a text fallback when the model cannot view images
  (`imageMode`: `auto` / `always` / `never`).
- Inbound files and videos: downloads land in the agent's workspace
  (`.wecom-uploads/`) and are referenced by path for the agent's own tools.
- Access policies (`open` / `allowlist` / `disabled`) for single and group scopes.
- Bot commands: `/bot-ping`, `/bot-help`, `/bot-status`, `/bot-cancel`, `/bot-new`.
- Response timeout that cancels the in-flight turn.
- Global concurrency cap (`maxConcurrent`).
- Streaming reply ack + final answer.
- Secret resolution via `ctx.credentials`.
- Packaging: `prepare` script added so git installs build from source; `package-lock.json` re-synced with `package.json` (was missing four transitive deps, breaking `npm ci`).
- Docs: install section documents the pnpm ≥10 `allowBuilds` authorization for git installs and the prebuilt-tarball alternative.
