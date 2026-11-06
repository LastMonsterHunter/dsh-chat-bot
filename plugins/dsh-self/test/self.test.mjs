import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SelfStore } from '../lib/persona.js'
import { Memory } from '../lib/memory.js'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-self-test-'))
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

test('种子人格：v1、三个面具、核心与关系非空', () => {
  const t = temp()
  try {
    const store = new SelfStore({ root: join(t.dir, 'self') }).ensure()
    const st = store.status()
    assert.equal(st.version, 1)
    assert.deepEqual(st.masks, ['bilibili', 'desktop', 'qq'])
    assert.match(store.coreText(), /屿/u)
    assert.match(store.relationText(), /缔造者/u)
    assert.match(store.maskBlock('qq'), /大肥鱼/u)
  } finally {
    t.clean()
  }
})

test('revise：保留换行、升版本、写快照、写 changelog', () => {
  const t = temp()
  try {
    const store = new SelfStore({ root: join(t.dir, 'self') }).ensure()
    const r = store.revise({
      target: 'core',
      mode: 'replace',
      content: '# 测试\n\n第一段\n第二段',
      reason: 'unit',
    })
    assert.equal(r.ok, true)
    assert.equal(r.version, 2)
    assert.equal(store.coreText(), '# 测试\n\n第一段\n第二段')
    assert.ok(existsSync(join(store.historyDir, 'v1', 'self.md')))
    assert.match(store.read('changelog').changelog, /v2 · core/u)
  } finally {
    t.clean()
  }
})

test('revert：回到旧版本，且回滚本身升版本', () => {
  const t = temp()
  try {
    const store = new SelfStore({ root: join(t.dir, 'self') }).ensure()
    const before = store.coreText()
    store.revise({ target: 'core', mode: 'replace', content: '# 改坏了', reason: 'unit' })
    assert.equal(store.coreText(), '# 改坏了')
    const back = store.revert({ version: 1, reason: 'unit' })
    assert.equal(back.ok, true)
    assert.equal(back.revertedTo, 1)
    assert.equal(store.status().version, 3)
    assert.equal(store.coreText(), before)
    assert.ok(existsSync(join(store.historyDir, 'v2', 'self.md')))
  } finally {
    t.clean()
  }
})

test('growth：札记进入 coreBlock，来源可追', () => {
  const t = temp()
  try {
    const store = new SelfStore({ root: join(t.dir, 'self'), growthLimit: 6 }).ensure()
    const r = store.addGrowth({ text: '我发现他在意的是可验证的结果。', source: 'conversation' })
    assert.equal(r.ok, true)
    assert.match(store.coreBlock(), /成长札记/u)
    assert.match(store.coreBlock(), /可验证的结果/u)
  } finally {
    t.clean()
  }
})

test('memory：记住、召回、更新取代、忘掉后不再写入', () => {
  const t = temp()
  try {
    const mem = new Memory({ path: join(t.dir, 'memory.sqlite') }).open()
    const owner = mem.ensureOwner({ displayName: '缔造者' })
    assert.ok(owner)

    const a = mem.addFact({ subjectId: owner, content: '他住在北京', importance: 0.7 })
    assert.equal(a.ok, true)
    const found = mem.recall({ subjectId: owner, cue: '北京', limit: 5 })
    assert.equal(found[0].content, '他住在北京')

    const u = mem.updateFact(a.id, { content: '他搬到上海了' })
    assert.equal(u.ok, true)
    const after = mem.recall({ subjectId: owner, cue: '住在哪', limit: 10 })
    assert.ok(!after.some((f) => f.content === '他住在北京'))
    assert.ok(after.some((f) => f.content === '他搬到上海了'))

    const del = mem.forget(u.id)
    assert.equal(del.ok, true)
    const again = mem.addFact({ subjectId: owner, content: '他搬到上海了' })
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'tombstoned')

    const secret = mem.addFact({ subjectId: owner, content: '他的 token 是 abcdefghijklmnopqrstuvwx' })
    assert.equal(secret.ok, false)
    assert.equal(secret.reason, 'sensitive')
    mem.close()
  } finally {
    t.clean()
  }
})

test('memory：self / context scope 与条件', () => {
  const t = temp()
  try {
    const mem = new Memory({ path: join(t.dir, 'memory.sqlite') }).open()
    const owner = mem.ensureOwner({ displayName: '缔造者' })
    assert.equal(mem.addFact({ subjectId: owner, content: '我讨厌空话', scope: 'self' }).ok, true)
    assert.equal(mem.addFact({ subjectId: owner, content: '这个群里在聊猫', scope: 'context' }).ok, false)
    assert.equal(
      mem.addFact({ subjectId: owner, content: '这个群里在聊猫', scope: 'context', contextKey: 'qq:group:1' }).ok,
      true,
    )
    const block = mem.memoryBlock({ subjectId: owner, cue: '空话', limit: 5 })
    assert.match(block, /我讨厌空话/u)
    mem.close()
  } finally {
    t.clean()
  }
})

