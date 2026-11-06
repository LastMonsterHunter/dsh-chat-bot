#!/usr/bin/env node
/**
 * tieba-ops.mjs — 用浏览器会话做吧级操作：关注/取消关注、签到。
 *
 * 客户端写接口（/c/c/forum/like、/c/c/forum/sign）对这台机器的登录态一直返回
 * 110001，所以走浏览器：打开吧页，点“关注本吧”/“签到”，读 DOM 判断结果。
 *
 * 用法：
 *   node scripts/tieba-ops.mjs --action follow --kw 孙笑川
 *   node scripts/tieba-ops.mjs --action sign --kw 孙笑川
 * 退出码：0 成功；1 失败；2 需要重新扫码登录。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9353

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

async function main() {
  const action = arg('action', 'sign')
  const kw = arg('kw', '')
  if (!kw) throw new Error('缺 --kw（吧名）')
  const profile = join(dshHome(), 'tieba-browser')
  if (!existsSync(profile)) {
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
        if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break
      } catch {
        /* not up yet */
      }
      await sleep(250)
    }
    const tab = await (
      await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    ).json()
    ws = new WebSocket(tab.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
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
    await send('Page.navigate', { url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(kw)}` })
    await sleep(9000)
    const text = await send('Runtime.evaluate', {
      expression: 'document.body.innerText.slice(0, 1200)',
      returnByValue: true,
    })
    const page = String(text.result?.value || '')
    if (!page.includes(kw)) {
      console.log(JSON.stringify({ ok: false, needLogin: true, error: '吧页没加载出内容（可能登录态失效）' }))
      return 2
    }

    const readState = async () => {
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify([...document.querySelectorAll('a,button,div,span')].filter(e=>{const t=(e.innerText||'').trim();return t.length>0&&t.length<=8&&!t.includes('\\n')&&/关注本吧|已关注|^关注$|签到|已签到|连签/.test(t)&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().y<420}).map(e=>e.innerText.trim()+'@'+Math.round(e.getBoundingClientRect().y)))`,
        returnByValue: true,
      })
      return JSON.parse(String(r.result?.value || '[]'))
    }
    const clickText = async (pattern, yMax = 420) => {
      const r = await send('Runtime.evaluate', {
        expression: `(()=>{const els=[...document.querySelectorAll('a,button,div,span')].filter(e=>{const t=(e.innerText||'').trim();return ${pattern}&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().y<${yMax}});if(!els.length)return false;const b=els[0].getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)})})()`,
        returnByValue: true,
      })
      const v = String(r.result?.value || '')
      if (!v || v === 'false') return false
      const pos = JSON.parse(v)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      return true
    }

    const before = await readState()
    let clicked = false
    let note = ''
    if (action === 'follow') {
      if (before.some((s) => s.startsWith('已关注'))) {
        note = '已经是关注状态，没重复点'
      } else {
        clicked = await clickText(`t==='关注本吧'||t==='关注'`, 320)
        note = clicked ? '点了关注' : '没找到关注按钮'
      }
    } else if (action === 'unfollow') {
      if (!before.some((s) => s.startsWith('已关注'))) {
        note = '本来就没关注'
      } else {
        // 右侧“已关注”点一下会弹确认框，还要点“确认取消”。
        clicked = await clickText(`t.startsWith('已关注')`, 420)
        if (clicked) {
          await sleep(1200)
          const confirmed = await clickText(`t==='确认取消'`, 900)
          note = confirmed ? '已确认取消关注' : '点了已关注，但没找到确认取消按钮'
        } else {
          note = '没找到已关注按钮'
        }
      }
    } else if (action === 'sign') {
      if (before.some((s) => s.startsWith('连签'))) {
        note = '今天已经签过了'
      } else {
        clicked = await clickText(`t==='签到'`, 320)
        note = clicked ? '点了签到' : '没找到签到按钮'
      }
    } else {
      throw new Error(`未知 action：${action}`)
    }
    await sleep(3500)
    const after = await readState()
    console.log(
      JSON.stringify({
        ok: true,
        action,
        kw,
        clicked,
        note,
        before,
        after,
      }),
    )
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
