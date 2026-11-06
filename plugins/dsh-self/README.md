# dsh-self · 屿的自我层

一个给 DSH 用的「自我」插件：人格、平台面具、与缔造者的关系、成长札记、长期记忆。
全部落盘、可版本化、可回滚；不依赖任何外部服务。

## 它做什么

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 内核 | `$DSH_HOME/self/self.md` | 屿是谁、怎么说话、判断权重、边界 |
| 面具 | `$DSH_HOME/self/masks/{desktop,qq,bilibili}.md` | 平台身份；只改表达，不改判断 |
| 关系 | `$DSH_HOME/self/relation.md` | 与缔造者的关系设定 |
| 人格层 | `$DSH_HOME/self/masks/personas/<id>.md` | 面具人格的说话方式与设定（溟月 / 大肥鱼 / 鼠鱼） |
| 人格记忆 | `$DSH_HOME/self/masks/personas/memory/<id>.jsonl` | 每张脸自己的经历与认知，带出处；和人格层分开 |
| 人格状态 | `$DSH_HOME/self/masks/personas/state/<id>.json` | 每张脸一份 `global`（mood / energy，**所有人共享**）+ 按「平台:账号」分的 `peers`（affection 0~100 / today / why）。初值 0.8 / 0.8 / 50（缔造者 90）；mood、energy 每天 05:00 回 0.8，affection 长期不刷新 |
| 成长 | `$DSH_HOME/self/growth.jsonl` + bili-humanism 的 `human-world.md`（只读） | 可修正的理解，不是命令 |
| 版本 | `history/v{n}/` + `changelog.md` | 每次修改前的完整快照 |
| 记忆 | `memory.sqlite` | fact / episode / person / account / tombstone / audit |

## 记忆归属（谁经历的归谁）

- 屿的记忆：`fact.persona_id='self'`，所有面具共享。
- 人格记忆：`fact.persona_id='persona:<id>'`，只有那张脸看得到；`scope=person`（关于缔造者的事实）仍留在 `self`。
- 回忆时合并：`self` + 当前平台映射到的人格 id；桌面是屿本人，只有 `self`。
- 人格档案里的记忆（jsonl，来历/底色/边界）不进数据库，读取时和事实一起给。

## 注入方式

- **系统提示词（稳定段）**：`self-core` = 内核 + 关系 + 成长札记。内容不变时前缀缓存照常命中。
- **每会话（per-agent）**：`self-mask` = 当前面具；`self-persona-memory` = 当前人格自己的记忆（jsonl，稳定段）；`self-memory` = 屿 + 当前人格的长期记忆（`systemPrompt.context`，不污染系统提示词缓存）。
- **人格记忆写入**：每轮结束的判定同时产出 `episode`（归当前人格 `persona:<id>`）和 `ownerFact`（归屿 `self`，跨脸共享）；寒暄、无信息的轮次留空，不硬记。回忆时永远是屿 + 当前脸，两张脸互不可见。
- **人格状态**：`self-persona-state` = 当前脸对**当前这个人**的状态（`systemPrompt.context`，order 918）；对话里由 dsh-qq 的 `【发送者】platform:uid` 标记识别是谁。只在对外平台有；桌面是屿本人，不挂。判定挂在 `agent/turn-stopping`，一次很短的模型调用，不阻塞回复，结果下一轮注入。
- 面具按会话渠道自动识别：`qq`（dsh-im 的 rpcId 前缀）、`bilibili`（来源 kind / 会话标题）、`tieba`、其余 `desktop`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `self_status` | 人格版本、面具、记忆条数、缔造者 |
| `self_read` | 读 core / mask / relation / growth / changelog |
| `self_revise` | 改人格：`append`/`replace`，升版本 + 快照 + changelog |
| `self_revert` | 回滚到某个历史版本（回滚也升版本、也留痕） |
| `self_mask` | 看/切当前会话面具 |
| `self_state` | 看当前会话这张脸的状态数值，以及每张脸存了几份 |
| `self_remember` | 记一条事实或一段经历（敏感内容拒写） |
| `self_recall` | 按线索找记忆 |
| `self_update` | 改一条已有事实：新值取代旧值，旧值保留可追溯 |
| `self_forget` | 忘掉一条（写 tombstone） |
| `self_grow` | 记一条成长札记 |
| `self_whois` | 平台账号 → 人 → 关系与事实 |

## 数据与隐私

- 账号 UID 只存在 `memory.sqlite`，不写进人格、不写进提示词、不对外说。
- 与 `core/policy/privacy.py` 对齐：密码/验证码/token/cookie/身份证等直接拒写。
- 删除写 tombstone，防止以后从对话里再学回来。
- 目录 0700，文件 0600；原子写（临时文件 + rename）。

## 配置（cordis.patch.yml）

```yaml
- id: dsh-self
  config:
    dataDir: ""            # 默认 $DSH_HOME/self
    brainDb: ""            # 留空自动找 ~/AI_develop/chat_bot/data/brain/brain.db
    personaId: self
    injectMemory: true
    memoryLimit: 8
    growthLimit: 6
    biliHumanismDir: ""    # 默认 $DSH_HOME/bili-humanism
```

## 首次启动

1. 从 `seed/` 复制内核、三个面具、关系设定；
2. 若找得到 `brain.db`，一次性迁移 person / account / admin / fact / fact_source / episode / relation；
3. 迁移过会写 `setting.migrated_from_brain`，不会重复。

## 不在这个插件里

- QQ 消息收发（需要 NapCat/OneBot 桥，另做）。
- B 站浏览与写操作（用 `dsh-bili-whale` / `dsh-bili-humanism`，本插件只读它们的成长札记）。
