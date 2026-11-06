# dsh-chat-bot

DeepSeek Harness（DSH）上的一套个人聊天机器人：QQ、B 站私信、贴吧，加上人格与长期记忆。
**仅支持 macOS。**

A macOS-only chat-bot suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
QQ, Bilibili DMs, Tieba, plus a persona/memory layer.

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| `dsh-self` | `plugins/dsh-self` | 人格、面具、关系、成长札记、长期记忆、平台巡检 |
| `dsh-qq` | `plugins/dsh-qq` | NapCat（OneBot 11）↔ DSH 会话桥，QQ 收发与群白名单 |
| `dsh-bili-dm` | `plugins/dsh-bili-dm` | B 站私信桥 + 只读工具（视频、字幕、评论、抽帧） |
| `dsh-tieba` | `plugins/dsh-tieba` | 贴吧读/写工具与扫码登录脚本 |
| `bot` | `bot/` | 贴吧 gateway（:6282）、NapCat 启动脚本、凭据目录 |

四个插件共享一个 Python 层（`bot/`）和同一份凭据目录，所以放在同一个仓库里维护；
每个插件仍是独立 npm 包，版本、tag、发布互不影响。

## 先决条件

- macOS（Apple Silicon 或 Intel）
- [DeepSeek Harness](https://www.deepseek.com/harness/) ≥ `0.2.1-rc.2`（推荐 `0.2.2-rc.1`）
- Node.js ≥ 24.9（DSH 自身要求），Python 3.12
- QQ 客户端 + [NapCat](https://github.com/NapNeko/NapCatQQ)（需要自己安装并注入 QQ）
- 一个愿意用来跑机器人的 QQ 号，B 站与贴吧的登录只能扫码

## 快速开始

```bash
git clone https://github.com/LastMonsterHunter/dsh-chat-bot.git
cd dsh-chat-bot
./install.sh        # 检查环境、建 Python venv、把四个插件接进 DSH profile
./doctor.sh         # 看还有哪几项没就绪
```

然后重启 DSH，在插件页确认四个插件已启用，再按 `docs/install.md` 完成：

1. QQ / NapCat 登录；
2. B 站扫码登录；
3. 贴吧扫码登录（`bot/scripts/tieba login`）；
4. 可选：QQ 群白名单（`profile/cordis.patch.yml.example`）。

## 手动步骤（无法自动化）

- 安装 DSH 本体；
- 安装 QQ 并给 QQ 注入 NapCat；
- B 站、贴吧扫码登录；
- 群白名单、人格数据等个人配置。

## 隐私

仓库不包含任何账号、cookie、令牌。凭据只在本地 `bot/data/secrets/`（0600）生成，
该目录与 `bot/data/`、`bot/envs/` 都不进版本库。

## 版本

- 每个插件独立 semver，tag 形如 `dsh-qq@0.2.1`；
- `bot/` 独立版本（`bot/VERSION`），tag 形如 `bot@0.1.0`；
- 一起验证过的组合记在 [`docs/compatibility.md`](docs/compatibility.md)。

## 许可

[Apache-2.0](LICENSE)