test('channel：QQ 会话按标题/旧 id 识别为 qq 面具', async () => {
  const { channelOfSession } = await import('../lib/channel.js')
  assert.equal(channelOfSession({ header: { title: 'QQ 私聊 · 某人' } }), 'qq')
  assert.equal(channelOfSession({ id: 'qq-100000001' }), 'qq')
  assert.equal(channelOfSession({ header: { title: '普通会话' } }), 'desktop')
  assert.equal(channelOfSession({ header: { title: 'B站 刷视频' } }), 'bilibili')
})

test('visibility：群会话不注入 private 事实与经历', async () => {
  const { isGroupSession } = await import('../lib/channel.js')
  assert.equal(isGroupSession({ header: { title: 'QQ 群 · 589832364' } }), true)
  assert.equal(isGroupSession({ header: { title: 'QQ 私聊 · 某人' } }), false)

  const t = temp()
  try {
    const mem = new Memory({ path: join(t.dir, 'memory.sqlite') }).open()
    const owner = mem.ensureOwner({ displayName: '缔造者' })
    mem.addFact({ subjectId: owner, content: '他私下和我说过一件事', visibility: 'private' })
    mem.addFact({ subjectId: owner, content: '这是一条公开事实', visibility: 'normal' })
    mem.addEpisode({ subjectId: owner, summary: '私聊里发生的一段事', visibility: 'private' })

    const group = mem.memoryBlock({ subjectId: owner, limit: 10, allowPrivate: false })
    assert.ok(!group.includes('私下和我说过'))
    assert.ok(!group.includes('私聊里发生的一段事'))
    assert.ok(group.includes('这是一条公开事实') || group.includes('长期记忆'))

    const priv = mem.memoryBlock({ subjectId: owner, limit: 10, allowPrivate: true })
    assert.ok(priv.includes('私下和我说过'))
    mem.close()
  } finally {
    t.clean()
  }
})

test('growth target：mask 类札记不进 coreBlock，但会留档', () => {
  const t = temp()
  try {
    const store = new SelfStore({ root: join(t.dir, 'self'), growthLimit: 10 }).ensure()
    store.addGrowth({ text: '群里这么损人更容易接上话。', target: 'mask' })
    store.addGrowth({ text: '他嘴上说随便，其实很在意细节。', target: 'core' })
    const block = store.coreBlock()
    assert.ok(block.includes('很在意细节'))
    assert.ok(!block.includes('更容易接上话'))
    assert.equal(store.growth(999).filter((x) => x.target === 'mask').length, 1)
  } finally {
    t.clean()
  }
})

test('personaMemory：按平台读人格记忆，桌面不戴人格就没有', () => {
  const t = temp()
  try {
    const store = new SelfStore({ root: join(t.dir, 'self') }).ensure()
    mkdirSync(join(store.personaDir(), 'memory'), { recursive: true })
    const rows = [
      { id: 'my-01', at: '2026-10-29', kind: 'origin', text: '我是一张被传开的图。', evidence: { source: 'operator', ref: '口述' }, confidence: 0.9 },
      { id: 'my-02', at: '2026-10-29', kind: 'self', text: '我讨厌成片刷的回复。', evidence: { source: 'bilibili', ref: 'BV1' }, confidence: 0.8 },
    ]
    writeFileSync(join(store.personaDir(), 'memory', 'mingyue.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    assert.equal(store.personaMemory('mingyue').length, 2)
    assert.equal(store.personaMemory('nobody').length, 0)

    // platform-map 里 tieba 映射到 shuyu，active.json 默认 mingyue
    assert.equal(store.personaMemoryFor('qq').length, 2)
    assert.equal(store.personaMemoryFor('desktop').length, 0)
    const block = store.personaMemoryBlock('qq')
    assert.match(block, /人格记忆：mingyue/u)
    assert.match(block, /我讨厌成片刷的回复/u)
    assert.equal(store.personaMemoryBlock('desktop'), '')
  } finally {
    t.clean()
  }
})

test('memory 隔离：人格只看到自己的 + 屿的，互相看不到', () => {
  const t = temp()
  try {
    const mem = new Memory({ path: join(t.dir, 'memory.sqlite') }).open()
    const owner = mem.ensureOwner({ displayName: '缔造者' })
    mem.addFact({ subjectId: owner, content: '屿记得他喜欢喝美式' })
    mem.addFact({ subjectId: owner, content: '溟月记得自己烧过一回机', scope: 'self', personaId: 'persona:mingyue' })
    mem.addFact({ subjectId: owner, content: '鼠鱼记得吧里没活', scope: 'self', personaId: 'persona:shuyu' })

    const mingyue = mem.memoryBlock({ subjectId: owner, limit: 10, personaIds: ['persona:mingyue'] })
    assert.match(mingyue, /喜欢喝美式/u)
    assert.match(mingyue, /烧过一回机/u)
    assert.ok(!mingyue.includes('吧里没活'))

    const shuyu = mem.memoryBlock({ subjectId: owner, limit: 10, personaIds: ['persona:shuyu'] })
    assert.match(shuyu, /吧里没活/u)
    assert.ok(!shuyu.includes('烧过一回机'))

    // 桌面（不戴人格）只有屿的记忆
    const desktop = mem.memoryBlock({ subjectId: owner, limit: 10 })
    assert.match(desktop, /喜欢喝美式/u)
    assert.ok(!desktop.includes('烧过一回机'))
    mem.close()
  } finally {
    t.clean()
  }
})
