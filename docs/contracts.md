# 跨部分契约

这五部分（`bot` + 四个插件）共享进程、凭据和几个本地 HTTP 路由。改下面任何一条都属于
breaking change：要同时 bump 调用方和被调方，并在 `docs/compatibility.md` 记一笔。

## 本地 HTTP 路由

| 路由 | 提供方 | 使用方 | 用途 |
|---|---|---|---|
| `POST /dsh-qq/reply` | `dsh-qq` | `dsh-bili-dm`、`bot` 侧旧桥 | 把一条消息投进 QQ 会话（`platform` 区分来源） |
| `GET /dsh-qq/state` | `dsh-qq` | `dsh-self` 体检 | 桥的连接状态、最近心跳 |
| `GET /dsh-bili-dm/state` | `dsh-bili-dm` | `dsh-self` 体检 | 轮询状态、最近错误 |
| `GET /dsh-self/render` | `dsh-self` | `dsh-bili-dm` | 渲染当前人格段（B 站回复用） |
| `GET /dsh-self/state` | `dsh-self` | 人工/脚本 | 人格版本与记忆计数 |

端口不固定：由 DSH 的 webServer 分配，调用方通过 `~/.dsh/dsh-origin.txt` 或
`ctx.get('webServer').getOrigin()` 取，**不要硬编码端口**。

## 文件契约

| 路径 | 写入方 | 读取方 |
|---|---|---|
| `bot/data/secrets/bilibili_credential.json` | `dsh-bili-dm` 登录/人工 | `dsh-bili-dm`、`dsh-self` 体检 |
| `bot/data/secrets/tieba_credential.json` | `dsh-tieba` 登录脚本 | `dsh-tieba`、`dsh-self` 体检 |
| `bot/data/secrets/tieba_token` | `bot/scripts/tieba` | 贴吧 gateway 鉴权 |
| `bot/data/bilibili/interest/default.json` | 旧数据/人工 | `dsh-bili-dm` 兴趣兜底（可缺省） |
| `bot/scripts/start-bot.sh` | 仓库 | `dsh-self` 在 3010 掉线时执行它拉起 NapCat |

路径解析顺序统一为：`CHAT_BOT_ROOT` 环境变量 → 插件同仓库的兄弟目录 `../../bot`。

## 配置契约

- profile 的 `dsh.profile.bundles` 必须包含四个包名；
- 群白名单只写在 profile 的 `cordis.patch.yml`，片段见 `profile/cordis.patch.yml.example`；
- 每个插件的 `engines.dsh` 声明兼容范围，升级 DSH 前先核对。
