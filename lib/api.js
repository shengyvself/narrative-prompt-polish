/**
 * api.js — API 方法表（polish / config / config.get / config.update / traces.recent）。
 * polish 主流程：校验（rejected 族）→ 意图分类（4 类骨架）→ 上下文探测链
 * （C 方案 full → partial → none）→ llm.stream 直调（不挂会话调度）→ 清洗 → trace。
 */
import { PolishError, optionalString } from "./wire.js"
import { classifyIntent, INTENT_SYSTEM_PROMPTS, SINGLE_SYSTEM_PROMPT, polishInstruction } from "./intent.js"
import { assembleContext } from "./context-assembler.js"
import { buildPartialUserPrompt, assembleText, stripWrapper, extractUsage } from "./polish.js"
import { recordTrace, shortHash, recentTraces } from "./trace-recorder.js"
import { buildPolishTaskbook } from "./taskbook.js"

/** composer 引用占位符（一个 U+FFFC；含引用 chip 的草稿拒绝润色）。 */
export const CHIP_PLACEHOLDER = "\uFFFC"

/** 为手拼消息生成唯一 id。 */
function randomId() {
  const c = /** @type {any} */ (globalThis).crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  return "npp-" + Date.now() + "-" + Math.random().toString(36).slice(2)
}

/** 构造一条 plugin 来源的 user 消息。 @param {string} text */
export function userMessage(text) {
  return {
    id: randomId(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "narrative-prompt-polish" },
  }
}

/**
 * 构建 API 方法表。
 * @param {{ sessions?: any, sessionQuery?: any, llm?: any }} ctx cordis 切片
 * @param {() => any} getConfig 生效配置读取器
 * @param {{ traceDir: string, cwd: string }} traceOpts
 * @param {(patch: Record<string, unknown>) => Promise<void>} [persistConfig] settings 缺位时缺省
 */
export function buildApi(ctx, getConfig, traceOpts, persistConfig) {
  return {
    config: () => getConfig(),
    "config.get": () => ({ value: getConfig(), revision: undefined }),
    "config.update": async (payload) => {
      const record = /** @type {any} */ (payload)
      const patch = record && record.patch
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new PolishError("bad-request", "patch must be a plain object")
      }
      if (!persistConfig) {
        throw new PolishError("settings-unavailable", "settings 服务未挂载，配置仅可通过 cordis.patch.yml 静态段调整", 503)
      }
      await persistConfig(/** @type {Record<string, unknown>} */ (patch))
      return { value: getConfig(), revision: undefined }
    },
    "traces.recent": (payload) => {
      const q = /** @type {any} */ (payload) || {}
      const limit = typeof q.limit === "number" && Number.isFinite(q.limit) ? Math.min(Math.max(1, q.limit | 0), 100) : 20
      return { value: recentTraces(traceOpts, limit) }
    },
    "apply-report": (payload) => {
      // 浏览器端 CAS 完成 (applied=true/false) 后回传, 按 traceTs 关联原 dispatch 行,
      // 以 {type:"apply-report"} 追加到同文件(JSONL append-only, 回放时按 ts 配对).
      const r = /** @type {any} */ (payload) || {}
      const traceTs = typeof r.traceTs === "string" ? r.traceTs : ""
      if (!traceTs) throw new PolishError("bad-request", "traceTs is required", 400)
      const applied = r.applied === true
      const reason = typeof r.reason === "string" ? r.reason : (applied ? "applied" : "not-applied")
      const triggerSource = typeof r.triggerSource === "string" ? r.triggerSource : "unknown"
      recordTrace({
        ts: new Date().toISOString(),
        type: "apply-report",
        traceTs: traceTs,
        applied: applied,
        reason: reason,
        triggerSource: triggerSource,
        sessionId: r.sessionId || null,
        error: null,
      }, traceOpts)
      return { value: { accepted: true } }
    },
    polish: (payload) => polishOnce(ctx, getConfig, traceOpts, payload),
    // 主路径（0.1.5 迭代）：起 continuable 子代理做多轮打磨；失败显式抛错、不降级到单次 polish。
    "polish.start": (payload) => startPolishSubagent(ctx, getConfig, traceOpts, payload),
  }
}

