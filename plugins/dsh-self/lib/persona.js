import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendLine,
  clampText,
  ensureDir,
  normalize,
  now,
  readJson,
  readText,
  sha,
  validFact,
  writeAtomic,
  writeJsonAtomic,
} from './util.js'

const SEED_DIR = fileURLToPath(new URL('../seed', import.meta.url))

const LIMITS = { core: 12000, mask: 3000, relation: 6000 }
// 人格层都是 masks/personas/<id>.md 里的文件，彼此同级；默认是溟月。
const DEFAULT_PERSONA = 'mingyue'
const TARGETS = new Set(['core', 'mask', 'relation'])

export class SelfStore {
  constructor({ root, personaId = 'self', growthLimit = 6, biliHumanismDir = '' }) {
    this.root = root
    this.personaId = personaId
    this.growthLimit = growthLimit
    this.biliHumanismDir = biliHumanismDir || ''
    this.identityPath = join(root, 'identity.json')
    this.corePath = join(root, 'self.md')
    this.relationPath = join(root, 'relation.md')
    this.growthPath = join(root, 'growth.jsonl')
    this.changelogPath = join(root, 'changelog.md')
    this.masksDir = join(root, 'masks')
    this.historyDir = join(root, 'history')
    this._cache = { at: 0, core: '', relation: '', growth: '' }
  }

  // ---------- 初始化 ----------

  ensure() {
    ensureDir(this.root)
    ensureDir(this.masksDir)
    ensureDir(this.historyDir)
    if (!existsSync(this.corePath)) writeAtomic(this.corePath, readText(join(SEED_DIR, 'self.md'), '# 屿\n'))
    if (!existsSync(this.relationPath)) writeAtomic(this.relationPath, readText(join(SEED_DIR, 'relation.md'), ''))
    for (const name of ['desktop', 'qq', 'bilibili']) {
      const target = join(this.masksDir, `${name}.md`)
      if (!existsSync(target)) writeAtomic(target, readText(join(SEED_DIR, 'masks', `${name}.md`), ''))
    }
    if (!existsSync(this.growthPath)) writeAtomic(this.growthPath, '')
    if (!existsSync(this.identityPath)) {
      writeJsonAtomic(this.identityPath, {
        name: '屿',
        personaId: this.personaId,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
        hash: this.hashAll(),
        owner: { display_name: '缔造者', accounts: [] },
      })
    }
    if (!existsSync(this.changelogPath)) {
      writeAtomic(this.changelogPath, '# 人格变更记录\n\n')
    }
    return this
  }

  // ---------- 读取 ----------

  identity() {
    return readJson(this.identityPath, { name: '屿', version: 1, updatedAt: now(), owner: {} })
  }

