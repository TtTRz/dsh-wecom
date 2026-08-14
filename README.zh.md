# dsh-wecom

把企业微信「智能机器人」接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：每一条单聊 / 群聊会话，背后都是一个**真正带工具的 Harness agent**。

## 它解决什么

企微智能机器人官方只提供长连接通道，至于「收到消息之后交给谁回答」是空的。这个插件补上后半段：

- 一个会话 = 一个 agent，且 agent **在自己的作用域里挂载了 preset**（默认 `standard`）。这意味着它拥有 preset 的 bash / read / edit / skills 等工具和人设，而不是一个只会聊天的空壳。
- 会话 id 由 `sha256(namespace · scope · peer)` 确定性生成，不落真实 userid，跨进程重启通过 `sessionPersistence` 续跑。
- 图片 / 文件也能收：图片用官方 SDK 下载解密后挂成附件（模型不支持看图时自动降级为文字说明）；文件 / 视频落进 agent 工作目录，让 agent 用自己的工具去读。

## 连接流程

```
企微智能机器人
   │  WebSocket 长连接（wss://openws.work.weixin.qq.com）
   │  认证帧 body 只含 { bot_id, secret }（按官方文档，无多余字段）
   ▼
dsh-wecom 插件（host 常驻）
   │  msgid 去重 → 访问策略 → 每会话串行队列 → 全局并发上限
   │  create/resume agent（setup 里挂 preset + 注入持久指令段）
   │  agent.followup(userMessage) → await agent.whenIdle()
   │  超时则 agent.cancel()，不留僵尸 turn
   ▼
按会话持久化的 Harness agent（sessionPersistence）
```

## 相比「裸 create」的关键差异

| 点 | 说明 |
| --- | --- |
| 挂 preset | `setup` 里 `presets.mount(agentCtx, presetId)`，agent 才有工具和人设 |
| 持久指令 | `systemPrompt.section()` 每轮叠加，不是一次性 `inject` |
| 超时即取消 | `turnTimeoutMs` 到了会 `agent.cancel()`，而不是只回错误、turn 还在后台跑 |
| 群聊白名单 | 按群 `chatid` 限定（`groupAllowlist`），不是按发消息的人 |
| 全局背压 | `maxConcurrent` 限制同时跑几个 turn |

## 安装

```sh
dsh plugin --profile web add github:TtTRz/dsh-wecom
```

本地路径：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-wecom
```

## 配置

Secret 走 Harness 密钥服务（引用 `WECOM_BOT_SECRET`），Bot ID 走启动环境 `WECOM_BOT_ID`。两者都别提交进仓库。

```sh
export WECOM_BOT_ID='你的 BotID'
# Secret 用 Harness 的凭证设置面板存到引用 WECOM_BOT_SECRET（也可开发期 export）
```

持久化时，把 `WECOM_BOT_ID` 写进 `~/.dsh/.env`（harness 启动时读取 user 层 `.env`），`WECOM_BOT_SECRET` 写进 `~/.dsh/.credentials.yaml`。`DSH_WECOM_CWD` 可覆盖 agent 工作目录。

在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖插件行：

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
    groupAllowlist: [wr_你要的群chatid]
    greeting: 您好，我是助手。
```

字段：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `preset` | `standard` | 挂到每个会话 agent 的具名 preset |
| `dmPolicy` / `groupPolicy` | `open` | `open` / `allowlist` / `disabled` |
| `dmAllowlist` | `[]` | 单聊 userid 白名单 |
| `groupAllowlist` | `[]` | 群聊 chatid 白名单 |
| `instructions` | 企业聊天引导语 | 每轮叠加在人设上的指令段 |
| `imageMode` | `auto` | 模型支持看图就挂附件；`always` / `never` 强制开关 |
| `maxConcurrent` | `4` | 全局并发 turn 上限 |
| `turnTimeoutMs` | `300000` | 单轮超时（超时会取消该 turn） |

## 命令

| 命令 | 作用 |
| --- | --- |
| `/bot-ping` | 连通性自检 |
| `/bot-help` | 列出命令 |
| `/bot-status` | 会话状态 |
| `/bot-cancel` | 取消当前生成 |
| `/bot-new` | 开新会话（旧会话历史保留，新消息走新 session） |

## 验证

日志出现 `WeCom AI Bot authenticated` 后，给机器人发 `/bot-ping`，应回 `pong`。

## 状态服务

运行期间，插件会向主机发布 `wecomChannelStatus` 服务，供面板与 UI 插件渲染实时
健康状态，而无需触碰通道内部实现：

```ts
const status = ctx.get('wecomChannelStatus') // { snapshot(): ChannelStatus }
const health = status.snapshot()
// { connected: boolean, stopping: boolean, conversations: number,
//   authenticatedAt: number | null, lastError: string | null }
```

`snapshot()` 只返回纯标量字段，可以安全地放进 RPC 或 JSON。

## 浏览器界面

本包自带浏览器客户端半端（通过 `dsh.client` 声明，由 web profile 以
`/plugins/dsh-wecom/client.js` 下发，无需重建前端）。它提供：

- **侧边栏底部的 WeCom 动作按钮**，带实时连接状态点；
- 点击打开的**悬浮状态面板**（连接状态、会话数、认证时长、最近错误），
  每五秒轮询一次。

两者都消费主机半端注册的 `GET /api/wecom/status` JSON 路由（存在 web server
时才注册）。客户端半端构建为 CommonJS 后，由 `scripts/wrap-client.mjs` 包装成
web 模块加载器执行的 factory 形式。

## 开发

```sh
npm install --legacy-peer-deps
npm run check   # biome + typecheck + test + build
```

## 许可证

MIT
