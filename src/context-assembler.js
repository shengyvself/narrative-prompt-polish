/**
 * context-assembler.js — 上下文组装（设计文档 ContextAssembler 与决策4 降级链）。
 *
 * full（C 方案，已实测 DSH 暴露接口）：
 *   ctx.sessions.get(sessionId) 取 live Session；
 *   session.deriveMessages() 给完整派生 LLM 历史（deep-frozen Message 数组）；
 *   session.requestHeader() 给 EpochHeader（config.provider/model 与渲染后的 system）。
 *   非 live 兜底：sessionQuery.readSession(id) 读 raw log，离线 fold 重建 header/messages。
 * partial（Max-Null 风格 A 方案）：sessionQuery.readSurface 过滤折叠 user/assistant 段。
 * none：裸草稿。
 *
 * 红线：只读会话——绝不 append 事件、绝不把调用挂上会话调度（llm.stream 不传 sessionId）。
 */
import { extractSegments, splitRecent, formatSegments, composeContext } from "./surface-fold.js"

/** @typedef {"full" | "partial" | "none"} ContextMode */

/**
 * 从 raw log 事件离线重建 header 与 messages（非 live 会话的 full 兜底）。
 * @param {any} sessionModule dsh-session 运行时导出（foldRequestHeader / deriveEventMessage）
 * @param {any[]} events 有序 raw 事件
 */
export function foldOfflineHistory(sessionModule, events) {
  const header = typeof sessionModule && typeof sessionModule.foldRequestHeader === "function"
    ? sessionModule.foldRequestHeader(events)
    : undefined
  const messages = []
  if (sessionModule && typeof sessionModule.deriveEventMessage === "function") {
    for (const event of events) {
      const m = sessionModule.deriveEventMessage(event)
      if (m) messages.push(m)
    }
  }
  return { header, messages }
}

/** 动态加载 dsh-session 运行时模块（仅离线路径需要；失败继续降级）。 */
let sessionModulePromise = null
function loadSessionModule(fallbacks) {
  if (!sessionModulePromise) {
    sessionModulePromise = import("@deepseek-ai/dsh-session").catch((e) => {
      fallbacks.push("dsh-session-import-failed:" + shortMsg(e))
      return null
    })
  }
  return sessionModulePromise
}

/**
 * 探测链组装：full → partial → none 自动降级，任何失败不向上抛。
 * @param {{ sessions?: any, sessionQuery?: any, llm?: any }} ctx cordis 上下文切片
 * @param {any} config 生效配置
 * @param {string | undefined} sessionId
 * @param {{ mode?: ContextMode }} [opts]
 */
export async function assembleContext(ctx, config, sessionId, opts = {}) {
  const fallbacks = []
  const wanted = opts.mode || config.contextMode

  // ── full：live 会话优先（seq O(1) 预检在前——deriveMessages 全量投影不可逆地
  // 吃掉整进程堆，OOM 无法 catch；超大日志必须先挡在投影之前）──
  if (wanted === "full") {
    if (sessionId && ctx.sessions && typeof ctx.sessions.get === "function") {
      try {
        const session = ctx.sessions.get(sessionId)
        if (session) {
          const seq = typeof session.seq === "number" ? session.seq : -1
          if (seq > config.maxFullHistoryEvents) {
            fallbacks.push("skipped-full-seq-" + seq + ">" + config.maxFullHistoryEvents)
            return finishPartialOrNone(ctx, config, sessionId, wanted, fallbacks)
          }
          if (typeof session.deriveMessages === "function") {
            const history = session.deriveMessages() || []
            const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined
            return finishFull(history, header, fallbacks, config)
          }
          fallbacks.push("deriveMessages-missing")
        } else {
          fallbacks.push("not-live")
        }
      } catch (e) {
        fallbacks.push("live-read-failed:" + shortMsg(e))
      }
    } else if (!sessionId) {
      fallbacks.push("no-session-id")
    }

    // ── full：persisted 离线兜底（默认关——readSession 全量读取对超大持久化日志有 OOM 风险）──
    if (config.offlineFullEnabled && sessionId && ctx.sessionQuery && typeof ctx.sessionQuery.readSession === "function") {
      try {
        const snap = await ctx.sessionQuery.readSession(sessionId)
        const events = (snap && snap.events) || []
        const offline = foldOfflineHistory(await loadSessionModule(fallbacks), events)
        return finishFull(offline.messages, offline.header, fallbacks.concat(["offline-log"]), config)
      } catch (e) {
        fallbacks.push("readSession-failed:" + shortMsg(e))
      }
    } else if (sessionId && !config.offlineFullEnabled) {
      fallbacks.push("offline-full-disabled")
    }

    // full 彻底不可得 → 自动降级 partial（是否硬报错由 api.js 按 strictFull 决定）。
    fallbacks.push("degraded-full-to-partial")
  }

  // ── partial / none 收口（预检降档也汇入此处）──
  return finishPartialOrNone(ctx, config, sessionId, wanted, fallbacks)
}

