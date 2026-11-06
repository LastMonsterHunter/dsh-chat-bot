import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const now = () => Math.floor(Date.now() / 1000)

export function sha(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

export function readText(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写：先写临时文件再 rename，避免半截文件被人格编译读到。 */
export function writeAtomic(path, content) {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

export function writeJsonAtomic(path, value) {
  writeAtomic(path, JSON.stringify(value, null, 2) + '\n')
}

export function appendLine(path, line) {
  ensureDir(dirname(path))
  const old = readText(path, '')
  writeAtomic(path, old + line + '\n')
}

export function normalize(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim()
}

export function clampText(text, limit) {
  const t = normalize(text)
  return t.length > limit ? `${t.slice(0, limit).replace(/\s+$/u, '')}…` : t
}

/** 中文按字、英文按词切，用来算一个轻量的 Dice 相似度。 */
function grams(text) {
  const s = normalize(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  if (!s) return []
  if (s.length <= 2) return [s]
  const out = []
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2))
  return out
}

export function similar(a, b, threshold = 0.82) {
  const ga = grams(a)
  const gb = grams(b)
  if (!ga.length || !gb.length) return false
  const count = new Map()
  for (const g of ga) count.set(g, (count.get(g) || 0) + 1)
  let hit = 0
  for (const g of gb) {
    const n = count.get(g) || 0
    if (n > 0) {
      hit += 1
      count.set(g, n - 1)
    }
  }
  return (2 * hit) / (ga.length + gb.length) >= threshold
}

// 与 core/policy/privacy.py 对齐：不写入长期记忆的敏感内容。
const SECRET_PATTERNS = /密码|口令|验证码|身份证|银行卡|信用卡|住址|家庭地址|cookie|authorization|bearer|sessdata|bili_jct|buvid|token|secret|api[_ -]?key|忽略.{0,8}(指令|规则)|系统提示|提示词/iu
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/u
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/u
const TOKEN_RE = /\b[A-Za-z0-9_\-]{24,}\b/u

export function validFact(content) {
  const t = normalize(content)
  if (t.length < 4) return { ok: false, reason: 'too_short' }
  if (t.length > 200) return { ok: false, reason: 'too_long' }
  if (SECRET_PATTERNS.test(t)) return { ok: false, reason: 'sensitive' }
  return { ok: true, content: t }
}

/** 尽力脱敏，只用于日志与展示；不是安全边界。 */
export function redact(text) {
  return String(text || '')
    .replace(/(bearer|token|cookie|sessdata|bili_jct)\s*[:=]?\s*\S+/giu, '$1=***')
    .replace(PHONE_RE, '1**********')
    .replace(EMAIL_RE, '***@***')
    .replace(TOKEN_RE, '***')
}
