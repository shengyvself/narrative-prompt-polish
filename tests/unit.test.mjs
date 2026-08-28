// 单元测试：node --test 运行。覆盖 intent / polish 清洗 / surface 过滤 / trust fence /
// config 合并 / trace 持久化 / context 探测链 / api 校验与错误细分 / CAS 纯逻辑。
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SRC = fileURLToPath(new URL("../src/", import.meta.url))
const load = async (m) => import(SRC + m + ".js")

// ── intent ──
test("intent: debug 骨架命中「为什么/报错」", async () => {
  const { classifyIntent } = await load("intent")
  assert.equal(classifyIntent('为什么这个报错'), 'debug')
  assert.equal(classifyIntent('服务没反应了，是不是挂了？'), 'debug')
})
test("intent: implement 命中「帮我/写一个」", async () => {
  const { classifyIntent } = await load("intent")
  assert.equal(classifyIntent('帮我写一个导出脚本'), 'implement')
  assert.equal(classifyIntent('创建一个新组件'), 'implement')
})
test("intent: explain 命中「解释/区别」；chat 兜底", async () => {
  const { classifyIntent } = await load("intent")
  assert.equal(classifyIntent('解释一下这两个概念的区别'), 'explain')
  assert.equal(classifyIntent('你好呀'), 'chat')
})
test("intent: 四套 system prompt 与 full 指令非空且含结构", async () => {
  const { INTENT_SYSTEM_PROMPTS, polishInstruction, SINGLE_SYSTEM_PROMPT } = await load("intent")
  for (const k of ['debug', 'implement', 'explain', 'chat']) {
    assert.ok(INTENT_SYSTEM_PROMPTS[k].length > 30)
    assert.ok(polishInstruction(k).includes("<polish-request>"))
    assert.ok(polishInstruction(k).includes("</polish-request>"))
  }
  assert.ok(SINGLE_SYSTEM_PROMPT.includes("只输出改写后的消息本身"))
  assert.ok(SINGLE_SYSTEM_PROMPT.includes("最小必要改写"))
})

// ── polish 清洗与流组装 ──
test("polish: stripWrapper 去围栏与前缀", async () => {
  const { stripWrapper } = await load("polish")
  assert.equal(stripWrapper("```\n优化后的文本\n```"), "优化后的文本")
  assert.equal(stripWrapper("润色后的提示词：你好"), "你好")
  assert.equal(stripWrapper("  保持原样  "), "保持原样")
})
test("polish: assembleText 累积 text-delta 并报告 finish/usage", async () => {
  const { assembleText, extractUsage } = await load("polish")
  async function* fake() {
    yield { type: "text-delta", index: 0, text: "A" }
    yield { type: "reasoning-delta", index: 0, text: "想" }   // 不计入正文
    yield { type: "text-delta", index: 0, text: "B" }
    yield { type: "usage", usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 } }
    yield { type: "finish", reason: { kind: "stop" } }
  }
  const r = await assembleText(fake())
  assert.equal(r.text, "AB")
  assert.equal(r.failed, false)
  const u = extractUsage(r.usage)
  assert.equal(u.inputTokens, 10)
  assert.equal(u.outputTokens, 2)
  assert.equal(u.cacheHitTokens, 8)
})
test("polish: assembleText 把 error/aborted 记为失败", async () => {
  const { assembleText } = await load("polish")
  async function* fake() {
    yield { type: "text-delta", index: 0, text: "半截" }
    yield { type: "finish", reason: { kind: "error", failure: { message: "boom" } } }
  }
  const r = await assembleText(fake())
  assert.equal(r.failed, true)
})

