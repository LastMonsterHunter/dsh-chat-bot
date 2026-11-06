# dsh-qq · 机器人 QQ 账号的 OneBot 11 桥

把旧机器人的 QQ 账号接进 DSH。不碰 AstrBot，也不需要重启 QQ。

## 前提

NapCat 里要有一个 OneBot 11 的 **WebSocket 服务端**。本机已经加好了：

```json
{
  "name": "dsh-self",
  "enable": true,
  "host": "127.0.0.1",
  "port": 3010,
  "messagePostFormat": "array",
  "token": "<见 ~/.dsh/secrets/qq-bridge.json>",
  "heartInterval": 30000
}
```

连接信息在 `~/.dsh/secrets/qq-bridge.json`（600）：

```json
{ "wsUrl": "ws://127.0.0.1:3010", "token": "…", "selfUid": "100000001", "ownerUid": "100000002" }
```

（上面的账号只是示例，换成自己的。）

## 工具

| 工具 | 用途 |
| --- | --- |
| `qq_status` | 连接状态、机器人账号、心跳、缓冲条数、自动回复开关 |
| `qq_recent` | 本地缓冲里的最近入站消息（只读） |
| `qq_send` | 发文字：默认只发给缔造者；群发要先授权 |
| `qq_selftest` | 诊断：在独立会话里跑一轮「消息 → 回复」，不发到 QQ |
| `qq_autoreply` | 看/开关自动回复；AstrBot 还在 6199 时拒绝打开（除非 force） |

## 自动回复（默认关）

打开后：入站消息 → 按会话映射到独立 DSH 会话（标题 `QQ 私聊 · 昵称` / `QQ 群 · 群号`，标题会让 dsh-self 戴上 QQ 面具）→ `sessionController.prompt` 起一轮 → 捕获 `turn/end` 后的回复 → `send_private_msg` / `send_group_msg` 发回。

配置：

```yaml
autoReply: true            # 总开关
autoReplyStrangers: false  # 只回缔造者私聊
autoReplyGroups: []        # 允许自动回复的群号，空 = 不接群
replyTimeoutMs: 180000
```

当前机器人号在 2 个群里：`752650746`（2 人）、`589832364`（19 人）。要接群，先把群号写进 `autoReplyGroups`，并且确认旧 AstrBot 已停——否则会双回复。

链路已用 `qq_selftest` 自检通过（约 1.5s），但没有在真实 QQ 消息上开过。

## 边界

- 只发文字，不发图、不发文件、不改资料、不踢人。
- 私聊默认只允许发给缔造者；群聊必须写进 `allowGroups`。
- 入站消息只在本地缓冲（`~/.dsh/qq-buffer.json`，600），不上传。
- **不做自动回复**：收消息和回消息都通过工具显式调用，避免在没人看着的时候替自己在群里说话。
- 旧 AstrBot 仍在跑；在它停掉之前，同一条消息可能被两边都看到。停 AstrBot 是另一件要当面确认的事。

## 装

```bash
dsh plugin --profile desktop add link:/path/to/dsh-chat-bot/plugins/dsh-qq
```

或者用插件管理器 install_bundle，再把它加进 `dsh.profile.bundles`。
