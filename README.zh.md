# dsh-wecom

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的企业微信 AI 机器人 channel——每条单聊/群聊背后都是一个真正带工具的 agent，流式回复、思考卡片、实时状态面板。

[![npm version](https://img.shields.io/npm/v/dsh-wecom)](https://www.npmjs.com/package/dsh-wecom)
[![license](https://img.shields.io/npm/l/dsh-wecom)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-wecom)](https://nodejs.org)

通过官方长连接把企业微信「智能机器人」接入 dsh。每个会话对应一个**持久化的 Harness agent（带工具）**，而不是裸聊天循环。

## ✨ 特性

- 🤖 **一会话一 agent**——在隔离 setup 里挂载 preset（默认 `standard`），天然拥有 preset 的工具（`bash`、`read`、`edit`、skills…）与人设；会话 id 由 `sha256(namespace · scope · peer)` 确定性派生（不落原始 userid），经 `sessionPersistence` 跨重启存活
- 🖼️ **多媒体**——图片下载后用官方 SDK 解密、模型可看时自动附带；文件/视频落入 agent 工作区供工具读取
- ⚡ **流式回复**——token 级文本流、原生 `<think>` 思考卡片、卡片内的紧凑工具调用列表
- 🛡️ **访问策略**——单聊/群聊各自 `open` / `allowlist` / `disabled`（群按 `chatid` 控制）
- 🧹 **消息治理**——msgid 去重、按会话排队、全局并发上限、单轮超时主动 cancel 不留僵尸轮次
- 📡 **自愈**——长连接断开（被踢/鉴权失败/被新客户端顶掉）后按 `restartIntervalMs`（默认 10s）自动重连
- 🩺 **可观测**——主机级 `wecomChannelStatus` 服务、`GET /api/wecom/status` JSON 路由、侧栏入口 + 连接状态圆点 + 浮动状态面板
- 💬 **机器人命令**——`/ping /help /status /stop /compact /new`

## 🚀 快速开始

```sh
dsh plugin --profile web add dsh-wecom

export WECOM_BOT_ID='你的机器人id'
export WECOM_BOT_SECRET='你的secret'   # 仅开发环境；生产用 credential 服务

dsh web
```

日志出现 `WeCom AI Bot authenticated` 后，发 `/ping` 应收到 `pong`。

持久化：`WECOM_BOT_ID` 写入 `~/.dsh/.env`，`WECOM_BOT_SECRET` 写入 `~/.dsh/.credentials.yaml`（引用 `WECOM_BOT_SECRET`）；`DSH_WECOM_CWD` 覆盖 agent 工作目录。

## 📦 从 npm 安装

发布包自带预构建的 `dist/`，安装时不会执行构建脚本：

```sh
dsh plugin --profile web add dsh-wecom          # 最新版
dsh plugin --profile web add dsh-wecom@0.1.17   # 锁定版本
```

升级同理：`dsh plugin --profile web add dsh-wecom@<新版本>`。装好后配置
`WECOM_BOT_ID` / `WECOM_BOT_SECRET`（见快速开始）并重启 `dsh web`。

## 📦 从源码安装

Git 安装（请锁定 commit——构建脚本会在你机器上执行）：

```sh
dsh plugin --profile web add github:TtTRz/dsh-wecom#<sha>
```

> pnpm ≥10 默认拒绝 git 依赖的构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）：把 pnpm 提示的包名加进该 profile 的 `pnpm-workspace.yaml` 后重试。想完全避开授权，用预构建 tarball：

```sh
git clone https://github.com/TtTRz/dsh-wecom && cd dsh-wecom
npm install && npm pack                # 产出 dsh-wecom-0.1.5.tgz
dsh plugin --profile web add ./dsh-wecom-0.1.5.tgz
```

本地目录：`dsh plugin --profile web add /绝对路径/dsh-wecom`（链接源码、不跑构建脚本——先 `npm install && npm run build` 产出 `dist/`）。

## ⚙️ 配置

调整 `~/.dsh/profiles/web/cordis.patch.yml` 中挂载的行：

```yaml
- id: wecom-channel
  name: dsh-wecom
  config:
    botId: !!js process.env.WECOM_BOT_ID
    credentialName: WECOM_BOT_SECRET
    namespace: default
    # cwd 可选：默认 ~/.wecom-sessions（可用环境变量 DSH_WECOM_CWD 覆盖）
    cwd: /data/wecom
    preset: standard
    dmPolicy: open
    dmAllowlist: []
    groupPolicy: allowlist
    groupAllowlist: [wr_你的群chatid]
    greeting: 你好，我是助手。
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `cwd` | `~/.wecom-sessions` | agent 工作目录：WeCom 会话、上传文件（`.wecom-uploads/`）与 `.dsh-wecom-state.json` 都落在这里，侧边栏 "WeCom" 工作区也认领在该目录上；可用 `DSH_WECOM_CWD` 覆盖，必须为绝对路径 |
| `preset` | `standard` | 挂进每个会话 agent 的 preset |
| `provider` / `model` | 不设置 | 所有 wecom 会话的固定模型路由，两者必须成对配置；不设置时新会话用 harness 默认选择，恢复的会话继承其最后一次记录的模型 |
| `dmPolicy` / `groupPolicy` | `open` | `open` / `allowlist` / `disabled` |
| `dmAllowlist` | `[]` | 单聊 userid 白名单 |
| `groupAllowlist` | `[]` | 群聊 chatid 白名单 |
| `instructions` | 企业会话指引 | 每轮叠加在人设上的指令段 |
| `imageMode` | `auto` | `auto` 模型可看图时附带；`always` / `never` 强制 |
| `streaming` | `true` | token 级流式；`false` 只回执 + 最终答案 |
| `streamFlushMs` | `250` | 流式文本冲刷节奏（ms） |
| `showReasoning` | `true` | 推理包进企微原生 `<think>` 卡片 |
| `showToolCalls` | `true` | 在 `<think>` 卡片内渲染紧凑的工具调用列表 |
| `maxConcurrent` | `4` | 全局并发轮次上限 |
| `turnTimeoutMs` | `300000` | 单轮超时（超时取消本轮） |

## 💬 命令

| 命令 | 作用 |
| --- | --- |
| `/ping` | 连通性检查 |
| `/help` | 列出命令 |
| `/status` | 会话状态 |
| `/stop` | 取消当前生成 |
| `/compact` | 把较早历史压缩成摘要省上下文 |
| `/new` | 开启新会话（历史保留，下一条消息开新 session） |

## 🏗️ 工作原理

```
企业微信 AI 机器人
   │  WebSocket 长连接（wss://openws.work.weixin.qq.com）
   ▼
dsh-wecom（host 插件）
   │  msgid 去重 → 访问策略 → 按会话排队 → 全局并发上限
   │  创建/恢复 agent（setup 挂载 preset + 常驻指令段）
   │  agent.followup(userMessage) → await agent.whenIdle()
   │  超时 → agent.cancel()，不留僵尸轮次
   ▼
持久化的按会话 Harness agent（sessionPersistence）
```

为什么不是裸 `agents.create`：preset 在 `setup` 挂载（裸 agent 没有工具）、指令经 `systemPrompt.section()` 每轮常驻、超时取消保证下一条消息不被卡住、群聊按 `chatid` 白名单控制、全局 `maxConcurrent` 兜底。

## 🧩 集成

- **状态服务**——`ctx.get('wecomChannelStatus').snapshot()` 只返回标量（`connected`、`stopping`、`conversations`、`authenticatedAt`、`lastError`），供面板/UI 插件使用
- **REST 路由**——`GET /api/wecom/status`（有 web server 时注册，JSON）；`POST /api/wecom/restart` 重连渠道
- **浏览器 UI**——自带 client 半身（`/plugins/dsh-wecom/client.js` 提供，无需前端重建）：侧栏入口 + 连接状态圆点 + 每 5 秒轮询的浮动状态面板

## 🧪 开发

```sh
npm install --legacy-peer-deps
npm run check   # biome + typecheck + test + build
```

## 📄 License

[MIT](LICENSE)
