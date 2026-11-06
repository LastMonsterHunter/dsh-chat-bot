/**
 * 人格状态：每张面具人格一份。
 *
 * 结构分两层：
 *   - global：这张脸自己的 mood / energy（0~1）——所有人共享，不按人分。
 *   - peers ：这张脸对「每个人」的 affection（0~100）与 today / why / turns。
 *
 * 规则：
 *   - 初值：mood 0.8 / energy 0.8 / affection 50；对缔造者（他的所有平台身份）affection 90。
 *   - mood / energy 每天凌晨 05:00 回到 0.8。
 *   - affection 长期存在，不随时间刷新，只由和这个人的交互慢慢变。
 *
 * 存储：masks/personas/state/<personaId>.json
 *   { version: 2, global: {...}, peers: { "<platform>:<uid>": {...} } }
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './util.js'

export const STATE_DEFAULTS = Object.freeze({ mood: 0.8, energy: 0.8, affection: 35 })

/** 对缔造者的初始好感。他的每个平台身份都按这个来。 */
export const OWNER_AFFECTION = 90

export const STATE_STEP = Object.freeze({ mood: 0.12, energy: 0.02, affection: 4 })

/** energy 每小时恢复 0.05，封顶 0.8 */
export const ENERGY_REGEN_PER_HOUR = 0.05
export const ENERGY_CAP = 0.8

/** 好感增减的硬上限：单次最多 +5，单次最多 -4，每人每天最多 +15。 */
export const AFFECTION_GAIN_MAX = 5
export const AFFECTION_LOSS_MAX = 10
export const AFFECTION_DAILY_GAIN_MAX = 20

/**
 * 心情波动带来的额外好感增减，独立于判定值、不受单次上限约束。
 * 正向：>30 +2 / >40 +4 / >50 +7 / >60 +10
 * 负向：<-30 -3 / <-40 -6 / <-50 -10 / <-60 -15
 */
export function swingAffectionBonus(swing) {
  const v = Number(swing) || 0
  if (v > 60) return 10
  if (v > 50) return 7
  if (v > 40) return 4
  if (v > 30) return 2
  if (v < -60) return -15
  if (v < -50) return -10
  if (v < -40) return -6
  if (v < -30) return -3
  return 0
}

/** 好感衰减：24 小时没变化才开始，之后每天 -5，最低到 35。 */
export const AFFECTION_DECAY_AFTER_MS = 24 * 60 * 60 * 1000
export const AFFECTION_DECAY_PER_DAY = 5
export const AFFECTION_DECAY_FLOOR = 35

const RESET_HOUR = 5
const DAY_MS = 24 * 60 * 60 * 1000

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function normNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const round3 = (n) => Math.round(n * 1000) / 1000

export function normGlobal(raw = {}, at = Date.now()) {
  return {
    mood: round3(clamp(normNum(raw.mood, STATE_DEFAULTS.mood), 0, 1)),
    energy: round3(clamp(normNum(raw.energy, STATE_DEFAULTS.energy), 0, 1)),
    at: Math.round(normNum(raw.at, at)),
  }
}


export function normPeer(raw = {}, at = Date.now()) {
  return {
    affection: Math.round(clamp(normNum(raw.affection, STATE_DEFAULTS.affection), 0, 100)),
    // 对方自己指定的称呼（昵称/名字）；不能是「老婆」「爸爸」这类身份词，由判定器把关
    nickname: String(raw.nickname || '').slice(0, 20),
    gainDate: String(raw.gainDate || ''),
    gainToday: Math.max(0, Math.round(normNum(raw.gainToday, 0))),
    // 好感最后一次真正变化的时间；旧数据没有就用 at 兜底。
    affAt: Math.round(normNum(raw.affAt, normNum(raw.at, at))),
    today: String(raw.today || '').slice(0, 60),
    why: String(raw.why || '').slice(0, 120),
    turns: Math.max(0, Math.round(normNum(raw.turns, 0))),
    at: Math.round(normNum(raw.at, at)),
  }
}

/** 最近一次凌晨 05:00 的时间戳（本地时区）。 */
export function lastResetAt(at = Date.now()) {
  const d = new Date(at)
  const mark = new Date(d.getFullYear(), d.getMonth(), d.getDate(), RESET_HOUR, 0, 0, 0).getTime()
  return at < mark ? mark - DAY_MS : mark
}

