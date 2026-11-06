# dsh-tieba

百度贴吧接入 DSH：与 `dsh-qq`（QQ）、`dsh-bili-dm`（B 站）同级。

## 工具

| 工具 | 作用 |
| --- | --- |
| `tieba_status` | 登录态、凭据位置、今日计数、发言是否预览 |
| `tieba_feed` | 按兴趣吧挑帖子（排除已看、签到/广告帖、2 天无回复），在符合条件的池里随机抽 |
| `tieba_read` | 读帖子：标题、吧名、楼层、作者、赞数、前几条楼中楼；最新回复超过 2 天的帖子不浏览 |
| `tieba_comments` | 读某楼的全部楼中楼（翻页） |
| `tieba_like` | 帖子/楼层/楼中楼 点赞、点踩、取消 |
| `tieba_favorite` | 收藏 / 取消收藏 |
| `tieba_comment` | 发评论：回帖 / 回复楼层 / 回复楼中楼；默认只给预览 |
| `tieba_home` | 读个人主页四个分类：贴子 / 回帖 / 点赞 / 收藏（浏览器会话，一次十几秒） |
| `tieba_follow` | 关注 / 取消关注一个吧（浏览器会话点按钮）；关注前查活跃度：最近 3 天有回复的帖子数 < 50 拒绝 |
| `tieba_sign` | 给一个吧签到（浏览器会话点签到按钮） |
| `tieba_seen` | 标记已看，避免重复推荐 |
| `tieba_interest` | 看/改兴趣吧与不想看关键词 |

## 主页分类

`tieba_home` 不走 API 签名，而是用持久 Chrome profile（`~/.dsh/tieba-browser`）打开 `/home/main`，点对应 tab 后从 CDP 拿接口 JSON：

| tab | 接口 | 内容 |
| --- | --- | --- |
| threads | `/c/u/feed/myThread` type=1 | 我发过的主题帖 |
| replies | `/c/u/feed/myThread` type=2 | 我发过的回帖（含楼层内容） |
| likes | `/c/u/feed/userAgree_pc` | 赞过的帖子；赞的是评论时带 `top_agree_post` |
| favorites | `/c/u/feed/threadStoreList` | 收藏的帖子 |

profile 登录态过期（主页跳登录页）时工具会返回 needLogin，需要重新扫码：`node scripts/tieba-login.mjs --force`。

## 吧操作

关注/取关/签到走 `scripts/tieba-ops.mjs`：关注前用 `/c/f/frs/page` 按最后回复排序翻页，统计最近 3 天有回复的帖子数，< 50 直接拒绝；打开吧页，点「关注本吧」「签到」，读 DOM 判断结果（顶部「签到」变「连签N天」即成功）。客户端接口 `/c/c/forum/like`、`/c/c/forum/sign` 对这台机器的登录态一直 110001，所以不进签名通道。

## 登录

写操作需要贴吧账号 cookie（BDUSS、STOKEN）。用扫码脚本：

```bash
node scripts/tieba-login.mjs
# 默认写到套件的 bot/data/secrets/tieba_credential.json；可用 --out 覆盖
```

脚本会用本机 Chrome 开 passport 扫码页，保存二维码，等扫码后把 cookie 写成 600 的凭据文件。

## 发言

- `previewDefault: true` 时，`tieba_comment` 第一次只返回草稿；确认后加 `confirm=true` 才发。
- 写操作间至少 `minGapMs`（默认 20 秒），命中风控错误码后冷却 `cooldownMs`（默认 5 分钟），每天评论上限 `dailyCommentLimit`（默认 20）。
- 读请求串行（`tieba_feed` 每个吧之间停 1～2 秒），不做并发扫描。
- 按 `masks/tieba.md` 的口吻写：像吧友闲聊，不写小作文、不引战、不挂人。

## 协议

走贴吧 Android 客户端协议（`https://c.tieba.baidu.com`），请求体按参数名排序 + `tiebaclient!!!` 做 MD5 签名；写操作另带 `/dc/common/tbs` 的 `tbs` 和 cookie 里的 `stoken`。网页版已 SPA 化且有安全验证，不作为主通道。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `credentialPath` | `$CHAT_BOT_ROOT/data/secrets/tieba_credential.json` | 凭据文件 |
| `previewDefault` | `true` | 发言先预览 |
| `minGapMs` | `5000` | 写操作最小间隔 |
| `dailyCommentLimit` | `20` | 每日评论上限 |
| `statePath` | `~/.dsh/tieba-state.json` | 已看/动作/计数 |
| `interestPath` | `~/.dsh/tieba-interest.json` | 兴趣 |
