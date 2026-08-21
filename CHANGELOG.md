# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.27] - 2026-08-21

### Changed

- `replyLimitBytes` schema ceiling raised from 20,480 to 204,800 bytes:
  long reasoning + tool-heavy replies no longer need the `[reply truncated]`
  marker so soon; deployments can raise the limit beyond 20 KB.

## [0.1.26] - 2026-08-21

### Changed

- Turn settling uses a no-progress timeout instead of a fixed total budget:
  the deadline resets on every session event (reasoning deltas, tool calls,
  assistant text), so long thinking passes and slow tool loops stay alive
  while demonstrably moving; only a turn that goes silent for
  `turnTimeoutMs` is cancelled, and that still surfaces as an error so the
  user knows to retry.

### Fixed

- pnpm v11 install on the repo now approves esbuild's build script via
  `pnpm.onlyBuiltDependencies`, unbreaking fresh checkouts.

## [0.1.25] - 2026-08-21

### Added

- Per-session sandbox cwd: every WeCom conversation (each `/reset` epoch is
  its own session id) runs in its own directory under the configured base —
  `WeCom-{userid|chatid}-{MMDD}-{hhmmss}-{id-tail}` — so the harness sandbox
  fence isolates each session's filesystem, and one workspace row appears per
  session with a readable title (`WeCom · {peer} {MM-DD} {HH:mm:ss}`,
  derived from the minted directory name).
- Session titles are topic-only now: the `userid:` / `chatid:` prefix is
  gone; caller identity is carried by the per-session workspace row.

### Changed

- `/new` no longer disposes the previous session's agent: a disposed session
  left the host's live-session projection, blanking its sidebar row until a
  reload. The old conversation stays visible and resumable; teardown happens
  at pool shutdown.
- Uploads land inside the conversation's own sandbox directory.

### Fixed

- Restart re-grouping no longer mints empty workspace rows for legacy
  sessions: rows are created only when the session's stored cwd matches its
  per-session directory (anchored on the id tail).

## [0.1.24] - 2026-08-17

### Added

- Optional `provider` / `model` config pins one model route for every WeCom
  conversation (both fields must be set together; a half-set pair fails
  loudly at plugin startup).
- Resumed WeCom conversations now inherit the model logged in their session
  header when no explicit route is configured — a model switched in the web
  UI stays in effect across restarts instead of reverting to the harness
  default. The pool installs a per-agent model selection (the harness's own
  mechanism), so a later web-UI switch still overrides everything.

## [0.1.23] - 2026-08-17

### Changed

- The sidebar status button now reads `Active: N Total: M` — running WeCom
  conversations and total WeCom sessions. Non-WeCom sessions no longer
  appear anywhere in the status UI: the floating panel's Sessions row shows
  only the WeCom count, and the live-agent list stays WeCom-only.

## [0.1.22] - 2026-08-17

### Changed

- The `[userid]：` sender label is now prepended to message content only in
  group chats. Single chats have exactly one sender, so the label is dropped
  and the bubble shows the message text alone.

## [0.1.21] - 2026-08-17

### Changed

- The per-conversation display peer (userid / chatid) is now persisted in
  `.dsh-wecom-state.json` next to the reset epochs, so the status panel shows
  the right peer immediately after a restart instead of falling back to
  `WeCom · single/group` until the next message. Legacy flat epoch state
  files migrate transparently on load.

## [0.1.20] - 2026-08-17

### Changed

- The status panel now lists WeCom conversations only (web sessions are
  filtered out), and each row's label is the conversation's chatid (groups)
  or userid (single chats) resolved host-side, instead of the generic
  `WeCom · single` / `WeCom · group` scope text. The peer is known once a
  message touched the conversation in this process; until then the row falls
  back to the scope label.

## [0.1.19] - 2026-08-17

### Fixed

- The status panel (`/api/wecom/status` and the sidebar popover) showed the
  same stale model for every live agent: it read the creation-time
  `agent.options` snapshot. It now reads each session's folded request header
  — the model the conversation actually runs on — and falls back to the
  creation options before the first request is logged. Per-session model
  switches in the web UI now show up correctly.

## [0.1.18] - 2026-08-17

### Changed

- WeCom session titles are now locked: the plugin watches every `session/title`
  event host-wide (so it covers sessions resumed outside the pool, e.g. the
  web UI or the rename API) and reverts manual renames back to the canonical
  title — the prefixed harness-generated LLM title, or a legacy session's
  existing title. Renames that already match the canonical title pass
  through. The enforcement is best-effort and never fails a turn.

## [0.1.17] - 2026-08-17

### Changed

- The sender metadata line is now a compact `[userid]：text` prefix instead of
  the long `[WeCom group message from WeCom user …]` bracket. The full-width
  colon is deliberate: an ASCII colon after a bracket would parse as a
  Markdown link reference and disappear from rendered chat bubbles.

### Fixed

- Text messages no longer carry a spurious `[Unsupported WeCom message type]`
  note — the sender-label rewrite broke the emptiness check that guarded it.

### Docs

- READMEs now document installing from npm (`dsh plugin --profile web add
  dsh-wecom`), including version pinning and upgrades.

## [0.1.15] - 2026-08-17

### Changed

- Group conversations now use the group `chatid` (falling back to the sender
  userid) as the session-title prefix, while single chats keep the sender
  userid — so the sidebar prefix always matches the conversation identity.
- Message content no longer masks the sender userid: each message carries the
  full WeCom userid in its leading metadata line, so chat bubbles distinguish
  senders (the masked 8-character prefix is gone).

## [0.1.14] - 2026-08-17

### Changed

- Session titles: the plugin no longer renames a conversation to its first
  message text. WeCom sessions now keep the harness-generated short LLM title,
  prefixed with the first sender's WeCom userid (`userid：标题`), so the
  sidebar shows who each conversation belongs to. The prefix is applied only
  to harness-generated (provider) titles: manual renames in the web UI are
  left untouched, and the deterministic fallback is not pinned, so pending
  LLM title generation is never superseded. Title rewrites are best-effort
  and never fail the turn.

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