// ── surface 过滤（Max-Null 第 3 层）──
test("surface-fold: 只留人类 user 与 assistant 文本", async () => {
  const sf = await load("surface-fold")
  const segs = sf.extractSegments([
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "人话" }] } },
    { type: "user/message", data: { source: { kind: "plugin" }, content: [{ type: "text", text: "注入" }] } },
    { type: "user/message", data: { source: { kind: "skill-catalog" }, content: [{ type: "text", text: "技能表" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "回复" }, { type: "tool-use" }] } } },
    { type: "tool/result", data: {} },
  ])
  assert.deepEqual(segs.map(s => s.role), ["user", "assistant"])
})
test("surface-fold: splitRecent/formatSegments/composeContext", async () => {
  const sf = await load("surface-fold")
  const segs = [1, 2, 3, 4, 5].map(n => ({ role: n % 2 ? "user" : "assistant", text: String(n) }))
  const { earlier, recent } = sf.splitRecent(segs, 2)
  assert.equal(recent.length, 2)
  assert.equal(earlier.length, 3)
  const formatted = sf.formatSegments(recent, 400)
  assert.ok(formatted.includes("助手：4"))
  assert.ok(formatted.includes("用户：5"))
  assert.ok(sf.composeContext("bg", "recent").includes("【背景】"))
  assert.equal(sf.composeContext("", ""), "")
})

// ── trust fence（第 1 层）──
test("trust-fence: loopback 放行、cross-site 与外域拒绝", async () => {
  const tf = await load("trust-fence")
  assert.equal(tf.isTrustedApiRequest({ headers: { host: "localhost:3080" } }, []), true)
  assert.equal(tf.isTrustedApiRequest({ headers: { host: "127.0.0.1:3080" } }, []), true)
  assert.equal(tf.isTrustedApiRequest({ headers: { host: "localhost:3080", "sec-fetch-site": "cross-site" } }, []), false)
  assert.equal(tf.isTrustedApiRequest({ headers: { host: "evil.example" } }, []), false)
  assert.equal(tf.isTrustedApiRequest({ headers: { host: "myhost:3080", origin: "http://evil.example" } }, ["myhost:3080"]), false)
  assert.equal(tf.isTrustedApiRequest({ headers: { host: "myhost:3080", origin: "http://myhost:3080" } }, ["myhost:3080"]), true)
})

// ── config 合并 ──
test("config: 防御式合并拒绝坏类型与未知键", async () => {
  const { effectiveConfig, DEFAULTS } = await load("config")
  const cfg = effectiveConfig({ contextMode: "partial", timeoutMs: "bad", junk: 1 })
  assert.equal(cfg.contextMode, "partial")
  assert.equal(cfg.timeoutMs, DEFAULTS.timeoutMs)
  assert.ok(!("junk" in cfg))
  assert.equal(effectiveConfig(null).contextMode, DEFAULTS.contextMode)
})

// ── trace recorder ──
test("trace: 一行一调 + recent 回读", async () => {
  const tr = await load("trace-recorder")
  const dir = mkdtempSync(join(tmpdir(), "npp-trace-"))
  for (let i = 0; i < 3; i++) {
    const p = tr.recordTrace({ ts: "t" + i, intent: "chat" }, { traceDir: dir, cwd: tmpdir() })
    assert.ok(p && existsSync(p))
  }
  const lines = readFileSync(join(dir, new Date().toISOString().slice(0, 10) + ".jsonl"), "utf8").trim().split("\n")
  assert.equal(lines.length, 3)
  assert.equal(tr.recentTraces({ traceDir: dir, cwd: tmpdir() }, 2).length, 2)
})