/** 日期键：和 05:00 的边界一致，用来算「每天最多 +15」。 */
export function dayKey(at = Date.now()) {
  const d = new Date(lastResetAt(at))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 跨过了一个 05:00：mood / energy 回 0.8。affection 不在这一层，动不到。 */
export function resetDailyGlobal(g, at = Date.now()) {
  const s = normGlobal(g, at)
  if (s.at >= lastResetAt(at)) return { ...s, at }
  return { mood: STATE_DEFAULTS.mood, energy: STATE_DEFAULTS.energy, at }
}

/**
 * swing 是「心情波动值」：-70 ~ 70，只对这一条回复有效。
 * 回复时看的是「基础好感 + 波动」，回复结束波动归零，基础好感照旧。
 */
export function effectiveAffection(peer, swing = 0) {
  const p = normPeer(peer)
  const s = Math.round(Math.min(70, Math.max(-70, Number(swing) || 0)))
  return { base: p.affection, swing: s, value: Math.max(0, Math.min(100, p.affection + s)) }
}

/**
 * 好感衰减：从最后一次变化起算，满 24 小时开始，每满一天 -5，最低 35。
 * 已经在 35 或以下的不再衰减；衰减本身也算一次变化，时钟重置，按天扣。
 */
export function decayAffection(peer, at = Date.now()) {
  const p = normPeer(peer, at)
  // 满值保护：100 之后不再随时间衰减，只能靠对话降
  if (p.affection >= 100) return p
  if (p.affection <= AFFECTION_DECAY_FLOOR) return p
  const since = Math.max(0, at - p.affAt)
  if (since < AFFECTION_DECAY_AFTER_MS) return p
  const days = Math.floor(since / AFFECTION_DECAY_AFTER_MS)
  const next = Math.max(AFFECTION_DECAY_FLOOR, p.affection - days * AFFECTION_DECAY_PER_DAY)
  if (next === p.affection) return p
  return { ...p, affection: next, affAt: at }
}

export function stateLine(id, global, peer, swing = 0) {
  const g = normGlobal(global)
  const p = normPeer(peer)
  const aff = effectiveAffection(p, swing)
  const today = p.today ? ` / 今天：${p.today}` : ''
  const nick = p.nickname ? `，他让你叫「${p.nickname}」` : ''
  const affText = aff.swing
    ? `affection ${aff.base}，本次波动 ${aff.swing > 0 ? '+' : ''}${aff.swing}（说话的激烈程度按这个数），本轮关系值 ${aff.value}（只用于安慰腔和语气浓度，不参与选称呼；对这个人，本次回复${nick}）`
    : `affection ${aff.base}（对这个人${nick}）`
  return `【当前人格状态：${id}】mood ${g.mood.toFixed(2)} / energy ${g.energy.toFixed(2)}（这张脸自己的，所有人共享） / ${affText}${today}`
}

/** 注入给模型的那句话：给数值，也说明它不是台词。 */
export function stateBlock(id, global, peer, swing = 0) {
  return [
    stateLine(id, global, peer, swing),
    'mood / energy 是你自己的，跟谁说话都一样；affection 是「对这一位」的，换个人就是另一份。',
    '波动只对这一条回复有效：称呼档位看**基础 affection**（波动不让称呼越档），情绪激烈程度看本次波动。回复完就消失，别当成长期关系变了。',
    '这是这会儿的底色，不是这一轮的台词：按人格层「状态」节的映射去调语气、句长、自称和距离感；别把数值念出来，别解释自己是什么状态。',
  ].join('\n')
}

export class PersonaStateStore {
  constructor({ dir }) {
    this.dir = dir
    ensureDir(dir)
  }

  pathOf(id) {
    return join(this.dir, `${id}.json`)
  }

  readAll(id) {
    const raw = readJson(this.pathOf(id), null)
    if (!raw || typeof raw !== 'object') return { version: 2, global: {}, peers: {} }
    // 兼容 v1：老文件只有 peers，且 mood/energy 混在每个人身上。
    const peers = raw.peers && typeof raw.peers === 'object' ? raw.peers : {}
    const global = raw.global && typeof raw.global === 'object' ? raw.global : {}
    return { version: 2, global, peers }
  }

  writeAll(id, data) {
    writeJsonAtomic(this.pathOf(id), {
      version: 2,
      global: data?.global || {},
      peers: data?.peers || {},
    })
  }

  peers(id) {
    return Object.keys(this.readAll(id).peers || {})
  }

  /** 这张脸自己的 mood / energy；跨过 05:00 就回 0.8。 */
  global(id) {
    const all = this.readAll(id)
    return resetDailyGlobal(all.global, Date.now())
  }

  /** 对某个人的 affection；没有记录就按初值（缔造者传 90）。 */
  peer(id, peer, initial = {}) {
    const key = String(peer || 'default')
    const all = this.readAll(id)
    const raw = all.peers[key]
    const at = Date.now()
    return decayAffection(raw ? normPeer(raw, at) : normPeer({ ...STATE_DEFAULTS, ...initial, at }, at), at)
  }

  ensurePeer(id, peer, initial = {}) {
    const key = String(peer || 'default')
    const all = this.readAll(id)
    const at = Date.now()
    if (all.peers[key]) return decayAffection(normPeer(all.peers[key], at), at)
    const p = normPeer({ ...STATE_DEFAULTS, ...initial, at }, at)
    all.peers[key] = p
    this.writeAll(id, all)
    return p
  }

  /**
   * 一次交互：mood / energy 写 global（所有人共享），affection / today / why 写这个人。
   * 返回 { global, peer }。
   */
  apply(id, peer, delta = {}, at = Date.now()) {
    const key = String(peer || 'default')
    const all = this.readAll(id)
    const g0 = resetDailyGlobal(all.global, at)
    const p0raw = all.peers[key]
      ? normPeer(all.peers[key], at)
      : normPeer({ ...STATE_DEFAULTS, ...(delta.initial || {}), at }, at)
    const p0 = decayAffection(p0raw, at)

    // mood 受好感放大：好感越高，涨得越多；好感越低，跌得越多（幅度都在两成以内）。
    const affNorm = clamp(p0.affection / 100, 0, 1)
    let moodDelta = clamp(delta.mood, -STATE_STEP.mood, STATE_STEP.mood)
    moodDelta *= moodDelta > 0 ? 1 + (affNorm - 0.5) * 0.4 : 1 + (0.5 - affNorm) * 0.4

    const global = normGlobal(
      {
        ...g0,
        mood: g0.mood + moodDelta,
        energy: g0.energy + clamp(delta.energy, -STATE_STEP.energy, STATE_STEP.energy),
        at,
      },
      at,
    )
    // 好感 = 判定值（单次 +5 / -10 内）+ 心情波动额外（不受单次上限约束）。
    // 增加总量受「每人每天 +20」约束，扣减无下限。
    const day = dayKey(at)
    const gainToday = p0.gainDate === day ? p0.gainToday : 0
    let affDelta = clamp(delta.affection, -AFFECTION_LOSS_MAX, AFFECTION_GAIN_MAX)
    affDelta += swingAffectionBonus(delta.swing)
    if (affDelta > 0) {
      affDelta = Math.min(affDelta, AFFECTION_DAILY_GAIN_MAX - gainToday)
      if (affDelta < 0) affDelta = 0
    }

    const affectionChanged = affDelta !== 0 || p0.affection !== p0raw.affection
    const p = normPeer(
      {
        ...p0,
        affection: p0.affection + affDelta,
        nickname: delta.nickname ? String(delta.nickname).slice(0, 20) : p0.nickname,
        // 真变了才重置衰减时钟；没变就保留，别让一次闲聊把 24 小时重新计时。
        affAt: affectionChanged ? at : p0.affAt,
        gainDate: day,
        gainToday: gainToday + Math.max(0, affDelta),
        today: delta.today ? String(delta.today).slice(0, 60) : p0.today,
        why: delta.why ? String(delta.why).slice(0, 120) : p0.why,
        turns: p0.turns + 1,
        at,
      },
      at,
    )
    all.global = global
    all.peers[key] = p
    this.writeAll(id, all)
    return { global, peer: p }
  }

  /** 好感衰减轮询：满 24 小时没变化的人按天扣，最低 35。 */
  decayAffectionAll(at = Date.now()) {
    const changed = []
    for (const id of this.list()) {
      const all = this.readAll(id)
      let dirty = false
      for (const [key, raw] of Object.entries(all.peers || {})) {
        const p0 = normPeer(raw, at)
        const p1 = decayAffection(p0, at)
        if (p1.affection !== p0.affection) {
          all.peers[key] = p1
          dirty = true
          changed.push(`${id}:${key}`)
        }
      }
      if (dirty) this.writeAll(id, all)
    }
    return changed
  }

  /**
   * 定时器每小时调一次：energy +0.05，封顶 0.8。
   * 不按「最后一次变化」累积，也不受期间聊了多少影响——到点就加。
   */
  regenEnergyAll(at = Date.now()) {
    const changed = []
    for (const id of this.list()) {
      const all = this.readAll(id)
      const before = normGlobal(all.global, at)
      if (before.energy >= ENERGY_CAP) continue
      const after = { ...before, energy: round3(Math.min(ENERGY_CAP, before.energy + ENERGY_REGEN_PER_HOUR)), at }
      all.global = after
      this.writeAll(id, all)
      changed.push(`${id}:${before.energy}→${after.energy}`)
    }
    return changed
  }

  /** 到点把每张脸的 mood / energy 拉回 0.8；affection 不动。 */
  resetDailyAll(at = Date.now()) {
    const changed = []
    for (const id of this.list()) {
      const all = this.readAll(id)
      const before = normGlobal(all.global, at)
      const after = resetDailyGlobal(before, at)
      if (after.mood !== before.mood || after.energy !== before.energy) {
        all.global = after
        this.writeAll(id, all)
        changed.push(id)
      }
    }
    return changed
  }

  list() {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .sort()
    } catch {
      return []
    }
  }

  snapshot() {
    const out = {}
    for (const id of this.list()) {
      const all = this.readAll(id)
      out[id] = { global: normGlobal(all.global), peers: all.peers }
    }
    return out
  }
}