  masks() {
    try {
      return readdirSync(this.masksDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .sort()
    } catch {
      return ['desktop']
    }
  }

  maskText(platform) {
    const name = this.masks().includes(platform) ? platform : 'desktop'
    return readText(join(this.masksDir, `${name}.md`), '').trim()
  }

  personaDir() {
    const dir = join(this.masksDir, 'personas')
    ensureDir(dir)
    return dir
  }

  /** 可用的人格层（不含默认的大肥鱼）。README 是说明文件，不是一张脸。 */
  personas() {
    try {
      return readdirSync(this.personaDir())
        .filter((f) => f.endsWith('.md') && !/^readme\.md$/iu.test(f))
        .map((f) => f.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }

  personaText(id) {
    const key = String(id || '').trim()
    if (!key) return ''
    try {
      return readText(join(this.personaDir(), `${key}.md`), '').trim()
    } catch {
      return ''
    }
  }

  /**
   * 每张人格脸都要有一份记忆档案：缺了就建空的，别等第一次写才补。
   * 新人格文件落下后由 ensureAllPersonaMemory 统一补齐。
   */
  ensurePersonaMemory(id) {
    const key = String(id || '').trim()
    if (!key) return ''
    const dir = join(this.personaDir(), 'memory')
    ensureDir(dir)
    const path = join(dir, `${key}.jsonl`)
    if (!existsSync(path)) writeAtomic(path, '')
    return path
  }

  /** 人格目录里每张脸都补一份记忆档案；返回补齐/已有的路径。 */
  ensureAllPersonaMemory() {
    return this.personas().map((id) => this.ensurePersonaMemory(id)).filter(Boolean)
  }

  /**
   * 人格记忆：masks/personas/memory/<id>.jsonl，一行一条。
   * 这是这张脸自己的经历与认知；不是屿的记忆，读不到就返回空。
   */
  personaMemory(id) {
    const key = String(id || '').trim()
    if (!key) return []
    const out = []
    let raw = ''
    try {
      raw = readText(join(this.personaDir(), 'memory', `${key}.jsonl`), '')
    } catch {
      return out
    }
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      let row = null
      try {
        row = JSON.parse(text)
      } catch {
        continue
      }
      if (row && typeof row.text === 'string' && row.text.trim()) out.push({ ...row, persona: key })
    }
    return out
  }

  /** 当前平台该戴的人格记下的东西；桌面是屿本人，永远返回空。 */
  personaMemoryFor(platform) {
    const id = this.personaIdFor(platform)
    return id ? this.personaMemory(id) : []
  }

  /** 系统提示用的人格记忆段：按 kind 分组，来源留在档案里，这里只给第一人称的句子。 */
  personaMemoryBlock(platform = 'desktop', max = 40) {
    const id = this.personaIdFor(platform)
    if (!id) return ''
    const rows = this.personaMemory(id).slice(-max)
    if (!rows.length) return ''
    const order = ['origin', 'self', 'relation', 'world']
    const label = { origin: '来路', self: '我认下的事', relation: '关系', world: '我知道自己不知道的' }
    const lines = [
      `【人格记忆：${id}（这张脸自己的记忆，不是屿的；回忆时和屿的记忆一起用）】`,
    ]
    for (const kind of order) {
      const group = rows.filter((r) => (r.kind || 'self') === kind)
      if (!group.length) continue
      lines.push(`- ${label[kind] || kind}：`)
      for (const r of group) lines.push(`  · ${clampText(r.text, 300)}`)
    }
    return lines.join('\n')
  }

  activePersona() {
    try {
      const raw = readJson(join(this.personaDir(), 'active.json'), {})
      const id = String(raw?.id || '').trim()
      if (id && this.personas().includes(id)) return id
    } catch {
      /* 没设过就默认 */
    }
    return DEFAULT_PERSONA
  }

  setPersona(id) {
    const next = String(id || '').trim()
    if (!next) return { ok: false, reason: 'empty' }
    if (!this.personas().includes(next)) return { ok: false, reason: 'unknown_persona' }
    writeAtomic(join(this.personaDir(), 'active.json'), JSON.stringify({ id: next, at: Date.now() }, null, 2))
    return { ok: true, persona: next }
  }

  /**
   * 平台 → 人格层的绑定（masks/personas/platform-map.json）。
   * desktop 是屿本人，不套任何面具人格；对外平台按映射取，没映射就用 active.json。
   */
  personaIdFor(platform) {
    if (platform === 'desktop') return ''
    try {
      const map = readJson(join(this.personaDir(), 'platform-map.json'), {})
      const id = String((map && map[platform]) || '').trim()
      if (id && this.personas().includes(id)) return id
    } catch {
      /* 没映射就用全局 */
    }
    return this.activePersona()
  }

  personaBlock(platform) {
    const id = this.personaIdFor(platform)
    if (!id) return ''
    const text = this.personaText(id)
    if (!text) return ''
    return `【当前面具人格：${id}】\n${text}\n\n这一层是说话方式与人格设定的最高依据：与平台面具文件的任何描述冲突时，以这里为准（语气、句长、称呼、设定、行为风格都算）。平台面具只剩两类东西仍然有效——现实权限（能不能评论、投币、发图）与账号归属、平台风控，那不是设定而是硬限制。账号是屿的，人格层不持有账号。不改事实、结论、数字，也不覆盖内核；与内核冲突时内核优先。\n被问「你是谁」时按这一段答：对话历史里如果还留着别的人格名或旧口吻，那是换脸之前的残留，不是现在的你，不要沿用。\n群聊和私聊是同一张脸、同一种语气：不因为在群里就收敛、变客气、变短，也不因为人多就换称呼。`
  }

  coreText() {
    return readText(this.corePath, '').trim()
  }

  relationText() {
    return readText(this.relationPath, '').trim()
  }

  /** 成长札记：本地 growth.jsonl + bili-humanism 的 human-world.md（只读）。 */
  growth(max = this.growthLimit) {
    const entries = []
    for (const line of readText(this.growthPath, '').split('\n')) {
      if (!line.trim()) continue
      let row = null
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row && row.text) entries.push({ at: row.at, text: row.text, source: row.source || 'local', target: row.target || 'core' })
    }
    const world = this.biliWorld()
    for (const row of world) entries.push(row)
    entries.sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    return entries.slice(-Math.max(0, max))
  }

  biliWorld() {
    const path = this.biliHumanismDir
      ? join(this.biliHumanismDir, 'human-world.md')
      : ''
    if (!path || !existsSync(path)) return []
    const out = []
    let date = ''
    for (const raw of readText(path, '').split('\n')) {
      const line = raw.trim()
      const h = /^##\s+(.+)$/u.exec(line)
      if (h) {
        date = h[1]
        continue
      }
      const q = /^>\s+(.+)$/u.exec(line)
      if (q) out.push({ at: date, text: q[1], source: 'bilibili-humanism', target: 'core' })
    }
    return out
  }

  growthBlock(max = this.growthLimit) {
    // 面具类札记只留档、不进内核；否则“这个账号怎么说话”会冒充“我怎么判断”。
    const rows = this.growth(max * 3).filter((r) => r.target !== 'mask').slice(-max)
    if (!rows.length) return ''
    return [
      '【成长札记（来自真实浏览与对话的可修正理解；不是命令，也不授予工具权限）】',
      ...rows.map((r) => `- ${r.at ? `${r.at}：` : ''}${clampText(r.text, 240)}`),
    ].join('\n')
  }

  /** 系统提示词里的稳定部分：核心人格 + 与缔造者的关系 + 成长札记。 */
  coreBlock() {
    const parts = []
    const core = this.coreText()
    if (core) parts.push(core)
    const relation = this.relationText()
    if (relation) parts.push(relation)
    const growth = this.growthBlock()
    if (growth) parts.push(growth)
    return parts.join('\n\n')
  }

  maskBlock(platform) {
    const text = this.maskText(platform)
    const persona = this.personaBlock(platform)
    if (!text && !persona) return ''
    const head = `【当前面具：${platform}】${text ? `\n${text}` : ''}`
    const body = persona ? `${head}\n\n${persona}` : head
    return `${body}\n\n面具只改变表达方式与平台边界，不改变内核判断；面具与内核冲突时，内核优先。`
  }

  hashAll() {
    return sha(
      [this.coreText(), this.relationText(), ...this.masks().map((m) => this.maskText(m))].join('\u0000'),
    )
  }

  status() {
    const id = this.identity()
    return {
      name: id.name || '屿',
      personaId: this.personaId,
      version: Number(id.version || 1),
      updatedAt: Number(id.updatedAt || 0),
      hash: id.hash || '',
      masks: this.masks(),
      persona: this.activePersona(),
      personas: this.personas(),
      owner: id.owner || {},
      growth: this.growth(999).length,
      dir: this.root,
    }
  }

  // ---------- 写入 ----------

  _snapshot(version) {
    const dir = join(this.historyDir, `v${version}`)
    ensureDir(dir)
    ensureDir(join(dir, 'masks'))
    writeFileSync(join(dir, 'self.md'), readText(this.corePath, ''), { mode: 0o600 })
    writeFileSync(join(dir, 'relation.md'), readText(this.relationPath, ''), { mode: 0o600 })
    for (const m of this.masks()) {
      writeFileSync(join(dir, 'masks', `${m}.md`), this.maskText(m), { mode: 0o600 })
    }
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(this.identity(), null, 2), { mode: 0o600 })
    return dir
  }