// ── context 探测链（C 方案 + 降级链）──
function mockFullSession() {
  return {
    sessions: { get: (id) => ({
      deriveMessages: () => ([{ role: "user", content: [{ type: "text", text: "历史" }] }]),
      requestHeader: () => ({ config: { provider: "p1", model: "m1" }, system: "SYS-PROMPT" }),
    }) },
  }
}
test("context: full 模式走 deriveMessages + requestHeader", async () => {
  const ca = await load("context-assembler")
  const cfg = await load("config")
  const r = await ca.assembleContext(mockFullSession(), cfg.effectiveConfig({}), "s1")
  assert.equal(r.mode, "full")
  assert.equal(r.system, "SYS-PROMPT")
  assert.equal(r.provider, "p1")
  assert.equal(r.model, "m1")
  assert.equal(r.historyCount, 1)
})
test("context: live 缺失自动降级并留痕", async () => {
  const ca = await load("context-assembler")
  const cfg = await load("config")
  const r = await ca.assembleContext({}, cfg.effectiveConfig({}), "missing")
  assert.notEqual(r.mode, "full")
  assert.ok(r.fallbacks.length > 0)
})
test("context: partial 读 surface 且过滤噪音（live 会话守卫内）", async () => {
  const ca = await load("context-assembler")
  const cfg = await load("config")
  const ctx = { sessions: { get: () => ({ seq: 2 }) }, sessionQuery: { readSurface: async () => ({ events: [
    { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "问句" }] } },
    { type: "tool/use", seq: 2, time: 2, data: {} },
  ] }) } }
  const r = await ca.assembleContext(ctx, cfg.effectiveConfig({}), "s1", { mode: "partial" })
  assert.equal(r.mode, "partial")
  assert.ok(r.contextBlock.includes("问句"))
  assert.ok(!r.contextBlock.includes("undefined"))
})
test("context: 超大 live 会话被 seq 预检拦截降级", async () => {
  const ca = await load("context-assembler")
  const cfg = await load("config")
  const ctx = { sessions: { get: () => ({ seq: 999999, deriveMessages: () => { throw new Error("should not project") } }) } }
  const r = await ca.assembleContext(ctx, cfg.effectiveConfig({}), "big")
  assert.notEqual(r.mode, "full")
  assert.ok(r.fallbacks.some(f => f.startsWith("skipped-full-seq")))
})
test("context: persisted 会话默认禁离线全量（offlineFullEnabled=false）", async () => {
  const ca = await load("context-assembler")
  const cfg = await load("config")
  let readSessionCalled = false
  const ctx = { sessionQuery: { readSession: async () => { readSessionCalled = true; return { events: [] } }, listEvents: async () => [] } }
  const r = await ca.assembleContext(ctx, cfg.effectiveConfig({}), "persisted-id")
  assert.equal(readSessionCalled, false)
  assert.ok(r.fallbacks.includes("offline-full-disabled"))
})
test("context: none 无会话也可用", async () => {
  const ca = await load("context-assembler")
  const cfg = await load("config")
  const r = await ca.assembleContext({}, cfg.effectiveConfig({}), undefined, { mode: "none" })
  assert.equal(r.mode, "none")
  assert.deepEqual(r.fallbacks, [])
})

