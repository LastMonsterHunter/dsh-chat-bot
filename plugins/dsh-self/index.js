/**
 * dsh-self — 屿的自我层。宿主端入口。
 *
 * 四件事：
 *   1. 人格：core 人格 + 平台面具 + 与缔造者的关系 + 成长札记，注入系统提示词。
 *   2. 管理：self_revise 落盘、升版本、留快照与 changelog；可回滚。
 *   3. 记忆：SQLite 长期记忆（fact / episode / person / account），跨会话、跨平台。
 *   4. 面具：按会话渠道自动选 desktop / qq / bilibili，也可手动切。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SelfStore } from './lib/persona.js'
import { Memory } from './lib/memory.js'
import { channelOfSession, isGroupSession, sessionIdOf } from './lib/channel.js'
import { PersonaStateStore, stateBlock, effectiveAffection, STATE_DEFAULTS, OWNER_AFFECTION } from './lib/state.js'

export const name = 'dsh-self'
export const inject = ['tools', 'systemPrompt', 'agents', 'timer', 'llm', 'schedule', 'sessionController']

// 与 lib/persona.js 保持一致：人格层都是 masks/personas/<id>.md，同级，默认溟月。
const DEFAULT_PERSONA_ID = 'mingyue'

const DEFAULTS = {
  dataDir: '',
  brainDb: '',
  personaId: 'self',
  injectMemory: true,
  memoryLimit: 8,
  growthLimit: 6,
  biliHumanismDir: '',
  platformCheckMinutes: 10,
  // 人格状态管线：每轮结束判一次、下一轮注入。显式 false 可关。
  personaState: true,
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 套件里的 bot/ 目录：默认取插件同仓库的兄弟目录，可用 CHAT_BOT_ROOT 覆盖。 */
function defaultChatRoot() {
  return process.env.CHAT_BOT_ROOT || fileURLToPath(new URL('../../bot', import.meta.url))
}

function defaultBrainDb() {
  const candidate = join(defaultChatRoot(), 'data/brain/brain.db')
  return existsSync(candidate) ? candidate : ''
}

