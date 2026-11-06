# 安装与首次配置

## 0. 前提

- macOS（Apple Silicon / Intel）
- 已安装 [DeepSeek Harness](https://www.deepseek.com/harness/) 并至少启动过一次
  （需要 `~/.dsh/profiles/desktop` 已生成）
- Node.js ≥ 24.9、Python 3.12
- `ffmpeg`（B 站抽帧用）：`brew install ffmpeg`，或把二进制放到
  `plugins/dsh-bili-dm/bin/ffmpeg`，或用 `BILI_DM_FFMPEG` 指定路径
- 用于机器人的 QQ 号，以及它对应的 QQ 客户端

## 1. 跑安装脚本

```bash
git clone https://github.com/LastMonsterHunter/dsh-chat-bot.git
cd dsh-chat-bot
./install.sh
```

脚本会：建 `bot/envs/bilibili` 虚拟环境 → 装 `bot/requirements.txt` → 备份 profile 的
`package.json` → 把四个插件写进 `dependencies`（`link:`）和 `dsh.profile.bundles` →
在 profile 的 `node_modules/` 建符号链接。

重启 DSH，到插件页确认 `dsh-self`、`dsh-qq`、`dsh-bili-dm`、`dsh-tieba` 都已启用。

## 2. QQ / NapCat

1. 安装 QQ 客户端；
2. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ)，按它的文档把 loader 注入 QQ；
3. 登录 QQ，确认 NapCat 的 OneBot 端口（默认 3010）在监听：

```bash
nc -z -G 1 127.0.0.1 3010 && echo ok
```

`bot/scripts/start-bot.sh` 只负责拉起 QQ（`open -a`），不负责安装 NapCat。
QQ 的登录凭据在系统钥匙串里，不在仓库。

## 3. B 站登录

B 站凭据由 `dsh-bili-dm` 读取 `bot/data/secrets/bilibili_credential.json`。
按插件页的提示扫码，或参考插件 README。

## 4. 贴吧登录

```bash
cd /path/to/dsh-chat-bot
bot/scripts/tieba login      # 本机 Chrome 扫码，凭据写入 bot/data/secrets/
bot/scripts/tieba status
```

贴吧 gateway（:6282）是可选的运维通道，DSH 的 `dsh-tieba` 工具不依赖它。

## 5. 可选：QQ 群白名单

复制 `profile/cordis.patch.yml.example` 里需要的条目到
`~/.dsh/profiles/desktop/cordis.patch.yml`，填自己的群号：

```yaml
- id: dsh-qq
  name: dsh-qq
  config:
    allowGroups: ["123456"]
    autoReplyGroups: ["123456"]
```

改完重启 DSH。

## 6. 检查

```bash
./doctor.sh
```

标 ✗ 的项必须解决；标 ! 的多半是还没登录或还没装 QQ，不影响启动。