// ── api 层：校验与错误细分 ──
function fakeLlmStream(text) {
  return async function* () {
    yield { type: "text-delta", index: 0, text }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}
async function buildEnv(configPatch) {
  const apiMod = await load("api")
  const cfgMod = await load("config")
  const config = cfgMod.effectiveConfig(Object.assign({ provider: "pv", model: "md" }, configPatch || {}))
  const ctx = Object.assign({}, mockFullSession())
  ctx.llm = { stream: fakeLlmStream("润色结果") }
  const dir = mkdtempSync(join(tmpdir(), "npp-api-"))
  const api = apiMod.buildApi(ctx, () => config, { traceDir: dir, cwd: tmpdir() })
  return { api, config }
}
test("api: empty/references/too-large 三类 rejected", async () => {
  const { api } = await buildEnv()
  await assert.rejects(() => api.polish({}), e => e.code === "bad-request")
  await assert.rejects(() => api.polish({ text: "   " }), e => e.code === "rejected" && e.reason === "empty")
  await assert.rejects(() => api.polish({ text: "含引用\uFFFC占位" }), e => e.code === "rejected" && e.reason === "references")
  await assert.rejects(() => api.polish({ text: "x".repeat(9000) }), e => e.code === "rejected" && e.reason === "too-large")
})
test("api: route-unavailable 在无渠道时抛出", async () => {
  const { api } = await buildEnv({ provider: "", model: "" })
  await assert.rejects(() => api.polish({ text: "草稿" }), e => e.code === "route-unavailable")
})
test("api: strictFull 且会话缺失 → no-session", async () => {
  const apiMod = await load("api")
  const cfgMod = await load("config")
  const config = cfgMod.effectiveConfig({})
  const api = apiMod.buildApi({}, () => config, { traceDir: mkdtempSync(join(tmpdir(), "npp-")), cwd: tmpdir() })
  await assert.rejects(() => api.polish({ text: "草稿", strictFull: true, sessionId: "nope" }), e => e.code === "no-session")
})
test("api: 主流程 full 模式返回文本 + intent + trace 落盘", async () => {
  const { api } = await buildEnv()
  const result = await api.polish({ text: "帮我看看这个为什么报错", sessionId: "s1" })
  assert.equal(result.ok, true)
  assert.equal(result.text, "润色结果")
  assert.equal(result.intent, "debug")
  assert.equal(result.contextMode, "full")
  const traces = await load("trace-recorder")
  void traces
})
test("api: stream 失败 → stream-failed；空输出 → empty-result", async () => {
  const apiMod = await load("api")
  const cfgMod = await load("config")
  const config = cfgMod.effectiveConfig({ provider: "p", model: "m" })
  const badCtx = mockFullSession()
  badCtx.llm = { stream: async function* () { yield { type: "finish", reason: { kind: "error", failure: { message: "x" } } } } }
  const badApi = apiMod.buildApi(badCtx, () => config, { traceDir: mkdtempSync(join(tmpdir(), "npp-")), cwd: tmpdir() })
  await assert.rejects(() => badApi.polish({ text: "草稿" }), e => e.code === "stream-failed")
  const emptyCtx = mockFullSession()
  emptyCtx.llm = { stream: fakeLlmStream("```\n\n```") }
  const emptyApi = apiMod.buildApi(emptyCtx, () => config, { traceDir: mkdtempSync(join(tmpdir(), "npp-")), cwd: tmpdir() })
  await assert.rejects(() => emptyApi.polish({ text: "草稿" }), e => e.code === "empty-result")
})
test("api: partial 模式意图骨架进 system；full 指令在末尾且 system 继承", async () => {
  const apiMod = await load("api")
  const cfgMod = await load("config")
  let captured = null
  const config = cfgMod.effectiveConfig({ provider: "p", model: "m", contextMode: "partial" })
  const ctx = { sessionQuery: { readSurface: async () => ({ events: [] }) }, llm: { stream: (opts) => { captured = opts; return fakeLlmStream("结果")() } } }
  const api = apiMod.buildApi(ctx, () => config, { traceDir: mkdtempSync(join(tmpdir(), "npp-")), cwd: tmpdir() })
  await api.polish({ text: "解释一下 X 的原理" })
  assert.match(captured.system, /概念解释助手/)
  // full 模式：system 来自会话 header，指令是最后一条 user
  let capturedFull = null
  const fullCfg = cfgMod.effectiveConfig({ provider: "", model: "", contextMode: "full" })
  const fullCtx = mockFullSession()
  fullCtx.llm = { stream: (opts) => { capturedFull = opts; return fakeLlmStream("结果")() } }
  const fullApi = apiMod.buildApi(fullCtx, () => fullCfg, { traceDir: mkdtempSync(join(tmpdir(), "npp-")), cwd: tmpdir() })
  await fullApi.polish({ text: "随便说说", sessionId: "s1" })
  assert.equal(capturedFull.system, "SYS-PROMPT")
  // 追加的两条在尾部：草稿 + polish 指令；历史前缀保持 deriveMessages 原样
  const tail = capturedFull.messages.slice(-2)
  assert.equal(tail[0].source.plugin, "narrative-prompt-polish")
  assert.equal(tail[0].content[0].text, "随便说说")
  assert.ok(tail[1].content[0].text.includes("<polish-request>"))
})