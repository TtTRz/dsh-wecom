# dsh-wecom

Wire a WeCom AI Bot to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Each single/group chat is backed by a **real Harness agent with tools** — not a bare chat loop.

## What it solves

WeCom's AI Bot long connection only carries messages; deciding who answers them is left open. This plugin fills the gap:

- One conversation = one agent, and the agent **mounts a preset in its scoped setup** (default `standard`). It therefore has the preset's tools (`bash`, `read`, `edit`, skills, …) and persona.
- The session id is derived deterministically from `sha256(namespace · scope · peer)` — it never embeds the raw userid — and survives restarts through `sessionPersistence`.
- Media arrives too: images are downloaded, decrypted with the official SDK, and attached when the model can view them; files and videos land in the agent's workspace so its tools can read them.

## The loop

```
WeCom AI Bot
   │  WebSocket long connection (wss://openws.work.weixin.qq.com)
   │  auth body is exactly { bot_id, secret } — nothing else, per the official doc
   ▼
dsh-wecom (host plugin)
   │  msgid dedup → access policy → per-conversation queue → global concurrency cap
   │  create/resume agent (setup mounts the preset + a persistent instruction section)
   │  agent.followup(userMessage) → await agent.whenIdle()
   │  on timeout → agent.cancel(), no zombie turn left behind
   ▼
persistent per-conversation Harness agent (sessionPersistence)
```

## Why not a bare `agents.create`

| Decision | Why |
| --- | --- |
| Preset mounted in `setup` | A bare agent has no tools; mounting `preset` is what makes it capable |
| `systemPrompt.section()` | A persistent instruction rendered every turn, not a one-shot `inject` |
| Timeout cancels | A slow turn is cancelled, so the next message is not stuck behind it |
| Group allowlist by `chatid` | You gate which groups the bot answers in, not which senders |
| `maxConcurrent` | Bounds how many turns run at once across all conversations |

## Install

```sh
dsh plugin --profile web add github:TtTRz/dsh-wecom
```

> pnpm ≥10 refuses to run build scripts of git-hosted dependencies, so the first `add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Add the exact package key pnpm prints to that profile's `pnpm-workspace.yaml` (usually `dsh-wecom`), then re-run `add`. This authorization lets package code run on your machine outside any sandbox — pin the commit: `github:TtTRz/dsh-wecom#<sha>`.
>
> To avoid authorization entirely, install from a prebuilt tarball instead:
>
> ```sh
> git clone https://github.com/TtTRz/dsh-wecom && cd dsh-wecom
> npm install && npm pack    # produces dsh-wecom-0.1.0.tgz
> dsh plugin --profile web add ./dsh-wecom-0.1.0.tgz
> ```

Local checkout:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-wecom
```

A local path install links the source directly and runs no build scripts; run `npm install && npm run build` first to produce `dist/`.

## Configure

The Secret lives in the Harness credential service (reference `WECOM_BOT_SECRET`); the Bot ID comes from `WECOM_BOT_ID`. Commit neither.

```sh
export WECOM_BOT_ID='your-bot-id'
# put the Secret into credential reference WECOM_BOT_SECRET (env works for development too)
```

To make it stick across restarts, write `WECOM_BOT_ID` into `~/.dsh/.env` (the user `.env` layer the harness loads at boot) and `WECOM_BOT_SECRET` into `~/.dsh/.credentials.yaml`. `DSH_WECOM_CWD` overrides the agent working directory.

Every WeCom conversation is grouped under a workspace created on `cwd` (title
`workspaceTitle`, default `WeCom`), so chats stay out of the sidebar's
"Ungrouped" bucket. Point `DSH_WECOM_CWD` at a dedicated directory to keep
them separate from your own sessions. When the long connection dies (kicked,
auth failure, or replaced by another client), the channel restarts itself
after `restartIntervalMs` (default 10s) — no dead bot, no manual restarts.

Tune the mounted row in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: wecom-channel
  name: dsh-wecom
  config:
    botId: !!js process.env.WECOM_BOT_ID
    credentialName: WECOM_BOT_SECRET
    namespace: default
    cwd: !!js process.env.DSH_WECOM_CWD ?? process.cwd()
    preset: standard
    dmPolicy: open
    dmAllowlist: []
    groupPolicy: allowlist
    groupAllowlist: [wr_your_group_chatid]
    greeting: Hello, I am an assistant.
```

| field | default | meaning |
| --- | --- | --- |
| `preset` | `standard` | preset mounted into each conversation agent |
| `dmPolicy` / `groupPolicy` | `open` | `open` / `allowlist` / `disabled` |
| `dmAllowlist` | `[]` | single-chat userid allowlist |
| `groupAllowlist` | `[]` | group-chat chatid allowlist |
| `instructions` | enterprise-chat guidance | instruction section layered on the persona every turn |
| `imageMode` | `auto` | `auto` attaches images when the model can view them; `always` / `never` force it |
| `streaming` | `true` | stream model text token-by-token; `false` sends only the ack + final answer |
| `streamFlushMs` | `250` | cadence (ms) for flushing accumulated streamed text |
| `showReasoning` | `true` | wrap model reasoning in WeCom's native `<think>` card (the collapsible "思考过程") |
| `showToolCalls` | `true` | append a tool-call activity summary to the final reply |
| `maxConcurrent` | `4` | global cap on concurrent turns |
| `turnTimeoutMs` | `300000` | per-turn timeout (cancels the turn) |

## Commands

| command | what it does |
| --- | --- |
| `/bot-ping` | connectivity check |
| `/bot-help` | list commands |
| `/bot-status` | session status |
| `/bot-cancel` | cancel the current generation |
| `/bot-new` | start a fresh conversation (history is kept, the next message opens a new session) |

## Verify

Once the log prints `WeCom AI Bot authenticated`, try `/bot-ping` and expect a `pong` back.

## Status service

While running, the plugin publishes a host-wide `wecomChannelStatus` service so
dashboards and UI plugins can render live health without touching channel
internals:

```ts
const status = ctx.get('wecomChannelStatus') // { snapshot(): ChannelStatus }
const health = status.snapshot()
// { connected: boolean, stopping: boolean, conversations: number,
//   authenticatedAt: number | null, lastError: string | null }
```

`snapshot()` returns plain scalars only — safe to serialize into RPC or JSON.

## Browser UI

The package ships a browser client half (declared via `dsh.client` and served
by the web profile as `/plugins/dsh-wecom/client.js` — no frontend rebuild
needed). It adds:

- a **WeCom action in the sidebar foot** with a live connection dot, and
- a **floating status panel** (connection, conversation count, authentication
  age, last error) that opens from the action and polls every five seconds.

Both consume `GET /api/wecom/status`, the JSON route the host half registers
when a web server is present. The client half is built to CommonJS and wrapped
by `scripts/wrap-client.mjs` into the factory form the web module loader runs.

## Development

```sh
npm install --legacy-peer-deps
npm run check   # biome + typecheck + test + build
```

## License

MIT
