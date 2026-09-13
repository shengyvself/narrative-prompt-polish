/**
 * config.js — 插件配置（设计文档 §Config schema 的 JS 落地）。
 * 双层来源：cordis.patch.yml 的 config 段为静态基座；settings 服务注册为可选增强
 * （缺位时静默回退基座——防御式模式）。所有运行时读取走 effectiveConfig()。
 */

/** settings 命名空间 id（与插件 id 唯一化对齐）。 */
export const SETTINGS_NS = 'narrative-prompt-polish'

/** HTTP 路由前缀。 */
export const ROUTE_PREFIX = '/narrative-prompt-polish/api'

/** 默认配置（对齐设计文档 §API 设计 Config schema）。 */
export const DEFAULTS = {
  // ── 上下文策略 ──
  contextMode: 'full',        // full=C 方案复刻会话 | partial=readSurface | none=只发草稿
  intentEnabled: true,        // 4 类意图骨架开关
  draftPosition: 'last',      // last=草稿在消息末尾（attention 最强位）| system=意图指令进 system

  // ── 主路径：可对话子代理（0.2.0 取代 better-sidebar sidechat）──
  // fork＝子代理 seed 主会话已完成轮并继承父 Agent（provider/model/预设）——默认；
  // spawn＝全新子代理（不继承会话上下文）。
  subagentProvider: 'fork',

  // ── 联动配置 ──
  // 0.2.0：悬浮按钮层已随 better-sidebar 一并移除（该服务在 0.1.5 本部署不存在）；
  // 键保留仅为兼容已存储的设置文档（settings.yaml 中已有该键），不再有任何行为。
  sidebarFloatingButtonEnabled: false,
  mergeSidebarContextByDefault: false,
  sidebarTriggerSources: ['sidebar:qa', 'sidebar:terminal', 'sidebar:file-viewer', 'sidebar:text-editor', 'sidebar:auto'],
  // 注：sidebarTriggerSources 与 mergeSidebarContextByDefault 仍由 CustomEvent 总线路径使用。

  // ── 模型 ──
  provider: '',               // 空 = 继承会话（requestHeader().config 或客户端 resolveModel）
  model: '',                  // 空 = 同上；再退 DEFAULT_MODEL
  samplingSource: 'session',  // session=采样参数（reasoningEffort/temperature）随会话 header 继承 | plugin=固定用下方配置
  reasoningEffort: 'off',
  maxOutputTokens: 1024,
  temperature: 0.3,

  // ── 限制 ──
  timeoutMs: 30000,
  maxInputChars: 8000,
  recentWindowMessages: 4,    // partial 模式逐字保留的最近条数
  perSegmentMaxChars: 400,    // partial 模式每段截断
  maxFullHistoryEvents: 4000, // full 模式事件数硬上限（Session.seq 预检；超出降 none，防超大日志 OOM）
  offlineFullEnabled: false,  // 非 live（persisted）会话是否允许离线全量读取（readSession 对超大日志有 OOM 风险，默认关）

  // ── 可观测 ──
  traceEnabled: true,
  traceDir: 'lore/traces/prompt-polish', // 相对进程 cwd；lore 约定对齐 writing 插件 lore/profiles
}

/**
 * 防御式合并：未知来源（patch config / settings）缺字段或类型不对时落默认值。
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function effectiveConfig(raw) {
  const src = (raw !== null && typeof raw === "object") ? /** @type {Record<string, unknown>} */ (raw) : {}
  /** @type {Record<string, unknown>} */
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const v = src[key]
    if (v === undefined || v === null) continue
    const d = DEFAULTS[key]
    if (typeof d === "string") { if (typeof v === "string") out[key] = v }
    else if (typeof d === "number") { if (typeof v === "number" && Number.isFinite(v)) out[key] = v }
    else if (typeof d === "boolean") { if (typeof v === "boolean") out[key] = v }
    else if (Array.isArray(d)) { if (Array.isArray(v)) out[key] = v.filter(x => typeof x === "string") }
  }
  return /** @type {typeof DEFAULTS} */ (out)
}