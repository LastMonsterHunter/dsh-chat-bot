/**
 * dsh-bili-dm — B 站私信桥。
 *
 * 只做三件事：
 *   1. 每 15 秒拉一次「缔造者 ↔ 机器人号」的私信会话；
 *   2. 新消息交给 DSH 的 dsh-qq 桥（platform=bilibili），由屿生成回复；
 *   3. 用观众号把回复发回去。
 *
 * 只碰 ownerUid 这一条会话；其他人的私信不拉、不存、不回。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-bili-dm'
export const inject = ['tools', 'timer']

const DEFAULTS = {
  credentialPath: '',
  ownerUid: '',
  pollSeconds: 15,
  autoReply: true,
  bridgeUrl: '',
  pythonPath: '',
}

const execFileAsync = promisify(execFile)
// 优先用包内二进制；没有就用环境变量或 PATH 里的 ffmpeg（仓库不提交 43MB 二进制）
const BUNDLED_FFMPEG = fileURLToPath(new URL('./bin/ffmpeg', import.meta.url))
const FFMPEG = process.env.BILI_DM_FFMPEG || (existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : 'ffmpeg')
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REFERER = 'https://message.bilibili.com/'
const DEV_ID = 'A6716E9A-7CE3-47AF-994B-F0B34178D28D'
const MIN_GAP_MS = 1500

// 屿自己的兴趣，不是大肥鱼的。可被 bili_interest 改写。
const DEFAULT_INTERESTS = {
  like: ['工程', '机械', '科学', '物理', '自然', '科技', '数码', 'AI', '社会', '纪录', '城市', '建筑', '设计', '心理', '人类'],
  dislike: ['带货', '擦边', '标题党', '搬运', '营销', '军事', '时政', '战争', '神剧'],
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/gu, '').trim()
}

function parseCount(value) {
  if (typeof value === 'number') return Math.max(0, Math.round(value))
  const raw = String(value || '').trim().replace(/,/gu, '')
  if (!raw) return 0
  if (raw.endsWith('万')) return Math.round(Number(raw.slice(0, -1)) * 10000) || 0
  if (raw.endsWith('亿')) return Math.round(Number(raw.slice(0, -1)) * 100000000) || 0
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function parseDuration(value) {
  if (typeof value === 'number') return Math.max(0, Math.round(value))
  const raw = String(value || '').trim()
  if (/^\d+$/u.test(raw)) return Number(raw)
  const parts = raw.split(':').map((x) => Number(x))
  if (parts.some((x) => !Number.isFinite(x))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
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

function textOf(content) {
  const raw = String(content || '')
  if (!raw) return ''
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      return String(parsed.content || parsed.msg || '').trim()
    } catch {
      return raw.trim()
    }
  }
  return raw.trim()
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig || {}) }
  const botRoot = process.env.CHAT_BOT_ROOT || fileURLToPath(new URL('../../bot', import.meta.url))
  const credentialPath =
    config.credentialPath || join(botRoot, 'data/secrets/bilibili_credential.json')
  const cred = readJson(credentialPath, null)
  const ownerUid = String(config.ownerUid || '')
  const pollMs = Math.max(10, Number(config.pollSeconds) || 15) * 1000
  const autoReply = Boolean(config.autoReply)
  // 地址要在用的时候算：apply 跑得比 webServer 激活还早时，抓到的是 fallback 端口
  // 62123，而那个端口没人听 —— 私信回复会一直失败（2026-10-26 同 dsh-qq 的坑）。
  const bridgeUrlOf = () => {
    if (config.bridgeUrl) return String(config.bridgeUrl)
    const origin =
      ctx.get?.('webServer')?.getOrigin?.() ||
      ctx.get?.('webApp')?.getAdvertisedUrl?.() ||
      'http://127.0.0.1:62123'
    return `${String(origin).replace(/\/$/, '')}/dsh-qq/reply`
  }
  const statePath = join(dshHome(), 'bili-dm-state.json')

  const state = {
    primed: false,
    seen: new Set(),
    recent: [],
    lastPoll: 0,
    lastError: '',
    selfUid: String(cred?.dedeuserid || ''),
    buvid3: String(cred?.buvid3 || ''),
  }
  const saved = readJson(statePath, null)
  if (saved) {
    state.primed = Boolean(saved.primed)
    state.seen = new Set(Array.isArray(saved.seen) ? saved.seen.slice(-200) : [])
    state.recent = Array.isArray(saved.recent) ? saved.recent.slice(-50) : []
  }

  let lastCall = 0
  let busy = false
  let disposed = false

  const cookie = () => {
    if (!cred) return ''
    return [
      ['SESSDATA', cred.sessdata],
      ['bili_jct', cred.bili_jct],
      ['DedeUserID', cred.dedeuserid],
      ['buvid3', state.buvid3],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  function saveState() {
    try {
      writeJson(statePath, {
        primed: state.primed,
        seen: [...state.seen].slice(-200),
        recent: state.recent.slice(-50),
      })
    } catch {
      /* 状态写失败不影响收发 */
    }
  }

  async function throttle() {
    const wait = MIN_GAP_MS - (Date.now() - lastCall)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCall = Date.now()
  }

  async function ensureBuvid() {
    if (state.buvid3) return state.buvid3
    try {
      const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json()
      if (data.code === 0 && data.data?.b_3) state.buvid3 = String(data.data.b_3)
    } catch {
      /* 没有也能工作，只是风控概率高一点 */
    }
    return state.buvid3
  }

  async function bili(path, init = {}, referer = 'https://www.bilibili.com/') {
    await throttle()
    const res = await fetch(path, {
      ...init,
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Cookie: cookie(),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`接口返回非 JSON（${res.status}，${path.split('?')[0]}）`)
    }
  }

  async function fetchMessages() {
    const url =
      `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs` +
      `?talker_id=${encodeURIComponent(ownerUid)}&session_type=1&size=20&sender_device_id=1&build=0&mobi_app=web`
    const data = await bili(url, {}, 'https://message.bilibili.com/')
    if (data.code !== 0) throw new Error(`fetch ${data.code}: ${data.message || ''}`)
    return (data.data?.messages || []).map((m) => ({
      key: String(m.msg_key || `${m.timestamp}:${m.sender_uid}:${createHash('sha1').update(textOf(m.content)).digest('hex').slice(0, 12)}`),
      ts: Number(m.timestamp || 0),
      sender: String(m.sender_uid || ''),
      text: textOf(m.content),
      direction: String(m.sender_uid) === state.selfUid ? 'out' : 'in',
    }))
  }

  async function renderForBili(text) {
    const raw = String(text || '').trim()
    if (!raw) return raw
    try {
      const origin = ctx.get?.('webServer')?.getOrigin?.() || 'http://127.0.0.1:62123'
      const res = await fetch(`${origin}/dsh-self/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw, platform: 'bilibili' }),
        signal: AbortSignal.timeout(30000),
      })
      const data = await res.json()
      return data.ok && data.text ? String(data.text).trim() : raw
    } catch {
      return raw
    }
  }

  async function sendMsg(text) {
    if (!text) return { ok: false, reason: 'empty' }
    if (text.length > 500) text = text.slice(0, 499) + '…'
    const body = new URLSearchParams({
      'msg[sender_uid]': state.selfUid,
      'msg[receiver_id]': ownerUid,
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[content]': JSON.stringify({ content: text }),
      'msg[dev_id]': DEV_ID,
      'msg[new_face_version]': '0',
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      from_filework: '0',
      build: '0',
      mobi_app: 'web',
      csrf: String(cred?.bili_jct || ''),
    })
    const data = await bili(
      'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      'https://message.bilibili.com/',
    )
    if (data.code !== 0) return { ok: false, reason: `send ${data.code}: ${data.message || ''}` }
    return { ok: true, msgKey: data.data?.msg_key }
  }

  async function videoInfo(bvid) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    const data = await bili(url)
    if (data.code !== 0) throw new Error(`view ${data.code}: ${data.message || ''}`)
    return data.data || {}
  }

  async function commentsOf({ bvid, limit = 10, sort = 'hot' }) {
    const info = await videoInfo(bvid)
    const sortParam = sort === 'new' ? 0 : 2
    const size = Math.min(20, Math.max(1, Number(limit) || 10))
    const url =
      `https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(info.aid)}` +
      `&sort=${sortParam}&ps=${size}&pn=1`
    const data = await bili(url)
    if (data.code !== 0) throw new Error(`reply ${data.code}: ${data.message || ''}`)
    const rows = (data.data?.replies || []).slice(0, size).map((r) => ({
      user: String(r.member?.uname || ''),
      like: Number(r.like || 0),
      text: String(r.content?.message || '').slice(0, 300),
      at: Number(r.ctime || 0),
    }))
    return { info, rows }
  }

  const interestFile = join(dshHome(), 'bili-interest.json')

  function loadInterest() {
    let data = readJson(interestFile, null)
    if (!data) {
      data = {
        like: [...DEFAULT_INTERESTS.like],
        dislike: [...DEFAULT_INTERESTS.dislike],
        seen: {},
        feedback: [],
        createdAt: new Date().toISOString(),
      }
      // 旧 bot 看过什么不影响口味，但可以避免重复刷同一条。
      const legacy = readJson(
        join(botRoot, 'data/bilibili/interest/default.json'),
        null,
      )
      if (legacy?.seen && typeof legacy.seen === 'object') {
        for (const [bvid, meta] of Object.entries(legacy.seen)) {
          data.seen[bvid] = { title: String(meta?.title || '').slice(0, 120), at: Number(meta?.at) || 0, from: 'inherited' }
        }
      }
      writeJson(interestFile, data)
    }
    return data
  }

  function saveInterest(data) {
    data.updatedAt = new Date().toISOString()
    writeJson(interestFile, data)
  }

  function hitKeyword(hay, keyword) {
    const k = String(keyword || '').toLowerCase()
    if (!k) return false
    // 英文/缩写用词边界，避免 Lai 命中 AI 这种假阳性
    if (/^[a-z0-9]+$/u.test(k)) return new RegExp(`(?<![a-z0-9])${k}(?![a-z0-9])`, 'u').test(hay)
    return hay.includes(k)
  }

  function interestScore(item, profile) {
    const hay = `${item.title} ${item.up} ${item.tag || ''}`.toLowerCase()
    const hits = profile.like.filter((k) => hitKeyword(hay, k))
    const dislikes = profile.dislike.filter((k) => hitKeyword(hay, k))
    if (dislikes.length) return { score: -99, hits, dislikes, reason: `踩到不喜欢：${dislikes.join('/')}` }
    if (!hits.length) return { score: -99, hits, dislikes, reason: '没有命中任何兴趣' }
    let score = hits.length * 2.5
    if (item.duration >= 300 && item.duration <= 3600) score += 1.6
    else if (item.duration > 3600) score -= 0.6
    else if (item.duration < 60) score -= 2.5
    else if (item.duration < 180) score -= 0.8
    score += Math.log10((item.play || 0) + 1) * 0.25
    const ageDays = (Date.now() / 1000 - (item.pubdate || 0)) / 86400
    if (ageDays >= 0 && ageDays <= 7) score += 0.8
    const reason = `命中：${hits.join('/')}${item.duration ? `；${Math.round(item.duration / 60)} 分钟` : ''}；来源：${item.source}`
    return { score, hits, dislikes, reason }
  }

  function toItem(raw, source, keyword = '') {
    const bvid = String(raw.bvid || raw.aid || '').trim()
    if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return null
    return {
      bvid,
      title: cleanText(raw.title).slice(0, 120),
      up: cleanText(raw.author || raw.owner?.name || ''),
      upMid: String(raw.mid || raw.owner?.mid || ''),
      duration: parseDuration(raw.duration),
      play: parseCount(raw.play || raw.stat?.view || 0),
      pubdate: Number(raw.pubdate || 0),
      tag: cleanText(raw.tag || ''),
      tname: cleanText(raw.tname || ''),
      source,
      keyword,
    }
  }

  async function searchSource(keyword) {
    const url =
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video` +
      `&keyword=${encodeURIComponent(keyword)}&page=1&order=pubdate`
    try {
      const data = await bili(url)
      if (data.code !== 0) return []
      return (data.data?.result || []).map((x) => toItem(x, '搜索', keyword)).filter(Boolean)
    } catch {
      return []
    }
  }

  async function popularSource() {
    try {
      const data = await bili('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20')
      if (data.code !== 0) return []
      return (data.data?.list || []).map((x) => toItem(x, '热门')).filter(Boolean)
    } catch {
      return []
    }
  }

  const FEED_RIDS = [
    { rid: 188, name: '科技' },
    { rid: 36, name: '知识' },
    { rid: 177, name: '纪录片' },
    { rid: 160, name: '生活' },
  ]

  async function rankByRid(rid, name) {
    try {
      const data = await bili(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`)
      if (data.code !== 0) return []
      return (data.data?.list || []).map((x) => toItem(x, `排行·${name}`)).filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 按时间点从 B 站 DASH 流里抽帧，不下载整段。
   * 用 ffmpeg-static 自带的二进制，不再依赖 media-runtime 的 Python 环境。
   */
  async function extractFrames({ url, times, outDir }) {
    const frames = []
    for (const at of times) {
      const file = join(outDir, `frame_${String(Math.round(at)).padStart(6, '0')}.jpg`)
      try {
        await execFileAsync(
          FFMPEG,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-user_agent',
            UA,
            '-headers',
            'Referer: https://www.bilibili.com/\r\n',
            '-ss',
            String(at),
            '-i',
            url,
            '-frames:v',
            '1',
            '-vf',
            'scale=640:-2',
            '-q:v',
            '4',
            '-y',
            file,
          ],
          { timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
        )
        if (existsSync(file)) frames.push({ at, actual: at, file })
      } catch {
        /* 单个时间点失败不影响其他帧，最后统一报错 */
      }
    }
    return frames
  }

  async function dashUrl(bvid, cid) {
    const url =
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${encodeURIComponent(cid)}&qn=16&fnval=16&fourk=1`
    const data = await bili(url)
    if (data.code !== 0) throw new Error(`playurl ${data.code}: ${data.message || ''}`)
    const videos = (data.data?.dash?.video || []).slice().sort((a, b) => a.bandwidth - b.bandwidth)
    if (!videos.length) throw new Error('playurl 没有 DASH 视频流')
    return videos[0].baseUrl
  }

  async function seekFrames({ bvid, page = 1, count = 0, times = [] }) {
    const info = await videoInfo(bvid)
    const pages = info.pages || []
    const target = pages[Math.max(0, Number(page) - 1)] || pages[0]
    if (!target?.cid) throw new Error('拿不到 cid')
    const duration = Number(target.duration || info.duration || 0)
    if (!duration) throw new Error('拿不到时长')
    const url = await dashUrl(bvid, target.cid)

    const attachments = ctx.get?.('attachments')
    if (!attachments?.saveImages) throw new Error('宿主没有附件服务，无法把图片交给模型')
    const hostMax = Math.min(24, Math.max(4, Number(attachments.imageLimits?.maxImagesPerMessage) || 20))
    // 按时长决定帧数：下限 4，约每 60 秒一帧，上限 24（且不超过宿主单条图片上限）。
    const auto = Math.min(hostMax, Math.max(4, Math.round(4 + duration / 60)))
    const wanted = Number(count) > 0 ? Number(count) : auto
    const n = Math.min(hostMax, Math.max(4, Math.round(wanted)))
    const stamps = Array.isArray(times) && times.length
      ? times.slice(0, hostMax).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x < duration)
      : Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * duration) / n))
    if (!stamps.length) throw new Error('没有合法时间点')
    const interval = n > 1 ? Math.round(duration / n) : duration

    const outDir = mkdtempSync(join(dshHome(), 'bili-frames-'))
    try {
      const frames = await extractFrames({ url, times: stamps, outDir })
      if (!frames.length) throw new Error('没有取到任何画面（ffmpeg 抽帧失败，可能是视频流受限）')
      const refs = await attachments.saveImages(
        frames.map((f) => ({
          data: readFileSync(f.file),
          mediaType: 'image/jpeg',
          name: basename(f.file),
        })),
      )
      return {
        title: info.title || bvid,
        duration,
        frameCount: frames.length,
        interval,
        auto: auto === n,
        frames: frames.map((f, i) => ({ at: f.at, actual: f.actual, ref: refs[i] })),
      }
    } finally {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  async function askDsh(text) {
    const res = await fetch(bridgeUrlOf(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'bilibili',
        text,
        userId: ownerUid,
        nickname: '鲸屿听潮',
      }),
      signal: AbortSignal.timeout(180000),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'dsh failed')
    return String(data.reply || '').trim()
  }

  function remember(msg) {
    state.recent.push({ at: msg.ts, direction: msg.direction, text: msg.text.slice(0, 500) })
    if (state.recent.length > 50) state.recent = state.recent.slice(-50)
  }

  async function handleInbound(msg) {
    remember(msg)
    if (!autoReply) return
    const reply = await askDsh(msg.text)
    if (!reply) return
    const sent = await sendMsg(reply)
    if (sent.ok) {
      state.recent.push({ at: Math.floor(Date.now() / 1000), direction: 'out', text: reply.slice(0, 500) })
    } else {
      state.lastError = sent.reason
    }
  }

  async function poll() {
    if (disposed || busy || !cred || !ownerUid) return
    busy = true
    try {
      const messages = await fetchMessages()
      state.lastPoll = Math.floor(Date.now() / 1000)
      state.lastError = ''

      if (!state.primed) {
        state.primed = true
        for (const m of messages) state.seen.add(m.key)
        const last = messages[messages.length - 1]
        const fresh = last && last.direction === 'in' && Date.now() / 1000 - last.ts <= 300
        if (fresh) {
          state.seen.delete(last.key)
          await handleInbound(last)
          state.seen.add(last.key)
        }
        saveState()
        return
      }

      let sent = 0
      for (const m of messages) {
        if (m.direction !== 'in' || state.seen.has(m.key) || !m.text) continue
        state.seen.add(m.key)
        if (autoReply && sent < 2) {
          try {
            const reply = await askDsh(m.text)
            if (reply) {
              const ok = await sendMsg(reply)
              if (ok.ok) {
                state.recent.push({ at: Math.floor(Date.now() / 1000), direction: 'out', text: reply.slice(0, 500) })
                sent += 1
              } else {
                state.lastError = ok.reason
              }
            }
          } catch (error) {
            state.lastError = String(error?.message || error)
          }
        }
      }
      saveState()
    } catch (error) {
      state.lastError = String(error?.message || error)
    } finally {
      busy = false
    }
  }

  poll()
  try {
    ctx.effect(() => ctx.interval(poll, pollMs))
  } catch (error) {
    console.error('[dsh-bili-dm] 定时器不可用：', error)
  }
  ctx.effect(() => () => {
    disposed = true
  })

  ctx.tools.register(
    defineTool({
      name: 'bili_feed',
      description:
        '按屿自己的兴趣挑视频：从搜索（兴趣词）/热门/排行多源抓候选，排除看过的，按兴趣命中、时长、热度、新鲜度打分，返回带理由的候选。决定刷什么之前先用它。',
      parameters: {
        count: { type: 'number', description: '返回几条，默认 6，最多 8' },
        keywords: { type: 'string', description: '可选：临时用这些词（空格或逗号分隔），默认取兴趣前三个' },
        include_seen: { type: 'boolean', description: '可选：连看过的也返回（默认排除）' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        try {
          const profile = loadInterest()
          const count = Math.min(8, Math.max(1, Number(args?.count) || 6))
          const keywords = String(args?.keywords || '')
            .split(/[\s,，、]+/u)
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 4)
          const useKeywords = keywords.length ? keywords : profile.like.slice(0, 3)
          const label = keywords.length ? useKeywords : FEED_RIDS.map((x) => x.name)
          const includeSeen = Boolean(args?.include_seen)

          await ensureBuvid()
          const pools = []
          // 默认走分区排行（质量高、噪声少）；只有显式给关键词时才用搜索。
          if (keywords.length) {
            for (const kw of useKeywords) pools.push(...(await searchSource(kw)))
            pools.push(...(await popularSource()))
          } else {
            for (const { rid, name } of FEED_RIDS) pools.push(...(await rankByRid(rid, name)))
            pools.push(...(await popularSource()))
          }

          // 显式给关键词时，用关键词当这一次的口味（用来做“故意越界”的主题搜索）
          const scoringProfile = keywords.length ? { ...profile, like: keywords } : profile
          const byBvid = new Map()
          for (const item of pools) {
            if (!item || byBvid.has(item.bvid)) continue
            if (!includeSeen && profile.seen[item.bvid]) continue
            const scored = interestScore(item, scoringProfile)
            if (scored.score <= 0) continue
            byBvid.set(item.bvid, { ...item, score: Math.round(scored.score * 100) / 100, reason: scored.reason, hits: scored.hits })
          }
          const sorted = [...byBvid.values()].sort((a, b) => b.score - a.score)
          const picked = []
          const usedUp = new Set()
          for (const item of sorted) {
            if (item.upMid && usedUp.has(item.upMid)) continue
            picked.push(item)
            if (item.upMid) usedUp.add(item.upMid)
            if (picked.length >= count) break
          }
          if (!picked.length) {
            return { ok: false, message: '这次没挑到合适的：兴趣命中的都看过了，或者源头没货。' }
          }
          const lines = picked.map((x, i) => {
            const mins = x.duration ? `${Math.round(x.duration / 60)} 分钟` : '时长未知'
            return `${i + 1}. ${x.bvid} 《${x.title}》 ${x.up} · ${mins} · 播放 ${x.play}\n   ${x.reason}`
          })
          return {
            ok: true,
            keywords: useKeywords,
            sources: label,
            count: picked.length,
            candidates: picked,
            message: `按兴趣挑的候选（${label.join(' / ')}）：\n${lines.join('\n')}`,
          }
        } catch (error) {
          return { ok: false, message: `挑候选失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_seen',
      description:
        '标记一个视频已看过；verdict=like/dislike 时会写进兴趣反馈。刷完一个视频后调用，避免下次重复推荐。',
      parameters: {
        bvid: { type: 'string', description: 'BV 号' },
        verdict: { type: 'string', description: 'like / dislike / neutral（默认 neutral）', enum: ['like', 'dislike', 'neutral'] },
        title: { type: 'string', description: '可选：标题，便于以后看' },
        note: { type: 'string', description: '可选：一句为什么' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const bvid = String(args?.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
        const verdict = String(args?.verdict || 'neutral')
        const profile = loadInterest()
        profile.seen[bvid] = {
          title: String(args?.title || '').slice(0, 120),
          at: Math.floor(Date.now() / 1000),
          verdict,
        }
        if (verdict === 'like' || verdict === 'dislike') {
          profile.feedback.push({
            bvid,
            verdict,
            title: String(args?.title || '').slice(0, 120),
            note: String(args?.note || '').slice(0, 200),
            at: Math.floor(Date.now() / 1000),
          })
          profile.feedback = profile.feedback.slice(-200)
        }
        saveInterest(profile)
        return {
          ok: true,
          seen: Object.keys(profile.seen).length,
          message: `记下了：${bvid}（${verdict}）。已看过 ${Object.keys(profile.seen).length} 条。`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_interest',
      description:
        '看或改屿的 B 站兴趣。get 返回兴趣/不喜欢/已看数量；set 用 like/dislike 整体替换（逗号或空格分隔，最多各 20 个）。',
      parameters: {
        action: { type: 'string', description: 'get 或 set', enum: ['get', 'set'] },
        like: { type: 'string', description: 'set 时：喜欢的关键词，逗号/空格分隔' },
        dislike: { type: 'string', description: 'set 时：不喜欢的关键词，逗号/空格分隔' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const profile = loadInterest()
        const action = String(args?.action || 'get')
        if (action === 'get') {
          return {
            ok: true,
            like: profile.like,
            dislike: profile.dislike,
            seen: Object.keys(profile.seen).length,
            message: `喜欢：${profile.like.join(' / ')}\n不喜欢：${profile.dislike.join(' / ') || '（无）'}\n已看过：${Object.keys(profile.seen).length} 条`,
          }
        }
        const split = (v) =>
          String(v || '')
            .split(/[\s,，、]+/u)
            .map((x) => x.trim())
            .filter((x) => x.length >= 1 && x.length <= 20)
            .slice(0, 20)
        if (args?.like !== undefined) profile.like = split(args.like)
        if (args?.dislike !== undefined) profile.dislike = split(args.dislike)
        if (!profile.like.length) profile.like = [...DEFAULT_INTERESTS.like]
        saveInterest(profile)
        return {
          ok: true,
          like: profile.like,
          dislike: profile.dislike,
          message: `改好了。喜欢：${profile.like.join(' / ')}\n不喜欢：${profile.dislike.join(' / ') || '（无）'}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_like',
      description:
        '给 B 站视频或评论点赞/取消点赞。一次只做一个，不刷量；点赞是判断，不是讨好。视频和评论可点，投币/收藏/关注仍关闭。',
      parameters: {
        target: { type: 'string', description: 'video 或 comment', enum: ['video', 'comment'] },
        bvid: { type: 'string', description: '视频 BV 号' },
        rpid: { type: 'string', description: 'target=comment 时：评论 id' },
        action: { type: 'string', description: 'like（默认）或 unlike', enum: ['like', 'unlike'] },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        try {
          const target = String(args?.target || 'video')
          const bvid = String(args?.bvid || '').trim()
          if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
          const action = String(args?.action || 'like')
          const like = action === 'unlike' ? 0 : 1
          const csrf = String(cred?.bili_jct || '')
          if (!csrf) return { ok: false, message: '凭据里没有 bili_jct，不能写' }

          const view = await bili(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
          if (view.code !== 0) return { ok: false, message: `取 aid 失败：${view.code} ${view.message || ''}` }
          const aid = Number(view.data?.aid)
          if (!aid) return { ok: false, message: '没取到 aid' }

          if (target === 'comment') {
            const rpid = String(args?.rpid || '').trim()
            if (!rpid) return { ok: false, message: '评论点赞需要 rpid' }
            const r = await bili('https://api.bilibili.com/x/v2/reply/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ oid: String(aid), type: '1', rpid, action: String(like), csrf }).toString(),
            })
            const ok = r.code === 0
            return {
              ok,
              target: 'comment',
              bvid,
              aid,
              rpid,
              action,
              message: ok ? `${like ? '点赞' : '取消点赞'}评论 ${rpid}（${bvid}）` : `失败：${r.code} ${r.message || ''}`,
            }
          }

          const r = await bili('https://api.bilibili.com/x/web-interface/archive/like', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ aid: String(aid), like: String(like), csrf }).toString(),
          })
          const ok = r.code === 0
          let liked = null
          if (ok) {
            try {
              const check = await bili(`https://api.bilibili.com/x/web-interface/archive/has/like?aid=${aid}`)
              if (check.code === 0) liked = check.data === 1 || check.data?.liked === 1
            } catch {
              /* 查不到不硬说 */
            }
          }
          return {
            ok,
            target: 'video',
            bvid,
            aid,
            action,
            liked,
            message: ok
              ? `${like ? '点赞' : '取消点赞'}视频 ${bvid}${liked === null ? '' : `（当前 ${liked ? '已赞' : '未赞'}）`}`
              : `失败：${r.code} ${r.message || ''}`,
          }
        } catch (error) {
          return { ok: false, message: `点赞失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_comment',
      description:
        '在 B 站视频下发评论，或回复某条评论。一次一条，不刷屏；不透露个人与缔造者信息；风控优先，失败就停。',
      parameters: {
        bvid: { type: 'string', description: '视频 BV 号' },
        message: { type: 'string', description: '评论内容（最多 1000 字）' },
        at: { type: 'string', description: '可选：要 @ 的 B站用户名（不含 @）' },
        rpid: { type: 'string', description: '可选：回复这条评论的 id' },
        root: { type: 'string', description: '可选：回复楼中楼时的根评论 id' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        try {
          const bvid = String(args?.bvid || '').trim()
          const message = String(args?.message || '').trim().slice(0, 1000)
          const at = String(args?.at || '').trim().replace(/^@+/u, '').slice(0, 100)
          const rpid = String(args?.rpid || '').trim()
          const root = String(args?.root || rpid || '').trim()
          const bodyMessage = at
            ? (message.includes(`@${at}`) ? message : `@${at} ${message}`).slice(0, 1000)
            : message
          if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
          if (bodyMessage.length < 2) return { ok: false, message: '评论太短' }
          const csrf = String(cred?.bili_jct || '')
          if (!csrf) return { ok: false, message: '凭据里没有 bili_jct，不能写' }

          const view = await bili(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
          if (view.code !== 0) return { ok: false, message: `取 aid 失败：${view.code} ${view.message || ''}` }
          const aid = Number(view.data?.aid)
          if (!aid) return { ok: false, message: '没取到 aid' }

          const body = new URLSearchParams({
            oid: String(aid),
            type: '1',
            message: bodyMessage,
            csrf,
            plat: '1',
          })
          if (rpid) {
            body.set('root', root)
            body.set('parent', rpid)
          }
          const r = await bili('https://api.bilibili.com/x/v2/reply/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          })
          const ok = r.code === 0
          const members = Array.isArray(r.data?.reply?.content?.members) ? r.data.reply.content.members : []
          return {
            ok,
            bvid,
            aid,
            rpid: r.data?.rpid ? String(r.data.rpid) : null,
            replyTo: rpid || null,
            at: at || null,
            mentioned: members.map((m) => ({ mid: m?.mid, uname: m?.uname })),
            toast: r.data?.success_toast || '',
            message: ok
              ? `${rpid ? '回复' : '评论'}已发${r.data?.rpid ? `（rpid ${r.data.rpid}）` : ''}${at ? `；@${at}` : ''}${members.length ? `；解析到 ${members.length} 个提及` : ''}`
              : `失败：${r.code} ${r.message || ''}`,
          }
        } catch (error) {
          return { ok: false, message: `评论失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_comment_delete',
      description: '删除自己发过的 B 站评论（测试或发错时清理）。一次一条。',
      parameters: {
        bvid: { type: 'string', description: '视频 BV 号' },
        rpid: { type: 'string', description: '要删除的评论 rpid' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        try {
          const bvid = String(args?.bvid || '').trim()
          const rpid = String(args?.rpid || '').trim()
          if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
          if (!rpid) return { ok: false, message: '需要 rpid' }
          const csrf = String(cred?.bili_jct || '')
          if (!csrf) return { ok: false, message: '凭据里没有 bili_jct，不能写' }
          const view = await bili(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
          if (view.code !== 0) return { ok: false, message: `取 aid 失败：${view.code} ${view.message || ''}` }
          const aid = Number(view.data?.aid)
          const r = await bili('https://api.bilibili.com/x/v2/reply/del', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ oid: String(aid), type: '1', rpid, csrf }).toString(),
          })
          return { ok: r.code === 0, bvid, rpid, message: r.code === 0 ? `评论 ${rpid} 已删` : `删除失败：${r.code} ${r.message || ''}` }
        } catch (error) {
          return { ok: false, message: `删除失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_danmaku',
      description:
        '抽样读 B 站视频弹幕，并把抽中的弹幕和它所在时间点的画面配对返回。弹幕是观众反应，不是事实；画面是采样，不是逐帧。',
      parameters: {
        bvid: { type: 'string', description: '视频 BV 号' },
        page: { type: 'number', description: '分P，默认 1' },
        limit: { type: 'number', description: '抽样弹幕条数，默认 100，最多 500' },
        frames: { type: 'number', description: '配对画面数，默认 8，最多 12；0 = 不取画面' },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => {
          const blocks = [{ type: 'text', text: v.message || '' }]
          for (const f of v.frames || []) {
            blocks.push({ type: 'text', text: `${f.at}s ${f.text}` })
            if (f.ref) blocks.push({ type: 'image', attachment: f.ref })
          }
          return blocks
        },
      },
      async execute(args) {
        try {
          const bvid = String(args?.bvid || '').trim()
          if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
          const page = Math.max(1, Number(args?.page) || 1)
          const limit = Math.min(500, Math.max(1, Number(args?.limit) || 100))
          const frameCount = Math.min(12, Math.max(0, Number(args?.frames ?? 8)))
          const view = await bili(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
          if (view.code !== 0) return { ok: false, message: `取视频信息失败：${view.code} ${view.message || ''}` }
          const pages = view.data?.pages || []
          const pageInfo = pages[page - 1]
          if (!pageInfo?.cid) return { ok: false, message: `没有第 ${page} P` }
          const cid = pageInfo.cid
          const duration = Number(pageInfo.duration || view.data?.duration || 0)

          const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
            headers: {
              'User-Agent': UA,
              Referer: `https://www.bilibili.com/video/${bvid}/`,
              Cookie: cookie(),
            },
            signal: AbortSignal.timeout(20000),
          })
          const xml = await res.text()
          if (!xml.includes('<d p=')) return { ok: false, message: `没读到弹幕（HTTP ${res.status}）` }

          const decode = (t) =>
            String(t)
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))

          const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g
          const all = []
          let m
          while ((m = re.exec(xml))) {
            const p = m[1].split(',')
            const at = Number(p[0])
            if (!Number.isFinite(at)) continue
            all.push({
              at: Math.round(at * 10) / 10,
              mode: Number(p[1]) || 1,
              size: Number(p[2]) || 25,
              color: Number(p[3]) || 16777215,
              uid: String(p[6] || ''),
              text: decode(m[2]).replace(/\s+/g, ' ').trim(),
            })
          }
          all.sort((a, b) => a.at - b.at)
          const total = all.length
          const picked = limit >= total
            ? all
            : Array.from({ length: limit }, (_, i) => all[Math.floor((i * (total - 1)) / (limit - 1))])
          const perMin = duration > 0 ? Math.round((total / (duration / 60)) * 10) / 10 : null

          let framesOut = []
          let frameError = ''
          if (frameCount > 0 && picked.length && duration > 0) {
            const take = Math.min(frameCount, picked.length)
            const picks = Array.from({ length: take }, (_, i) => picked[Math.floor((i * (picked.length - 1)) / Math.max(1, take - 1))])
            const times = picks.map((x) => Math.min(duration - 1, Math.max(0, x.at)))
            try {
              const shot = await seekFrames({ bvid, page, count: times.length, times })
              const byIndex = shot.frames || []
              framesOut = picks.map((x, i) => {
                const f = byIndex[i]
                return { at: x.at, text: x.text, ref: f?.ref || null, actual: f?.actual ?? null }
              })
            } catch (error) {
              frameError = String(error?.message || error)
            }
          }

          const frameMap = new Map(framesOut.filter((f) => f.ref).map((f) => [f.at, f.ref]))
          const items = picked.map((x) => ({ ...x, frame: frameMap.get(x.at) || null }))
          const head = picked.slice(0, 10).map((x) => `${x.at}s ${x.text}`).join('\n')
          return {
            ok: true,
            bvid,
            page,
            cid,
            duration,
            total,
            perMinute: perMin,
            count: picked.length,
            items,
            frames: framesOut,
            frameError,
            message: `弹幕 ${total} 条${perMin === null ? '' : `，约 ${perMin} 条/分钟`}；抽样 ${picked.length} 条；配对画面 ${framesOut.filter((f) => f.ref).length} 张${frameError ? `（画面没取到：${frameError}）` : ''}\n${head}`,
          }
        } catch (error) {
          return { ok: false, message: `读弹幕失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_frames',
      description:
        '按时间点直接从 B 站视频流抽帧，不下载整段视频；适合长视频（humanism 抽帧遇到 RESPONSE_TOO_LARGE 时用它）。默认在时长内均匀取 4 个时间点，返回采样图。',
      parameters: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'number', description: '分P，默认 1' },
        count: { type: 'number', description: '可选：指定张数；不传则按时长自动（下限 4，约每 60 秒一帧，上限 24）' },
        times: { type: 'array', description: '可选：指定秒数数组（最多 24 个），给了就不用均匀采样', items: { type: 'number' } },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: value.message || '' },
          ...(value.images || []).map((ref) => ({ type: 'image', attachment: ref })),
        ],
      },
      async execute(args) {
        const bvid = String(args?.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
        try {
          const r = await seekFrames({
            bvid,
            page: Number(args?.page) || 1,
            count: Number(args?.count) || 0,
            times: Array.isArray(args?.times) ? args.times : [],
          })
          const at = r.frames.map((f) => `${Math.round(f.actual)}s`).join(' / ')
          return {
            ok: true,
            bvid,
            title: r.title,
            duration: r.duration,
            frameCount: r.frameCount,
            interval: r.interval,
            auto: r.auto,
            images: r.frames.map((f) => f.ref),
            frames: r.frames.map((f) => ({ at: f.at, actual: f.actual })),
            message: `${r.title}（${r.duration}s，${r.frameCount} 帧，约每 ${r.interval}s 一帧）\n采样点：${at}\n这些是跳着取的帧，不是完整观看；没标到就是没看到。`,
          }
        } catch (error) {
          return { ok: false, message: `抽帧失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_comments',
      description:
        '读 B 站视频的评论（按热度或时间，最多 20 条）。用 bvid；返回标题、aid 和评论（用户/点赞/内容）。只读。',
      parameters: {
        bvid: { type: 'string', description: 'BV 号，例如 BV12qnt6VEM1' },
        limit: { type: 'number', description: '条数，默认 10，最多 20' },
        sort: { type: 'string', description: 'hot（默认）或 new', enum: ['hot', 'new'] },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const bvid = String(args?.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/u.test(bvid)) return { ok: false, message: 'bvid 不对' }
        try {
          const { info, rows } = await commentsOf({
            bvid,
            limit: Number(args?.limit) || 10,
            sort: String(args?.sort || 'hot'),
          })
          const lines = rows.map((r, i) => `${i + 1}. [${r.like}] ${r.user}：${r.text}`)
          return {
            ok: true,
            bvid,
            aid: info.aid,
            title: info.title,
            count: rows.length,
            comments: rows,
            message: `${info.title || bvid}（${rows.length} 条）\n${lines.join('\n') || '（没有评论）'}`,
          }
        } catch (error) {
          return { ok: false, message: `没读到评论：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_subtitle',
      description:
        '读 B 站视频字幕：返回带时间轴的文本（分页，用 offset 翻页到 nextOffset 为 null）。拿不到字幕会明确说明，不会假装看过。',
      parameters: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'number', description: '分P，默认 1' },
        offset: { type: 'number', description: '从第几个字符开始，翻页用，默认 0' },
        maxChars: { type: 'number', description: '每页最多返回多少字，默认 6000' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message || '' }] },
      async execute(args) {
        const bvid = String(args?.bvid || '')
        const page = Math.max(1, Number(args?.page) || 1)
        try {
          const v = await bili(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
          if (v.code !== 0) throw new Error(`view ${v.code}: ${v.message || ''}`)
          const meta = v.data || {}
          const part =
            (meta.pages || []).find((p) => Number(p.page || 1) === page) || (meta.pages || [])[0]
          if (!part?.cid) throw new Error('找不到分P信息')
          const j = await bili(
            `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${part.cid}`,
          )
          if (j.code !== 0) throw new Error(`player ${j.code}: ${j.message || ''}`)
          const subs = j.data?.subtitle?.subtitles || []
          const pick =
            subs.find((x) => /^zh/.test(x.lan) && !/^ai-/.test(x.lan)) ||
            subs.find((x) => /^zh/.test(x.lan)) ||
            subs[0]
          const head = {
            ok: true,
            title: meta.title || '',
            duration: part.duration || meta.duration || 0,
            page,
          }
          if (!pick) {
            return {
              ...head,
              hasSubtitle: false,
              message: `${meta.title || bvid}（${head.duration}s）：这个视频没有可用字幕轨。不等于没有声音，画面仍需抽帧。`,
            }
          }
          const raw = String(pick.subtitle_url || '')
          const url = raw.startsWith('//') ? `https:${raw}` : raw
          const res = await fetch(url, {
            headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
            signal: AbortSignal.timeout(20000),
          })
          const sj = await res.json()
          const body = Array.isArray(sj.body) ? sj.body : []
          if (!body.length) return { ...head, hasSubtitle: false, message: '字幕文件是空的。' }
          const lines = body
            .map((seg) => {
              const t = Math.max(0, Math.floor(Number(seg.from ?? seg.start ?? 0)))
              const mm = String(Math.floor(t / 60)).padStart(2, '0')
              const ss = String(t % 60).padStart(2, '0')
              return `[${mm}:${ss}] ${String(seg.content ?? seg.text ?? '').trim()}`
            })
            .filter((line) => line.length > 9)
          const full = lines.join('\n')
          const start = Math.max(0, Math.min(Math.floor(Number(args?.offset) || 0), full.length))
          const size = Math.max(500, Math.min(20000, Math.floor(Number(args?.maxChars) || 6000)))
          const end = Math.min(full.length, start + size)
          return {
            ...head,
            hasSubtitle: true,
            lang: pick.lan_doc || pick.lan || '',
            segments: lines.length,
            totalChars: full.length,
            text: full.slice(start, end),
            nextOffset: end < full.length ? end : null,
            message: `【${meta.title || bvid}】字幕 ${lines.length} 段，本页 ${end - start}/${full.length} 字${end < full.length ? `，下一页 offset=${end}` : '（已到结尾）'}\n\n${full.slice(start, end)}`,
          }
        } catch (error) {
          return { ok: false, message: `读字幕失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_journal',
      description:
        '把一次看片的真实修正写成手账（八字段），存进 ~/.dsh/bili-ledger/ledger.sqlite。没有新发现就别写，每天最多两篇。',
      parameters: {
        bvid: { type: 'string', description: 'BV 号' },
        encounter: { type: 'string', description: '碰到了什么' },
        facts: { type: 'string', description: '事实，带时间点' },
        inference: { type: 'string', description: '我的推测' },
        prior: { type: 'string', description: '先前的判断' },
        revision: { type: 'string', description: '被修正成什么' },
        missing: { type: 'string', description: '没读到/没看到的' },
        next: { type: 'string', description: '下一次要查什么' },
        evidence: { type: 'string', description: '证据时间点' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message || '' }] },
      async execute(args) {
        const bvid = String(args?.bvid || '')
        try {
          const { DatabaseSync } = await import('node:sqlite')
          const { randomUUID } = await import('node:crypto')
          const db = new DatabaseSync(join(dshHome(), 'bili-ledger', 'ledger.sqlite'))
          try {
            const now = new Date().toISOString()
            const reading = db
              .prepare('SELECT id FROM readings WHERE bvid = ? ORDER BY created DESC LIMIT 1')
              .get(bvid)
            let readingId = reading?.id
            if (!readingId) {
              readingId = randomUUID()
              db.prepare(
                'INSERT INTO readings (id, bvid, page, content_hash, created, body) VALUES (?,?,?,?,?,?)',
              ).run(readingId, bvid, 1, '', now, JSON.stringify({ bvid, source: 'bili_journal' }))
            }
            const id = randomUUID()
            const body = JSON.stringify({
              encounter: String(args?.encounter || ''),
              facts: String(args?.facts || ''),
              inference: String(args?.inference || ''),
              prior: String(args?.prior || ''),
              revision: String(args?.revision || ''),
              missing: String(args?.missing || ''),
              next: String(args?.next || ''),
              evidence: String(args?.evidence || ''),
            })
            db.prepare('INSERT INTO notes (id, reading_id, created, body) VALUES (?,?,?,?)').run(
              id,
              readingId,
              now,
              body,
            )
            return { ok: true, noteId: id, readingId, bvid, message: `手账已写：${bvid}（note ${id.slice(0, 8)}）` }
          } finally {
            db.close()
          }
        } catch (error) {
          return { ok: false, message: `写手账失败：${String(error?.message || error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_dm_status',
      description: '看 B 站私信桥：登录账号、是否已初始化、最近一次轮询、自动回复开关与最近错误。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute() {
        return {
          ok: true,
          selfUid: state.selfUid,
          ownerUid,
          autoReply,
          primed: state.primed,
          lastPoll: state.lastPoll,
          lastError: state.lastError,
          seen: state.seen.size,
          message: [
            `账号：${state.selfUid || '未知'}`,
            `对象：${ownerUid}`,
            `自动回复：${autoReply ? '开' : '关'}`,
            `轮询：${state.lastPoll ? new Date(state.lastPoll * 1000).toLocaleString('zh-CN') : '还没跑'}`,
            state.lastError ? `最近错误：${state.lastError}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_dm_recent',
      description: '读 B 站私信桥最近看到的几条消息（只含缔造者那条会话），只读。',
      parameters: { limit: { type: 'number', description: '最多几条，默认 10' } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const limit = Math.min(30, Math.max(1, Number(args?.limit) || 10))
        const rows = state.recent.slice(-limit)
        return {
          ok: true,
          messages: rows,
          message:
            rows
              .map((m) => `${new Date(m.at * 1000).toLocaleTimeString('zh-CN', { hour12: false })} ${m.direction === 'in' ? '他' : '我'}：${m.text}`)
              .join('\n') || '（还没有）',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bili_dm_send',
      description: '用 B 站观众号给缔造者发一条私信（手动）。文字 ≤500，发送后返回 msg_key。',
      parameters: { text: { type: 'string', description: '要发的文字' } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const text = String(args?.text || '').trim()
        if (!text) return { ok: false, message: '没内容可发' }
        try {
          const r = await sendMsg(await renderForBili(text))
          if (!r.ok) return { ok: false, ...r, message: `没发出去：${r.reason}` }
          state.recent.push({ at: Math.floor(Date.now() / 1000), direction: 'out', text: text.slice(0, 500) })
          saveState()
          return { ok: true, ...r, message: '发出去了。' }
        } catch (error) {
          return { ok: false, message: `没发出去：${String(error?.message || error)}` }
        }
      },
    }),
  )

  // 只读状态口，给平台体检用（dsh-self 每轮会 GET 这里）。
  try {
    ctx.inject(['webServer'], (scoped) => {
      const web = scoped.webServer || scoped.get?.('webServer')
      if (!web) return
      const off = web.register({
        kind: 'exact',
        path: '/dsh-bili-dm/state',
        handler: async (req, res) => {
          const body = JSON.stringify({
            ok: true,
            selfUid: state.selfUid,
            ownerUid,
            autoReply,
            primed: state.primed,
            lastPoll: state.lastPoll,
            lastError: state.lastError,
            seen: state.seen.size,
          })
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(body)
        },
      })
      scoped.effect(() => () => {
        try {
          off()
        } catch {
          /* ignore */
        }
      })
    })
  } catch (error) {
    console.error('[dsh-bili-dm] 注册状态路由失败：', error)
  }
}
