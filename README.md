# dsh-wecom

[English](README.md) | [简体中文](README.zh.md)

> WeCom AI Bot channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — persistent agents, streaming replies, thinking cards, and session navigation for single and group chats.

[![npm version](https://img.shields.io/npm/v/dsh-wecom)](https://www.npmjs.com/package/dsh-wecom)
[![license](https://img.shields.io/npm/l/dsh-wecom)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-wecom)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/dm/dsh-wecom)](https://www.npmjs.com/package/dsh-wecom)

Wire a WeCom AI Bot to DeepSeek Harness over the official long connection. Each conversation is backed by a **persistent Harness agent with tools** — not a bare chat loop.

## ✨ Features

- 🤖 **One conversation = one agent** — mounts a preset (default `standard`) in its scoped setup, so it has the preset's tools (`bash`, `read`, `edit`, skills, …) and persona. Session ids are derived deterministically (`sha256(namespace · scope · peer)`, no raw userid) and survive restarts via `sessionPersistence`.
- 🖼️ **Media support** — images are downloaded, decrypted with the official SDK, and attached when the model can view them; files and videos land in the agent's workspace for its tools.
- ⚡ **Streaming replies** — token-level text streaming, native `<think>` reasoning card ("思考过程"), and a compact tool-call activity list inside the card.
- 🛡️ **Access policy** — `open` / `allowlist` / `disabled` per channel (dm and group, gated by `chatid` for groups).
- 🧹 **Housekeeping** — msgid dedup, per-conversation queues, a global concurrency cap, and per-turn timeouts that cancel the turn instead of leaving zombies.
- 📡 **Self-healing** — when the long connection dies (kicked, auth failure, replaced client), the channel restarts itself after `restartIntervalMs` (default 10s).
- 🩺 **Observability** — per-bot status and reconnect services for integration with a separate dashboard.
- 💬 **Bot commands** — `/ping /help /status /stop /compact /new /session /current /resume`.

## 🚀 Quick Start

```sh
dsh plugin --profile web add dsh-wecom

export WECOM_BOT_ID='your-bot-id'
export WECOM_BOT_SECRET='your-bot-secret'   # dev only — in production use the credential service

dsh web
```

Once the log prints `WeCom AI Bot authenticated`, send `/ping` and expect `pong`.

To persist across restarts: write `WECOM_BOT_ID` into `~/.dsh/.env` and `WECOM_BOT_SECRET` into `~/.dsh/.credentials.yaml` (reference `WECOM_BOT_SECRET`). `DSH_WECOM_CWD` overrides the agent working directory.

## 📦 Install from npm

The published package ships prebuilt `dist/` — no build scripts run on install:

```sh
dsh plugin --profile web add dsh-wecom          # latest
dsh plugin --profile web add dsh-wecom@0.5.2    # pin a version
```

Upgrade a pinned install the same way (`dsh-wecom@<newer version>`). After
installing, set `WECOM_BOT_ID` / `WECOM_BOT_SECRET` (see Quick Start) and
restart `dsh web`.

Node.js `22.19` or newer is required. See the [changelog](CHANGELOG.md) for
release details.

### Upgrading from 0.3.x

Version 0.5.2 includes session history navigation and the streaming and card
delivery fixes from 0.5.0–0.5.1. The channel now publishes status and reconnect
services; it no longer mounts a browser panel, bot manager, or `/api/wecom/*`
routes. Use a separate dashboard integration if you need those interfaces.
Keep each bot's `namespace` and working directory unchanged to retain its
conversation routing and persisted history.

## 📦 Install from source

Git install (pin the commit — build scripts run on your machine):

```sh
dsh plugin --profile web add github:TtTRz/dsh-wecom#<sha>
```

> If pnpm blocks a Git dependency with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, review the pinned commit and copy the exact `allowBuilds` entry it prints into that profile's `pnpm-workspace.yaml`. The key may include the Git URL and commit; the package name alone is not sufficient. Re-run the install, or use a locally built tarball:

```sh
git clone https://github.com/TtTRz/dsh-wecom && cd dsh-wecom
npm install --legacy-peer-deps
npm pack                              # produces dsh-wecom-0.5.2.tgz
dsh plugin --profile web add ./dsh-wecom-0.5.2.tgz
```

Local checkout: `dsh plugin --profile web add /absolute/path/to/dsh-wecom` (links the source; run `npm install --legacy-peer-deps && npm run build` first).

## ⚙️ Configuration

Tune the mounted row in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: wecom-channel
  name: dsh-wecom
  config:
    botId: !!js process.env.WECOM_BOT_ID
    credentialName: WECOM_BOT_SECRET
    namespace: default
    # cwd is optional: defaults to ~/.wecom-sessions (DSH_WECOM_CWD overrides)
    cwd: /data/wecom
    preset: standard
    dmPolicy: open
    dmAllowlist: []
    groupPolicy: allowlist
    groupAllowlist: [wr_your_group_chatid]
    greeting: Hello, I am an assistant.
```

### Multiple bots (one row per bot)

One composition row = one WeCom bot. Mount the same plugin again with a distinct
`namespace` to run a second bot — its own botId/credential, access policy, preset,
and model route — in the same process:

```yaml
- insert:
    - id: wecom-channel-lab
      name: dsh-wecom
      config:
        botId: !!js process.env.WECOM_BOT_ID_2
        credentialName: WECOM_BOT_SECRET_2
        namespace: lab
        preset: standard
```

Each non-default bot publishes `wecomChannelStatus.<namespace>` and stores
its routing state in `.dsh-wecom-state.<namespace>.json`. The default bot uses
`wecomChannelStatus` and `.dsh-wecom-state.json`. A dashboard can consume these
services without designating one bot as the primary UI host.

### Configuration reference

| Field | Default | Meaning |
| --- | --- | --- |
| `cwd` | `~/.wecom-sessions` | Agent working directory: WeCom sessions, uploads (`.wecom-uploads/`), and `.dsh-wecom-state.json` live here; the sidebar workspace "WeCom" is claimed on it. `DSH_WECOM_CWD` overrides it. Must be absolute |
| `preset` | `standard` | Preset mounted into each conversation agent |
| `provider` / `model` | unset | Fixed model route for every WeCom conversation; both must be set together. When unset, new conversations use the harness default selection and resumed conversations inherit their last logged model |
| `dmPolicy` / `groupPolicy` | `open` | `open` / `allowlist` / `disabled` |
| `dmAllowlist` | `[]` | Single-chat userid allowlist |
| `groupAllowlist` | `[]` | Group-chat chatid allowlist |
| `instructions` | enterprise-chat guidance | Instruction section layered on the persona every turn |
| `imageMode` | `auto` | `auto` attaches images when the model can view them; `always` / `never` force it |
| `streaming` | `true` | Stream model text token-by-token; `false` sends only the ack + final answer |
| `streamFlushMs` | `250` | Cadence (ms) for flushing accumulated streamed text |
| `showReasoning` | `true` | Wrap model reasoning in WeCom's native `<think>` card |
| `showToolCalls` | `true` | Render a compact tool-call activity list inside the `<think>` card |
| `maxConcurrent` | `4` | Global cap on concurrent turns |
| `turnTimeoutMs` | `300000` | No-progress timeout; session events and stream frames reset the deadline |
| `approvalMode` | `chat` | In-chat sandbox-escalation approvals: `chat` answers from the chat (reply 批准/拒绝), `notify` only pushes the ask, `off` is fully silent (web UI decides) |
| `approvalTimeoutMs` | `300000` | How long an in-chat approval waits before failing closed (`cancelled`) |
| `approvalAllowlist` | `[]` | Userids allowed to answer in-chat approvals; empty admits every admitted sender |
| `approvalHint` | `回复「批准」继续，回复「拒绝」取消。` | Reply-word hint appended to the pushed approval request |

## 💬 Commands

| Command | What it does |
| --- | --- |
| `/ping` | Connectivity check |
| `/help` | List commands |
| `/status` | Session status |
| `/stop` | Cancel the current generation |
| `/compact` | Summarize older history into a summary to save context |
| `/new` | Start a fresh conversation (history kept; next message opens a new session) |
| `/session` | List this chat's sessions newest-first (epoch, start time, turns, title; current marked `*`). Alias `/sessions` |
| `/current` | Show the session new messages route to |
| `/resume <n>` | Switch back to a past session by epoch number (see `/session`; persisted across restarts) |

## 🏗️ How it works

```
WeCom AI Bot
   │  WebSocket long connection (wss://openws.work.weixin.qq.com)
   ▼
dsh-wecom (host plugin)
   │  msgid dedup → access policy → per-conversation queue → global concurrency cap
   │  create/resume agent (setup mounts the preset + a persistent instruction section)
   │  agent.followup(userMessage) → await agent.whenIdle()
   │  on timeout → agent.cancel(), no zombie turn left behind
   ▼
persistent per-conversation Harness agent (sessionPersistence)
```

Why not a bare `agents.create`: the preset is mounted in `setup` (a bare agent has no tools), instructions ride `systemPrompt.section()` every turn, timeouts cancel so the next message is never stuck, and groups are gated by `chatid` allowlist with a global `maxConcurrent` bound.

## 🧩 Integrations

- **Status service** — `ctx.get('wecomChannelStatus').snapshot()` returns plain scalars (`connected`, `stopping`, `conversations`, `authenticatedAt`, `lastError`) for dashboards and UI plugins. Use `channelStatusServiceName(namespace)` for other bots.
- **Reconnect service** — call `reconnect()` on the same service to replace the connection and wake its reconnect loop.
- **Dashboard integration** — the channel registers no HTTP routes or browser slots. A separate UI plugin can consume the services and own its routes, authentication, and display.

## 🧪 Development

```sh
npm install --legacy-peer-deps
npm run check   # biome + typecheck + test + build
```

## 📄 License

[MIT](LICENSE)