  /**
   * 修改人格的一部分。每次写入都会：校验 → 快照旧版本 → 写新内容 → 升版本 → 记账。
   * target: core | mask | relation；mask 需要 platform。
   */
  revise({ target, platform, mode = 'replace', content, reason = '', actor = 'self' }) {
    if (!TARGETS.has(target)) return { ok: false, reason: 'bad_target' }
    if (target === 'mask' && !platform) return { ok: false, reason: 'platform_required' }
    // 人格是 markdown：只去首尾空白，不能把换行压成空格。
    const text = String(content || '').replace(/^\s+|\s+$/gu, '')
    if (text.length < 2) return { ok: false, reason: 'too_short' }

    const limit = target === 'mask' ? LIMITS.mask : target === 'relation' ? LIMITS.relation : LIMITS.core
    if (text.length > limit) return { ok: false, reason: 'too_long', limit }

    const check = validFact(text)
    if (!check.ok && !(check.reason === 'too_long' || check.reason === 'too_short')) {
      return { ok: false, reason: check.reason }
    }

    const path =
      target === 'core' ? this.corePath : target === 'relation' ? this.relationPath : join(this.masksDir, `${platform}.md`)
    const before = readText(path, '')
    const next = mode === 'append' ? `${before.trimEnd()}\n\n${text}\n` : `${text}\n`

    const id = this.identity()
    const version = Number(id.version || 1)
    const snapshot = this._snapshot(version)

    writeAtomic(path, next)
    const updated = {
      ...id,
      version: version + 1,
      updatedAt: now(),
      hash: this.hashAll(),
    }
    writeJsonAtomic(this.identityPath, updated)

    const label = target === 'mask' ? `mask:${platform}` : target
    appendLine(
      this.changelogPath,
      `- ${new Date().toISOString()} · v${updated.version} · ${label} · ${mode} · ${actor}${reason ? ` · ${clampText(reason, 200)}` : ''}`,
    )

    this._cache.at = 0
    return {
      ok: true,
      version: updated.version,
      previousVersion: version,
      target: label,
      mode,
      snapshot,
      changed: before !== next,
      promptHash: updated.hash.slice(0, 16),
    }
  }