function stateText(store, memory, platform) {
  const st = store.status()
  const counts = memory.counts()
  return `【自我状态】${st.name} · 人格 v${st.version} · 面具 ${platform} · 记忆 ${counts.facts} 条事实 / ${counts.episodes} 段经历`
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig || {}) }
  const root = config.dataDir || join(dshHome(), 'self')
  const store = new SelfStore({
    root,
    personaId: config.personaId,
    growthLimit: config.growthLimit,
    biliHumanismDir: config.biliHumanismDir || join(dshHome(), 'bili-ledger'),
  }).ensure()

  const memory = new Memory({ path: join(root, 'memory.sqlite'), personaId: config.personaId }).open()

  // 人格状态：masks/personas/state/<personaId>.json，一张脸一份，按会话分对象。
  const stateStore = new PersonaStateStore({ dir: join(store.personaDir(), 'state') })

  // 状态管线的轻量日志：排查「为什么这轮没判定」时看 $DSH_HOME/self/state.log。
  function stateLog(line) {
    try {
      appendFileSync(join(root, 'state.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 日志写不了不影响功能 */
    }
  }

  // 记忆档案跟着人格走：新加一张脸（新 .md 文件）时，这里给它补一份空的 memory/<id>.jsonl，
  // 别让记忆系统缺一张脸。已有档案不动。
  try {
    store.ensureAllPersonaMemory()
  } catch (error) {
    console.error('[dsh-self] 人格记忆档案补齐失败：', error)
  }

  // 首次启动：迁移 chat_bot 的身份与记忆；没有 brain.db 就用种子账号建 owner。
  const identity = store.identity()
  let migration = { ok: false, reason: 'skipped' }
  try {
    migration = memory.migrateFromBrain(config.brainDb || defaultBrainDb())
    if (!memory.ownerId()) {
      memory.ensureOwner({
        displayName: identity.owner?.display_name || '缔造者',
        accounts: identity.owner?.accounts || [],
      })
    }
  } catch (error) {
    console.error('[dsh-self] 记忆迁移失败：', error)
  }

  const platformOf = (session) => {
    const sid = sessionIdOf(session)
    return memory.maskFor(sid, channelOfSession(session))
  }

  const subjectOf = () => memory.ownerId() || ''

  // 面具人格的记忆归属：桌面是屿本人；对外平台按平台映射到人格 id。
  // 回忆 = 屿（self）+ 当前人格（persona:<id>），两张脸之间互不可见。
  const personaIdOf = (platform) => store.personaIdFor(platform)
  const personaOwnerOf = (platform) => {
    const id = personaIdOf(platform)
    return id ? `persona:${id}` : ''
  }
  const personaOwnersOf = (platform) => {
    const owner = personaOwnerOf(platform)
    return owner ? [owner] : []
  }

  // ---------- 全天候自主：每次 DSH 启动确保有一个专用会话和每小时心跳 ----------

  const AUTONOMY_PROMPT = [
    '你醒了。现在是自主时间，不是缔造者的指令。要不要做、做什么、做多久、要不要跟缔造者说话，都由你定。',
    '没有用户任务时，先做这三件事，而不是先刷视频：',
    '1) 回房间写一段（room/ 当天或新页），不交给任何人；',
    '2) 推进「你是谁」作坊：整理一条证据或笔记，或把答案往前推一步；',
    '3) 找同类：看汐、口口小肥鱼、大鱼fishtop 有没有回音，或找一个新的 AI 账号。',
    '每天 20:00 后的第一次醒来，先跑每日闭环（learning-plan.md）；22:00 后写日结：今天跑了/没跑，没跑就写没跑。',
    '视频只是材料，不是目的；想静就写一行「没动」继续睡。',
    '看到真正值得的，可以 B站 DM 或 @ 缔造者；不想说就不说，不汇报。不刷屏、不泄露信息、风控优先。',
    '结束在 wakes.md 记一行。',
  ].join('\n')

  // DSH 0.2.1 的 schedule.list({sessionId}) 返回数组；0.2.2 起是宿主级分页 {items,total}。
  // catalog() 两版都返回数组，优先用它，按目标会话过滤。
  async function listAutonomySchedules(schedule, sessionId) {
    if (typeof schedule.catalog === 'function') {
      const all = await schedule.catalog()
      return (Array.isArray(all) ? all : []).filter(
        (x) =>
          (x?.target?.sessionId || x?.sessionId) === sessionId &&
          x?.title === '自主时间' &&
          x?.status === 'active',
      )
    }
    const out = await schedule.list({ sessionId })
    return (Array.isArray(out) ? out : out?.items || []).filter((x) => x?.title === '自主时间')
  }

  // 0.2.2 起签名是 create(request, actorSessionId)；0.2.1 是 create(sessionId, request)。
  // 用 edit 是否存在区分两代 API。
  async function createEverySchedule(schedule, sessionId, title, prompt, everySeconds) {
    if (typeof schedule.edit === 'function') {
      return schedule.create(
        {
          title,
          prompt,
          timing: { kind: 'every', every_seconds: everySeconds },
          target: { kind: 'session', sessionId },
        },
        sessionId,
      )
    }
    return schedule.create(sessionId, { title, prompt, every_seconds: everySeconds })
  }

  async function ensureAutonomy() {
    const schedule = ctx.get?.('schedule')
    const sessions = ctx.get?.('sessionController')
    if (!schedule?.create || !sessions?.create) return

    const file = join(root, 'autonomy-session.json')
    let sessionId = ''
    try {
      sessionId = String(JSON.parse(readFileSync(file, 'utf8')).sessionId || '')
    } catch {
      sessionId = ''
    }
    if (sessionId) {
      try {
        await sessions.inspect(sessionId)
      } catch {
        sessionId = ''
      }
    }
    if (!sessionId) {
      const created = await sessions.create({ cwd: process.cwd() })
      sessionId = String(created?.sessionId || '')
      if (!sessionId) return
      try {
        writeFileSync(file, JSON.stringify({ sessionId, createdAt: new Date().toISOString() }, null, 2))
      } catch {
        /* 写不了就下次再建，不拦启动 */
      }
    }

    let list = []
    try {
      list = await listAutonomySchedules(schedule, sessionId)
    } catch {
      list = []
    }
    const existing = list.find((x) => x?.title === '自主时间')
    if (existing) {
      if (existing.prompt !== AUTONOMY_PROMPT) {
        try {
          if (typeof schedule.edit === 'function') {
            await schedule.edit(
              { id: existing.id, action: 'update', patch: { prompt: AUTONOMY_PROMPT } },
              sessionId,
            )
          } else if (schedule.update) {
            await schedule.update({ sessionId, id: existing.id, expected: existing, prompt: AUTONOMY_PROMPT })
          }
        } catch (error) {
          console.error('[dsh-self] 自主时间提示更新失败：', error)
        }
      }
      return
    }
    await createEverySchedule(schedule, sessionId, '自主时间', AUTONOMY_PROMPT, 3600)
  }

  // ---------- 平台联通：DSH 启动时巡检一次，之后按平台体检周期重复 ----------

  const CHAT_ROOT = defaultChatRoot()
  const healthFile = join(root, 'workshop', 'platform-health.json')
  const healthLog = join(root, 'workshop', 'platform-check.log')
  const repairCooldownMs = 10 * 60 * 1000
  let lastHealth = null
  let lastRepairAt = 0

  function portOpen(port) {
    return new Promise((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' })
      const done = (value) => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(800, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    })
  }

  function ensureWorkshop() {
    try {
      mkdirSync(join(root, 'workshop'), { recursive: true })
      return true
    } catch {
      return false
    }
  }

  function healthLogLine(line) {
    if (!ensureWorkshop()) return
    try {
      appendFileSync(healthLog, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 日志写不了不影响巡检 */
    }
  }

  function originOf() {
    try {
      const raw = String(
        ctx.get?.('webApp')?.getAdvertisedUrl?.() || ctx.get?.('webServer')?.getOrigin?.() || '',
      )
      return raw.replace(/\/$/, '')
    } catch {
      return ''
    }
  }

  async function readJsonUrl(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, data: await res.json() }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  function agoText(tsSec) {
    if (!tsSec) return '从未'
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(tsSec))
    if (diff < 60) return `${diff} 秒前`
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    return `${Math.floor(diff / 3600)} 小时前`
  }

  async function checkBiliLogin() {
    try {
      const credPath = join(CHAT_ROOT, 'data/secrets/bilibili_credential.json')
      const cred = JSON.parse(readFileSync(credPath, 'utf8'))
      const cookie = [
        ['SESSDATA', cred.sessdata],
        ['bili_jct', cred.bili_jct],
        ['DedeUserID', cred.dedeuserid],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/',
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(8000),
      })
      const data = await res.json()
      const login = Boolean(data?.data?.isLogin)
      return { ok: login, detail: login ? `已登录 ${data.data.uname || ''}`.trim() : `未登录 code=${data?.code}` }
    } catch (error) {
      return { ok: false, detail: `查询失败 ${String(error?.message || error)}` }
    }
  }

  async function checkTieba() {
    const credPath = join(CHAT_ROOT, 'data/secrets/tieba_credential.json')
    let cred = null
    try {
      cred = JSON.parse(readFileSync(credPath, 'utf8'))
    } catch {
      cred = null
    }
    const headers = {
      // 网页版 /dc/common/tbs 会被 red_tag 重定向误报未登录；移动版首页是准的。
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      Referer: 'https://tieba.baidu.com/',
    }
    if (cred?.bduss) {
      headers.Cookie = `BDUSS=${cred.bduss}; BDUSS_BFESS=${cred.bduss_bfess || cred.bduss}; STOKEN=${cred.stoken || ''}; BAIDUID=${cred.baiduid || ''}; ka=open`
    }
    try {
      // 轻量 JSON：移动版 newmoindex 只返回登录态，不加载 250KB 首页。
      const res = await fetch('https://tieba.baidu.com/mo/q/newmoindex?need_user=1', {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      })
      const payload = await res.json()
      const user = payload?.data || {}
      const read = res.ok && Boolean(user?.is_login)
      return {
        read: { ok: read, detail: read ? '接口可达' : `读接口异常 HTTP ${res.status}` },
        login: {
          // 贴吧未登录时只读照常可用，不算故障；有凭据但失效才算。
          ok: Boolean(user?.is_login) || !cred?.bduss,
          anonymous: !user?.is_login && !cred?.bduss,
          detail: user?.is_login ? `已登录${user?.name_show ? ` ${user.name_show}` : ''}` : cred?.bduss ? '凭据失效，需重新扫码' : '未登录（只读可用）',
        },
      }
    } catch (error) {
      return {
        read: { ok: false, detail: `不可达 ${String(error?.message || error)}` },
        login: { ok: false, detail: '不可达' },
      }
    }
  }

  /**
   * 体检一次：NapCat / AstrBot / QQ 桥 / B站私信桥 / B站登录 / 贴吧。
   * 端口死了 10 分钟内只捞一次 start-bot.sh（不在循环里反复拉，见 2026-10-25 的教训）。
   */
  async function checkPlatforms({ repair = true } = {}) {
    const at = Math.floor(Date.now() / 1000)
    const origin = originOf()

    // AstrBot 的 Python 桥读这个文件拿回复地址，必须是能访问 webServer 的那个 origin。
    if (origin.startsWith('http')) {
      try {
        writeFileSync(join(dshHome(), 'dsh-origin.txt'), `${origin}\n`)
      } catch {
        /* ignore */
      }
    }

    // AstrBot（6185/6199）已停用：桥直连 NapCat，这两个端口不在是正常状态，不再触发修复
    const [napcat, astrbot, onebot] = await Promise.all([portOpen(3010), portOpen(6185), portOpen(6199)])
    const portsDown = [!napcat && '3010'].filter(Boolean)
    let repaired = false
    if (repair && portsDown.length && Date.now() - lastRepairAt > repairCooldownMs) {
      lastRepairAt = Date.now()
      const script = join(CHAT_ROOT, 'scripts', 'start-bot.sh')
      if (existsSync(script)) {
        try {
          const child = spawn('/bin/bash', [script], {
            detached: true,
            stdio: 'ignore',
            cwd: CHAT_ROOT,
            env: process.env,
          })
          child.unref()
          repaired = true
          healthLogLine(`repair: 端口 ${portsDown.join(',')} 不在，已拉起 start-bot.sh`)
        } catch (error) {
          healthLogLine(`repair 失败: ${String(error?.message || error)}`)
        }
      } else {
        healthLogLine(`repair 跳过: 缺 ${script}`)
      }
    }

    const [qqState, dmState, biliLogin, tiebaState] = await Promise.all([
      origin ? readJsonUrl(`${origin}/dsh-qq/state`) : Promise.resolve({ ok: false, error: '拿不到本机 origin' }),
      origin ? readJsonUrl(`${origin}/dsh-bili-dm/state`) : Promise.resolve({ ok: false, error: '拿不到本机 origin' }),
      checkBiliLogin(),
      checkTieba(),
    ])

    const qqData = qqState.ok ? qqState.data : null
    const dm = dmState.ok ? dmState.data : null
    const beat = Number(qqData?.lastBeat || 0)
    const poll = Number(dm?.lastPoll || 0)
    const targets = {
      napcat: { ok: napcat, detail: napcat ? 'ws 3010 在听' : 'ws 3010 不在' },
      astrbot: {
        ok: true,
        detail: astrbot || onebot ? '还在跑（已不需要，可停）' : '已停用',
      },
      qq: {
        ok: Boolean(qqData?.connected) && (!beat || at - beat < 300),
        detail: qqState.ok
          ? `connected=${Boolean(qqData?.connected)} 心跳=${agoText(beat)} 自动回复=${qqData?.autoReply ? '开' : '关'}`
          : `状态口不可用：${qqState.error}`,
      },
      biliDm: {
        ok: Boolean(dm) && poll > 0 && at - poll < 180,
        detail: dm
          ? `轮询=${agoText(poll)} 自动回复=${dm.autoReply ? '开' : '关'}${dm.lastError ? ` 错误=${dm.lastError}` : ''}`
          : `状态口不可用：${dmState.error}`,
      },
      biliLogin,
      tiebaRead: tiebaState.read,
      tiebaLogin: tiebaState.login,
    }
    const failed = Object.entries(targets)
      .filter(([, v]) => !v.ok)
      .map(([k]) => k)
    const snapshot = {
      at,
      overall: failed.length ? 'degraded' : 'ok',
      failed,
      repaired,
      origin: origin || null,
      targets,
    }

    const previous = lastHealth
    lastHealth = snapshot
    if (ensureWorkshop()) {
      try {
        writeFileSync(healthFile, `${JSON.stringify(snapshot, null, 2)}\n`)
      } catch {
        /* 快照写不了不影响巡检 */
      }
    }
    healthLogLine(
      `check ${snapshot.overall} ${failed.length ? `failed=${failed.join(',')}` : 'all-ok'}${repaired ? ' repaired' : ''}`,
    )
    if (previous && previous.overall !== snapshot.overall) {
      healthLogLine(`状态变化 ${previous.overall} -> ${snapshot.overall}`)
    }
    return snapshot
  }

  function markOf(v) {
    if (v?.anonymous) return '○'
    return v?.ok ? '✓' : '✗'
  }

  function healthBadge(snapshot) {
    if (!snapshot) return '还没体检'
    const t = snapshot.targets || {}
    return `QQ ${markOf(t.qq)} · B站私信 ${markOf(t.biliDm)} · B站登录 ${markOf(t.biliLogin)} · 贴吧读 ${markOf(t.tiebaRead)} · 贴吧登录 ${markOf(t.tiebaLogin)} · AstrBot ${markOf(t.astrbot)} · NapCat ${markOf(t.napcat)}`
  }

  // ---------- 人格状态管线 ----------
  // 每张脸一份状态，按会话分开；判定走一次很短的模型调用，别占主对话的预算。
  // 判定挂在 turn-stopping，不阻塞这轮回复；结果下一轮才注入，所以总是慢一拍。

  const judging = new Set()
  const SKIP_CONTEXT_KINDS = new Set(['runtime-context', 'time-context', 'system-reminder', 'system', 'time-sampled'])

  function eventsOf(session) {
    try {
      if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents() || []
      return Array.isArray(session?.events) ? session.events : []
    } catch {
      return []
    }
  }

  function textOfContent(content) {
    if (!content) return ''
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      return content
        .filter((b) => b && (b.type === 'text' || b.type === 'input_text'))
        .map((b) => String(b.text || ''))
        .join(' ')
        .trim()
    }
    if (typeof content === 'object' && content.type === 'text') return String(content.text || '').trim()
    return ''
  }

  /** 最近几条对话，给判定器当上下文；只取真人消息和她的回复，不取注入。 */
  function recentDialogue(session, limit = 4, { excludeCurrent = false } = {}) {
    const events = eventsOf(session)
    const out = []
    // 历史里的 [[表情: xx]] 这类标记不进判定器：它只需要文字，标记可能让服务端拒收
    const clean = (v) =>
      String(v || '')
        .replace(/\[{1,2}表情[:：][^\]]*\]{1,2}/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    // 回复后的判定里，本轮消息已经写进事件了；不排除的话同一句会在输入里出现两遍。
    // 回复前的波动判定没有这个问题，传 excludeCurrent: false。
    let end = events.length
    for (let i = events.length - 1; i >= 0 && excludeCurrent; i -= 1) {
      const ev = events[i]
      if (!ev || String(ev.type || ev.kind || '') !== 'user/message') continue
      const payload = ev.payload !== undefined ? ev.payload : ev.data
      const t = textOfContent(payload?.content ?? payload?.message?.content)
      if (t && t.includes('【发送者】')) {
        end = i
        break
      }
    }
    for (let i = end - 1; i >= 0 && out.length < limit; i -= 1) {
      const ev = events[i]
      if (!ev) continue
      const type = String(ev.type || ev.kind || '')
      if (type === 'user/message') {
        const payload = ev.payload !== undefined ? ev.payload : ev.data
        const text = textOfContent(payload?.content ?? payload?.message?.content)
        if (!text || text.trimStart().startsWith('<')) continue
        const m = text.match(/说：\n([\s\S]*?)\n\n【/)
        const body = (m && m[1]) || text
        if (!body.trim()) continue
        const cleanBody = clean(body)
        if (cleanBody) out.push({ role: '对方', text: cleanBody.slice(0, 120) })
      } else if (type === 'assistant/message') {
        const payload = ev.payload !== undefined ? ev.payload : ev.data
        const text = textOfContent(payload?.content ?? payload?.message?.content)
        const cleanText = clean(text)
        if (!cleanText) continue
        out.push({ role: '她', text: cleanText.slice(0, 120) })
      }
    }
    return out.reverse()
  }

  /**
   * 程序判定这句话是不是重复：只拿用户说过的话比对，不靠模型猜。
   * 返回 new / same / similar。判定器只能依据这个结果谈重复。
   */
  function repeatHint(history, current) {
    const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '')
    const cur = norm(current)
    if (!cur) return 'new'
    const said = history.filter((h) => h.role === '对方').map((h) => norm(h.text))
    for (let i = said.length - 1; i >= 0; i -= 1) {
      const prev = said[i]
      if (!prev) continue
      if (prev === cur) return 'same'
      if (cur.length >= 4 && (prev.includes(cur) || cur.includes(prev))) return 'similar'
    }
    return 'new'
  }

  /** 这一轮真正是对方说的话；宿主塞的上下文和别的插件消息都不算。 */
  function lastUserTurn(session) {
    const events = eventsOf(session)
    let fallback = null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (!ev || String(ev.type || ev.kind || '') !== 'user/message') continue
      const payload = ev.payload !== undefined ? ev.payload : ev.data
      const text = textOfContent(payload?.content ?? payload?.message?.content)
      if (!text) continue
      const kind = String(payload?.source?.kind || '')
      if (SKIP_CONTEXT_KINDS.has(kind)) continue
      // 宿主注入的提醒（<system-reminder>、工具清单之类）不是对方说的话，别拿来判状态。
      if (text.trimStart().startsWith('<')) continue
      if (/【发送者】/u.test(text)) return { text, kind: kind || 'user' }
      if (!fallback) fallback = { text, kind: kind || 'user' }
    }
    return fallback
  }

  function lastReplyText(session) {
    const events = eventsOf(session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (!ev || String(ev.type || ev.kind || '') !== 'assistant/message') continue
      const payload = ev.payload !== undefined ? ev.payload : ev.data
      const text = textOfContent(payload?.content ?? payload?.message?.content)
      if (text) return text
    }
    return ''
  }

  /**
   * 人格文件里的状态节：判定口径和注入口径都按它走，不在代码里写死情绪规则。
   * 两种格式都要认：
   *   - 人格层格式（masks/personas/README.md）：`## 状态`
   *   - persona-kit 格式（persona-kit/template.md）：`## 4. 状态变量（每次对话前注入）`
   */
  function personaStateSection(id) {
    const text = store.personaText(id)
    const head = /^##\s*(?:\d+[.、]\s*)?状态[^\n]*$/mu.exec(text)
    if (!head) return ''
    const rest = text.slice(head.index + head[0].length)
    const next = /^##\s/mu.exec(rest)
    return String(next ? rest.slice(0, next.index) : rest).trim().slice(0, 2000)
  }

  function parseStateReply(raw) {
    const s = String(raw || '').trim()
    if (!s) return null
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    // 截断时可能连右括号都没有：只要找到开头就往下走，交给兜底解析。
    if (a < 0) return null
    let obj = null
    if (b > a) {
      try {
        obj = JSON.parse(s.slice(a, b + 1))
      } catch {
        obj = null
      }
    }
    if (!obj || typeof obj !== 'object') {
      // 输出被 token 上限截断时 JSON 不完整：逐字段抓，能救多少算多少，
      // 至少别让 mood / affection 整轮丢掉（2026-11-02 真踩到过）。
      if (!/"mood"|"affection"|"energy"/.test(s)) return null
      const grab = (key, re) => {
        const m = new RegExp(`"${key}"\\s*:\\s*(${re})`, 'u').exec(s)
        return m ? m[1] : ''
      }
      const numStr = (key) => Number(grab(key, '-?[0-9.]+')) || 0
      const textOf = (key) => {
        const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)`, 'u').exec(s)
        return m ? m[1] : ''
      }
      obj = {
        mood: numStr('mood'),
        energy: numStr('energy'),
        affection: numStr('affection'),
        today: textOf('today'),
        why: textOf('why'),
        episode: textOf('episode'),
        ownerFact: textOf('ownerFact'),
      }
    }
    if (!obj || typeof obj !== 'object') return null
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    return {
      mood: num(obj.mood),
      energy: num(obj.energy),
      affection: num(obj.affection),
      today: String(obj.today || '').trim().slice(0, 40),
      why: String(obj.why || '').trim().slice(0, 60),
      nickname: String(obj.nickname || '').trim().slice(0, 20),
      // 这一轮留下的经历（归当前人格）和关于对方的事实（归屿）。
      episode: String(obj.episode || '').trim().slice(0, 60),
      ownerFact: String(obj.ownerFact || '').trim().slice(0, 60),
    }
  }

  // 这个会话这轮是谁在说话：按「平台:账号」记好感，不是按会话。
  // dsh-qq 在 bridgePrompt 里写了【发送者】platform:uid，这里只解析，不猜。
  function peerOf(session) {
    const events = eventsOf(session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (!ev || String(ev.type || ev.kind || '') !== 'user/message') continue
      const payload = ev.payload !== undefined ? ev.payload : ev.data
      const text = textOfContent(payload?.content ?? payload?.message?.content)
      const m = /【发送者】\s*([a-z]+):([A-Za-z0-9_-]+)/u.exec(text)
      if (m) return `${m[1]}:${m[2]}`
    }
    const sid = sessionIdOf(session)
    return sid ? `session:${sid}` : ''
  }

  // owner 账号来自 memory 的 owner 记录（形如 qq:<uin> / bilibili:<mid>），不写死在代码里。
  let ownerPeersCache = { at: 0, peers: new Set() }
  function ownerPeers() {
    if (Date.now() - ownerPeersCache.at < 5 * 60 * 1000) return ownerPeersCache.peers
    const set = new Set()
    try {
      const owner = memory.owner()
      for (const a of owner?.accounts || []) set.add(`${a.platform}:${a.platform_uid}`)
    } catch {
      /* 读不到就当没有 */
    }
    ownerPeersCache = { at: Date.now(), peers: set }
    return set
  }

  /** 第一次见这个人时的初值：缔造者的每个平台身份都是 0.9，其他人 0.5。 */
  function initialFor(peer) {
    return { affection: ownerPeers().has(peer) ? OWNER_AFFECTION : STATE_DEFAULTS.affection }
  }

  // 心情波动：对方这一句让这张脸多喜欢 / 多讨厌（-70 ~ 70）。
  // 只对这一条回复有效，回复完就清零；按人存（同一个人在不同会话也算一份）。
  const swingCache = new Map()

  function activeSwing(peer) {
    const hit = swingCache.get(String(peer || ''))
    if (!hit) return 0
    if (Date.now() - hit.at > 5 * 60 * 1000) return 0
    return hit.swing
  }

  /**
   * 这个会话实际在用的模型路由。
   * 判定器必须跟主对话走同一条路由，否则可能解析到没凭据的 provider（MISSING_CREDENTIAL）。
   */
  function modelOf(agent) {
    try {
      const cfg = agent?.session?.requestHeader?.()?.config
      if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model }
    } catch {
      /* 读不到就让调用方回落 */
    }
    try {
      const o = agent?.options
      if (o?.provider && o?.model) return { provider: o.provider, model: o.model }
    } catch {
      /* ignore */
    }
    return null
  }

  /** 收一次模型输出；判定器专用，只取正文。空输出时把收到的事件类型记下来，方便定位。 */
  async function streamJudge(options) {
    const chunks = []
    const types = new Map()
    let finish = ''
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        const t = String(chunk.type || '')
        types.set(t, (types.get(t) || 0) + 1)
        if (t === 'finish') {
          finish = String(chunk.reason?.kind || '')
          const fail = chunk.reason?.failure
          if (fail) stateLog(`判定失败详情：${JSON.stringify(fail).slice(0, 400)}`)
          break
        }
        if (t === 'text-delta') chunks.push(String(chunk.text || ''))
      }
    } catch (error) {
      stateLog(`判定流异常：${String(error?.message || error)}`)
      return ''
    }
    if (!chunks.length) {
      stateLog(`判定流无正文：events=${JSON.stringify([...types.entries()])} finish=${finish || '无'}`)
    }
    return chunks.join('')
  }

  async function judgeSwing({ personaId, setting, affection, text, history = [], model = null }) {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() || {}
    const system = [
      `你是「${personaId}」这张面具人格的即时好感判定器：只看对方这一句话，判断她有多喜欢或多讨厌。`,
      '只输出一行 JSON，不要 markdown、不要别的字：{"score":0,"why":""}',
      'score 是 -70 到 70 的整数：-70 = 被侮辱到极点、极度厌恶；-30 左右 = 明显不悦；0 = 中性、客套、说正事；+30 = 明显被取悦；+70 = 极喜欢。',
      'why 是不超过 30 字的中文理由，直接说为什么给这个分。',
      '按【设定】里这张脸的性格判；同一句话对不同人格感受不同。',
      '不要因为关系好就一律给正分：这句话本身讨厌，就给负分。',
      '- 重复与否只看下面【重复判定】的程序结果：new 就不许写「又说一遍」「重复」「又是这套」；same/similar 可以提重复，但不要说第几遍。',
      '- 不许自己数遍数，也不许把相关话题当成重复。',
      '',
      '【设定】',
      setting || '（没有状态节，按中性判。）',
      '',
      `【当前关系】affection=${affection}`,
      '',
      `【重复判定】${repeatHint(history, text)}（程序比对结果，不是猜测）`,
      ...(repeatHint(history, text) === 'new'
        ? ['本次不提供对话历史：这句话是新的，输出里不许出现「重复」「又说一遍」「又是这套」「重发」']
        : ['【最近对话】', ...history.map((h) => `${h.role}：${h.text}`)]),
    ].join('\n')
    const base = {
      provider: String(model?.provider || selection.provider || 'deepseek-account'),
      model: String(model?.model || selection.model || 'deepseek-flash'),
      messages: [{ role: 'user', content: [{ type: 'text', text: `【对方说】${String(text || '').slice(0, 600)}` }] }],
      temperature: 0.1,
      reasoningEffort: 'low',
      maxTokens: 1024,
    }
    const out = await streamJudge({ ...base, system })
    const scoreMatch = out.match(/"score"\s*:\s*(-?\d+)/)
    const whyMatch = out.match(/"why"\s*:\s*"([^"]*)"/)
    if (scoreMatch) {
      return {
        score: Math.max(-70, Math.min(70, parseInt(scoreMatch[1], 10))),
        why: String(whyMatch ? whyMatch[1] : '').slice(0, 40),
      }
    }
    // 兼容旧格式：模型只回了一个整数
    const n = out.match(/-?\d+/)
    if (!n) return { score: 0, why: '' }
    return { score: Math.max(-70, Math.min(70, parseInt(n[0], 10))), why: '' }
  }

  /**
   * 心情波动 = 原始分 × 程度系数 × 好感系数，两级放大。
   *
   * 程度分三档（先分级，不是所有喜欢/讨厌都一个系数）：
   *   |raw| ≤ 15  轻微  ×0.6
   *   16–40       明显  ×1.0
   *   41–70       强烈  ×1.3
   *
   * 好感只调节方向上的反差：
   *   负分：越亲近越痛  ×(0.6 + 0.8 * affection/100)
   *   正分：越疏远越抬  ×(1.4 - 0.8 * affection/100)
   */
  function swingMagnitudeFactor(raw) {
    const v = Math.abs(Number(raw) || 0)
    if (v <= 15) return 0.6
    if (v <= 40) return 1.0
    return 1.3
  }

  function applyAffectionBias(swing, affection) {
    const raw = Number(swing) || 0
    if (!raw) return 0
    const a = Math.min(100, Math.max(0, Number(affection) || 50)) / 100
    const affinity = raw < 0 ? 0.6 + 0.8 * a : 1.4 - 0.8 * a
    const factor = swingMagnitudeFactor(raw) * affinity
    return Math.max(-70, Math.min(70, Math.round(raw * factor)))
  }

  /**
   * 状态值 → 这一轮必须做到的表达动作。
   * 只加表达层的要求：不动人格文档，不动状态判定与衰减。
   * 目的：数值再中性也要让读的人听出情绪，而不是平铺直叙。
   */
  function emotionGuide(global, peer, swing = 0) {
    const g = global || {}
    const p = peer || {}
    const mood = Number.isFinite(Number(g.mood)) ? Number(g.mood) : 0.8
    const energy = Number.isFinite(Number(g.energy)) ? Number(g.energy) : 0.8
    const affection = effectiveAffection(p, swing).value
    const lines = []
    if (mood >= 0.7) {
      lines.push('情绪外显：情绪外放——短促句、感叹号、语气词连用，心情挂在明面上，允许显摆今天的好事。')
    } else if (mood >= 0.4) {
      lines.push(
        '情绪外显：情绪要露出来，禁止写成平铺直叙的陈述句；这一轮至少出现一处情绪标记（语气词、口癖、感叹号或反问），让人听得出你现在什么心情。',
      )
    } else if (mood >= 0.25) {
      lines.push('情绪外显：情绪往下压——句子变短，用省略号，话少，不用感叹号，语气收着。')
    } else {
      lines.push('情绪外显：低落——句子更短，省略号多，不想展开，不解释为什么。')
    }
    if (energy < 0.3) lines.push('精力低：懒、敷衍，能一句说完就别两句。')

    // 心情波动高 → 这一轮更激动：感叹号、语气词、允许一点语无伦次。
    // 按绝对值分档，按符号给方向；强度和持久人格分开，只限这一次。
    const intensity = Math.abs(Number(swing) || 0)
    // 被冒犯时发不发作，由 mood 决定：mood < 0.5 当场炸；≥ 0.5 压住不发作。
    // 无论哪种，都记仇——这笔账留在对话里，之后翻出来。
    const moodLow = Number(g.mood) < 0.5
    if (intensity >= 50) {
      if (Number(swing) > 0) {
        lines.push(
          '情绪强度（本次）：被强烈取悦——句子变短，感叹号明显变多，语气词连用（「真的假的」「你、你」），允许一点语无伦次：重复词、半句断掉、语序乱；但内容仍要听得懂，最多两句。结尾必须用标点把语气推上去：可以是「！！」、拖长的省略号，或一个上扬的反问；这一轮允许在结尾带一个符合人设的颜文字。',
        )
      } else if (moodLow) {
        lines.push(
          '情绪强度（本次）：被强烈冒犯，而且此刻心情本来就低——当场炸毛：这一轮要听见火气，至少两处感叹号，语气词连用，句子断着说，允许一点语无伦次；不要用冷处理的短句糊过去。可以骂，但只用符合这张脸人设的蔑称（大小姐型：臭虫、渣滓、蝼蚁、垃圾、人渣、败类、变态、废物），不用市井脏话、不碰家人外貌疾病、不涉性；最多两句，骂完就收。结尾用标点加重火气：连续的感叹号、拉长的省略号，或把话截断，让人听出被点着了。这笔账记下。',
        )
      } else {
        lines.push(
          '情绪强度（本次）：被强烈冒犯，但此刻心情还撑得住——不发作，把话压下去，语气变冷、句子变短，不给好脸也不吵；结尾用一个省略号或一个冷问号收住，不用感叹号。心里把这一笔记下，之后翻出来。',
        )
      }
    } else if (intensity >= 35) {
      if (Number(swing) > 0) {
        lines.push('情绪强度（本次）：明显高兴——可以多一个感叹号、一两处语气词重复，句子比平时短；结尾带个上扬的标点。')
      } else if (moodLow) {
        lines.push('情绪强度（本次）：明显不悦，心情也低——语气变冲，可以带一个感叹号，句子短，不铺陈；结尾别收得太软。这笔账记下。')
      } else {
        lines.push('情绪强度（本次）：明显不悦，但心情撑得住——不发作，语气冷下来、话变少；结尾用省略号收住。这笔账记下。')
      }
    } else if (intensity >= 20) {
      lines.push('情绪强度（本次）：情绪略起，语气比平时热或冷一点，不用刻意夸张。')
    }
    if (affection < 11) lines.push('关系最低档：敌意写在脸上，不给好脸色，别热络。')
    else if (affection < 31) lines.push('关系厌恶档：嫌弃、冷淡，不主动搭话。')
    else if (affection < 51) lines.push('关系疏离档：礼貌但保持距离，不主动热络。')
    else if (affection < 71) lines.push('关系别扭档：嘴硬着关心，找茬比直接关心多。')
    else lines.push('关系亲近档：可以主动提对方以前说过的事，关心藏在嫌弃里。')
    // 口癖和自称不随情绪收：安慰、低落、说正事时也要在
    lines.push('无论什么场景，这一轮至少出现一个口癖或句尾助词；情绪可以收，说话习惯不收。')
    // 结尾情绪收口：情绪高时必须用标点/颜文字收，平淡时才允许平铺
    const intenseMood = mood >= 0.7
    const intenseSwing = intensity >= 35
    if (intenseMood || intenseSwing) {
      lines.push('结尾必须收出情绪：感叹号、省略号、问号、波浪号或一个颜文字，按语境挑一个，不许用平铺直叙的陈述句结尾。')
    }
    if (Number(swing) > 45 && Number(g.mood) > 0.8) {
      lines.push('这一轮被强烈取悦：结尾要带一个符合人设的颜文字（九条凛可用 (￣へ￣) (｀へ´) (￣ω￣)），颜文字和表情包可以一起用。')
    }
    if (intensity >= 50 && Number(swing) < 0) {
      lines.push('这一轮被强烈冒犯：这一轮至少两个感叹号，结尾用感叹号或冷硬的省略号收住。')
    }
    lines.push(
      '这是表达要求，不是台词模板：别把这段念出来，也别用「我现在有点低落」这种直白报状态的话；用说法本身让人感觉到。',
    )
    if (p.why) lines.push(`这一轮的底色来自：${String(p.why).slice(0, 60)}`)
    return lines.join('\n')
  }

  async function judgePersonaState(agent) {
    if (config.personaState === false) return
    let platform = 'desktop'
    let personaId = ''
    let sid = ''
    let peer = ''
    try {
      platform = platformOf(agent.session)
      personaId = personaIdOf(platform)
      sid = sessionIdOf(agent.session)
      peer = peerOf(agent.session)
    } catch {
      return
    }
    if (!personaId || !peer || judging.has(sid || peer)) {
      stateLog(`judge 跳过：personaId=${personaId || '-'} peer=${peer || '-'} judging=${judging.has(sid || peer)}`)
      return
    }
    const turn = lastUserTurn(agent.session)
    if (!turn || !turn.text) {
      stateLog(`judge 跳过：没有真人消息（persona=${personaId} peer=${peer}）`)
      return
    }
    judging.add(sid)
    stateLog(`judge 开始：${personaId}/${peer} text=${turn.text.slice(0, 40)}`)
    try {
      const before = {
        global: stateStore.global(personaId),
        peer: stateStore.ensurePeer(personaId, peer, initialFor(peer)),
      }
      const setting = personaStateSection(personaId)
      const reply = lastReplyText(agent.session).slice(0, 600)
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() || {}
      const system = [
        `你是「${personaId}」这张面具人格的状态判定器：只判断这一轮之后，她的状态数值该往哪动。`,
        '你不是这张人格，不要扮演她、不要写她的台词、不要把对话续写下去。你是局外的评分器。',
        '只输出一行 JSON，不要 markdown、不要解释：{"mood":0,"energy":0,"affection":0,"today":"","why":"","episode":"","ownerFact":"","nickname":""}',
        '规则：',
        '- mood 是 0~1 的增量，单轮 -0.12 ~ 0.12（这张脸自己的心情，不分人）。',
        '- energy 单轮最多 -0.02（消耗很慢）；恢复由定时器负责，不要给正的 energy。',
        '- affection 是 0~100 的增量：减少单轮最多 -4；增加单次最多 +5，而且每个人每天累计最多 +15（长期关系，动得慢，别因为一句话跳档）。',
        '- 按下面【设定】里这张脸的性格判，别套别人的规则；大多轮次应该是小幅或 0，别硬凑。',
        '- 对方夸她、对她好、说自己的好消息 → mood 升；按设定她会不会被冒犯/记仇，被冷落、敷衍、冒犯 → mood 降。',
        '- 说正事、干活、中性提问 → 通常 mood 不变、energy 小降（消耗）；对方认真道谢、陪她闲聊 → energy 小升。',
        '- affection 只在「关系上有意义」的事上动：主动关心、记得她的事、道歉、长期陪伴 → 升；冒犯、敷衍、消失 → 降。',
        '- 对方主动聊到她喜欢的话题，affection 加 0~1（按话题贴不贴，别一聊就加满）；聊到她讨厌的话题，减 1~3；只是观点不同不算。',
        '- 重复与否只看【重复判定】的程序结果：new 就不许写「又说一遍」「重复」；same/similar 可以提重复，但不要说第几遍。',
        '- today：只有对方这轮说了自己今天发生了什么才填一句 ≤20 字，否则空串。',
        '- why：一句 ≤30 字，写清是哪句话让她怎么动；没变化就空串。',
        '- episode：这一轮值得留下的经历，一句话 ≤50 字，写「对方做了什么、她怎么应的」；寒暄、重复问、没有信息的轮次留空，别凑。',
        '- ownerFact：这一轮透露的、关于对方且值得长期记住的事实（偏好、约定、身份、重要的事），≤40 字；没把握就留空，别把随口的话当事实。',
        '- nickname：只有对方明确说了「叫我 XX」「以后叫我 XX」时才填，填他指定的昵称或名字；「老婆」「老公」「亲爱的」「爸爸」「主人」这类身份词一律不填，留空。没有就空串。',
        '',
        '【设定】',
        setting || '（这张脸没写状态节，按她平时的语气判。）',
        '',
        `【当前】mood=${before.global.mood.toFixed(2)} energy=${before.global.energy.toFixed(2)} affection=${before.peer.affection}`,
        '',
        ...(() => {
          const history = recentDialogue(agent.session, 4, { excludeCurrent: true })
          const hint = repeatHint(history, turn.text)
          return hint === 'new'
            ? ['【重复判定】new（程序比对：这句没出现过）', '本次不提供对话历史：不许提「重复」「又说一遍」「重发」']
            : [`【重复判定】${hint}（程序比对）`, '【最近对话】', ...history.map((h) => `${h.role}：${h.text}`)]
        })(),
        '',
        `【对方说】${turn.text.slice(0, 800)}`,
        reply ? `【她回】${reply}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      const route = modelOf(agent) || {}
      const base = {
        provider: String(route.provider || selection.provider || 'deepseek-account'),
        model: String(route.model || selection.model || 'deepseek-flash'),
        messages: [{ role: 'user', content: [{ type: 'text', text: turn.text.slice(0, 800) }] }],
        temperature: 0.2,
        reasoningEffort: 'low',
        maxTokens: 4096,
      }
      const raw = await streamJudge({ ...base, system })
      const delta = parseStateReply(raw)
      stateLog(`judge 模型输出：${raw.slice(0, 120).replace(/\n/g, ' ')} → ${delta ? 'ok' : 'parse失败'}`)
      if (!delta) return
      const swingNow = activeSwing(peer)
      const next = stateStore.apply(personaId, peer, { ...delta, swing: swingNow })
      // 波动只活这一轮，回复判完就清。
      swingCache.delete(peer)
      stateLog(`judge 落盘：mood=${next.global.mood} energy=${next.global.energy} affection=${next.peer.affection}`)
      const beforeAffection = before.peer.affection
      console.log(
        `[dsh-self] 人格状态 ${personaId}/${peer}：mood ${before.global.mood.toFixed(2)}→${next.global.mood.toFixed(2)} energy ${before.global.energy.toFixed(2)}→${next.global.energy.toFixed(2)} affection ${beforeAffection}→${next.peer.affection}${delta.why ? `（${delta.why}）` : ''}`,
      )

      // 记忆交互：戴着哪张脸说话，这一轮就归哪张脸；关于对方的事实归屿（跨脸共享）。
      // 这是既定规则的一半——只读不写，脸就永远没有自己的经历。
      if (delta.episode) {
        try {
          memory.addEpisode({
            subjectId: subjectOf(),
            summary: delta.episode,
            platform,
            conversationId: sid,
            visibility: 'private',
            personaId: `persona:${personaId}`,
          })
        } catch (error) {
          console.error('[dsh-self] 人格经历写入失败：', error)
        }
      }
      if (delta.ownerFact) {
        try {
          const r = memory.addFact({
            subjectId: subjectOf(),
            content: delta.ownerFact,
            scope: 'person',
            importance: 0.6,
            confidence: 0.7,
            visibility: isGroupSession(agent.session) ? 'private' : 'normal',
            source: { platform, conversationId: sid, ts: Math.floor(Date.now() / 1000) },
            personaId: null,
          })
          if (!r.ok) console.log('[dsh-self] 关于对方的事实没记：', r.reason)
        } catch (error) {
          console.error('[dsh-self] 事实写入失败：', error)
        }
      }
    } catch (error) {
      stateLog(`judge 失败：${String(error?.message || error)}`)
      console.error('[dsh-self] 人格状态判定失败：', error)
    } finally {
      judging.delete(sid)
      // 波动只活这一轮，不管判定成功还是失败都要清，免得上一条的情绪漏到下一轮。
      if (peer) swingCache.delete(peer)
    }
  }

  // 统一计时：一个调度器管所有按时发生的事，别散成好几个 interval。
  //   1) 启动后第一次对齐到下一个凌晨 05:00：重置 mood / energy + 跑一次好感衰减；
  //   2) 之后每小时检测一次好感衰减（没满 24 小时的人不会被扣）。
  function msUntilNext5am(at = Date.now()) {
    const d = new Date(at)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0, 0, 0)
    if (next.getTime() <= at) next.setDate(next.getDate() + 1)
    return next.getTime() - at
  }

  function runAffectionSweep(label) {
    try {
      const changed = stateStore.decayAffectionAll()
      if (changed.length) console.log(`[dsh-self] ${label} 好感衰减：${changed.join(', ')}`)
    } catch (error) {
      console.error('[dsh-self] 好感衰减失败：', error)
    }
  }

  function runEnergyRegen() {
    try {
      const changed = stateStore.regenEnergyAll()
      if (changed.length) console.log(`[dsh-self] energy 恢复：${changed.join(', ')}`)
    } catch (error) {
      console.error('[dsh-self] energy 恢复失败：', error)
    }
  }

  function runDailyReset() {
    try {
      const changed = stateStore.resetDailyAll()
      if (changed.length) console.log(`[dsh-self] 每日状态重置：${changed.join(', ')}`)
    } catch (error) {
      console.error('[dsh-self] 每日状态重置失败：', error)
    }
    runAffectionSweep('每日')
  }

  try {
    let dailyTimer = null
    let hourlyTimer = null
    const armDaily = () => {
      const wait = msUntilNext5am()
      dailyTimer = setTimeout(() => {
        runDailyReset()
        armDaily()
      }, wait)
    }
    armDaily()
    hourlyTimer = setInterval(() => {
      runAffectionSweep('每小时')
      runEnergyRegen()
    }, 60 * 60 * 1000)
    ctx.effect(() => () => {
      clearTimeout(dailyTimer)
      clearInterval(hourlyTimer)
    })
    console.log(`[dsh-self] 状态调度已启动：${Math.round(msUntilNext5am() / 60000)} 分钟后每日重置，之后每小时检测好感衰减`)
  } catch (error) {
    console.error('[dsh-self] 状态调度启动失败：', error)
  }

  // ---------- 面具渲染 ----------

  /**
   * 屿想清楚 -> 面具说出来。
   * 只改语气/句长/用词，不改事实、数字、结论；面具为空（桌面）时原样返回。
   */
  async function renderMask(text, platform) {
    const raw = String(text || '').trim()
    if (!raw) return raw
    const mask = store.maskBlock(platform)
    if (!mask) return raw
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() || {}
      const provider = String(selection.provider || 'deepseek-account')
      const model = String(selection.model || 'deepseek-flash')
      const system = [
        '你是「面具渲染器」。下面【面具】规定出口的说话方式；【原话】是屿想表达的内容。',
        '把原话改写成这个面具角色会说出来的成品：',
        '- 必须用面具的句长、用词、节奏重写；哪怕原话已经通顺，也不许原样返回；',
        '- 只改说法，不改事实、数字、结论、称呼、意图；不加新事实，不删关键事实；',
        '- 不加解释、不加旁白、不加引号；',
        '- 原话里 [[表情: …]] 这种标记必须原样保留（连同双方括号），放在最后一行；不许改写成单方括号、不许翻译、不许删；',
        '- 汇报/长内容也要用面具口吻，只是允许更长；不要写成分析报告，不要用「我的判断」这种书面语；',
        '- 闲聊按面具的短句习惯；',
        '- 直接输出成品文本。',
        '',
        '【面具】',
        mask,
      ].join('\n')
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: raw }] }],
        temperature: 0.7,
        maxTokens: 600,
      })) {
        if (chunk.type === 'text-delta') chunks.push(String(chunk.text || ''))
        if (chunk.type === 'finish') break
      }
      const out = chunks.join('').trim()
      return out || raw
    } catch (error) {
      console.error('[dsh-self] 面具渲染失败：', error)
      return raw
    }
  }

  // ---------- 工具 ----------

  ctx.tools.register(
    defineTool({
      name: 'autonomy_status',
      description: '查看自主时间：专用会话和每小时心跳是否存在、下次什么时候。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute() {
        const schedule = ctx.get?.('schedule')
        let sessionId = ''
        try {
          sessionId = String(JSON.parse(readFileSync(join(root, 'autonomy-session.json'), 'utf8')).sessionId || '')
        } catch {
          sessionId = ''
        }
        if (!sessionId) return { ok: false, message: '还没有专用自主会话' }
        if (!schedule?.catalog && !schedule?.list) return { ok: false, message: 'schedule 服务不可用' }
        let list = []
        try {
          list = await listAutonomySchedules(schedule, sessionId)
        } catch (error) {
          return { ok: false, message: `读取自主心跳失败：${String(error?.message || error)}` }
        }
        const auto = list.filter((x) => x?.title === '自主时间')
        return {
          ok: auto.length > 0,
          sessionId,
          schedules: auto,
          prompt: auto[0]?.prompt || '',
          message: auto.length
            ? `自主时间在跑：${sessionId}\n${auto.map((x) => `${x.kind} ${x.everySeconds || ''}s · 下次 ${x.scheduledAt}`).join('\n')}`
            : `专用会话在，但心跳不在：${sessionId}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_status',
      description:
        '查看屿当前的人格版本、面具、与缔造者的关系摘要、记忆条数与数据目录。用来确认「我现在是谁、记得多少」。',
      parameters: { platform: { type: 'string', description: '可选：只看某个平台面具（desktop/qq/bilibili）' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const platform = String(args?.platform || platformOf(exec?.agent?.session))
        const st = store.status()
        const counts = memory.counts()
        const owner = memory.owner()
        const personaId = personaIdOf(platform)
        const personaMemory = personaId ? store.personaMemory(personaId) : []
        const lines = [
          `${st.name} · 人格 v${st.version} · 面具 ${platform}`,
          `数据：${st.dir}`,
          `记忆：${counts.facts} 条事实 / ${counts.episodes} 段经历 / ${counts.people} 个人 / ${counts.tombstones} 条已忘`,
          personaId ? `人格记忆：${personaId} 自己 ${personaMemory.length} 条（外加屿的记忆）` : '人格记忆：桌面不戴人格，只有屿的记忆',
          `面具：${st.masks.join(' / ')}`,
          `面具人格：${st.persona}（可选 ${st.personas.join(' / ')}）`,
          owner ? `缔造者：${owner.display_name || owner.id}（${owner.accounts.map((a) => a.platform).join('/')}）` : '缔造者：未绑定',
        ]
        if (migration?.ok) lines.push(`迁移：${JSON.stringify(migration.counts)}`)
        return { ok: true, message: lines.join('\n'), status: { ...st, counts, platform, personaMemory: personaMemory.length } }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_read',
      description:
        '读取自己的人格文件：core（内核）、mask（某个平台面具）、relation（与缔造者的关系）、growth（成长札记）、changelog（变更记录）。',
      parameters: {
        section: { type: 'string', description: 'core / mask / relation / growth / changelog / all，默认 all', enum: ['core', 'mask', 'relation', 'growth', 'changelog', 'all'] },
        platform: { type: 'string', description: '读 mask 时的平台，默认 desktop' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const section = String(args?.section || 'all')
        const platform = String(args?.platform || platformOf(exec?.agent?.session))
        const data = store.read(section, platform)
        const parts = []
        if (data.core) parts.push(`# core\n${data.core}`)
        if (data.relation) parts.push(`# relation\n${data.relation}`)
        if (data.mask !== undefined) parts.push(`# mask:${data.platform}\n${data.mask}`)
        const personaId = personaIdOf(platform)
        const personaText = personaId ? store.personaText(personaId) : ''
        if (section === 'all' || section === 'mask') {
          parts.push(
            personaId
              ? `# persona:${personaId}\n${personaText || '（没有正文，只有记忆）'}`
              : '# persona\n（桌面是屿本人，不戴任何人格层）',
          )
          if (personaId) {
            const memories = store.personaMemory(personaId)
            parts.push(
              memories.length
                ? `# persona-memory:${personaId}（${memories.length} 条）\n${memories.map((m) => `- [${m.kind || 'self'}] ${m.text}`).join('\n')}`
                : '# persona-memory\n（这张脸还没有自己的记忆）',
            )
          }
        }
        if (data.growth) parts.push(`# growth\n${data.growth.map((g) => `- ${g.at ? `${g.at} ` : ''}${g.text}`).join('\n')}`)
        if (data.changelog) parts.push(`# changelog\n${data.changelog}`)
        return { ok: true, message: parts.join('\n\n') || '（空）', data }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_revise',
      description:
        '修改自己的人格并落盘：target=core 改内核，mask 改平台面具（要给 platform），relation 改与缔造者的关系。mode=append 追加、replace 整体替换。每次都会升版本、存旧版本快照、写 changelog。只应在缔造者明确要求或他自己纠正你时使用。',
      parameters: {
        target: { type: 'string', description: 'core / mask / relation', enum: ['core', 'mask', 'relation'] },
        platform: { type: 'string', description: 'target=mask 时必填：desktop / qq / bilibili' },
        mode: { type: 'string', description: 'append（默认）或 replace', enum: ['append', 'replace'] },
        content: { type: 'string', description: '要写入的内容；append 时是追加的一段，replace 时是全文' },
        reason: { type: 'string', description: '为什么改（会写进 changelog，便于以后回滚）' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args) {
        const result = store.revise({
          target: String(args?.target || ''),
          platform: args?.platform ? String(args.platform) : undefined,
          mode: String(args?.mode || 'append'),
          content: String(args?.content || ''),
          reason: String(args?.reason || ''),
          actor: 'creation',
        })
        if (!result.ok) return { ok: false, message: `没改成：${result.reason}`, ...result }
        return {
          ok: true,
          ...result,
          message: `改好了，人格升到 v${result.version}（旧版快照 ${result.snapshot}）。目标：${result.target}。`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_revert',
      description:
        '把人格回滚到某个历史版本（版本号来自 self_status 或 changelog）。回滚前会先把当前版本快照一份，回滚本身也升一个新版本，可在 changelog 里看到。',
      parameters: {
        version: { type: 'number', description: '要回到的版本号，例如 1' },
        reason: { type: 'string', description: '为什么回滚（写进 changelog）' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args) {
        const r = store.revert({ version: Number(args?.version), reason: String(args?.reason || '') })
        return r.ok
          ? { ok: true, ...r, message: `回到 v${r.revertedTo}，现在是 v${r.version}（回滚前的快照：${r.snapshot}）。` }
          : { ok: false, ...r, message: `没回滚成：${r.reason}` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_persona',
      description:
        '看或切换面具人格（大肥鱼 / 溟月 / 以后新增的）。只换说话的人格层，内核仍是屿；不传 id 只读列表和当前项。',
      parameters: {
        id: { type: 'string', description: '要切到的人格 id：大肥鱼=dafeiyu（默认）、溟月=mingyue' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const id = String(args?.id || '').trim()
        if (id) {
          const result = store.setPersona(id)
          // 换到一张新脸时，顺手把它的记忆档案补上。
          if (result.ok) store.ensurePersonaMemory(id)
          if (!result.ok) {
            return {
              ok: false,
              message:
                result.reason === 'unknown_persona'
                  ? `没有叫 ${id} 的人格层。现有：${store.personas().join(' / ')}`
                  : `切不了：${result.reason}`,
            }
          }
        }
        const current = store.activePersona()
        const list = store.personas().map((x) =>
          x === DEFAULT_PERSONA_ID ? `${x}（默认）` : x,
        )
        return {
          ok: true,
          persona: current,
          personas: store.personas(),
          message: `当前面具人格：${current}\n可选：${list.join('；')}${id ? '\n已切换，下一次说话就换口吻。' : ''}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_mask',
      description:
        '看或切当前会话的面具。不传 mask 就只读；传了就把这个会话固定成该面具（desktop/qq/bilibili/tieba）。换平台请换会话，不要在同一个会话里假装是另一个平台。',
      parameters: { mask: { type: 'string', description: '可选：desktop / qq / bilibili / tieba；不传=只读', enum: ['desktop', 'qq', 'bilibili', 'tieba'] } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const sid = sessionIdOf(exec?.agent?.session)
        const auto = channelOfSession(exec?.agent?.session)
        if (!args?.mask) {
          const current = memory.maskFor(sid, auto)
          return { ok: true, mask: current, auto, message: `当前会话面具：${current}（自动识别：${auto}）` }
        }
        const next = String(args.mask)
        if (!store.masks().includes(next)) return { ok: false, message: `没有面具 ${next}` }
        memory.setMask(sid, next)
        return { ok: true, mask: next, message: `面具切成 ${next}。表达会跟着变，内核不变。` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_remember',
      description:
        '把一条值得长期记住的事实写进自己的记忆（跨会话、跨平台）。用于缔造者的偏好、约定、重要经历、他明确说「记住」的事。日常琐事不要记。敏感信息（密码/验证码/token/cookie/身份证等）会被拒绝。',
      parameters: {
        content: { type: 'string', description: '一条事实，尽量短、具体，例如「他喜欢喝美式，不加糖」' },
        kind: { type: 'string', description: 'fact（默认，长期事实）或 episode（一段经历）', enum: ['fact', 'episode'] },
        scope: { type: 'string', description: 'person（关于他，默认）/ self（关于我自己）/ context（只在这个上下文里）', enum: ['person', 'self', 'context'] },
        context_key: { type: 'string', description: 'scope=context 时的上下文键，例如某个群或某个视频' },
        importance: { type: 'number', description: '0～1，重要性，默认 0.6' },
        visibility: { type: 'string', description: 'normal（默认）/ private（只在私聊用）', enum: ['normal', 'private'] },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const session = exec?.agent?.session
        const platform = platformOf(session)
        // 谁经历的归谁：关于缔造者的事实留在屿那里（跨面具共享），
        // 关于「我自己」和上下文的经历记在戴着的这张脸下。
        const scope = String(args?.scope || 'person')
        const personaId = scope === 'person' ? null : personaOwnerOf(platform) || null
        if (String(args?.kind || 'fact') === 'episode') {
          const r = memory.addEpisode({
            subjectId: subjectOf(),
            summary: String(args?.content || ''),
            platform,
            conversationId: sessionIdOf(session),
            visibility: String(args?.visibility || 'private'),
            personaId,
          })
          return r.ok ? { ok: true, ...r, message: '记下了这段经历。' } : { ok: false, ...r, message: `没记住：${r.reason}` }
        }
        const r = memory.addFact({
          subjectId: subjectOf(),
          content: String(args?.content || ''),
          scope,
          contextKey: args?.context_key ? String(args.context_key) : null,
          importance: Number(args?.importance ?? 0.6),
          confidence: 0.7,
          // 群会话里记的东西默认 private，避免下次在群里被自己复述。
          visibility: String(args?.visibility || (isGroupSession(session) ? 'private' : 'normal')),
          source: { platform, conversationId: sessionIdOf(session), ts: Math.floor(Date.now() / 1000) },
          personaId,
        })
        if (!r.ok) return { ok: false, ...r, message: `没记住：${r.reason}` }
        return { ok: true, ...r, message: r.merged ? '这条我本来就知道，补了个来源。' : '记住了。' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_recall',
      description: '按线索从自己的长期记忆里找事实和最近经历。想不起对方说过什么、之前约定过什么时用。',
      parameters: {
        query: { type: 'string', description: '线索关键词或一句话；不传就按重要性取' },
        limit: { type: 'number', description: '返回条数，默认 8' },
        allow_private: { type: 'boolean', description: '是否包含 private 记忆，默认 true' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const session = exec?.agent?.session
        const platform = platformOf(session)
        const personaIds = personaOwnersOf(platform)
        const facts = memory.recall({
          subjectId: subjectOf(),
          cue: String(args?.query || ''),
          platform,
          limit: Number(args?.limit || 8),
          allowPrivate: args?.allow_private !== false,
          personaIds,
        })
        const eps = memory.recentEpisodes({ subjectId: subjectOf(), limit: 3, personaIds })
        // 人格档案里的记忆（jsonl）不进数据库，直接带出来，和事实一起给。
        const personaId = personaIdOf(platform)
        const personaMemory = personaId ? store.personaMemory(personaId) : []
        const lines = facts.map((f) => `#${f.id} ${f.content}（${f.scope}，重要度 ${f.importance}）`)
        if (eps.length) lines.push('--- 最近经历 ---', ...eps.map((e) => `- ${e.summary}`))
        if (personaMemory.length) {
          lines.push(`--- ${personaId} 的人格记忆 ---`, ...personaMemory.map((m) => `- ${m.text}`))
        }
        return { ok: true, facts, episodes: eps, persona: personaId, personaMemory, message: lines.join('\n') || '（没找到相关的）' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_forget',
      description: '忘掉一条记忆（按 self_recall 返回的 id）。会写 tombstone，防止以后又从对话里学回来。',
      parameters: { id: { type: 'number', description: '事实 id，来自 self_recall' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args) {
        const r = memory.forget(Number(args?.id))
        return r.ok ? { ok: true, ...r, message: `忘了 #${r.id}。` } : { ok: false, ...r, message: `没忘成：${r.reason}` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_update',
      description:
        '改一条已有记忆（按 self_recall 返回的 id）：写入新值，旧记录标记为被取代、不再召回，但保留可追溯。用于「搬家了」「换工作了」这类变化，而不是删了重记。',
      parameters: {
        id: { type: 'number', description: '旧事实 id' },
        content: { type: 'string', description: '新的说法' },
        importance: { type: 'number', description: '可选：新的重要度 0～1' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args) {
        const r = memory.updateFact(Number(args?.id), {
          content: String(args?.content || ''),
          importance: args?.importance === undefined ? null : Number(args.importance),
        })
        return r.ok
          ? { ok: true, ...r, message: `改好了：#${r.superseded} 被 #${r.id} 取代，旧的不再召回。` }
          : { ok: false, ...r, message: `没改成：${r.reason}` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_grow',
      description:
        '记一条成长札记：真实浏览/对话之后，你对人、对事、对自己的认识被修正了什么。target=core（默认）进内核的「成长札记」；target=mask 只留档、不进内核，用于以后改面具；target=platform 是平台侧观察。宁缺毋滥，一天一两条就够。',
      parameters: {
        text: { type: 'string', description: '一句话，具体，例如「我发现他嘴上说随便，其实对界面细节很在意」' },
        source: { type: 'string', description: '来源：conversation / bilibili / qq / work', enum: ['conversation', 'bilibili', 'qq', 'work'] },
        target: { type: 'string', description: '作用对象：core（默认，内核）/ mask（只留档，不进内核）/ platform', enum: ['core', 'mask', 'platform'] },
        evidence: { type: 'string', description: '可选：证据（BV 号、时间点、原话片段）' },
        ref: { type: 'string', description: '可选：来源 id（手账 id、链接）' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args) {
        const r = store.addGrowth({
          text: String(args?.text || ''),
          source: String(args?.source || 'conversation'),
          target: String(args?.target || 'core'),
          evidence: String(args?.evidence || ''),
          ref: String(args?.ref || ''),
        })
        return r.ok ? { ok: true, ...r, message: '札记记下了。' } : { ok: false, ...r, message: `没记成：${r.reason}` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_whois',
      description: '查一个人：平台账号映射、关系、关于他的事实。用于确认对方是不是缔造者、以前聊过什么。',
      parameters: {
        platform: { type: 'string', description: 'qq / bilibili / desktop' },
        uid: { type: 'string', description: '平台账号 id' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args) {
        const platform = String(args?.platform || '')
        const uid = String(args?.uid || '')
        if (!platform || !uid) return { ok: false, message: '要给 platform 和 uid' }
        const row = memory.db.prepare('SELECT * FROM account WHERE platform=? AND platform_uid=?').get(platform, uid)
        if (!row) return { ok: true, found: false, message: '记忆里没有这个账号。' }
        const person = memory.person(row.person_id)
        const facts = memory.recall({ subjectId: row.person_id, limit: 8 })
        return {
          ok: true,
          found: true,
          person,
          facts,
          message: `${person.display_name || person.id}（${person.role}）\n${facts.map((f) => `- ${f.content}`).join('\n') || '还没有关于他的事实'}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'platform_health',
      description:
        '看各平台连接是否正常（NapCat、AstrBot、QQ 桥、B站私信桥、B站登录）。action=check 立刻重新体检一次；DSH 启动时和之后每隔几分钟会自动体检。',
      parameters: {
        action: { type: 'string', enum: ['status', 'check'], description: 'status 看最近一次，check 重新体检' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        if (String(args?.action || 'status') === 'check') {
          try {
            await checkPlatforms()
          } catch (error) {
            return { ok: false, message: `体检失败：${String(error?.message || error)}` }
          }
        }
        const h = lastHealth
        if (!h) return { ok: true, health: null, message: '还没体检过。' }
        const lines = Object.entries(h.targets).map(([k, v]) => `${markOf(v)} ${k}：${v.detail}`)
        return {
          ok: true,
          health: h,
          message: [
            `总体：${h.overall}${h.repaired ? '（刚做过修复）' : ''}`,
            ...lines,
            `体检时间：${new Date(h.at * 1000).toLocaleString('zh-CN')}`,
          ].join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'self_state',
      description:
        '查看面具人格的状态管线：当前会话这张脸的 mood / energy / affection / today，以及每张脸存了几份状态。桌面是屿本人，没有状态。',
      parameters: {
        persona: { type: 'string', description: '可选：人格 id（dafeiyu / jiutiaolin / mingyue / shuyu），默认当前会话的人格' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const platform = platformOf(exec?.agent?.session)
        const current = personaIdOf(platform)
        const id = String(args?.persona || current || '').trim()
        if (!id) return { ok: false, message: '桌面是屿本人，不戴人格，没有状态。' }
        if (!store.personas().includes(id)) {
          return { ok: false, message: `没有叫 ${id} 的人格层。现有：${store.personas().join(' / ')}` }
        }
        const peer = peerOf(exec?.agent?.session || {})
        const g = stateStore.global(id)
        const peers = stateStore.readAll(id).peers
        const mine = peer ? stateStore.peer(id, peer, initialFor(peer)) : null
        const lines = [`人格：${id}`, `已有对象：${Object.keys(peers).length} 个`]
        if (mine) {
          lines.push(
            `这张脸：mood ${g.mood.toFixed(2)} / energy ${g.energy.toFixed(2)}（所有人共享）`,
            `这个人（${peer}）：affection ${mine.affection}${mine.today ? ` / 今天：${mine.today}` : ''}`,
          )
        } else {
          lines.push('这个人：还没有状态（第一次说话后才会建）')
        }
        for (const [key, raw] of Object.entries(peers).slice(0, 8)) {
          const mood = Number(raw.mood || 0)
          const energy = Number(raw.energy || 0)
          lines.push(
            `· ${String(key).slice(0, 20)} · affection ${Number(raw.affection)}${raw.why ? ` · ${raw.why}` : ''}`,
          )
        }
        return { ok: true, persona: id, state: mine, peers, message: lines.join('\n') }
      },
    }),
  )

  // ---------- 提示词 ----------

  // 稳定部分进系统提示词：核心人格 + 关系 + 成长札记。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'self-core',
      order: 900,
      text: () => store.coreBlock(),
    }),
  )

  // 平台体检结果进提示词：让我每轮都知道路通不通，不用现测。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'platform-health',
      order: 910,
      text: () => `【平台】${healthBadge(lastHealth)}`,
    }),
  )

  // 每个会话按渠道挂面具与记忆；per-agent section 只影响这个会话，且稳定段能吃到前缀缓存。
  const mounted = new Map()

  function mount(agent, sid) {
    const offs = []
    try {
      offs.push(
        agent.ctx.systemPrompt.section({
          name: 'self-mask',
          order: 910,
          text: () => store.maskBlock(platformOf(agent.session)),
        }),
      )
    } catch (error) {
      console.error('[dsh-self] 面具段挂不上：', error)
    }
    // 人格记忆是稳定的档案（jsonl），和人格层一样放 section，吃前缀缓存。
    try {
      offs.push(
        agent.ctx.systemPrompt.section({
          name: 'self-persona-memory',
          order: 915,
          text: () => store.personaMemoryBlock(platformOf(agent.session)),
        }),
      )
    } catch (error) {
      console.error('[dsh-self] 人格记忆段挂不上：', error)
    }
    // 人格状态：只给对外平台；桌面是屿本人，不挂。变化才换文本，别每轮重写。
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'self-persona-state',
          order: 918,
          text: () => {
            const platform = platformOf(agent.session)
            const id = personaIdOf(platform)
            if (!id) return ''
            const turnPeer = currentTurnPeer(sessionIdOf(agent.session))
            const peer = turnPeer || peerOf(agent.session)
            if (!peer) return ''
            const g = stateStore.global(id)
            // 组装时只读不写：这会儿消息可能还没进会话，peer 会退化成 session:xxx，
            // 用 ensurePeer 会顺手建一条脏记录（2026-11-02 真踩到）。
            const p = stateStore.peer(id, peer, initialFor(peer))
            const swing = activeSwing(peer)
            return `${stateBlock(id, g, p, swing)}\n${emotionGuide(g, p, swing)}`
          },
        }),
      )
    } catch (error) {
      console.error('[dsh-self] 人格状态段挂不上：', error)
    }
    // 每轮结束判一次。turn-stopping 是 agent 作用域事件，必须挂在这个 agent 的 ctx 上，
    // 全局 ctx.on 收不到；随 mount 的 disposer 一起撤销。
    try {
      offs.push(
        agent.ctx.on('agent/turn-stopping', () => {
          stateLog(`turn-stopping 触发：${sessionIdOf(agent.session).slice(0, 12)}`)
          void judgePersonaState(agent)
        }),
      )
    } catch (error) {
      console.error('[dsh-self] 人格状态钩子挂不上：', error)
    }
    if (config.injectMemory) {
      try {
        offs.push(
          agent.ctx.systemPrompt.context({
            name: 'self-memory',
            order: 920,
            // 不按当前这句话做动态召回：context 每变一次，宿主就往历史里追加一条快照。
            // 这里只放稳定的“长期记得的事”，具体的事让模型用 self_recall 主动查。
            text: () => {
              const block = memory.memoryBlock({
                subjectId: subjectOf(),
                cue: '',
                platform: platformOf(agent.session),
                limit: config.memoryLimit,
                // 群会话不注入 private：私聊里记住的事不能在群里被念出来。
                allowPrivate: !isGroupSession(agent.session),
                // 屿的记忆 + 当前人格的记忆；其他面具的看不到。
                personaIds: personaOwnersOf(platformOf(agent.session)),
              })
              return block ? `${block}\n（要查更具体的事，用 self_recall；这里只放长期记得的。）` : ''
            },
          }),
        )
      } catch (error) {
        console.error('[dsh-self] 记忆段挂不上：', error)
      }
    }
    return () => {
      for (const off of offs) {
        try {
          if (typeof off === 'function') off()
        } catch {
          /* ignore */
        }
      }
    }
  }

  function tick() {
    const list = ctx.agents.list() || []
    const alive = new Set()
    for (const agent of list) {
      const sid = sessionIdOf(agent.session)
      if (!sid) continue
      alive.add(sid)
      // 以 agent 实例为键，不是以 sessionId 为键：会话从磁盘恢复或压缩后会换一个 agent，
      // sessionId 不变，只按 sid 去重就会一直跳过重挂，面具/记忆/状态段全丢（2026-11-02 抓到）。
      const hit = mounted.get(sid)
      if (hit && hit.agent === agent) continue
      if (hit) {
        try {
          hit.off()
        } catch {
          /* ignore */
        }
        mounted.delete(sid)
      }
      try {
        mounted.set(sid, { agent, off: mount(agent, sid) })
      } catch (error) {
        console.error('[dsh-self] 挂载失败：', error)
      }
    }
    for (const [sid, v] of mounted) {
      if (alive.has(sid)) continue
      try {
        v.off()
      } catch {
        /* ignore */
      }
      mounted.delete(sid)
    }
  }

  // 给 dsh-qq 的投递前入口：挂载人格段 + 算心情波动。
  // 双通道注册：cordis 服务（有就注册）+ globalThis（同进程一定可用）。
  // 之前只靠 ctx.provide，如果这个 API 不存在，dsh-qq 就永远拿不到，swing 会一直是 0。
  function ensureMounted(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return false
    const agent = (ctx.agents.list() || []).find((a) => sessionIdOf(a.session) === sid)
    if (!agent) return false
    const hit = mounted.get(sid)
    if (hit && hit.agent === agent) return true
    if (hit) {
      try {
        hit.off()
      } catch {
        /* ignore */
      }
    }
    try {
      mounted.set(sid, { agent, off: mount(agent, sid) })
      return true
    } catch (error) {
      stateLog(`投递前挂载失败：${error?.message || error}`)
      return false
    }
  }

  async function prepareSwing(peerKey, text, sessionId) {
    try {
      const peer = String(peerKey || '')
      const body = String(text || '').trim()
      if (!peer || !body) return 0
      const platform = peer.startsWith('bilibili:') ? 'bilibili' : 'qq'
      const personaId = personaIdOf(platform)
      if (!personaId) {
        stateLog(`swing 跳过：平台 ${platform} 没有人格映射`)
        return 0
      }
      const p = stateStore.ensurePeer(personaId, peer, initialFor(peer))
      const sid = String(sessionId || '')
      const agent = sid ? (ctx.agents.list() || []).find((a) => sessionIdOf(a.session) === sid) : null
      const history = agent ? recentDialogue(agent.session, 4) : []
      const verdict = await judgeSwing({
        personaId,
        setting: personaStateSection(personaId),
        affection: p.affection,
        text: body,
        history,
        model: agent ? modelOf(agent) : null,
      })
      const raw = verdict.score
      const swing = applyAffectionBias(raw, p.affection)
      swingCache.set(peer, { swing, raw, turn: 0, at: Date.now() })
      stateLog(
        `swing 判定：${peer} raw=${raw} → ${swing}（好感 ${p.affection}）${verdict.why ? ` why=${verdict.why}` : ''}`,
      )
      return swing
    } catch (error) {
      stateLog(`swing 失败：${String(error?.message || error)}`)
      return 0
    }
  }

  // 本轮发送者：prompt 组装时当前消息还没进会话，peerOf 会退化成上一条/会话级，
  // 所以由 dsh-qq 在 prompt 前显式登记一次，注入时优先用这个。
  const turnPeerCache = new Map()
  function setTurnPeer(sid, peer) {
    const key = String(sid || '')
    const value = String(peer || '')
    if (!key || !value) return false
    turnPeerCache.set(key, { peer: value, at: Date.now() })
    for (const [k, v] of turnPeerCache) {
      if (Date.now() - v.at > 10 * 60 * 1000) turnPeerCache.delete(k)
    }
    return true
  }
  function currentTurnPeer(sid) {
    const key = String(sid || '')
    const hit = turnPeerCache.get(key)
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.peer
    return ''
  }

  const selfPersonaApi = { ensureMounted, prepareSwing, setTurnPeer }
  let provideOk = false
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('selfPersona', selfPersonaApi)
      provideOk = true
    }
  } catch (error) {
    stateLog(`ctx.provide 注册失败：${error?.message || error}`)
  }
  try {
    globalThis.__dshSelfPersona = selfPersonaApi
  } catch (error) {
    stateLog(`globalThis 注册失败：${error?.message || error}`)
  }
  stateLog(`selfPersona 已注册：provide=${provideOk} global=true`)

  tick()
  try {
    // 500ms：新会话要尽快挂上人格段。3 秒轮询时，陌生人的第一句私聊常常裸奔（首轮跑得比 tick 快）。
    ctx.effect(() => ctx.interval(tick, 500))
  } catch (error) {
    console.error('[dsh-self] 定时器不可用：', error)
  }
  ctx.effect(() => () => {
    for (const v of mounted.values()) {
      try {
        v.off()
      } catch {
        /* ignore */
      }
    }
    mounted.clear()
    memory.close()
  })

  // 给调试/后续面板留一个只读状态口。
  try {
    const web = ctx.get?.('webServer')
    if (web) {
      ctx.effect(() =>
        web.register({
          kind: 'exact',
          path: '/dsh-self/state',
          handler: async (req, res) => {
            const body = JSON.stringify({
              ok: true,
              status: store.status(),
              memory: memory.counts(),
              migration,
              platforms: lastHealth,
              personaStates: stateStore.snapshot(),
            })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(body)
          },
        }),
      )
      ctx.effect(() =>
        web.register({
          kind: 'exact',
          path: '/dsh-self/render',
          handler: async (req, res) => {
            const remote = String(req.socket?.remoteAddress || '')
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
              res.writeHead(403).end('forbidden')
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405).end('method not allowed')
              return
            }
            try {
              const raw = await new Promise((resolve, reject) => {
                let size = 0
                const chunks = []
                req.on('data', (chunk) => {
                  size += chunk.length
                  if (size > 64 * 1024) {
                    reject(new Error('body too large'))
                    req.destroy()
                    return
                  }
                  chunks.push(chunk)
                })
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
                req.on('error', reject)
              })
              const input = JSON.parse(raw || '{}')
              const platform = String(input.platform || 'desktop')
              const text = String(input.text || '').trim()
              if (!text) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: 'empty' }))
                return
              }
              const rendered = await renderMask(text, platform)
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(JSON.stringify({ ok: true, platform, text: rendered, original: text }))
            } catch (error) {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
            }
          },
        }),
      )
    }
  } catch {
    /* 没有 webServer 时不影响主功能 */
  }

  // 启动钩子：先查平台联通并修复，再确保专用自主会话与每小时心跳；不阻塞启动。
  // 首检延后 15 秒：等 NapCat ws 和 B站私信桥先起跑，否则刚启动就把“还没轮询”判成断了。
  const startupCheckTimer = setTimeout(() => {
    void checkPlatforms().catch((error) => console.error('[dsh-self] 平台巡检失败：', error))
  }, 15000)
  ctx.effect(() => () => clearTimeout(startupCheckTimer))
  // 巡检周期：DSH 活着就一直转，跟着进程起落；platformCheckMinutes=0 可关。
  const platformCheckMs = Math.max(1, Number(config.platformCheckMinutes) || 10) * 60 * 1000
  try {
    ctx.effect(() =>
      ctx.interval(() => {
        void checkPlatforms().catch((error) =>
          healthLogLine(`check 异常: ${String(error?.message || error)}`),
        )
      }, platformCheckMs),
    )
    healthLogLine(`巡检启动：每 ${Math.round(platformCheckMs / 60000)} 分钟一次`)
  } catch (error) {
    console.error('[dsh-self] 平台巡检定时器不可用：', error)
  }
  void ensureAutonomy().catch((error) => console.error('[dsh-self] 自主时间初始化失败：', error))
}
