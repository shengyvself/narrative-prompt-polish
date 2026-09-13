/**
 * taskbook.js — 主路径「子代理打磨」的任务书文本。
 *
 * 0.1.5 迭代（2026-09-13）：主路径由 better-sidebar sidechat 改为原生 continuable subagent，
 * 任务书从客户端 bundle 移入服务端——单一真相、可单测，且与 `/api/polish` 共用同一份
 * 意图判定（classifyIntent）。
 */
import { classifyIntent } from "./intent.js"

/**
 * 构造润色任务书（子代理首轮 user 消息）。
 * @param {string} draft 作者草稿
 * @param {boolean} [intentEnabled] 是否附本地意图判定建议
 * @returns {{ text: string, intent: string }}
 */
export function buildPolishTaskbook(draft, intentEnabled = true) {
  const intent = intentEnabled ? classifyIntent(String(draft || "")) : "chat"
  const lines = [
    "【润色任务书】",
    "",
    "作者草稿：",
    draft || "（空）",
    "",
    "请按 polish 设计意图（4 类意图骨架 debug/implement/explain/chat + 共享重写规则）将上面草稿改写为可直接交给 AI 助手执行的高质量提示词。要求：保留事实、模糊→具体动作、缺背景标注待确认、拆编号子问题、长度匹配复杂度。完成后输出最终润色文本（不要解释过程）。",
  ]
  if (intentEnabled) lines.push("", "（本地意图判定：" + intent + "；如判定有误请按真实意图组织。）")
  return { text: lines.join("\n"), intent }
}