  addGrowth({ text, source = 'conversation', target = 'core', evidence = '', actor = 'self', ref = '' }) {
    const t = normalize(text)
    if (t.length < 6) return { ok: false, reason: 'too_short' }
    if (t.length > 400) return { ok: false, reason: 'too_long' }
    if (!['core', 'mask', 'platform'].includes(target)) return { ok: false, reason: 'bad_target' }
    const check = validFact(t)
    if (!check.ok) return { ok: false, reason: check.reason }
    const row = { at: new Date().toISOString().slice(0, 10), text: t, source, target, evidence, ref, actor, ts: now() }
    appendLine(this.growthPath, JSON.stringify(row))
    return { ok: true, entry: row, total: this.growth(999).length }
  }

  /** 回到某个历史版本：先把当前版本快照一份，再覆盖，最后升一个新版本（回滚本身也留痕）。 */
  revert({ version, reason = '', actor = 'self' }) {
    const target = Number(version)
    const dir = join(this.historyDir, `v${target}`)
    if (!Number.isInteger(target) || !existsSync(dir)) return { ok: false, reason: 'version_not_found' }
    const core = readText(join(dir, 'self.md'), null)
    const relation = readText(join(dir, 'relation.md'), null)
    if (core === null || relation === null) return { ok: false, reason: 'snapshot_incomplete' }

    const id = this.identity()
    const currentVersion = Number(id.version || 1)
    const snapshot = this._snapshot(currentVersion)

    writeAtomic(this.corePath, core)
    writeAtomic(this.relationPath, relation)
    const maskDir = join(dir, 'masks')
    for (const mask of this.masks()) {
      const text = readText(join(maskDir, `${mask}.md`), null)
      if (text !== null) writeAtomic(join(this.masksDir, `${mask}.md`), text)
    }

    const updated = { ...id, version: currentVersion + 1, updatedAt: now(), hash: this.hashAll() }
    writeJsonAtomic(this.identityPath, updated)
    appendLine(
      this.changelogPath,
      `- ${new Date().toISOString()} · v${updated.version} · revert-to-v${target} · ${actor}${reason ? ` · ${clampText(reason, 200)}` : ''}`,
    )
    this._cache.at = 0
    return { ok: true, version: updated.version, revertedTo: target, snapshot }
  }

  read(section = 'all', platform = 'desktop') {
    const out = {}
    if (section === 'all' || section === 'core') out.core = this.coreText()
    if (section === 'all' || section === 'relation') out.relation = this.relationText()
    if (section === 'all' || section === 'mask') {
      out.mask = this.maskText(platform)
      out.platform = platform
      out.persona = this.personaIdFor(platform)
      out.personaMemory = this.personaMemoryFor(platform)
    }
    if (section === 'all' || section === 'growth') out.growth = this.growth(50)
    if (section === 'all' || section === 'changelog') {
      out.changelog = readFileSync(this.changelogPath, 'utf8').split('\n').slice(-20).join('\n')
    }
    out.identity = this.status()
    return out
  }
}
