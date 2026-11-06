# dsh-bili-dm · B站私信桥

只接一条会话：机器人观众号（你的机器人 mid）↔ 你（你的 mid）。别人的私信不拉、不存、不回。

## 链路

```
B站私信（你发的）
  → 每 15s 轮询 svr_sync/fetch_session_msgs
  → POST /dsh-qq/reply（platform=bilibili）
  → DSH 会话「B站私信 · 鲸屿听潮」→ 戴 bilibili 面具回答
  → web_im/send_msg 发回
```

## 凭据

默认读 `~/AI_develop/chat_bot/data/secrets/bilibili_credential.json`（`sessdata` / `bili_jct` / `dedeuserid`）。
发送只用这张 cookie，不碰密码、不扫码。

## 工具

| 工具 | 用途 |
| --- | --- |
| `bili_feed` | 按兴趣挑候选：分区排行（科技/知识/纪录片/生活）+ 热门，命中/时长/热度/新鲜度打分，排除看过 |
| `bili_seen` | 标记看过；`verdict=like/dislike` 写进反馈 |
| `bili_interest` | 看/改兴趣（like / dislike，最多各 20 个） |
| `bili_frames` | 按时间点从 DASH 流 seek 抽帧（不下载整段）；帧数按时长自动（下限 4，约每 60 秒一帧，单次上限 20） |
| `bili_dm_status` | 账号、轮询时间、自动回复开关、最近错误 |
| `bili_dm_recent` | 最近看到的几条（只含这条会话） |
| `bili_dm_send` | 手动发一条（≤500 字） |

## 边界

- 只追问 `ownerUid` 的会话；其他人不读。
- 首次启动只“认领”旧消息；如果最后一条是 5 分钟内的 inbound，会回一次。
- 每轮最多回 2 条，API 调用间隔 ≥1.5s，避免风控。
- 回复发回前会把 markdown 星号和反引号去掉（B 站私信不渲染）。
- **平台写入只有私信发送**；点赞/投币/收藏/关注仍然没开。

## 状态

`~/.dsh/bili-dm-state.json`（600）：已见消息 key、最近 50 条、初始化标记。


## 长视频抽帧（bili_frames）

- 走 `x/player/playurl` 取最低码率的 DASH 流，用 PyAV 对 HTTP 流按时间点 seek，只解码需要的几帧。
- 不在本地落到整段视频；25 分钟的视频约 3 秒出 20 帧（约每 77 秒一帧）。
- 帧数策略：`max(4, round(4 + 时长/60))`，再按宿主单条图片上限（当前 20）夹紧；想覆盖更细可用 `times` 指定秒数，或分多次调用。
- 抽帧依赖：`ffmpeg-static`（npm 自带二进制），不再需要 Python/venv。
- 返回的图通过 DSH 附件服务落盘；采样帧不是完整观看，汇报必须标清楚。


## 兴趣浏览

`bili_feed` 不按“热门给什么就看什么”，而是：

1. 抓分区排行（科技 188 / 知识 36 / 纪录片 177 / 生活 160）+ 热门；
2. 用 `~/.dsh/bili-interest.json` 里的 like / dislike 在标题、UP、标签上匹配（英文按词边界，避免 `Lai` 命中 `AI`）；
3. 排除 `seen` 里的 bvid；旧 bot 的 seen 只继承“看过”，不继承口味；
4. 按时长（5–60 分钟加分、<3 分钟减分）、播放、新鲜度打分；同一 UP 只出一条；
5. 返回候选 + 命中理由。

口味可以改：`bili_interest set like="..." dislike="..."`；刷完用 `bili_seen verdict=like|dislike` 留反馈。
