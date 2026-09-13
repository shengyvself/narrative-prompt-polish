#!/usr/bin/env node
// verify-polish-cdp.mjs — 主路径端到端取证探针（真 GUI，headless chromium + CDP）。
//
// 用途：验证「主框 ✨ → /api/polish.start → continuable 子代理 → 子代理会话可对话」这条主路径
//       在真实浏览器里跑通（含 0.1.5 会话标准 props 契约：useInput.draft / inputActions）。
//
// 前置（chromium 不能跑在 dsh-web 的 cgroup 内，snap 会拒绝；用 systemd-run 起瞬时单元）：
//   sudo systemd-run --unit=cdp-npp-$(date +%s) --collect \
//     /snap/bin/chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
//     --remote-debugging-port=9229 --user-data-dir=/tmp/dsh-cdp-npp about:blank
// 运行：
//   DSH_TOK=$(cat ~/.dsh/current-web-token.txt) NPP_TITLE="<要打开的会话标题>" node verify-polish-cdp.mjs
//
// 注意：本探针会**真实点击 ✨**（起一个真子代理、消耗一次模型调用），并断言：
//   ① ✨ 按钮在会话内渲染；② 草稿非空时按钮启用（useInput.draft 契约）；③ 点击后服务端 trace
//   出现 type:"subagent-start" 行；④ 浏览器 console 无错误。
//   只读 + 一次真实子代理启动，不触碰 canon 与创作内容。
const PORT = Number(process.env.CDP_PORT || 9229)
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3080'
const TOKEN = process.env.DSH_TOK
const TITLE = process.env.NPP_TITLE || '提示词优化插件的处理方式'
const TRACE_DIR = process.env.NPP_TRACE_DIR || '<HOME_PATH>/lore/traces/prompt-polish'
const draft = process.env.NPP_DRAFT || '帮我写一个导出脚本，把 lore/traces 里最近的 trace 汇总成 CSV'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (!TOKEN) { console.error('DSH_TOK missing'); process.exit(2) }
const before = (() => {
  const f = join(TRACE_DIR, new Date().toISOString().slice(0, 10) + '.jsonl')
  if (!existsSync(f)) return 0
  return readFileSync(f, 'utf8').split('\n').filter(l => l.includes('"subagent-start"')).length
})()

const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
const page = targets.find(t => t.type === 'page') || targets[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let id = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 200))
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('EXC ' + String(m.params.exceptionDetails.text || '').slice(0, 200))
})
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { error: JSON.stringify(r.exceptionDetails).slice(0, 300) } : r.result.value }
const clickAria = (label) => ev('(function(){var b=Array.from(document.querySelectorAll("button[aria-label]")).find(function(n){return n.getAttribute("aria-label")===' + JSON.stringify(label) + '});if(!b)return "not-found";b.click();return "clicked"})()')
const clickAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }) }

let pass = 0, fail = 0
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  ok - ' + label + (extra ? ' ' + extra : '')) } else { fail++; console.log('  FAIL - ' + label + (extra ? ' ' + extra : '')) } }

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/?token=' + TOKEN })
await sleep(8000)

const opened = await clickAria('Search sessions')
ok(opened === 'clicked', '打开会话检索')
await sleep(2000)
const pick = await ev('(function(){var t=' + JSON.stringify(TITLE) + ';var all=Array.from(document.querySelectorAll("button,[role=button],li,div,a"));var hit=all.filter(function(n){return (n.innerText||"").trim()===t && n.offsetHeight>0});if(!hit.length)hit=all.filter(function(n){return (n.innerText||"").indexOf(t)>=0 && n.offsetHeight>0 && (n.innerText||"").length<200});if(!hit.length)return "not-found";hit[hit.length-1].click();return "clicked:"+hit.length})()')
ok(String(pick).indexOf('clicked') === 0, '打开目标会话', String(pick))
await sleep(4000)

const btn0 = await ev('(function(){var b=document.querySelector("button.npp-btn");return b?JSON.stringify({disabled:b.disabled}):"none"})()')
ok(btn0 !== 'none', '✨ 按钮在会话输入框右座渲染', String(btn0))

const ed = await ev('(function(){var el=document.querySelector("[contenteditable=true]");var r=el.getBoundingClientRect();return JSON.stringify([Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)])})()')
const [ex, ey] = JSON.parse(ed)
await clickAt(ex, ey); await sleep(400)
await send('Input.insertText', { text: draft })
await sleep(1500)
const btn1 = await ev('(function(){var b=document.querySelector("button.npp-btn");return b?JSON.stringify({disabled:b.disabled}):"none"})()')
ok(String(btn1).indexOf('"disabled":false') >= 0, '草稿非空 ⇒ 按钮启用（useInput.draft 契约生效）', String(btn1))

let clicked = false
if (String(btn1).indexOf('"disabled":false') >= 0) {
  const br = await ev('(function(){var b=document.querySelector("button.npp-btn");var r=b.getBoundingClientRect();return JSON.stringify([Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)])})()')
  const [bx, by] = JSON.parse(br)
  await clickAt(bx, by); clicked = true
  console.log('  i  - 已点击 ✨ @' + br)
}
ok(clicked, '点击 ✨')
await sleep(6000)

const after = (() => {
  const f = join(TRACE_DIR, new Date().toISOString().slice(0, 10) + '.jsonl')
  if (!existsSync(f)) return before
  return readFileSync(f, 'utf8').split('\n').filter(l => l.includes('"subagent-start"')).length
})()
ok(after > before, '服务端 trace 新增 subagent-start 行（子代理已起）', before + '→' + after)
ok(consoleErrors.length === 0, '浏览器 console 无错误', JSON.stringify(consoleErrors).slice(0, 200))

ws.close()
console.log('\nverify-polish-cdp: ' + pass + '/' + (pass + fail) + ' ' + (fail === 0 ? 'PASS' : 'FAIL'))
process.exit(fail === 0 ? 0 : 1)
