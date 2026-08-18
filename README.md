# dsh-wecom

> WeCom AI Bot channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — every single/group chat is a real agent with tools, streaming replies, thinking cards, and a live status panel.

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
- 🩺 **Observability** — a host-wide `wecomChannelStatus` service, a JSON route `GET /api/wecom/status`, a sidebar action with a live connection dot, and a floating status panel.
- 💬 **Bot commands** — `/ping /help /status /stop /compact /new`.

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
dsh plugin --profile web add dsh-wecom@0.1.17   # pin a version
```

Upgrade a pinned install the same way (`dsh-wecom@<newer version>`). After
installing, set `WECOM_BOT_ID` / `WECOM_BOT_SECRET` (see Quick Start) and
restart `dsh web`.

## 📦 Install from source

Git install (pin the commit — build scripts run on your machine):

```sh
dsh plugin --profile web add github:TtTRz/dsh-wecom#<sha>
```

> pnpm ≥10 refuses build scripts of git dependencies (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`): add the package key pnpm prints to that profile's `pnpm-workspace.yaml`, then re-run. Prefer the prebuilt tarball to avoid authorization entirely:

```sh
git clone https://github.com/TtTRz/dsh-wecom && cd dsh-wecom
npm install && npm pack                # produces dsh-wecom-0.1.5.tgz
dsh plugin --profile web add ./dsh-wecom-0.1.5.tgz
```

Local checkout: `dsh plugin --profile web add /absolute/path/to/dsh-wecom` (links the source, no build scripts — run `npm install && npm run build` first).

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
| `turnTimeoutMs` | `300000` | Per-turn timeout (cancels the turn) |

## 💬 Commands

| Command | What it does |
| --- | --- |
| `/ping` | Connectivity check |
| `/help` | List commands |
| `/status` | Session status |
| `/stop` | Cancel the current generation |
| `/compact` | Summarize older history into a summary to save context |
| `/new` | Start a fresh conversation (history kept; next message opens a new session) |

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

- **Status service** — `ctx.get('wecomChannelStatus').snapshot()` returns plain scalars (`connected`, `stopping`, `conversations`, `authenticatedAt`, `lastError`) for dashboards and UI plugins.
- **REST route** — `GET /api/wecom/status` (JSON, registered when a web server is present); `POST /api/wecom/restart` reconnects the channel.
- **Browser UI** — the bundled client half (served as `/plugins/dsh-wecom/client.js`, no frontend rebuild) adds a sidebar action with a live connection dot and a floating status panel that polls every five seconds.

## 🧪 Development

```sh
npm install --legacy-peer-deps
npm run check   # biome + typecheck + test + build
```

## 📄 License

[MIT](LICENSE)
