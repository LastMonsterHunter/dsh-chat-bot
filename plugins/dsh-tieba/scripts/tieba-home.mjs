#!/usr/bin/env node
/**
 * tieba-home.mjs — 读贴吧个人主页的四个分类（贴子/回贴/点赞/收藏）。
 *
 * 主页（/home/main）的数据接口带白名单签名，且要求浏览器会话；所以不逆签名，
 * 直接用持久 Chrome profile（~/.dsh/tieba-browser）打开主页，点对应 tab，
 * 从 CDP 的 Network.getResponseBody 拿回 JSON。
 *
 * 用法：
 *   node scripts/tieba-home.mjs --tab likes [--out /tmp/likes.json]
 *   tab: threads | replies | likes | favorites
 * 退出码：0 成功；1 失败；2 需要重新扫码登录。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9344
const HOME_URL = 'https://tieba.baidu.com/home/main?id=tb.1.8635512b.4ircYRGAvfpb5BepPcKUpw&fr=pb'
const TABS = {
  threads: { click: null, match: 'myThread.*type=1' }, // 页面初始请求就是 type=1
  replies: { click: '回贴', match: 'myThread.*type=2' },
  likes: { click: '点赞', match: 'userAgree' },
  favorites: { click: '收藏', match: 'threadStoreList' },
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function textOf(value) {
  if (!value) return ''
  if (Array.isArray(value)) return value.map((v) => textOf(v)).filter(Boolean).join(' ')
  if (typeof value === 'object') return textOf(value.text || value.content || value.title || '')
  return String(value)
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
}

function parseItems(tab, data) {
  const list = data?.list || data?.thread_list || data?.post_list || []
  const items = []
  for (const raw of list) {
    const t = raw?.thread_info || raw
    const p = raw?.post_info || null
    items.push({
      kind: tab,
      tid: String(t?.tid || t?.id || ''),
      title: String(t?.title || ''),
      fname: String(t?.fname || t?.forum_info?.name || ''),
      abstract: textOf(t?.first_post_content || t?.abstract || t?.rich_abstract),
      agreeNum: Number(t?.agree_num || t?.agree?.agree_num || 0),
      replyNum: Number(t?.reply_num || 0),
      time: String(t?.last_time || ''),
      author: String(t?.author?.name_show || t?.author?.name || ''),
      floor: p ? Number(p.floor || 0) : undefined,
      content: p ? textOf(p.content) : undefined,
      pid: p ? String(p.pid || p.id || '') : undefined,
      // 点赞列表里，如果赞的是评论，会带 top_agree_post。
      likedComment: t?.top_agree_post
        ? {
            pid: String(t.top_agree_post.id || ''),
            content: textOf(t.top_agree_post.content),
            author: String(t.top_agree_post.author?.name_show || t.top_agree_post.author?.name || ''),
            agreeNum: Number(t.top_agree_post.agree?.agree_num || 0),
            time: Number(t.top_agree_post.time || 0),
          }
        : undefined,
    })
  }
  return { items, hasMore: Boolean(data?.has_more) }
}

async function main() {
  const tab = arg('tab', 'likes')
  if (!TABS[tab]) throw new Error(`未知 tab：${tab}`)
  const out = arg('out', '')
  const profile = arg('profile', join(dshHome(), 'tieba-browser'))
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`)

  if (!existsSync(profile)) {
    // 没有浏览器档案 = 从没在 Chrome 里登录过，提示去扫码。
    console.log(JSON.stringify({ ok: false, needLogin: true, error: '没有浏览器档案，需要先扫码登录' }))
    return 2
  }

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  chrome.unref()

  let ws = null
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
        if (r.ok) break
      } catch {
        /* not up yet */
      }
      await sleep(250)
    }
    const newTab = await (
      await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    ).json()
    ws = new WebSocket(newTab.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    const reqs = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response
        if (!/\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?)(\?|$)/iu.test(r.url)) reqs.set(m.params.requestId, r.url)
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    }
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('DevTools 连接失败'))
    })
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id
        const timer = setTimeout(() => {
          pending.delete(mid)
          reject(new Error(`DevTools ${method} 超时`))
        }, 25000)
        pending.set(mid, (m) => {
          clearTimeout(timer)
          if (m.error) reject(new Error(JSON.stringify(m.error)))
          else resolve(m.result)
        })
        ws.send(JSON.stringify({ id: mid, method, params }))
      })

    await send('Page.enable')
    await send('Network.enable')
    await send('Page.navigate', { url: HOME_URL })
    await sleep(8000)

    // 登录检查：主页登录后会渲染“贴子/回贴/点赞/收藏”
    const bodyText = await send('Runtime.evaluate', {
      expression: 'document.body.innerText.slice(0, 800)',
      returnByValue: true,
    })
    const pageText = String(bodyText.result?.value || '')
    if (!pageText.includes('贴子') && !pageText.includes('回贴')) {
      console.log(JSON.stringify({ ok: false, needLogin: true, error: '主页跳到了登录页，需要重新扫码' }))
      return 2
    }

    if (TABS[tab].click) {
      reqs.clear()
      await send('Runtime.evaluate', {
        expression: `(()=>{const els=[...document.querySelectorAll('a,div,span,li')].filter(e=>e.innerText&&e.innerText.trim()==='${TABS[tab].click}'&&e.getBoundingClientRect().width>0);if(els.length)els[0].click()})()`,
        returnByValue: true,
      })
      await sleep(4500)
    }
    const re = new RegExp(TABS[tab].match, 'u')
    const hit = [...reqs].find(([, u]) => re.test(u))
    if (!hit) {
      console.log(JSON.stringify({ ok: true, tab, items: [], hasMore: false, note: '没有抓到列表接口（可能该分类为空）' }))
      return 0
    }
    const body = await send('Network.getResponseBody', { requestId: hit[0] })
    const raw = String(body.body || '')
    let data = {}
    try {
      data = JSON.parse(raw)?.data || {}
    } catch {
      throw new Error(`列表接口不是 JSON：${raw.slice(0, 120)}`)
    }
    const parsed = parseItems(tab, data)
    const payload = { ok: true, tab, ...parsed, raw: parsed.items.length ? undefined : data }
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(payload, null, 2))
    }
    console.log(JSON.stringify(payload))
    return 0
  } finally {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    try {
      chrome.kill()
    } catch {
      /* ignore */
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.log(JSON.stringify({ ok: false, error: String(error?.message || error) }))
    process.exit(1)
  })
