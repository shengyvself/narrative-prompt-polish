/**
 * smoke-apply.mjs — 服务端 apply 冒烟（改插件红线 10：上线前用真实 apply + 假 cordis Context 跑一遍）。
 * 覆盖：inject 声明、webServer prefix 注册、信任围栏、polish.start 端到端（假 agents/subagents）。
 * 运行：node scripts/smoke-apply.mjs
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as plugin from "../src/index.js"

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log("  ok - " + label) } else { fail++; console.log("  FAIL - " + label) }
}

const registered = []
const spec = { provider: null, request: null }
const parentAgent = { id: "agent-1", session: { id: "s1" } }
const ctx = {
  webServer: { register(route) { registered.push(route); return () => {} } },
  loader: { entries: () => [{ options: { name: "connection", config: { trustedHosts: ["trusted.example:3080"] } } }] },
  effect(fn, _label) { return fn() },
  inject() { /* settings 未挂载：走 patch config 基座 */ },
  sessions: { get: () => undefined },
  sessionQuery: {},
  llm: { stream: async function* () { yield { type: "finish", reason: { kind: "stop" } } } },
  agentDefaultModel: { currentSelection: () => ({ provider: "pv", model: "md" }) },
  agents: { get: (id) => (id === "s1" ? parentAgent : undefined) },
  subagents: {
    getProvider: (n) => (n === "fork" ? { name: n } : undefined),
    startContinuable: async (s) => { spec.provider = s.provider; spec.request = s.request; return { childId: "session-child-9", messageId: "m-9" } },
  },
}

const traceDir = mkdtempSync(join(tmpdir(), "npp-smoke-"))
plugin.apply(ctx, { subagentProvider: "fork", traceDir: traceDir })

ok(plugin.name === "narrative-prompt-polish", "name 唯一化")
for (const svc of ["webServer", "sessions", "agents", "subagents"]) ok(plugin.inject.includes(svc), "inject 声明 " + svc)
ok(registered.length === 1 && registered[0].kind === "prefix", "注册唯一 prefix 路由")
ok(registered[0].path === "/narrative-prompt-polish/api", "路由前缀正确")

const handler = registered[0].handler
function fakeRes() {
  const res = {
    statusCode: 0, body: "", headers: {},
    setHeader(k, v) { this.headers[k] = v },
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers) },
    end(chunk) { this.body += chunk || "" },
    write(chunk) { this.body += chunk || "" },
  }
  return res
}
function fakeReq(payload, headers) {
  const text = JSON.stringify(payload)
  return {
    url: "/narrative-prompt-polish/api/polish.start",
    method: "POST",
    headers: Object.assign({ host: "127.0.0.1:3080", "content-type": "application/json" }, headers || {}),
    async *[Symbol.asyncIterator]() { yield Buffer.from(text) },
    on() {}, removeListener() {},
  }
}

let res = fakeRes()
await handler(fakeReq({}, { host: "evil.example" }), res)
ok(res.statusCode === 403, "围栏：外域 host → 403")

res = fakeRes()
await handler({ url: "/narrative-prompt-polish/api/polish.start", method: "GET", headers: { host: "127.0.0.1:3080" } }, res)
ok(res.statusCode === 405, "非 POST → 405")

res = fakeRes()
await handler(fakeReq({ sessionId: "s1", text: "帮我写一个导出脚本" }), res)
const parsed = JSON.parse(res.body)
ok(res.statusCode === 200 && parsed.ok === true, "polish.start 200 信封 ok")
ok(parsed.value.childId === "session-child-9", "返回 childId")
ok(spec.provider === "fork", "provider=fork 传给 startContinuable")
ok(spec.request.parent === parentAgent, "parent 是 live Agent")
ok(String(spec.request.prompt[0].text).includes("帮我写一个导出脚本"), "任务书含草稿")

res = fakeRes()
await handler(fakeReq({ sessionId: "not-live", text: "草稿" }), res)
const err = JSON.parse(res.body)
ok(res.statusCode === 409 && err.error.code === "no-live-agent", "无 live agent → 409 no-live-agent")

res = fakeRes()
await handler(fakeReq({ sessionId: "s1", text: "   " }), res)
const err2 = JSON.parse(res.body)
ok(res.statusCode === 400 && err2.error.code === "rejected", "空草稿 → 400 rejected")

console.log("\nsmoke-apply: " + pass + "/" + (pass + fail) + " " + (fail === 0 ? "PASS" : "FAIL"))
process.exit(fail === 0 ? 0 : 1)
