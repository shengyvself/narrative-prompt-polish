/**
 * narrative-prompt-polish — host 半边入口。
 *
 * 5 层工程（Max-Null baseline）：
 *   1 trust fence   本文件（isTrustedApiRequest 围栏）
 *   2 surface 读取  context-assembler.js（readSurface partial；C 方案 deriveMessages/requestHeader full）
 *   3 过滤          surface-fold.js（人类消息白名单，tool/plugin/skill 噪音剔除）
 *   4 wire 信封     wire.js + api.js（{ok,value}|{ok:false,error} 统一信封与错误细分）
 *   5 失败降级      探测链 full→partial→none，任何失败不中断润色
 *
 * 为什么会话生成中也能用：ctx.llm 是独立于 agent-session 调度的能力，readSurface /
 * deriveMessages 是只读投影——既不阻塞也不被进行中的 turn 阻塞。
 *
 * 红线遵守：不写主会话历史（无 append、llm.stream 不传 sessionId）；
 * 服务端零 @deepseek-ai/* 静态 import（dsh-session 仅在离线路径动态 import 且失败降级）。
 */
import { DEFAULTS, ROUTE_PREFIX, SETTINGS_NS, effectiveConfig } from "./config.js"
import { isTrustedApiRequest } from "./trust-fence.js"
import { PolishError, readJsonBody, writeError, writeJson, writeOk } from "./wire.js"
import { buildApi } from "./api.js"

/** cordis.yml 行标识。 */
export const name = 'narrative-prompt-polish'

/** 挂载前置服务。sessions = C 方案 live 会话读取（deriveMessages/requestHeader）；agentDefaultModel = 渠道最终兜底；cordis fiber 守卫要求显式声明。 */
export const inject = ['webServer', 'sessionQuery', 'sessions', 'llm', 'loader', 'agentDefaultModel']

/** 从 loader 读连接行的 trustedHosts（/api 围栏同源列表）。 */
function trustedHostsOf(ctx) {
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name === "connection") {
        const config = entry.options.config
        return (config && config.trustedHosts) || []
      }
    }
  } catch { /* loader 形状漂移时按空表处理 */ }
  return []
}

/**
 * 插件体：围栏路由 + 配置面（settings 缺位时用 patch config 基座）。
 * @param {any} ctx @param {any} [patchConfig]
 */
