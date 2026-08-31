/**
 * surface-fold.js — readSurface 事件的过滤折叠（纯函数）。
 * 只保留人类 user/message 与 assistant/message 文本；跳过 plugin/skill-catalog 来源
 * 与 tool/result 派生噪音。
 */

/** @typedef {{ role: "user" | "assistant", text: string }} SurfaceSegment */

/**
 * 提取单个 surface 事件的语义文本（非文本返回空串）。
 * @param {{ type: string, data: Record<string, unknown> }} event
 */
export function textOfEvent(event) {
  switch (event.type) {
    case "user/message": {
      const data = /** @type {any} */ (event.data)
      const kind = data.source && data.source.kind
      // 非人类 user/message：运行时快照与代理通知（plugin）、技能目录（skill-catalog）跳过。
      if (kind !== undefined && kind !== "user") return ""
      return textOfBlocks(data.content)
    }
    case "assistant/message": {
      const data = /** @type {any} */ (event.data)
      return textOfBlocks(data.message && data.message.content)
    }
    default:
      return ""
  }
}

/** @param {unknown} blocks */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ""
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue
    const record = /** @type {any} */ (block)
    if (record.type === "text" && typeof record.text === "string" && record.text !== "") parts.push(record.text)
  }
  return parts.join("\n")
}

/**
 * 折叠 surface 为按序 user/assistant 段（新在后）。
 * @param {Array<{ type: string, data: Record<string, unknown> }>} events
 * @returns {SurfaceSegment[]}
 */
export function extractSegments(events) {
  const segments = []
  for (const event of events) {
    const text = textOfEvent(event)
    if (text !== "") {
      segments.push({ role: event.type === "user/message" ? "user" : "assistant", text })
    }
  }
  return segments
}

/**
 * 切分较早背景与逐字近期窗口。
 * @param {readonly SurfaceSegment[]} segments @param {number} recentCount
 */
export function splitRecent(segments, recentCount) {
  const count = Math.max(0, recentCount)
  const recent = segments.slice(Math.max(0, segments.length - count))
  const earlier = segments.slice(0, Math.max(0, segments.length - count))
  return { earlier, recent }
}

/**
 * 渲染段为角色标注文本（每段截断）。
 * @param {readonly SurfaceSegment[]} segments @param {number} maxPerSegment
 */
export function formatSegments(segments, maxPerSegment) {
  return segments
    .map(s => (s.role === "user" ? "用户：" : "助手：") + bound(s.text, maxPerSegment))
    .join("\n\n")
}

/**
 * 组合最终上下文块（背景 + 近期对话，均可缺席）。
 * @param {string} background @param {string} recent
 */
export function composeContext(background, recent) {
  const parts = []
  if (background.trim() !== "") parts.push("【背景】\n" + background)
  if (recent.trim() !== "") parts.push("【近期对话】\n" + recent)
  return parts.join("\n\n")
}

/** @param {string} input @param {number} max */
function bound(input, max) {
  return input.length <= max ? input : input.slice(0, max) + "…"
}