/** partial（readSurface）与 none 的收口路径。 */
async function finishPartialOrNone(ctx, config, sessionId, wanted, fallbacks) {
  // readSurface 是带 payload 的全量观察：仅对「live 且规模受控」的会话执行；
  // persisted 会话直接走 none，避免超大日志把整进程拖崩。
  let liveOk = false
  if (sessionId && ctx.sessions && typeof ctx.sessions.get === "function") {
    try {
      const s = ctx.sessions.get(sessionId)
      liveOk = !!s && (typeof s.seq !== "number" || s.seq <= config.maxFullHistoryEvents * 4)
    } catch (e) { liveOk = false }
  }
  if ((wanted === "full" || wanted === "partial") && sessionId && liveOk
      && ctx.sessionQuery && typeof ctx.sessionQuery.readSurface === "function") {
    try {
      const surface = await ctx.sessionQuery.readSurface(sessionId)
      const segments = extractSegments(surface.events || [])
      const parts = splitRecent(segments, config.recentWindowMessages)
      const recentText = formatSegments(parts.recent, config.perSegmentMaxChars)
      const backgroundText = formatSegments(parts.earlier.slice(-12).reverse(), config.perSegmentMaxChars)
      const contextBlock = composeContext(backgroundText, recentText)
      return {
        mode: "partial",
        messages: [],
        historyCount: segments.length,
        system: undefined,
        provider: "",
        model: "",
        fallbacks: wanted === "full" ? fallbacks : [],
        contextBlock,
      }
    } catch (e) {
      fallbacks.push("readSurface-failed:" + shortMsg(e))
    }
  }

  // ── none ──
  if (wanted !== "none") fallbacks.push("degraded-to-none")
  return { mode: "none", messages: [], historyCount: 0, system: undefined, provider: "", model: "", fallbacks, contextBlock: "" }
}

void finishPartialOrNone

/**
 * full 收口：header 提取 system 与模型路由；超长历史按字符预算裁最老消息
 * （最近消息永远完整，前缀连续性保 cache 命中语义）。
 */
function finishFull(history, header, fallbacks, config) {
  const cfg = (header && header.config) || {}
  let messages = history
  const budget = Math.max(config.maxInputChars * 2, 16000)
  let total = messages.reduce((n, m) => n + messageChars(m), 0)
  while (messages.length > 2 && total > budget) {
    total -= messageChars(messages[0])
    messages = messages.slice(1)
    fallbacks.push("trimmed-oldest")
  }
  const sys = header && typeof header.system === "string" ? header.system : ""
  return {
    mode: "full",
    messages,
    historyCount: history.length,
    system: sys.trim() !== "" ? sys : undefined,
    provider: typeof cfg.provider === "string" ? cfg.provider : "",
    model: typeof cfg.model === "string" ? cfg.model : "",
    // 会话采样参数（samplingSource=session 时由 api.js 采用）。
    sampling: {
      reasoningEffort: typeof cfg.reasoningEffort === "string" ? cfg.reasoningEffort : undefined,
      temperature: typeof cfg.temperature === "number" ? cfg.temperature : undefined,
      maxTokens: typeof cfg.maxTokens === "number" ? cfg.maxTokens : undefined,
    },
    fallbacks,
  }
}

/** 一条派生消息的字符量估算。 @param {any} m */
function messageChars(m) {
  if (!m || typeof m !== "object") return 0
  const content = m.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") n += block.text.length
  }
  return n
}

/** @param {unknown} e */
function shortMsg(e) {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 120 ? m.slice(0, 117) + "..." : m
}