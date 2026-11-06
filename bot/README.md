# chat_bot

跨平台机器人的本地运行层。聊天、人格与各平台工具已迁到 DSH 插件
（`dsh-self` / `dsh-qq` / `dsh-bili-dm` / `dsh-tieba`），这个仓库只保留仍在运行的部分。

## 当前在跑

- **贴吧 gateway**：`platforms/tieba/` + `scripts/tieba`，监听 `127.0.0.1:6282`。
  - `GET /health`：存活探活
  - `GET /status`：登录态、今日计数（Bearer token）
  - `GET /feed`：按兴趣吧拉帖子候选
  - `GET /read`：帖子与楼层
  - `GET /comments`：楼中楼
- **NapCat 启动**：`scripts/start-bot.sh`，拉起 QQ/NapCat（`:6099`），供 `dsh-qq` 连 OneBot 11。

已停用、不在本仓库：AstrBot QQ 管线、brain 内核、B 站 gateway/runtime、人格与记忆存储。

## 运行

```bash
python3.12 -m venv envs/bilibili        # 脚本默认用这个 venv 路径，可用 TIEBA_VENV 覆盖
envs/bilibili/bin/pip install -r requirements.txt

scripts/tieba up                        # 后台启动 gateway
scripts/tieba status                    # 登录态 + 今日计数
scripts/tieba browse "摸鱼,科技" 6       # 按吧拉候选
scripts/tieba login                     # 二维码登录，凭据写入 data/secrets/
```

## 凭据与隐私

- `data/`、`envs/`、`vendor/` 不进版本库。
- 登录凭据 `data/secrets/tieba_credential.json`（0600）；本地 token 首次启动自动生成。
- 仓库里不含账号、cookie、令牌。

## 依赖

Python 3.12，`fastapi` / `uvicorn` / `httpx`（见 `requirements.txt`）。
