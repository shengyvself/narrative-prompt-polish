/**
 * wire.js — JSON 信封与 HTTP 小工具。
 * 信封统一为 { ok: true, value } | { ok: false, error: { code, message } }。
 */

/** 一个带稳定业务码的结构化 API 失败。 */
export class PolishError extends Error {
  /**
   * @param {string} code 稳定机器码
   * @param {string} message 可呈现文案
   * @param {number} [status] HTTP 状态码
   * @param {string} [reason] rejected 细分原因（empty | too-large | references）
   */
  constructor(code, message, status = 400, reason) {
    super(message)
    this.code = code
    this.status = status
    this.reason = reason
  }
}

/**
 * 读取并解析 JSON 请求体（空体返回 {}; 坏 JSON 抛 bad-json）。带 2MB 上限防滥用。
 * @param {import("node:http").IncomingMessage} req
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new PolishError('bad-request', 'request body too large', 413)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new PolishError('bad-json', 'request body is not valid JSON', 400)
  }
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
export function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

/** @param {import("node:http").ServerResponse} res @param {unknown} value */
export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** @param {import("node:http").ServerResponse} res @param {unknown} error */
export function writeError(res, error) {
  const e = error instanceof PolishError
    ? error
    : new PolishError('internal', error instanceof Error ? error.message : String(error), 500)
  writeJson(res, e.status, { ok: false, error: { code: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}) } })
}

/**
 * 从 payload 取非空字符串字段，否则抛 bad-request。
 * @param {unknown} payload @param {string} key
 */
export function requireString(payload, key) {
  const value = /** @type {Record<string, unknown> | null} */ (payload)?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PolishError("bad-request", `"${key}" must be a non-empty string`)
  }
  return value
}

/**
 * 读一个可选字符串字段（缺失/类型不对返回 ''）。
 * @param {unknown} payload @param {string} key
 */
export function optionalString(payload, key) {
  const value = /** @type {Record<string, unknown> | null} */ (payload)?.[key]
  return typeof value === 'string' ? value : ''
}