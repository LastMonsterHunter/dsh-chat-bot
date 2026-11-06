#!/usr/bin/env node
/**
 * tieba-login.mjs — 用本机 Chrome 开贴吧扫码登录，把 cookie 存成凭据文件。
 *
 * 流程：
 *   1. headless Chrome 打开 passport 扫码页，保存二维码图片；
 *   2. 等人扫码（最长 5 分钟），轮询 Chrome 里的 cookie；
 *   3. 拿到 BDUSS/STOKEN/BAIDUID 后写凭据（600），关 Chrome。
 *
 * 用法：
 *   node scripts/tieba-login.mjs [--out /path/credential.json] [--qr /path/qr.png]
 *   退出码：0 成功；1 失败/超时；2 已登录（无需扫码）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LOGIN_URL = 'https://passport.baidu.com/v2/?login&tpl=tb&u=https%3A%2F%2Ftieba.baidu.com%2F'
const PORT = 9335
const PROFILE = join(homedir(), '.dsh', 'tieba-login-chrome')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const CHAT_BOT_ROOT = process.env.CHAT_BOT_ROOT || fileURLToPath(new URL('../../../bot', import.meta.url))
const outPath = arg('out', join(CHAT_BOT_ROOT, 'data/secrets/tieba_credential.json'))
const qrPath = arg('qr', '/tmp/tieba-login/qr.png')
const MAX_WAIT_MS = 5 * 60 * 1000

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
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

async function waitDevtools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Chrome DevTools 没起来')
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`)
  // 已登录且凭据里有全量 cookie 就直接复用；--force 强制重新扫码。
  const existing = readJson(outPath, null)
  if (existing?.bduss && existing?.cookies && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ ok: true, already: true, path: outPath }))
    return 0
  }

  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
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
    await waitDevtools()
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
    ws = new WebSocket(tab.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('DevTools WebSocket 连接失败'))
    })
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id
        const timer = setTimeout(() => {
          pending.delete(mid)
          reject(new Error(`DevTools ${method} 超时`))
        }, 12000)
        pending.set(mid, (m) => {
          clearTimeout(timer)
          if (m.error) reject(new Error(JSON.stringify(m.error)))
          else resolve(m.result)
        })
        ws.send(JSON.stringify({ id: mid, method, params }))
      })

    await send('Page.enable')
    await send('Network.enable')
    await send('Page.navigate', { url: LOGIN_URL })

    // 等二维码真正加载出来：页面先用 GIF 转圈图占位，成功后才换成 PNG。
    // 所以不能只等元素出现，要下载到 PNG 字节（magic 89504e47）才算数。
    let qrBuf = null
    const qrDeadline = Date.now() + 30000
    while (Date.now() < qrDeadline && !qrBuf) {
      const r = await send('Runtime.evaluate', {
        expression:
          "(()=>{const el=document.querySelector('img.tang-pass-qrcode-img');return el&&el.src&&el.getBoundingClientRect().width>50?el.src:''})()",
        returnByValue: true,
      })
      const src = String(r.result?.value || '')
      if (src) {
        try {
          const img = await fetch(src)
          if (img.ok) {
            const buf = Buffer.from(await img.arrayBuffer())
            if (buf.length > 4 && buf.slice(0, 4).toString('hex') === '89504e47') qrBuf = buf
          }
        } catch {
          /* 这一轮没拿到，继续 */
        }
      }
      if (!qrBuf) await new Promise((r) => setTimeout(r, 600))
    }
    if (!qrBuf) throw new Error('二维码一直没加载出来（只拿到占位图）')
    mkdirSync(dirname(qrPath), { recursive: true })
    writeFileSync(qrPath, qrBuf, { mode: 0o600 })
    console.log(
      JSON.stringify({ ok: true, stage: 'qr', qr: qrPath, url: LOGIN_URL, hint: '用百度 App 扫码；二维码几分钟内有效' }),
    )

    // 轮询 cookie，最多 5 分钟
    const deadline = Date.now() + MAX_WAIT_MS
    let found = null
    while (Date.now() < deadline) {
      try {
        const cookies = await send('Network.getCookies', {
          urls: [
            'https://tieba.baidu.com/',
            'https://passport.baidu.com/',
            'https://www.baidu.com/',
            'https://wappass.baidu.com/',
          ],
        })
        const list = cookies?.cookies || []
        const get = (name) => list.find((c) => c.name === name)
        const bduss = get('BDUSS')
        const stoken = get('STOKEN')
        if (bduss?.value) {
          // 全量保存：主页（/home/main）要完整登录态，只存 BDUSS/STOKEN 会被踢回登录页。
          const all = {}
          for (const c of list) {
            if (c?.name && c.value !== undefined && !(c.name in all)) all[c.name] = c.value
          }
          found = {
            bduss: bduss.value,
            stoken: stoken?.value || '',
            baiduid: get('BAIDUID')?.value || '',
            bduss_bfess: get('BDUSS_BFESS')?.value || '',
            cookies: all,
            saved_at: Math.floor(Date.now() / 1000),
          }
          break
        }
      } catch (error) {
        // 页面跳转时 DevTools 偶尔超时，继续等。
        console.error('cookie 轮询失败：', String(error?.message || error))
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (!found) throw new Error('等待扫码超时（5 分钟）')
    writeJson(outPath, found)
    console.log(JSON.stringify({ ok: true, stage: 'saved', path: outPath }))
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
