/**
 * trace-recorder.js — 全链路 trace 持久化（设计文档 TraceRecorder 节）。
 * 追加 JSONL 到 traceDir/YYYY-MM-DD.jsonl（相对进程 cwd，对齐 lore 约定）；
 * 写失败绝不阻塞 polish 主流程。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { join, dirname, isAbsolute, resolve } from "node:path"
import { createHash } from "node:crypto"

/** 当天本地日期 YYYY-MM-DD。 */
function todayTag() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
}

/**
 * 解析 trace 目录：绝对路径直用；相对路径相对进程 cwd。
 * @param {string} traceDir @param {string} cwd
 */
export function resolveTraceDir(traceDir, cwd) {
  return isAbsolute(traceDir) ? traceDir : resolve(cwd, traceDir)
}

/**
 * sha256 前 16 位（trace 存 hash 不存全文，避免敏感上下文落盘扩散）。
 * @param {string} value
 */
export function shortHash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : String(value)).digest("hex").slice(0, 16)
}

/**
 * 追加一条 trace。返回写入路径；失败返回 null（warn 后吞掉）。
 * @param {Record<string, unknown>} trace
 * @param {{ traceDir: string, cwd: string }} opts
 */
export function recordTrace(trace, opts) {
  try {
    const dir = resolveTraceDir(opts.traceDir, opts.cwd)
    const file = join(dir, todayTag() + ".jsonl")
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(trace) + "\n", "utf8")
    return file
  } catch (e) {
    console.warn("[narrative-prompt-polish] trace write failed:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * 读最近 N 条 trace（今天优先，最多回看 7 天）。
 * @param {{ traceDir: string, cwd: string }} opts
 * @param {number} limit
 */
export function recentTraces(opts, limit) {
  const dir = resolveTraceDir(opts.traceDir, opts.cwd)
  const collected = []
  for (let back = 0; back < 7 && collected.length < limit; back++) {
    const d = new Date(Date.now() - back * 86400000)
    const p = (n) => String(n).padStart(2, "0")
    const tag = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
    const file = join(dir, tag + ".jsonl")
    if (!existsSync(file)) continue
    try {
      const dayLines = readFileSync(file, "utf8").split("\n").filter(Boolean)
      collected.unshift(...dayLines.slice(-limit))
    } catch { /* 单日读失败跳过 */ }
  }
  const parsed = []
  for (const line of collected.slice(-limit)) {
    try {
      parsed.push(JSON.parse(line))
    } catch { /* 坏行跳过 */ }
  }
  // 新的在前。
  return parsed.reverse()
}