/**
 * polish.js — 流组装与输出清洗（Max-Null assembleText + LCQ stripWrapper 合体）。
 * 全部纯函数，node --test 直测，不需要 cordis 运行时。
 */

/**
 * 累积一个 llm.stream 的 text-delta 直到 finish，报告成败。
 * @param {AsyncIterable<any>} chunks ctx.llm.stream 的块迭代器
 * @returns {Promise<{ text: string, failed: boolean, finishKind: string | null, usage: any }>} 
 */
export async function assembleText(chunks) {
  let text = ''
  let failed = false
  /** @type {string | null} */
  let finishKind = null
  /** @type {any} */
  let usage = null
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      finishKind = String(chunk.reason?.kind ?? "")
      if (finishKind === "error" || finishKind === "aborted") failed = true
    }
  }
  return { text, failed, finishKind, usage }
}

/**
 * 去 ``` 围栏与「优化后的提示词：」类前缀（LCQ stripWrapper）。
 * @param {string} text
 */
export function stripWrapper(text) {
  let out = String(text || "").trim()
  const fenced = out.match(/^```[a-zA-Z]*[\s\S]*?```$/)
  if (fenced) {
    out = out.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim()
  }
  out = out.replace(/^(?:润色(?:后)?(?:的)?(?:(?:提示)?词|文本|消息|草稿)[:：]\s*)+/i, "")
  out = out.replace(/^(?:优化(?:后)?(?:的)?(?:提示词|提示|prompt)[:：]\s*)+/i, "")
  return out.trim()
}

/**
 * 从 usage 对象尽力提取 token 计数与缓存命中信息（DeepSeek prompt_cache_hit_tokens 兼容）。
 * @param {any} usage
 * @returns {{ inputTokens: number | null, outputTokens: number | null, cacheHitTokens: number | null }}
 */
export function extractUsage(usage) {
  if (usage === null || typeof usage !== "object") return { inputTokens: null, outputTokens: null, cacheHitTokens: null }
  const u = /** @type {Record<string, unknown>} */ (usage)
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  return {
    inputTokens: num(u.inputTokens) ?? num(u.input_tokens) ?? num(u.prompt_tokens),
    outputTokens: num(u.outputTokens) ?? num(u.output_tokens) ?? num(u.completion_tokens),
    cacheHitTokens: num(u.prompt_cache_hit_tokens) ?? num(u.cacheReadInputTokens) ?? num(u.cache_read_input_tokens),
  }
}

/**
 * partial 模式的 user message 组装：上下文块在前（明确标注仅背景），草稿殿后
 * （draft-last attention，Max-Null buildPolishPrompt 血统）。
 * @param {string} context composeContext 的产物（"" 表示无上下文）
 * @param {string} draft 已裁剪的草稿
 */
export function buildPartialUserPrompt(context, draft) {
  const parts = []
  if (context.trim() !== '') {
    parts.push(
      '下面是当前会话的部分上下文，仅作背景理解，帮助你明白草稿在讨论什么；',
      '不要引用上下文里的内容到润色结果中，不要复述它。',
      '',
      context.trim(),
    )
  }
  parts.push('待润色草稿：', draft)
  return parts.join('\n')
}