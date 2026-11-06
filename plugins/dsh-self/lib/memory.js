import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { ensureDir, normalize, now, readJson, similar, validFact } from './util.js'

const SCOPES = new Set(['person', 'context', 'self'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  cross_platform_recall INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
  platform TEXT NOT NULL,
  platform_uid TEXT NOT NULL,
  person_id TEXT NOT NULL,
  display_name TEXT,
  linked_by TEXT,
  linked_at INTEGER,
  PRIMARY KEY (platform, platform_uid)
);
CREATE TABLE IF NOT EXISTS admin (
  platform TEXT NOT NULL,
  platform_uid TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (platform, platform_uid)
);
CREATE TABLE IF NOT EXISTS fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'person',
  context_key TEXT,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  visibility TEXT NOT NULL DEFAULT 'normal',
  superseded_by INTEGER,
  created_at INTEGER NOT NULL,
  last_hit INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fact_exact
  ON fact(persona_id, subject_id, IFNULL(context_key, ''), content);
CREATE INDEX IF NOT EXISTS idx_fact_lookup ON fact(persona_id, subject_id, scope);
CREATE TABLE IF NOT EXISTS fact_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_fact ON fact_source(fact_id);
CREATE TABLE IF NOT EXISTS episode (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  platform TEXT,
  conversation_id TEXT,
  summary TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episode_lookup ON episode(persona_id, subject_id, created_at DESC);
CREATE TABLE IF NOT EXISTS relation (
  persona_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'friend',
  note TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (persona_id, person_id)
);
CREATE TABLE IF NOT EXISTS tombstone (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  before TEXT,
  after TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_mask (
  session_id TEXT PRIMARY KEY,
  mask TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

export class Memory {
  constructor({ path, personaId = 'self' }) {
    this.path = path
    this.personaId = personaId
    this.db = null
  }

  open() {
    ensureDir(this.path.replace(/\/[^/]+$/u, ''))
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;')
    this.db.exec(SCHEMA)
    return this
  }

  close() {
    try {
      this.db?.close()
    } catch {
      /* already closed */
    }
    this.db = null
  }

  _get(key) {
    const row = this.db.prepare('SELECT value FROM setting WHERE key=?').get(key)
    return row ? row.value : null
  }

  _set(key, value) {
    this.db.prepare('INSERT INTO setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
  }

  ownerId() {
    return this._get('owner_person_id') || null
  }

  owner() {
    const id = this.ownerId()
    if (!id) return null
    return this.person(id)
  }

  person(id) {
    const row = this.db.prepare('SELECT * FROM person WHERE id=?').get(id)
    if (!row) return null
    const accounts = this.db
      .prepare('SELECT platform, platform_uid, display_name, linked_by, linked_at FROM account WHERE person_id=? ORDER BY platform')
      .all(id)
    return { ...row, accounts }
  }

  /**
   * 从 chat_bot 的 brain.db 一次性迁移：人、账号、管理员、事实、来源、情节、关系。
   * 源库只读打开；已迁移过或源库不存在就跳过。
   */
  migrateFromBrain(brainPath) {
    if (!brainPath || !existsSync(brainPath)) return { ok: false, reason: 'no_brain_db' }
    if (this._get('migrated_from_brain')) return { ok: false, reason: 'already_migrated' }

    let src
    try {
      src = new DatabaseSync(brainPath, { readOnly: true })
    } catch (error) {
      return { ok: false, reason: 'open_failed', message: String(error?.message || error) }
    }

    const counts = { person: 0, account: 0, admin: 0, fact: 0, fact_source: 0, episode: 0, relation: 0 }
    const has = (table) =>
      !!src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    const rows = (table, sql) => (has(table) ? src.prepare(sql).all() : [])

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows('person', 'SELECT * FROM person')) {
        this.db
          .prepare('INSERT OR IGNORE INTO person(id,display_name,cross_platform_recall,role,created_at) VALUES(?,?,?,?,?)')
          .run(r.id, r.display_name || '', Number(r.cross_platform_recall || 0), r.role || 'user', Number(r.created_at || now()))
        counts.person += 1
      }
      for (const r of rows('account', 'SELECT * FROM account')) {
        this.db
          .prepare('INSERT OR IGNORE INTO account(platform,platform_uid,person_id,display_name,linked_by,linked_at) VALUES(?,?,?,?,?,?)')
          .run(r.platform, r.platform_uid, r.person_id, r.display_name || '', r.linked_by || 'migrated', Number(r.linked_at || now()))
        counts.account += 1
      }
      for (const r of rows('admin', 'SELECT * FROM admin')) {
        this.db
          .prepare('INSERT OR IGNORE INTO admin(platform,platform_uid,role,added_at) VALUES(?,?,?,?)')
          .run(r.platform, r.platform_uid, r.role || 'owner', Number(r.added_at || now()))
        counts.admin += 1
      }
      const oldFacts = rows('fact', 'SELECT * FROM fact')
      const idMap = new Map()
      for (const r of oldFacts) {
        const info = this.db
          .prepare(
            `INSERT OR IGNORE INTO fact(persona_id,subject_id,scope,context_key,content,importance,confidence,visibility,superseded_by,created_at,last_hit,hit_count)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            this.personaId,
            r.subject_id,
            r.scope || 'person',
            r.context_key || null,
            r.content,
            Number(r.importance ?? 0.5),
            Number(r.confidence ?? 0.5),
            r.visibility || 'normal',
            r.superseded_by ?? null,
            Number(r.created_at || now()),
            Number(r.last_hit || 0),
            Number(r.hit_count || 0),
          )
        const newId = Number(info.lastInsertRowid)
        if (newId) idMap.set(Number(r.id), newId)
        counts.fact += 1
      }
      for (const r of rows('fact_source', 'SELECT * FROM fact_source')) {
        const target = idMap.get(Number(r.fact_id))
        if (!target) continue
        this.db
          .prepare('INSERT INTO fact_source(fact_id,platform,account_id,conversation_id,message_id,ts) VALUES(?,?,?,?,?,?)')
          .run(target, r.platform || '', r.account_id || '', r.conversation_id || '', r.message_id || '', Number(r.ts || now()))
        counts.fact_source += 1
      }
      for (const r of rows('episode', 'SELECT * FROM episode')) {
        this.db
          .prepare('INSERT INTO episode(persona_id,subject_id,platform,conversation_id,summary,visibility,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(
            this.personaId,
            r.subject_id,
            r.platform || '',
            r.conversation_id || '',
            r.summary || '',
            r.visibility || 'private',
            Number(r.created_at || now()),
          )
        counts.episode += 1
      }
      for (const r of rows('relation', 'SELECT * FROM relation')) {
        this.db
          .prepare('INSERT OR IGNORE INTO relation(persona_id,person_id,kind,note,updated_at) VALUES(?,?,?,?,?)')
          .run(this.personaId, r.person_id, r.kind || 'friend', r.note || '', Number(r.updated_at || now()))
        counts.relation += 1
      }
      const owner = this.db.prepare("SELECT id FROM person WHERE role='owner' ORDER BY created_at LIMIT 1").get()
      if (owner) this._set('owner_person_id', owner.id)
      this.db
        .prepare('INSERT INTO audit(actor,action,target,before,after,ts) VALUES(?,?,?,?,?,?)')
        .run('migration', 'memory.migrate', brainPath, '', JSON.stringify(counts), now())
      this._set('migrated_from_brain', new Date().toISOString())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      src.close()
      return { ok: false, reason: 'migrate_failed', message: String(error?.message || error), counts }
    }
    src.close()
    return { ok: true, counts }
  }

  ensureOwner({ displayName = '缔造者', role = 'owner', accounts = [] } = {}) {
    const existing = this.ownerId()
    if (existing) return existing
    const id = 'p_owner'
    this.db.prepare('INSERT OR IGNORE INTO person(id,display_name,cross_platform_recall,role,created_at) VALUES(?,?,1,?,?)').run(
      id,
      displayName,
      role,
      now(),
    )
    for (const a of accounts) {
      if (!a?.platform || !a?.uid) continue
      this.db
        .prepare('INSERT OR IGNORE INTO account(platform,platform_uid,person_id,display_name,linked_by,linked_at) VALUES(?,?,?,?,?,?)')
        .run(a.platform, String(a.uid), id, a.display_name || '', 'seed', now())
    }
    this._set('owner_person_id', id)
    return id
  }

  // ---------- 写入 ----------

  addFact({
    subjectId,
    content,
    scope = 'person',
    contextKey = null,
    importance = 0.5,
    confidence = 0.5,
    visibility = 'normal',
    source = null,
    personaId = null,
  }) {
    // 谁经历的归谁：戴着面具时发生的事记在 persona:<id>，桌面（屿本人）记在 self。
    const owner = personaId || this.personaId
    const check = validFact(content)
    if (!check.ok) return { ok: false, reason: check.reason }
    const text = check.content
    if (!SCOPES.has(scope)) return { ok: false, reason: 'bad_scope' }
    if (scope === 'context' && !contextKey) return { ok: false, reason: 'context_key_required' }
    const subject = scope === 'self' ? 'persona:self' : subjectId
    if (!subject) return { ok: false, reason: 'subject_required' }

    const tomb = this.db.prepare('SELECT content FROM tombstone WHERE persona_id=? AND subject_id=?').all(owner, subject)
    if (tomb.some((row) => similar(row.content, text))) return { ok: false, reason: 'tombstoned' }

    const existing = this._findSimilar(subject, scope, contextKey, text, owner)
    if (existing) {
      this._addSource(existing.id, source)
      this.db
        .prepare('UPDATE fact SET importance=MAX(importance,?), confidence=MAX(confidence,?) WHERE id=?')
        .run(Number(importance), Number(confidence), existing.id)
      return { ok: true, id: Number(existing.id), merged: true }
    }

    try {
      const info = this.db
        .prepare(
          `INSERT INTO fact(persona_id,subject_id,scope,context_key,content,importance,confidence,visibility,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(owner, subject, scope, contextKey || null, text, Number(importance), Number(confidence), visibility, now())
      const id = Number(info.lastInsertRowid)
      this._addSource(id, source)
      this._audit('memory.add', `fact:${id}`, '', text)
      return { ok: true, id, merged: false }
    } catch (error) {
      return { ok: false, reason: 'write_failed', message: String(error?.message || error) }
    }
  }

  _findSimilar(subjectId, scope, contextKey, content, personaId = null) {
    const owner = personaId || this.personaId
    const rows = this.db
      .prepare(
        `SELECT * FROM fact WHERE persona_id=? AND subject_id=? AND scope=? AND IFNULL(context_key,'')=? AND superseded_by IS NULL
         ORDER BY id DESC LIMIT 50`,
      )
      .all(owner, subjectId, scope, contextKey || '')
    return rows.find((r) => similar(r.content, content)) || null
  }

  _addSource(factId, source) {
    if (!source) return
    this.db
      .prepare('INSERT INTO fact_source(fact_id,platform,account_id,conversation_id,message_id,ts) VALUES(?,?,?,?,?,?)')
      .run(factId, String(source.platform || ''), String(source.accountId || ''), String(source.conversationId || ''), String(source.messageId || ''), Number(source.ts || now()))
  }

  addEpisode({ subjectId, summary, platform = '', conversationId = '', visibility = 'private', personaId = null }) {
    const text = normalize(summary)
    if (!text) return { ok: false, reason: 'empty' }
    const info = this.db
      .prepare('INSERT INTO episode(persona_id,subject_id,platform,conversation_id,summary,visibility,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(personaId || this.personaId, subjectId || 'persona:self', platform, conversationId, text.slice(0, 600), visibility, now())
    return { ok: true, id: Number(info.lastInsertRowid) }
  }

  /** 一次回忆能看到哪些记忆归属：屿（self）永远在，加上当前面具人格。 */
  _owners(personaIds) {
    const list = Array.isArray(personaIds) ? personaIds : personaIds ? [personaIds] : []
    const owners = [...new Set([this.personaId, ...list].filter(Boolean))]
    return owners.length ? owners : [this.personaId]
  }

  /** 改一条事实：新值作为新记录，旧记录用 superseded_by 指向新记录（不删，可追溯）。 */
  updateFact(id, { content, importance = null, confidence = null, actor = 'self' }) {
    const old = this.db.prepare('SELECT * FROM fact WHERE id=?').get(Number(id))
    if (!old) return { ok: false, reason: 'not_found' }
    if (old.superseded_by) return { ok: false, reason: 'already_superseded' }

    const check = validFact(content)
    if (!check.ok) return { ok: false, reason: check.reason }
    const text = check.content

    const info = this.db
      .prepare(
        `INSERT INTO fact(persona_id,subject_id,scope,context_key,content,importance,confidence,visibility,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        old.persona_id,
        old.subject_id,
        old.scope,
        old.context_key || null,
        text,
        Number(importance ?? old.importance),
        Number(confidence ?? old.confidence),
        old.visibility,
        now(),
      )
    const newId = Number(info.lastInsertRowid)
    this.db.prepare('UPDATE fact SET superseded_by=? WHERE id=?').run(newId, Number(id))

    const sources = this.db.prepare('SELECT * FROM fact_source WHERE fact_id=?').all(Number(id))
    for (const s of sources) {
      this.db
        .prepare('INSERT INTO fact_source(fact_id,platform,account_id,conversation_id,message_id,ts) VALUES(?,?,?,?,?,?)')
        .run(newId, s.platform, s.account_id, s.conversation_id, s.message_id, s.ts)
    }
    this._audit('memory.update', `fact:${id}->${newId}`, old.content, text, actor)
    return { ok: true, id: newId, superseded: Number(id), merged: false }
  }

  forget(id, actor = 'self') {
    const row = this.db.prepare('SELECT * FROM fact WHERE id=?').get(Number(id))
    if (!row) return { ok: false, reason: 'not_found' }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO tombstone(persona_id,subject_id,content,created_at) VALUES(?,?,?,?)')
        .run(row.persona_id, row.subject_id, row.content, now())
      this.db.prepare('DELETE FROM fact_source WHERE fact_id=?').run(Number(id))
      this.db.prepare('DELETE FROM fact WHERE id=?').run(Number(id))
      this._audit('memory.forget', `fact:${id}`, row.content, '')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, reason: 'write_failed', message: String(error?.message || error) }
    }
    return { ok: true, id: Number(id) }
  }

  // ---------- 读取 ----------

  recall({ subjectId, cue = '', platform = '', contextKey = '', limit = 8, allowPrivate = true, personaIds = null } = {}) {
    const owners = this._owners(personaIds)
    const ownerMarks = owners.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM fact WHERE persona_id IN (${ownerMarks}) AND superseded_by IS NULL
         AND ((scope='person' AND subject_id=?) OR scope='self' OR (scope='context' AND IFNULL(context_key,'')=?))
         ORDER BY importance DESC, created_at DESC LIMIT 200`,
      )
      .all(...owners, subjectId || '', contextKey || '')

    const person = subjectId ? this.db.prepare('SELECT cross_platform_recall FROM person WHERE id=?').get(subjectId) : null
    const crossOk = Boolean(person && person.cross_platform_recall)
    const sources = this._sourcesFor(rows.map((r) => Number(r.id)))
    const q = normalize(cue)
    const scored = []

    for (const row of rows) {
      if (!allowPrivate && row.visibility !== 'normal') continue
      const src = sources.get(Number(row.id)) || []
      if (platform && !crossOk && row.subject_id === subjectId && !src.some((s) => s.platform === platform)) continue
      const ageDays = Math.max(0, (now() - Number(row.created_at)) / 86400)
      const recency = Math.exp(-ageDays / 30)
      const relevance = q ? dice(q, row.content) : 0
      const score = 0.55 * Number(row.importance) + 0.25 * recency + 0.1 * Math.min(1, Number(row.hit_count) / 10) + 0.1 * relevance
      scored.push({ ...row, sources: src, score: Math.round(score * 10000) / 10000 })
    }
    scored.sort((a, b) => b.score - a.score)
    const picked = scored.slice(0, Math.max(1, limit))
    if (picked.length) {
      const marks = picked.map(() => '?').join(',')
      this.db.prepare(`UPDATE fact SET last_hit=?, hit_count=hit_count+1 WHERE id IN (${marks})`).run(now(), ...picked.map((p) => p.id))
    }
    return picked
  }

  _sourcesFor(ids) {
    const out = new Map()
    if (!ids.length) return out
    const marks = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT fact_id, platform, conversation_id, ts FROM fact_source WHERE fact_id IN (${marks}) ORDER BY ts DESC`).all(...ids)
    for (const r of rows) {
      const key = Number(r.fact_id)
      if (!out.has(key)) out.set(key, [])
      out.get(key).push({ platform: r.platform, conversation_id: r.conversation_id, ts: r.ts })
    }
    return out
  }

  recentEpisodes({ subjectId, limit = 3, maxAgeDays = 7, allowPrivate = true, personaIds = null } = {}) {
    const cutoff = now() - Math.max(1, maxAgeDays) * 86400
    const owners = this._owners(personaIds)
    const ownerMarks = owners.map(() => '?').join(',')
    const sql = allowPrivate
      ? `SELECT * FROM episode WHERE persona_id IN (${ownerMarks}) AND subject_id IN (?, 'persona:self') AND created_at>=? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM episode WHERE persona_id IN (${ownerMarks}) AND subject_id IN (?, 'persona:self') AND created_at>=? AND visibility='normal' ORDER BY created_at DESC LIMIT ?`
    return this.db.prepare(sql).all(...owners, subjectId || '', cutoff, limit)
  }

  memoryBlock({ subjectId, cue, platform, limit = 8, allowPrivate = true, personaIds = null }) {
    const facts = this.recall({ subjectId, cue, platform, limit, allowPrivate, personaIds })
    const eps = this.recentEpisodes({ subjectId, limit: 3, allowPrivate, personaIds })
    if (!facts.length && !eps.length) return ''
    const lines = ['【长期记忆（你自己记得的事；相关才用，不要生硬复述，不要说来自哪个平台）】']
    for (const f of facts) lines.push(`- ${f.content}`)
    if (eps.length) {
      lines.push('【最近发生（你自己的经历）】')
      for (const e of eps) lines.push(`- ${e.summary}`)
    }
    return lines.join('\n')
  }

  // ---------- 会话面具 ----------

  maskFor(sessionId, fallback = 'desktop') {
    if (!sessionId) return fallback
    const row = this.db.prepare('SELECT mask FROM session_mask WHERE session_id=?').get(String(sessionId))
    return row ? row.mask : fallback
  }

  setMask(sessionId, mask) {
    this.db
      .prepare('INSERT INTO session_mask(session_id,mask,updated_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET mask=excluded.mask, updated_at=excluded.updated_at')
      .run(String(sessionId), String(mask), now())
    return mask
  }

  // ---------- 统计 ----------

  counts() {
    const one = (table) => Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0
    return {
      people: one('person'),
      accounts: one('account'),
      facts: one('fact'),
      episodes: one('episode'),
      tombstones: one('tombstone'),
      sessions: one('session_mask'),
    }
  }

  _audit(action, target, before, after, actor = 'self') {
    this.db
      .prepare('INSERT INTO audit(actor,action,target,before,after,ts) VALUES(?,?,?,?,?,?)')
      .run(actor, action, target, String(before || ''), String(after || ''), now())
  }
}

function dice(a, b) {
  const clean = (s) => normalize(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const x = clean(a)
  const y = clean(b)
  if (!x || !y) return 0
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0
  const grams = (s) => {
    const out = []
    for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2))
    return out
  }
  const ga = grams(x)
  const gb = grams(y)
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
  return (2 * hit) / (ga.length + gb.length)
}
