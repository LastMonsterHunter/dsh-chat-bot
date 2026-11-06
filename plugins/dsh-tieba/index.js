/**
 * dsh-tieba — 百度贴吧的浏览与发言。
 *
 * 读：吧帖子列表、帖子正文与楼层、楼中楼回复、登录态。
 * 写：帖子/楼层/楼中楼点赞与踩、收藏、发评论（回复主题或楼层）、回复楼中楼。
 *
 * 边界：
 *   - 凭据只从 data/secrets/tieba_credential.json（600）读，不进日志、不进提示词。
 *   - 发言默认预览：tieba_comment 第一次只返回草稿，确认后才真的发。
 *   - 写操作之间有最小间隔（minGapMs），每天有上限（dailyCommentLimit），风控优先。
 *   - 读用贴吧客户端的签名协议（appSecret 固定），写操作需要登录 cookie + tbs。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const HOME_SCRIPT = fileURLToPath(new URL('./scripts/tieba-home.mjs', import.meta.url))
const OPS_SCRIPT = fileURLToPath(new URL('./scripts/tieba-ops.mjs', import.meta.url))

export const name = 'dsh-tieba'
export const inject = ['tools']

const DEFAULTS = {
  credentialPath: '',
  statePath: '',
  interestPath: '',
  previewDefault: true,
  minGapMs: 20000,
  cooldownMs: 300000,
  dailyCommentLimit: 20,
}

// 贴吧 Android 客户端的签名密钥（公开在开源客户端里，不是账号凭据）。
const APP_SECRET = 'tiebaclient!!!'
const UA = 'bdtb for Android 12.25.1.0'
const BASE = 'https://c.tieba.baidu.com'
const WEB_BASE = 'https://tieba.baidu.com'
const DEFAULT_INTERESTS = {
  likeForums: ['摸鱼', '职场', '生活', '心理', '科技', '电影'],
  dislikeKeywords: ['广告', '引流', '加群', '招聘', '兼职', '返利'],
}

function chatRoot() {
  return process.env.CHAT_BOT_ROOT || fileURLToPath(new URL('../../bot', import.meta.url))
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}

function sortedRaw(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('')
}

function signOf(params) {
  return createHash('md5').update(sortedRaw(params) + APP_SECRET).digest('hex')
}

function md5(text) {
  return createHash('md5').update(text).digest('hex')
}

function textOfContent(content) {
  let out = ''
  if (!content) out = ''
  else if (typeof content === 'string') out = content
  else if (Array.isArray(content)) {
    out = content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') return String(block.text || block.content || '')
        return ''
      })
      .join('')
  } else if (typeof content === 'object') out = String(content.text || '')
  // 贴吧把很多表情写成 image_emoticonN，直接显示像乱码。
  return String(out).replace(/image_emoticon\d+/gu, '[表情]').replace(/\s+/gu, ' ').trim()
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function todayKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clock(ts) {
  if (!ts) return ''
  return new Date(Number(ts) * 1000).toLocaleString('zh-CN', { hour12: false })
}

function short(text, n = 100) {
  const raw = String(text || '').replace(/\s+/gu, ' ').trim()
  return raw.length > n ? `${raw.slice(0, n)}…` : raw
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig || {}) }
  const credentialPath =
    config.credentialPath || join(chatRoot(), 'data/secrets/tieba_credential.json')
  const statePath = config.statePath || join(dshHome(), 'tieba-state.json')
  const interestPath = config.interestPath || join(dshHome(), 'tieba-interest.json')
  const minGapMs = Math.max(1500, Number(config.minGapMs) || 5000)
  const dailyCommentLimit = Math.max(1, Number(config.dailyCommentLimit) || 20)
  const previewDefault = Boolean(config.previewDefault)

  let state = readJson(statePath, null) || { seen: {}, forums: {}, actions: [], daily: {} }
  let interest = { ...DEFAULT_INTERESTS, ...readJson(interestPath, {}) }
  // 写接口要 client_user_token，登录后从移动版页面拿到 uid。
  let loginUid = ''
  const cooldownMs = Math.max(60000, Number(config.cooldownMs) || 300000)
  let cooldownUntil = 0

  function saveState() {
    // 只保留最近 1000 条动作，避免状态文件无限长。
    if (state.actions.length > 1000) state.actions = state.actions.slice(-1000)
    writeJson(statePath, state)
  }

  function saveInterest() {
    writeJson(interestPath, interest)
  }

  function cred() {
    return readJson(credentialPath, null)
  }

  function cookieHeader() {
    const c = cred()
    if (!c?.bduss) return ''
    // 登录脚本存的全量 cookie 优先：主页、写接口都要完整会话。
    if (c.cookies && typeof c.cookies === 'object') {
      const all = Object.entries(c.cookies)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
      if (all.length) return all.join('; ')
    }
    const parts = [`BDUSS=${c.bduss}`, `BDUSS_BFESS=${c.bduss}`]
    if (c.stoken) parts.push(`STOKEN=${c.stoken}`)
    if (c.baiduid) parts.push(`BAIDUID=${c.baiduid}`, `BAIDUID_BFESS=${c.baiduid}`)
    parts.push('ka=open')
    return parts.join('; ')
  }

  const logined = () => Boolean(cred()?.bduss)

  function daily() {
    const key = todayKey()
    if (!state.daily || state.daily.date !== key) {
      const prev = state.daily || {}
      state.daily = { date: key, comments: 0, likes: 0, favorites: 0, prevComments: prev.comments || 0 }
      saveState()
    }
    return state.daily
  }

  function lastWriteAt() {
    for (let i = state.actions.length - 1; i >= 0; i -= 1) {
      const a = state.actions[i]
      if (a && a.write) return Number(a.at) || 0
    }
    return 0
  }

  function noteWrite(kind, detail, ok, extra = {}) {
    state.actions.push({ at: Date.now(), kind, detail: short(detail, 200), ok: Boolean(ok), write: true, ...extra })
    saveState()
  }

  async function api(path, params, { timeoutMs = 15000 } = {}) {
    const all = {
      _client_version: '12.25.1.0',
      _client_type: '2',
      from: 'tieba',
      timestamp: String(Date.now()),
      ...params,
    }
    all.sign = signOf(all)
    const headers = {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    }
    // 写接口要 client_user_token（uid），缺了会直接 110001「未知错误」。
    if (loginUid) headers.client_user_token = loginUid
    const cookie = cookieHeader()
    if (cookie) headers.Cookie = cookie
    const res = await fetch(`https://c.tieba.baidu.com${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(all).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`贴吧返回不是 JSON（HTTP ${res.status}）：${short(text, 120)}`)
    }
    return data
  }

  function apiError(data, fallback = '贴吧返回错误') {
    const code = String(data?.error_code ?? data?.errorCode ?? '')
    const msg = String(data?.error_msg || data?.errorMsg || '')
    if (code === '0' || code === '') return ''
    return `${msg || fallback}（code ${code}）`
  }

  // 登录态与 tbs 都从移动版首页拿：网页版 /dc/common/tbs 会被 red_tag 重定向，
  // 常常返回 is_login=0；newmoindex 的 tbs 是 16 位，写接口要的是页面里的 24 位。
  const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  let sessionCache = null
  let sessionAt = 0
  async function session() {
    // tbs 缓 10 分钟：移动版首页 250KB，每个写操作都拉一次太扎眼。
    if (sessionCache && Date.now() - sessionAt < 10 * 60 * 1000) return sessionCache
    const cookie = cookieHeader()
    if (!cookie) throw new Error('没有登录凭据，写操作需要 BDUSS')
    const res = await fetch(`${WEB_BASE}/mo/q/m?kw=${encodeURIComponent('摸鱼')}`, {
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: `${WEB_BASE}/`,
        Cookie: cookie,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    const html = await res.text()
    const tbs = /"tbs":"([^"]+)"/u.exec(html)?.[1] || ''
    const isLogin = /"is_login":true/u.test(html)
    const name = /"user_name_show":"([^"]*)"/u.exec(html)?.[1] || /"name_show":"([^"]*)"/u.exec(html)?.[1] || ''
    const userId = /"user_id":(\d+)/u.exec(html)?.[1] || ''
    if (!isLogin) throw new Error('登录态失效（需要重新扫码）')
    if (!tbs) throw new Error('拿到了登录态但没找到 tbs')
    if (userId) loginUid = userId
    sessionCache = { tbs, isLogin, userId, name }
    sessionAt = Date.now()
    return sessionCache
  }

  async function tbs() {
    return await session()
  }

  async function loginInfo() {
    const c = cred()
    if (!c?.bduss) {
      return { ok: false, detail: '没有登录凭据（data/secrets/tieba_credential.json）', anonymous: true }
    }
    try {
      const r = await tbs()
      if (!r.isLogin) return { ok: false, detail: 'BDUSS 已失效，需要重新扫码登录', anonymous: false }
      return { ok: true, detail: `已登录${r.userId ? ` uid=${r.userId}` : ''}`, anonymous: false, tbs: r.tbs, userId: r.userId }
    } catch (error) {
      return { ok: false, detail: String(error?.message || error), anonymous: false }
    }
  }

  async function forumList(kw, pn = 1) {
    const data = await api('/c/f/frs/page', {
      kw,
      pn: String(pn),
      rn: '13',
      sort_type: '0',
      st_type: 'tb_forumlist',
      with_group: '0',
      q_type: '2',
      scr_dip: '1',
      scr_h: '1080',
      scr_w: '1080',
    })
    const err = apiError(data)
    if (err) throw new Error(err)
    const threads = data.thread_list || data?.data?.thread_list || []
    return {
      forum: data.forum || {},
      hasMore: Boolean(data.page?.has_more),
      threads: threads.map((t) => ({
        tid: String(t.id || ''),
        title: String(t.title || '').trim(),
        author: String(t.author?.name_show || t.author?.name || ''),
        authorId: String(t.author?.id || ''),
        replyNum: num(t.reply_num),
        viewNum: num(t.view_num),
        // 吧的活跃度看最后回复时间；last_time_int 是最后回复，create_time 是发帖。
        time: num(t.last_time_int || t.last_reply_time || t.create_time),
        isTop: num(t.is_top),
      })),
    }
  }

  /** 帖子的最后回复时间（用吧第一页按最后回复排序的列表查；找不到返回 0）。 */
  async function lastReplyTimeOf(tid, kw) {
    if (!kw) return 0
    try {
      const page = await forumList(kw)
      const t = page.threads.find((x) => x.tid === String(tid))
      return t ? t.time : 0
    } catch {
      return 0
    }
  }

  /**
   * 吧的活跃度：最近 days 天内有回复的帖子数。
   * 从第一页开始按最后回复排序翻，累计到 target 就停，最多 8 页。
   */
  async function recentThreadCount(kw, days = 3, target = 50) {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400
    let recent = 0
    for (let pn = 1; pn <= 8 && recent < target; pn += 1) {
      let page
      try {
        page = await forumList(kw, pn)
      } catch {
        break
      }
      if (!page.threads.length) break
      recent += page.threads.filter((t) => t.time >= cutoff).length
      if (!page.hasMore) break
      if (recent < target) await new Promise((r) => setTimeout(r, 1800))
    }
    return recent
  }

  async function readThread(tid, { pn = 1, rn = 30, floorRn = 3 } = {}) {
    const data = await api('/c/f/pb/page', {
      kz: String(tid),
      pn: String(pn),
      rn: String(rn),
      with_floor: '1',
      floor_rn: String(floorRn),
      st_type: 'tb_frslist',
      back: '0',
      mark: '0',
      scr_dip: '1',
      scr_h: '1080',
      scr_w: '1080',
    })
    const err = apiError(data)
    if (err) throw new Error(err)
    const users = new Map()
    for (const u of data.user_list || []) {
      if (u?.id) users.set(String(u.id), String(u.name_show || u.name || ''))
    }
    const posts = (data.post_list || []).map((p) => {
      const subs = p?.sub_post_list?.post_list || p?.sub_post_list || []
      return {
        pid: String(p.id || ''),
        floor: num(p.floor),
        authorId: String(p.author_id || ''),
        author: users.get(String(p.author_id || '')) || '',
        content: textOfContent(p.content),
        time: num(p.time),
        agree: num(p.agree?.agree_num),
        disagree: num(p.agree?.disagree_num),
        hasAgree: num(p.agree?.has_agree),
        subNumber: num(p.sub_post_number),
        subs: Array.isArray(subs)
          ? subs.map((s) => ({
              spid: String(s.id || ''),
              authorId: String(s.author_id || ''),
              author: users.get(String(s.author_id || '')) || String(s.author?.name_show || ''),
              content: textOfContent(s.content),
              time: num(s.time),
              agree: num(s.agree?.agree_num || s.agree_num),
            }))
          : [],
      }
    })
    return {
      tid: String(tid),
      title: String(data.thread?.title || ''),
      forumId: String(data.forum?.id || ''),
      forumName: String(data.forum?.name || ''),
      replyNum: num(data.thread?.reply_num),
      collectStatus: num(data.thread?.collect_status),
      page: num(data.page?.current_page || pn),
      totalPage: num(data.page?.total_page),
      posts,
    }
  }

  async function readComments(tid, pid, { pn = 1, rn = 20 } = {}) {
    const data = await api('/c/f/pb/floor', {
      kz: String(tid),
      pn: String(pn),
      pid: String(pid),
      rn: String(rn),
    })
    const err = apiError(data)
    if (err) throw new Error(err)
    const list = data.sub_post_list?.post_list || data.sub_post_list || data.post_list || []
    return (Array.isArray(list) ? list : []).map((s) => ({
      spid: String(s.id || ''),
      authorId: String(s.author_id || ''),
      author: String(s.author?.name_show || s.author?.name || ''),
      content: textOfContent(s.content),
      time: num(s.time),
      agree: num(s.agree?.agree_num || s.agree_num),
    }))
  }

  function ensureLoginForWrite() {
    if (!logined()) throw new Error('写操作需要登录：先跑 dsh-tieba 的 scripts/tieba-login.mjs 扫码')
    if (cooldownUntil > Date.now()) {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000)
      throw new Error(`风控冷却中，还剩 ${left} 秒，先别写`)
    }
  }

  async function writeGuard() {
    ensureLoginForWrite()
    const gap = Date.now() - lastWriteAt()
    if (gap < minGapMs) {
      await new Promise((r) => setTimeout(r, minGapMs - gap))
    }
    const d = daily()
    return d
  }

  /** 命中贴吧风控错误码时，进入冷却，避免连环撞墙。 */
  function tripCooldown(error) {
    const text = String(error?.message || error || '')
    if (/110001|300000|3280004|too.frequent|频繁/iu.test(text)) {
      cooldownUntil = Date.now() + cooldownMs
      return true
    }
    return false
  }

  // ---------- 工具 ----------

  const render = (_a, v) => [{ type: 'text', text: String(v?.message ?? '') }]

  ctx.tools.register(
    defineTool({
      name: 'tieba_status',
      description: '看贴吧登录态、凭据位置、今天的发言/点赞/收藏计数，以及发言是否默认先预览。',
      parameters: {},
      output: { schema: { type: 'json' }, render },
      async execute() {
        const info = await loginInfo()
        const d = daily()
        const c = cred()
        const left = cooldownUntil > Date.now() ? Math.ceil((cooldownUntil - Date.now()) / 1000) : 0
        return {
          ok: info.ok,
          loggedIn: info.ok,
          credentialPath,
          preview: previewDefault,
          cooldown: left,
          daily: { date: d.date, comments: d.comments, likes: d.likes, favorites: d.favorites },
          savedAt: c?.saved_at ? clock(c.saved_at) : '',
          message: [
            info.ok ? `✓ 贴吧已登录（${info.detail}）` : `✗ 贴吧未登录：${info.detail}`,
            `凭据：${credentialPath}`,
            `今天：评论 ${d.comments} 条 · 点赞 ${d.likes} 次 · 收藏 ${d.favorites} 次`,
            `发言模式：${previewDefault ? '先预览，确认后才发' : '直接发'}`,
            left ? `风控冷却还剩 ${left} 秒，先别写` : '写操作间隔 20 秒',
          ].join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_home',
      description:
        '读贴吧个人主页的分类记录：threads 贴子（我发过的主题帖）、replies 回帖（我发过的评论）、likes 点赞（赞过的帖子和评论）、favorites 收藏（收藏的帖子）。用浏览器会话读，一次要十几秒。',
      parameters: {
        tab: { type: 'string', enum: ['threads', 'replies', 'likes', 'favorites'], description: '分类，默认 likes' },
        count: { type: 'number', description: '最多返回几条，默认 20' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const tab = String(args?.tab || 'likes')
        if (!['threads', 'replies', 'likes', 'favorites'].includes(tab)) {
          return { ok: false, message: 'tab 只能是 threads / replies / likes / favorites' }
        }
        const loginHint = '主页登录态失效，需要重新扫码：node scripts/tieba-login.mjs --force'
        let stdout = ''
        try {
          const r = await execFileAsync(process.env.TIEBA_NODE || 'node', [HOME_SCRIPT, '--tab', tab], {
            timeout: 120000,
            maxBuffer: 4 * 1024 * 1024,
          })
          stdout = String(r.stdout || '')
        } catch (error) {
          stdout = String(error?.stdout || '')
          if (!stdout) return { ok: false, message: `读主页失败：${String(error?.message || error)}` }
        }
        const line = stdout.trim().split('\n').pop() || '{}'
        let data
        try {
          data = JSON.parse(line)
        } catch {
          return { ok: false, message: `主页脚本输出不是 JSON：${line.slice(0, 120)}` }
        }
        if (!data.ok) {
          return { ok: false, needLogin: Boolean(data.needLogin), message: data.needLogin ? loginHint : `读主页失败：${data.error || '未知'}` }
        }
        const count = Math.min(50, Math.max(1, Number(args?.count) || 20))
        const items = (data.items || []).slice(0, count)
        const label = { threads: '贴子', replies: '回帖', likes: '点赞', favorites: '收藏' }[tab]
        if (!items.length) return { ok: true, tab, items: [], message: `${label}：空（主页没有${label}记录）` }
        const lines = items.map((it, i) => {
          const head = `${i + 1}. [${it.fname || '?'}] ${it.title || '（无标题）'}${it.agreeNum ? ` · 👍${it.agreeNum}` : ''}${it.replyNum ? ` · ${it.replyNum} 回复` : ''}${it.time ? ` · ${it.time}` : ''}`
          const sub = it.likedComment
            ? `   ↳ 赞的评论（${it.likedComment.author || '匿名'}）：${short(it.likedComment.content, 120)}（👍${it.likedComment.agreeNum || 0}）`
            : ''
          const reply = it.content ? `   ↳ 我的回复：${short(it.content, 120)}` : ''
          return [head, sub, reply].filter(Boolean).join('\n')
        })
        return { ok: true, tab, items, message: `${label}（${items.length} 条）：\n${lines.join('\n')}` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_follow',
      description:
        '关注或取消关注一个吧（浏览器会话点按钮，客户端接口一直 110001）。action=follow/unfollow，一次约 15 秒。关注前会查活跃度：最近 3 天有回复的帖子数 < 50 的吧不关注。',
      parameters: {
        kw: { type: 'string', description: '吧名，例如 孙笑川' },
        action: { type: 'string', enum: ['follow', 'unfollow'], description: '默认 follow' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const kw = String(args?.kw || '').trim()
        if (!kw) return { ok: false, message: '要吧名（kw）' }
        const action = String(args?.action || 'follow')
        // 缔造者的规则：最近 3 天有回复的帖子数 < 50 的吧不关注。
        if (action === 'follow') {
          try {
            const recent = await recentThreadCount(kw)
            if (recent < 50) {
              return { ok: false, recent, message: `${kw}吧最近 3 天只有 ${recent} 帖有回复（<50），不关注。` }
            }
          } catch {
            /* 查不到活跃度就交给浏览器，页面会显示状态 */
          }
        }
        let stdout = ''
        try {
          const r = await execFileAsync(process.env.TIEBA_NODE || 'node', [OPS_SCRIPT, '--action', action, '--kw', kw], {
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          })
          stdout = String(r.stdout || '')
        } catch (error) {
          stdout = String(error?.stdout || '')
          if (!stdout) return { ok: false, message: `操作失败：${String(error?.message || error)}` }
        }
        let data
        try {
          data = JSON.parse(stdout.trim().split('\n').pop() || '{}')
        } catch {
          return { ok: false, message: `脚本输出异常：${stdout.slice(0, 120)}` }
        }
        if (!data.ok) {
          return { ok: false, message: data.needLogin ? '浏览器登录态失效，需要重新扫码：node scripts/tieba-login.mjs --force' : `操作失败：${data.error || '未知'}` }
        }
        return {
          ok: true,
          kw,
          action,
          state: data.after,
          message: `${kw}吧：${data.note}${data.after?.length ? `（当前 ${data.after.join(' / ')}）` : ''}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_sign',
      description: '给一个吧签到（浏览器会话点签到按钮，客户端接口一直 110001）。一次约 15 秒。',
      parameters: { kw: { type: 'string', description: '吧名，例如 孙笑川' } },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const kw = String(args?.kw || '').trim()
        if (!kw) return { ok: false, message: '要吧名（kw）' }
        let stdout = ''
        try {
          const r = await execFileAsync(process.env.TIEBA_NODE || 'node', [OPS_SCRIPT, '--action', 'sign', '--kw', kw], {
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          })
          stdout = String(r.stdout || '')
        } catch (error) {
          stdout = String(error?.stdout || '')
          if (!stdout) return { ok: false, message: `签到失败：${String(error?.message || error)}` }
        }
        let data
        try {
          data = JSON.parse(stdout.trim().split('\n').pop() || '{}')
        } catch {
          return { ok: false, message: `脚本输出异常：${stdout.slice(0, 120)}` }
        }
        if (!data.ok) {
          return { ok: false, message: data.needLogin ? '浏览器登录态失效，需要重新扫码：node scripts/tieba-login.mjs --force' : `签到失败：${data.error || '未知'}` }
        }
        return { ok: true, kw, state: data.after, message: `${kw}吧：${data.note}` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_feed',
      description:
        '按屿自己的兴趣从贴吧挑帖子：拉几个兴趣吧的第一页，排除已看过的，按回复数、新鲜度、兴趣关键词打分，返回带理由的候选。刷贴吧前先用它。',
      parameters: {
        forums: { type: 'string', description: '可选：临时用这些吧（空格或逗号分隔），默认用兴趣吧列表' },
        count: { type: 'number', description: '返回几条，默认 6，最多 10' },
        includeSeen: { type: 'boolean', description: '连看过的也返回（默认排除）' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const count = Math.min(10, Math.max(1, Number(args?.count) || 6))
        const includeSeen = Boolean(args?.includeSeen)
        const custom = String(args?.forums || '')
          .split(/[\s,，]+/u)
          .map((s) => s.trim())
          .filter(Boolean)
        const forums = (custom.length ? custom : interest.likeForums || []).slice(0, 8)
        if (!forums.length) return { ok: false, message: '兴趣吧是空的，用 tieba_interest 设几个。' }

        const seen = state.seen || {}
        const now = Math.floor(Date.now() / 1000)
        const dislike = (interest.dislikeKeywords || []).map((k) => String(k).toLowerCase())
        const candidates = []
        const failed = []
        // 串行拉吧，每个之间停 1～2 秒：并发拉 6 个吧太像扫描，容易吃风控。
        for (const kw of forums) {
          try {
            const { threads } = await forumList(kw)
            for (const t of threads) {
              if (!t.tid || !t.title) continue
              if (!includeSeen && seen[t.tid]) continue
              if (t.isTop) continue
              if (/签到|水楼|吧规|公告|交易|招聘|交友|广告/iu.test(t.title)) continue
              const lower = t.title.toLowerCase()
              if (dislike.some((k) => k && lower.includes(k))) continue
              const ageHours = t.time ? (now - t.time) / 3600 : 999
              // 缔造者的规则：最新回复超过 2 天的帖子不浏览。
              if (ageHours > 48) continue
              const fresh = Math.max(0, 40 - ageHours / 6)
              const heat = Math.min(30, Math.log10(Math.max(1, t.replyNum)) * 12)
              const hit = ['摸鱼', '职场', '生活', '心理', '上班', '工作', '焦虑', '关系']
                .filter((k) => lower.includes(k)).length
              const score = Math.round(fresh + heat + hit * 8)
              const reasons = []
              if (t.replyNum >= 20) reasons.push(`${t.replyNum} 回复`)
              if (ageHours <= 6) reasons.push('刚发的')
              if (hit) reasons.push('命中兴趣词')
              if (seen[t.tid]) reasons.push('看过')
              candidates.push({ ...t, kw, score, reasons, ageHours: Math.round(ageHours) })
            }
          } catch (error) {
            failed.push(`${kw}：${short(error?.message || error, 60)}`)
          }
          await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800))
        }
        // 缔造者的规则：不强制挑最新，在符合条件的候选里随机抽。
        for (let i = candidates.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
        const top = candidates.slice(0, count)
        if (!top.length) {
          return {
            ok: true,
            items: [],
            failed,
            message: `没有新帖可挑（看了 ${forums.join('、')}）。${failed.length ? `失败：${failed.join('；')}` : ''}`,
          }
        }
        const lines = top.map(
          (t, i) =>
            `${i + 1}. [${t.kw}] ${t.title}\n   tid=${t.tid} · ${t.replyNum} 回复 · ${t.ageHours} 小时前 · ${t.reasons.join(' / ') || '普通'}`,
        )
        return {
          ok: true,
          items: top,
          failed,
          message: [
            `从 ${forums.join('、')} 符合条件的 ${candidates.length} 条里随机挑了 ${top.length} 条：`,
            ...lines,
            failed.length ? `（拉取失败：${failed.join('；')}）` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_read',
      description:
        '读一个贴吧帖子：标题、吧名、正文、楼层列表（作者/内容/赞数/楼中楼数），可选带前几条楼中楼。先用 tieba_feed 或用户给的 tid。',
      parameters: {
        tid: { type: 'string', description: '帖子 id（tid）' },
        pn: { type: 'number', description: '页码，默认 1' },
        rn: { type: 'number', description: '每页楼层数，默认 30，最多 50' },
        withSub: { type: 'boolean', description: '是否带每楼的前几条楼中楼（默认 true）' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const tid = String(args?.tid || '').trim()
        if (!/^\d+$/u.test(tid)) return { ok: false, message: 'tid 要是数字。' }
        const pn = Math.max(1, Number(args?.pn) || 1)
        const rn = Math.min(50, Math.max(1, Number(args?.rn) || 30))
        const withSub = args?.withSub !== false
        try {
          const data = await readThread(tid, { pn, rn })
          if (data.forumId) {
            if (!state.forums) state.forums = {}
            state.forums[tid] = { kw: data.forumName, fid: data.forumId, title: data.title }
            saveState()
          }
          // 规则：最新回复超过 2 天的帖子不浏览。
          const cutoff = Math.floor(Date.now() / 1000) - 2 * 86400
          let lastReply = await lastReplyTimeOf(tid, data.forumName)
          if (!lastReply) {
            // 不在吧第一页时，用楼层里的最新时间兜底。
            lastReply = Math.max(0, ...data.posts.map((p) => p.time))
          }
          if (lastReply && lastReply < cutoff) {
            return { ok: false, tid, lastReply, message: `这帖最新回复是 ${clock(lastReply)}（超过 2 天），按规则不浏览。` }
          }
          const lines = [
            `《${data.title}》 · ${data.forumName}吧 · ${data.replyNum} 回复 · 第 ${data.page}/${data.totalPage || '?'} 页`,
            `tid=${data.tid} fid=${data.forumId} 收藏=${data.collectStatus ? '已收藏' : '未收藏'}`,
            '',
          ]
          for (const p of data.posts) {
            lines.push(`【${p.floor}楼】pid=${p.pid} ${p.author || '匿名'} · 👍${p.agree} · ${clock(p.time)}`)
            lines.push(short(p.content, 400) || '（空）')
            if (withSub && p.subs?.length) {
              for (const s of p.subs) {
                lines.push(`  ↳ ${s.author || '匿名'}：${short(s.content, 120)}（spid=${s.spid}）`)
              }
              if (p.subNumber > p.subs.length) lines.push(`  ↳ …还有 ${p.subNumber - p.subs.length} 条，用 tieba_comments 看`)
            }
            lines.push('')
          }
          return { ok: true, ...data, message: lines.join('\n') }
        } catch (error) {
          return { ok: false, message: `读帖失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_comments',
      description: '读某一楼的楼中楼回复（按 pn 翻页）。tieba_read 里每条楼中楼有 spid；要回复楼中楼用 tieba_comment 的 spid。',
      parameters: {
        tid: { type: 'string', description: '帖子 id' },
        pid: { type: 'string', description: '楼层 pid（tieba_read 里每楼的 pid）' },
        pn: { type: 'number', description: '页码，默认 1' },
        rn: { type: 'number', description: '条数，默认 20，最多 50' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const tid = String(args?.tid || '').trim()
        const pid = String(args?.pid || '').trim()
        if (!/^\d+$/u.test(tid) || !/^\d+$/u.test(pid)) return { ok: false, message: 'tid 和 pid 都要是数字。' }
        try {
          const list = await readComments(tid, pid, {
            pn: Math.max(1, Number(args?.pn) || 1),
            rn: Math.min(50, Math.max(1, Number(args?.rn) || 20)),
          })
          if (!list.length) return { ok: true, items: [], message: '这一楼没有楼中楼。' }
          const lines = list.map((s, i) => `${i + 1}. ${s.author || '匿名'}：${short(s.content, 300)}${s.agree ? `（👍${s.agree}）` : ''} · spid=${s.spid}`)
          return { ok: true, items: list, message: `楼中楼 ${list.length} 条：\n${lines.join('\n')}` }
        } catch (error) {
          return { ok: false, message: `读楼中楼失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_like',
      description:
        '给贴吧的帖子/楼层/楼中楼点赞或点踩。target=thread 赞主题楼（pid 用首楼 pid），target=post 赞某楼，target=subpost 赞楼中楼；action=like/unlike/dislike。一次一个，不刷量。',
      parameters: {
        tid: { type: 'string', description: '帖子 id' },
        pid: { type: 'string', description: '楼层 pid；target=thread 时用首楼 pid' },
        spid: { type: 'string', description: 'target=subpost 时的楼中楼 id' },
        target: { type: 'string', enum: ['thread', 'post', 'subpost'], description: '点赞对象，默认 thread' },
        action: { type: 'string', enum: ['like', 'unlike', 'dislike'], description: '默认 like' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        try {
          ensureLoginForWrite()
        } catch (error) {
          return { ok: false, message: String(error?.message || error) }
        }
        const tid = String(args?.tid || '').trim()
        const target = String(args?.target || 'thread')
        const action = String(args?.action || 'like')
        const pid = String(args?.pid || args?.spid || '').trim()
        if (!/^\d+$/u.test(tid) || !/^\d+$/u.test(pid)) return { ok: false, message: 'tid 和 pid 都要是数字。' }
        try {
          await writeGuard()
          const r = await tbs()
          // obj_type=3 是楼层；主题楼与楼层都走 3，楼中楼用 2。
          const objType = target === 'subpost' ? '2' : '3'
          const data = await api('/c/c/agree/opAgree', {
            thread_id: tid,
            post_id: pid,
            obj_type: objType,
            agree_type: '2',
            op_type: action === 'like' ? '0' : '1',
            tbs: r.tbs,
            stoken: cred()?.stoken || '',
            cuid_gid: '',
          })
          const err = apiError(data)
          if (err) throw new Error(err)
          daily().likes += 1
          noteWrite('like', `${target} ${action} ${tid}/${pid}`, true, { tid, pid })
          return { ok: true, message: `${action === 'like' ? '点了赞' : action === 'dislike' ? '点了踩' : '取消了'}：${target} ${pid}` }
        } catch (error) {
          const cooled = tripCooldown(error)
          noteWrite('like', `fail ${tid}/${pid}`, false, { tid, pid })
          return { ok: false, message: `点赞失败：${String(error?.message || error)}${cooled ? '（已进入风控冷却）' : ''}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_favorite',
      description: '收藏或取消收藏一个贴吧帖子。action=add/remove。一次一个。',
      parameters: {
        tid: { type: 'string', description: '帖子 id' },
        pid: { type: 'string', description: '首楼 pid（可选，收藏接口一般用不上；传了更稳）' },
        action: { type: 'string', enum: ['add', 'remove'], description: '默认 add' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        try {
          ensureLoginForWrite()
        } catch (error) {
          return { ok: false, message: String(error?.message || error) }
        }
        const tid = String(args?.tid || '').trim()
        const pid = String(args?.pid || '0').trim() || '0'
        const action = String(args?.action || 'add')
        if (!/^\d+$/u.test(tid)) return { ok: false, message: 'tid 要是数字。' }
        try {
          await writeGuard()
          const r = await tbs()
          const data = await api('/c/c/post/addstore', {
            data: JSON.stringify({ tid, pid, status: action === 'add' ? 1 : 0 }),
            stoken: cred()?.stoken || '',
            tbs: r.tbs,
          })
          const err = apiError(data)
          if (err) throw new Error(err)
          daily().favorites += 1
          noteWrite('favorite', `${action} ${tid}`, true, { tid })
          return { ok: true, message: `${action === 'add' ? '收藏了' : '取消收藏了'}：${tid}` }
        } catch (error) {
          const cooled = tripCooldown(error)
          noteWrite('favorite', `fail ${tid}`, false, { tid })
          return { ok: false, message: `收藏失败：${String(error?.message || error)}${cooled ? '（已进入风控冷却）' : ''}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_comment',
      description:
        '在贴吧帖子下发评论：不传 pid 就是回帖（新楼），传 pid 是回复某楼，传 spid 是回复楼中楼。默认只返回预览草稿、不发送；确认后再用同样的内容加 confirm=true 发。一次一条，有节流和每日上限。',
      parameters: {
        tid: { type: 'string', description: '帖子 id' },
        content: { type: 'string', description: '评论内容（按贴吧面具写，不刷屏、不攻击）' },
        pid: { type: 'string', description: '可选：回复哪一楼（楼层 pid）' },
        spid: { type: 'string', description: '可选：回复楼中楼（楼中楼 id）' },
        confirm: { type: 'boolean', description: 'true 才真的发送；默认 false 只预览' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const tid = String(args?.tid || '').trim()
        const content = String(args?.content || '').trim()
        const pid = String(args?.pid || '').trim()
        const spid = String(args?.spid || '').trim()
        const confirm = Boolean(args?.confirm)
        if (!/^\d+$/u.test(tid)) return { ok: false, message: 'tid 要是数字。' }
        if (!content) return { ok: false, message: '内容不能空。' }
        if (content.length > 1000) return { ok: false, message: '评论太长（贴吧上限约 1000 字）。' }

        // 目标：回复主题 / 楼层 / 楼中楼
        const target = spid ? 'subpost' : pid ? 'post' : 'thread'
        if (!confirm && previewDefault) {
          return {
            ok: true,
            preview: true,
            target,
            content,
            message: [
              `草稿（${target === 'thread' ? '回帖' : target === 'post' ? `回复 ${pid} 楼` : `回复楼中楼 ${spid}`}）：`,
              content,
              '',
              '这是预览，还没发。确认后用同样内容加 confirm=true 再调一次。',
            ].join('\n'),
          }
        }
        try {
          ensureLoginForWrite()
        } catch (error) {
          return { ok: false, message: String(error?.message || error) }
        }
        const d = daily()
        if (d.comments >= dailyCommentLimit) {
          return { ok: false, message: `今天的评论额度用完了（${dailyCommentLimit} 条），明天再来。` }
        }
        try {
          await writeGuard()
          const r = await tbs()
          // fid 优先用缓存；没有就现读帖子。
          let fid = state.forums?.[tid]?.fid || ''
          let kw = state.forums?.[tid]?.kw || ''
          if (!fid) {
            const t = await readThread(tid, { rn: 30 })
            fid = t.forumId
            kw = t.forumName
            state.forums = state.forums || {}
            state.forums[tid] = { kw, fid, title: t.title }
            saveState()
          }
          const params = {
            content,
            fid,
            kw,
            tbs: r.tbs,
            stoken: cred()?.stoken || '',
            tid,
            is_ad: '0',
            is_feedback: '0',
            is_barrage: '0',
            new_vcode: '1',
            vcode_tag: '12',
            anonymous: '1',
            post_from: target === 'thread' ? '3' : '0',
            _client_version: '12.25.1.0',
          }
          let replyUid = ''
          if (target !== 'thread') {
            // 楼层作者 uid：读帖拿（缓存可加，先现读一次）
            try {
              const t = await readThread(tid, { rn: 30 })
              const post = t.posts.find((p) => p.pid === pid || (spid && p.subs.some((s) => s.spid === spid)))
              if (post && !spid) replyUid = post.authorId
              if (post && spid) {
                const sub = post.subs.find((s) => s.spid === spid)
                if (sub) replyUid = sub.authorId
              }
            } catch {
              /* 拿不到作者就按无 reply_uid 发 */
            }
            params.quote_id = pid || '0'
            params.repostid = pid || '0'
            if (replyUid) params.reply_uid = replyUid
            if (spid) params.sub_post_id = spid
          }
          const data = await api('/c/c/post/add', params)
          const err = apiError(data)
          if (err) throw new Error(err)
          d.comments += 1
          noteWrite('comment', `${tid} ${target} ${short(content, 100)}`, true, { tid, pid })
          return {
            ok: true,
            sent: true,
            target,
            content,
            message: `发出去了（${target === 'thread' ? '回帖' : target === 'post' ? `回复 ${pid} 楼` : `回复楼中楼 ${spid}`}）。`,
          }
        } catch (error) {
          const cooled = tripCooldown(error)
          noteWrite('comment', `fail ${tid} ${short(content, 100)}`, false, { tid, pid })
          return { ok: false, message: `发送失败：${String(error?.message || error)}${cooled ? '（已进入风控冷却）' : ''}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_seen',
      description: '标记一个贴吧帖子已看过，避免下次 tieba_feed 重复推荐；verdict=like/dislike 会写进兴趣。',
      parameters: {
        tid: { type: 'string', description: '帖子 id' },
        title: { type: 'string', description: '可选：标题，便于以后看' },
        verdict: { type: 'string', enum: ['like', 'dislike', 'neutral'], description: '默认 neutral' },
        note: { type: 'string', description: '可选：一句为什么' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        const tid = String(args?.tid || '').trim()
        if (!/^\d+$/u.test(tid)) return { ok: false, message: 'tid 要是数字。' }
        state.seen = state.seen || {}
        const verdict = String(args?.verdict || 'neutral')
        state.seen[tid] = {
          at: Math.floor(Date.now() / 1000),
          title: String(args?.title || state.seen[tid]?.title || ''),
          kw: String(state.seen[tid]?.kw || state.forums?.[tid]?.kw || ''),
          verdict,
          note: String(args?.note || ''),
        }
        saveState()
        return { ok: true, tid, verdict, message: `记下了：${tid}（${verdict}）` }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'tieba_interest',
      description: '看或改屿的贴吧兴趣：喜欢的吧列表、不想看的关键词。get 只读；set 整体替换。',
      parameters: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get 或 set' },
        likeForums: { type: 'string', description: 'set 时：喜欢的吧名，逗号或空格分隔，最多 20 个' },
        dislikeKeywords: { type: 'string', description: 'set 时：不想看的关键词，逗号或空格分隔，最多 20 个' },
      },
      output: { schema: { type: 'json' }, render },
      async execute(args) {
        if (String(args?.action || 'get') === 'set') {
          const split = (v) =>
            String(v || '')
              .split(/[\s,，]+/u)
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 20)
          if (typeof args?.likeForums === 'string') interest.likeForums = split(args.likeForums)
          if (typeof args?.dislikeKeywords === 'string') interest.dislikeKeywords = split(args.dislikeKeywords)
          saveInterest()
          return {
            ok: true,
            interest,
            message: `兴趣已更新：吧 ${interest.likeForums.join('、') || '（空）'}；不想看 ${interest.dislikeKeywords.join('、') || '（空）'}`,
          }
        }
        return {
          ok: true,
          interest,
          message: `喜欢：${interest.likeForums.join('、') || '（空）'}\n不想看：${interest.dislikeKeywords.join('、') || '（空）'}`,
        }
      },
    }),
  )
}
