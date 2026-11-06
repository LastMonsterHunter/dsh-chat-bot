const IM_CHANNEL_PREFIXES = [
  'weixin',
  'feishu',
  'dingtalk',
  'wecom',
  'wecomapp',
  'qq',
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'imessage',
  'matrix',
  'email',
  'office',
]

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IM_RPC_ID = new RegExp(`^(${IM_CHANNEL_PREFIXES.join('|')})-(?:steer-)?${UUID}$`, 'u')
const IM_LEGACY_ID = new RegExp(`^(${IM_CHANNEL_PREFIXES.join('|')})-.+`, 'u')

export function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return ''
  const id = session.id ?? session.sessionId ?? session.header?.id
  return typeof id === 'string' ? id : ''
}

function eventsOf(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
  return Array.isArray(events) ? events : []
}

/**
 * 这一轮从哪个渠道进来：qq / bilibili / desktop。
 * QQ 走 dsh-im 的 rpcId 前缀；B站没有 IM 前缀，用来源 kind 与会话 id/标题兜底。
 * 判不出来就回桌面，宁可不戴面具也不乱戴。
 */
export function channelOfSession(session) {
  if (!session || typeof session !== 'object') return 'desktop'
  try {
    const id = sessionIdOf(session)
    // 标题可能在 header、会话顶层，或在 session/title 事件里；
    // 读不到标题就会一路兜底到 desktop，面具挂不上（2026-10-28 查到）。
    let title = String(session.header?.title || session.title || '')
    const events = eventsOf(session)
    if (!title || !/^(QQ|bilibili)/iu.test(title)) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev?.type === 'session/title' && ev.data?.title) {
          title = String(ev.data.title)
          break
        }
      }
    }
    // dsh-qq 建会话时会把标题写成「QQ 私聊 · 昵称」/「QQ 群 · 群号」；标题最权威，先看。
    if (/^QQ\s/u.test(title)) return 'qq'
    if (/bilibili|b站|哔哩/iu.test(`${id} ${title}`)) return 'bilibili'

    const inherited = session.inheritedEventCount
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event || (event.type !== 'user/message' && event.type !== 'message')) continue
      if (Number.isSafeInteger(inherited) && Number.isSafeInteger(event.seq) && event.seq < inherited) continue
      const source = event.data?.source
      if (!source) continue
      const kind = String(source.kind || '')
      if (/bili/iu.test(kind)) return 'bilibili'
      const rpcId = String(source.rpcId || '')
      const hit = IM_RPC_ID.exec(rpcId)
      if (hit) return hit[1] === 'qq' ? 'qq' : 'desktop'
      if (rpcId && !hit) return 'desktop'
    }

    const legacy = IM_LEGACY_ID.exec(id)
    if (legacy) return legacy[1] === 'qq' ? 'qq' : 'desktop'
  } catch {
    /* 会话半初始化时不连累提示词装配 */
  }
  return 'desktop'
}

export function lastUserText(session, fallback = '') {
  const events = eventsOf(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || (event.type !== 'user/message' && event.type !== 'message')) continue
    const content = event.data?.content ?? event.data?.message?.content
    const text = textOfContent(content)
    if (text) return text
  }
  return fallback
}

export function textOfContent(content) {
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

/** 这个会话是不是 QQ 群（标题由 dsh-qq 写成「QQ 群 · 群号」）。 */
export function isGroupSession(session) {
  const title = String(session?.header?.title || session?.title || '')
  return /^QQ\s*群/u.test(title)
}