/** polish 单次调用全流程。 */
async function polishOnce(ctx, getConfig, traceOpts, payload) {
  const t0 = Date.now()
  const config = getConfig()
  const record = /** @type {any} */ (payload) || {}
  const sessionId = typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : undefined
  const triggerSource = optionalString(payload, "triggerSource") || "main"
  /** @type {"full"|"partial"|"none"|undefined} */
  const modeReq = ["full", "partial", "none"].includes(record.mode) ? record.mode : undefined
  const strictFull = record.strictFull === true
  const mergeSidebar = record.mergeSidebarContext === true || (config.mergeSidebarContextByDefault && record.mergeSidebarContext !== false)
  const sidebarText = typeof record.sidebarContext === "string" ? record.sidebarContext : null

  // ── 前置校验（rejected 细分；polish.start 共用同一实现）──
  const draft = validateDraft(config, record.text)
  const intent = config.intentEnabled ? classifyIntent(draft) : "chat"

  // ── 上下文探测链 ──
  let assembled
  try {
    assembled = await assembleContext(ctx, config, sessionId, { mode: modeReq })
  } catch (e) {
    throw new PolishError("context-fallback", "上下文组装失败：" + (e instanceof Error ? e.message : String(e)), 500)
  }
  if (strictFull && assembled.mode !== "full") {
    throw new PolishError("no-session", "请求 full 模式但会话历史不可得：" + assembled.fallbacks.join(","), 409)
  }

  // ── 模型路由解析：显式 > 会话 header 继承（full）> 客户端传入 > 配置默认 ──
  let provider = config.provider || assembled.provider || optionalString(payload, "provider")
  let model = config.model || assembled.model || optionalString(payload, "model")
  // 最后兜底：DSH 全局 agentDefaultModel 服务——开箱即用。
  let admDebug = ""
  if (provider === "" && ctx.get && typeof ctx.get === "function") {
    try {
      const adm = ctx.get("agentDefaultModel")
      if (!adm) throw new Error("service absent")
      const sel = typeof adm.currentSelection === "function" ? adm.currentSelection() : undefined
      if (sel && sel.provider) {
        provider = sel.provider
        if (!model && sel.model) model = sel.model
      } else {
        admDebug = "selection=" + String(JSON.stringify(sel)).slice(0, 100)
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      admDebug = "fallback-failed:" + (m.length > 100 ? m.slice(0, 97) + "..." : m)
    }
  }
  if (provider === "") {
    const trace = assembled.fallbacks.length ? "；探测痕迹：" + assembled.fallbacks.join(",") : ""
    const admNote = admDebug ? "；默认模型兜底：" + admDebug : ""
    throw new PolishError("route-unavailable", "无法解析模型渠道（provider 为空）：会话无 header 且未配置默认渠道" + trace + admNote, 409)
  }
  if (model === "") throw new PolishError("route-unavailable", "无法解析模型 id（model 为空）", 409)

  // ── messages 组装 ──
  /** @type {any[]} */
  const messages = []
  /** @type {string | undefined} */
  let system
  if (assembled.mode === "full") {
    // C 方案：完整复刻 [system] + [...history]，前缀与主会话一致以命中 prompt cache；
    // 意图结构折进最后一条 user 指令（不动 system 前缀）。
    for (const m of assembled.messages) messages.push(m)
    messages.push(userMessage(draft))
    if (config.draftPosition === "last" || true) {
      // draft-last attention：草稿在指令之前、两者都在末尾（最强注意力区）。
      messages.push(userMessage(polishInstruction(intent)))
    }
    system = assembled.system
  } else {
    // partial / none：意图骨架作为 system，草稿在 user 尾部。
    system = config.intentEnabled ? INTENT_SYSTEM_PROMPTS[intent] : SINGLE_SYSTEM_PROMPT
    messages.push(userMessage(buildPartialUserPrompt(assembled.contextBlock || "", draft)))
  }

  // ── 联动：sidebar 上下文合并（失败不影响主流程）──
  if (mergeSidebar && sidebarText && sidebarText.trim() !== "") {
    const clipped = sidebarText.length > 1600 ? sidebarText.slice(0, 1600) + "…" : sidebarText
    messages.splice(Math.max(0, messages.length - 2), 0, userMessage("<sidebar-context>\n" + clipped + "\n</sidebar-context>"))
  }

  // ── llm.stream 直调（绝不传 sessionId——不写主会话历史、不进会话调度）──
  if (!ctx.llm || typeof ctx.llm.stream !== "function") {
    throw new PolishError("stream-failed", "llm 服务不可用", 503)
  }
  // ── 采样参数：samplingSource=session 且 full 模式拿到 header 时随会话继承，否则用插件配置 ──
  const hs = (config.samplingSource === "session" && assembled.mode === "full" && assembled.sampling) || null
  const options = {
    provider,
    model,
    messages,
    ...(system ? { system } : {}),
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(hs && hs.reasoningEffort ? { reasoningEffort: hs.reasoningEffort } : {}),
    ...(hs && typeof hs.temperature === "number" ? { temperature: hs.temperature } : {}),
    signal: AbortSignal.timeout(config.timeoutMs),
  }
  /** @type {{ text: string, failed: boolean, finishKind: string | null, usage: any }} */
  let assembledTextResult
  try {
    assembledTextResult = await assembleText(/** @type {any} */ (ctx.llm.stream(options)))
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
    traceWrite(traceOpts, { error: aborted ? "timeout/aborted" : "stream-exception", detail: e instanceof Error ? e.message : String(e) })
    throw new PolishError(aborted ? "rejected" : "stream-failed", aborted ? "润色超时或被取消" : "LLM 流式调用失败：" + (e instanceof Error ? e.message : String(e)), aborted ? 408 : 502)
  }
  if (assembledTextResult.failed) throw new PolishError("stream-failed", "润色请求失败或被中止（finish=" + (assembledTextResult.finishKind || "?") + "）", 502)
  const polished = stripWrapper(assembledTextResult.text)
  if (polished === "") throw new PolishError("empty-result", "润色失败：模型未返回内容", 502)

  const usage = extractUsage(assembledTextResult.usage)
  const cacheHit = usage.cacheHitTokens !== null && usage.cacheHitTokens > 0
  // ── dispatch ts 同时落 result.traceTs 与 trace 行 ts, 客户端 apply-report 按 ts 关联 ──
  const dispatchTs = new Date().toISOString()
  const result = {
    ok: true,
    text: polished,
    intent,
    contextMode: assembled.mode,
    historyCount: assembled.historyCount,
    degraded: assembled.fallbacks.length > 0,
    fallbackReasons: assembled.fallbacks,
    cacheHit,
    usage,
    traceTs: dispatchTs,
  }

  // ── trace（applied 由客户端 CAS 后经 apply-report 回补，这里先记 dispatch 结果）──
  recordTrace({
    ts: dispatchTs,
    sessionId: sessionId ?? null,
    triggerSource,
    intent,
    draftLength: draft.length,
    draftHash: shortHash(draft),
    contextMode: assembled.mode,
    historyCount: assembled.historyCount,
    fallbacks: assembled.fallbacks,
    sidebarContextMerged: mergeSidebar && !!sidebarText,
    systemPromptHash: assembled.system ? shortHash(assembled.system) : null,
    systemSource: assembled.system ? "session-header" : "intent-skeleton",
    // 指纹只覆盖尾部 8 条（大数组全量 stringify 本身是二次内存放大）。
    messagesHash: shortHash(JSON.stringify(messages.slice(-8).map(m => (m.content && m.content[0] && m.content[0].text) || ""))),
    model,
    provider,
    cacheHit,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: Date.now() - t0,
    resultLength: polished.length,
    applied: null,
    error: null,
  }, traceOpts)
  return result
}

/**
 * 草稿前置校验（rejected 细分）——`polish` 与 `polish.start` 共用。
 * @param {any} config 生效配置
 * @param {unknown} rawText 请求里的 text 字段
 * @returns {string} 通过校验的草稿
 */
function validateDraft(config, rawText) {
  if (typeof rawText !== "string") throw new PolishError("bad-request", '"text" must be a string')
  if (rawText.trim() === "") throw new PolishError("rejected", "草稿没有可见字符", 400, "empty")
  if (rawText.includes(CHIP_PLACEHOLDER)) throw new PolishError("rejected", "含引用 chip 的草稿暂不支持润色", 400, "references")
  if (rawText.length > config.maxInputChars) {
    throw new PolishError("rejected", "草稿 " + rawText.length + " 字符超过 maxInputChars " + config.maxInputChars, 400, "too-large")
  }
  return rawText
}

/**
 * polish.start —— 主路径（0.1.5 迭代，替代 better-sidebar sidechat）：
 * 在主会话下起一个**可对话的子代理**（continuable subagent，provider 默认 fork＝seed 主会话
 * 已完成轮、继承父 Agent 的 provider/model/预设），首轮投递「任务书 + 草稿」；客户端随后用
 * ctx.sessions.openSubagent 打开该子会话做多轮打磨。
 *
 * 红线 9：本路径失败**显式抛错**（子代理不可用/主会话无 live agent/启动异常），绝不静默降级
 * 到 /api/polish 单次直改。
 * @param {any} ctx cordis 切片（需 agents / subagents）
 * @param {() => any} getConfig
 * @param {{ traceDir: string, cwd: string }} traceOpts
 * @param {any} payload { sessionId, text, triggerSource?, provider? }
 */
async function startPolishSubagent(ctx, getConfig, traceOpts, payload) {
  const t0 = Date.now()
  const config = getConfig()
  const record = /** @type {any} */ (payload) || {}
  const draft = validateDraft(config, record.text)
  const sessionId = typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : ""
  if (sessionId === "") throw new PolishError("bad-request", '"sessionId" is required for polish.start')
  const triggerSource = optionalString(payload, "triggerSource") || "main"
  const providerName = typeof record.provider === "string" && record.provider !== "" ? record.provider : config.subagentProvider

  if (!ctx.agents || typeof ctx.agents.get !== "function") {
    throw new PolishError("subagent-unavailable", "agents 服务不可用（ctx.agents.get 缺失）", 503)
  }
  const parent = ctx.agents.get(sessionId)
  if (!parent) {
    throw new PolishError("no-live-agent", "主会话没有 live agent（" + sessionId + "）——请在会话内重试", 409)
  }
  if (!ctx.subagents || typeof ctx.subagents.startContinuable !== "function") {
    throw new PolishError("subagent-unavailable", "subagents 服务不可用（ctx.subagents.startContinuable 缺失）", 503)
  }
  if (typeof ctx.subagents.getProvider === "function" && !ctx.subagents.getProvider(providerName)) {
    throw new PolishError("subagent-unavailable", 'subagent provider "' + providerName + '" 未注册', 503)
  }

  const built = buildPolishTaskbook(draft, config.intentEnabled)
  const label = "✨ 提示词打磨：" + draft.slice(0, 24).replace(/\s+/g, " ").trim()
  let started
  try {
    started = await ctx.subagents.startContinuable({
      provider: providerName,
      label: label,
      request: { prompt: [{ type: "text", text: built.text }], parent: parent },
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (e) {
    throw new PolishError("subagent-failed", "子代理启动失败：" + (e instanceof Error ? e.message : String(e)), 502)
  }
  const childId = started && started.childId
  if (typeof childId !== "string" || childId === "") {
    throw new PolishError("subagent-failed", "子代理启动失败：未返回 childId", 502)
  }

  const dispatchTs = new Date().toISOString()
  recordTrace({
    ts: dispatchTs,
    type: "subagent-start",
    sessionId: sessionId,
    childId: childId,
    messageId: (started && started.messageId) || null,
    triggerSource: triggerSource,
    intent: built.intent,
    subagentProvider: providerName,
    draftLength: draft.length,
    draftHash: shortHash(draft),
    taskbookHash: shortHash(built.text),
    durationMs: Date.now() - t0,
    error: null,
  }, traceOpts)

  return {
    ok: true,
    childId: childId,
    messageId: (started && started.messageId) || null,
    intent: built.intent,
    subagentProvider: providerName,
    label: label,
    traceTs: dispatchTs,
  }
}

/** 失败路径也留痕（尽力而为）。 */
function traceWrite(traceOpts, extra) {
  try {
    recordTrace({ ts: new Date().toISOString(), ...extra }, traceOpts)
  } catch { /* 忽略 */ }
}