export function apply(ctx, patchConfig) {
  /** @type {any} */
  let staticBase = effectiveConfig(patchConfig)
  /** @type {{ get(): any, update(patch: Record<string, unknown>): Promise<void> } | undefined} */
  let settingsFace

  // ── settings 可选增强（防御式注册，拒绝绝不拖垮插件）──
  // DSH settings 服务要求 schemastery schema（函数）；schemastery 动态加载失败时
  // 回退 cordis.patch.yml config 基座——零硬依赖。
  try {
    ctx.inject(["settings"], (sctx) => {
      const settingsService = sctx.settings
      if (!settingsService || typeof settingsService.register !== "function") return
      import("@deepseek-ai/schemastery").then((mod) => {
        const z = mod.default || mod
        let scope
        try {
          scope = settingsService.register(SETTINGS_NS, buildSettingsSchema(z))
        } catch (e) {
          console.warn("[narrative-prompt-polish] settings register failed; using patch config:", e instanceof Error ? e.message : e)
          return
        }
        settingsFace = {
          get: () => scope.get(),
          update: async (patch) => {
            if (typeof scope.update === "function") await scope.update(patch)
          },
        }
      }).catch((e) => {
        console.warn("[narrative-prompt-polish] schemastery unavailable; using patch config:", e instanceof Error ? e.message : e)
      })
    })
  } catch { /* 无 settings 服务：走静态基座 */ }

  const getConfig = () => {
    try {
      if (settingsFace) {
        // settings 层只取「用户显式改动」的字段（≠ schema 默认）——schema 默认值
        // 与 DEFAULTS 相同，若整层合并会反向覆盖 patch 段的显式配置（如绝对 traceDir）。
        const s = toPlain(settingsFace.get())
        /** @type {Record<string, unknown>} */
        const userTouched = {}
        for (const k of Object.keys(s)) {
          if (s[k] !== DEFAULTS[k]) userTouched[k] = s[k]
        }
        return effectiveConfig({ ...toPlain(staticBase), ...userTouched })
      }
    } catch { /* settings 读取失败回基座 */ }
    return staticBase
  }

  const persistConfig = async (patch) => {
    if (settingsFace) { await settingsFace.update(patch); return }
    // settings 缺位：更新内存态（重启回落 patch 基座）——api.js 已在上游拦截此路径。
    staticBase = effectiveConfig({ ...toPlain(staticBase), ...patch })
  }

  const traceOpts = () => ({ traceDir: getConfig().traceDir, cwd: process.cwd() })
  // buildApi 需要稳定的 traceOpts 对象形状——包一层惰性取值。
  const lazyTraceOpts = { get traceDir() { return getConfig().traceDir }, get cwd() { return process.cwd() } }
  void traceOpts
  const api = buildApi(ctx, getConfig, lazyTraceOpts, persistConfig)

  const fence = (req) => isTrustedApiRequest(req, trustedHostsOf(ctx))

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } })
        return
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } })
        return
      }
      const pathname = new URL(req.url || "/", "http://dsh.internal").pathname
      const prefixAt = pathname.indexOf(ROUTE_PREFIX + "/")
      const method = prefixAt >= 0 ? pathname.slice(prefixAt + ROUTE_PREFIX.length + 1) : undefined
      if (!method || method.includes("/")) {
        throwReply(res, new PolishError("not-found", "unknown prompt-polish API method", 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (!handler) throw new PolishError("not-found", "unknown prompt-polish API method \"" + method + "\"", 404)
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), "narrative-prompt-polish: api routes")
}

/** @param {any} res @param {PolishError} e */
function throwReply(res, e) {
  writeJson(res, e.status, { ok: false, error: { code: e.code, message: e.message } })
}

/** @param {unknown} v */
function toPlain(v) {
  return v !== null && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : {}
}

/**
 * settings 注册 schema（schemastery 构造；对齐 Max-Null DraftPolishPrefsSchema 形状，
 * 全部带 DEFAULTS 缺省值）。调用方已保证 z 可用。
 */
function buildSettingsSchema(z) {
  return z.object({
    contextMode: z.union(["full", "partial", "none"]).default(DEFAULTS.contextMode),
    intentEnabled: z.boolean().default(DEFAULTS.intentEnabled),
    draftPosition: z.union(["last", "system"]).default(DEFAULTS.draftPosition),
    sidebarFloatingButtonEnabled: z.boolean().default(DEFAULTS.sidebarFloatingButtonEnabled),
    mergeSidebarContextByDefault: z.boolean().default(DEFAULTS.mergeSidebarContextByDefault),
    sidebarTriggerSources: z.array(String).default(DEFAULTS.sidebarTriggerSources),
    provider: z.string().default(DEFAULTS.provider),
    model: z.string().default(DEFAULTS.model),
    reasoningEffort: z.union(["off", "high", "max"]).default(DEFAULTS.reasoningEffort),
    maxOutputTokens: z.number().step(1).min(64).max(32768).default(DEFAULTS.maxOutputTokens),
    temperature: z.number().step(0.05).min(0).max(1).default(DEFAULTS.temperature),
    timeoutMs: z.number().step(1000).min(5000).max(120000).default(DEFAULTS.timeoutMs),
    maxInputChars: z.number().step(100).min(500).max(200000).default(DEFAULTS.maxInputChars),
    recentWindowMessages: z.number().step(1).min(1).max(32).default(DEFAULTS.recentWindowMessages),
    perSegmentMaxChars: z.number().step(50).min(50).max(4000).default(DEFAULTS.perSegmentMaxChars),
    traceEnabled: z.boolean().default(DEFAULTS.traceEnabled),
    traceDir: z.string().default(DEFAULTS.traceDir),
  })
}

// 兜底导出（cordis loader 兼容 default import）。 
export default { name, inject, apply }