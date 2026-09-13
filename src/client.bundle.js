// narrative-prompt-polish — web 客户端半边（ModuleLoader 自包含 bundle）。
// 三组注册：
//   1. conversation.input.right → PolishButton（主框 ✨）
//   2. settings.section         → PolishSettings（配置表单）
//   3. 事件总线                 → CustomEvent trigger/result（外部模块联动，本层代跑单次 polish + CAS 回写）
// 主路径（0.2.0，2026-09-13）：点 ✨ → 服务端 POST /api/polish.start 在主会话下起「可对话子代理」
//   （continuable subagent，provider 默认 fork ⇒ seed 主会话已完成轮、继承父 Agent 的 provider/model/预设），
//   任务书 + 草稿投进子代理首轮；随后 ctx.sessions.openSubagent 打开它，用户在子代理会话里多轮打磨，
//   满意后复制回主输入框。
//   —— 取代 0.0.20 的 better-sidebar sidechat：better-sidebar 已从本部署架构移除（0.1.5 起右侧栏面板
//   一律走官方 keyed 槽位，better-sidebar 自身 disabled ⇒ 其服务永久缺位，旧 inject 会让 apply 永不执行）。
// 红线 9：子代理起不来时显式报错（toast），绝不静默降级到单次 polish。
// 约束：不野生注入 DSH 结构；联动松耦合（事件总线 narrative:prompt-polish:trigger / :result）。
window.__ModuleLoader__.load({
  id: "narrative-prompt-polish",
  factory: (require) => {
    var module = { exports: {} };
    var react = require("react");
    var createElement = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;
    var useCallback = react.useCallback;

    // ── 身份与常量（唯一化命名空间）───────────────────────────────
    var PLUGIN_ID = "narrative-prompt-polish";
    var NS = "narrativePromptPolish";
    var ROUTE = "/narrative-prompt-polish/api";
    var EVT_TRIGGER = "narrative:prompt-polish:trigger";
    var EVT_RESULT = "narrative:prompt-polish:result";
    var CHIP_PLACEHOLDER = "\uFFFC";

    // ── 客户端 API 封装 ───────────────────────────────────────────
    function PolishApiError(code, message) {
      this.code = code;
      this.message = message;
    }
    PolishApiError.prototype = Object.create(Error.prototype);

    async function callApi(method, payload, signal) {
      var response;
      try {
        response = await fetch(ROUTE + "/" + method, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
          signal: signal,
        });
      } catch (error) {
        throw new PolishApiError("network", error instanceof Error ? error.message : String(error));
      }
      var parsed = null;
      try { parsed = await response.json(); } catch (e) { parsed = null; }
      if (!response.ok || !parsed || parsed.ok !== true) {
        var err = parsed && parsed.error;
        throw new PolishApiError((err && err.code) || "http", (err && err.message) || ("HTTP " + response.status));
      }
      return parsed.value;
    }

    var api = {
      polish: (payload, signal) => callApi("polish", payload, signal),
      polishStart: (payload) => callApi("polish.start", payload),
      config: () => callApi("config", {}),
      configUpdate: (patch) => callApi("config.update", { patch: patch }),
      tracesRecent: (limit) => callApi("traces.recent", { limit: limit }),
      applyReport: (payload) => callApi("apply-report", payload || {}),
    };

    // ── 多语言（zh/en 按 document.lang）────────────
    var STRINGS = {
      zh: {
        buttonAria: "润色草稿", buttonTip: "AI 改写草稿（携带会话上下文与意图结构）",
        empty: "请先输入内容", chip: "含引用引用块的草稿暂不支持润色",
        changed: "草稿已变，未应用润色", done: (intent, mode) => "已改写（" + intent + " · " + mode + "）",
        subagentStarted: (id, intent) => "已起提示词打磨子代理（childId: " + id + "…" + (intent ? " · " + intent : "") + "）—— 在该子代理会话里多轮打磨后复制回主输入框",
        subagentFailed: "起子代理失败：",
        failed: "润色失败：",
        errRejectedEmpty: "草稿没有可见字符", errChipRef: "含引用 chip 的草稿暂不支持润色",
        errTooLarge: "草稿过长", errNoSession: "会话历史不可得（full 模式）",
        errRoute: "无法解析模型渠道，请在设置中指定 provider/model",
        errTimeout: "润色超时或被取消",
        settingsNav: "提示词优化",
      },
      en: {
        buttonAria: "Polish draft", buttonTip: "Rewrite draft with AI (session context + intent structure)",
        empty: "Type something first", chip: "Reference chips are not supported",
        changed: "Draft changed; polish not applied", done: (intent, mode) => "Polished (" + intent + " · " + mode + ")",
        subagentStarted: (id, intent) => "Polish subagent started (childId: " + id + "…" + (intent ? " · " + intent : "") + ") — refine it there, then paste back",
        subagentFailed: "Subagent failed: ",
        failed: "Polish failed: ",
        errRejectedEmpty: "Draft has no visible characters", errChipRef: "Reference chips not supported",
        errTooLarge: "Draft too large", errNoSession: "Session history unavailable (full mode)",
        errRoute: "Cannot resolve model route; set provider/model in settings",
        errTimeout: "Polish timed out or was cancelled",
        settingsNav: "Prompt Polish",
      },
    };
    function langStrings() {
      var lang = typeof document !== "undefined" ? (document.documentElement.lang || "zh").toLowerCase() : "zh";
      return STRINGS[lang.indexOf("zh") === 0 ? "zh" : "en"];
    }
    function errorText(t, error) {
      if (!error) return t.failed;
      switch (error.code) {
        case "rejected": return String(error.message || t.failed);
        case "no-session": return t.errNoSession;
        case "route-unavailable": return t.errRoute;
        case "empty-result": return t.failed + "模型未返回内容";
        case "settings-unavailable": return "配置服务未挂载";
        case "method-error": return t.failed + "请求方法不被允许（请刷新浏览器重试）";
        case "forbidden": return t.failed + "跨域拒绝（请在 DSH 窗口内使用）";
        case "bad-request": return String(error.message || t.failed);
        case "http":
          // 非 JSON 响应（通常是 web-server 框架层拦截, 路由 prefix 失配等）— 提示用户看 DevTools
          return t.failed + "网络异常 " + (error.message || error.code) + "（请打开 DevTools → Network 看红色请求的 URL）";
        case "network": return t.failed + "网络中断：" + (error.message || "");
        default: return t.failed + (error.message || error.code);
      }
    }

    // ── 样式（插件自有 <style>，幂等注入）───────────────────────
    var STYLE_ID = "@shengyv/narrative-prompt-polish/client.css";
    if (typeof document !== "undefined") {
      var existed = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
      if (existed) existed.remove();
      var styleTag = document.createElement("style");
      styleTag.dataset.plugin = PLUGIN_ID;
      styleTag.dataset.pluginCss = STYLE_ID;
      styleTag.textContent = [
        ".npp-wrap{position:relative;display:grid;place-items:center}",
        ".npp-btn{background:0 0;border:none;border-radius:999px;width:28px;height:28px;color:var(--dsw-alias-label-secondary,#8b8b9e);cursor:pointer;place-items:center;display:grid;flex:none;transition:background-color .15s,color .15s;padding:0}",
        ".npp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,140,.14));color:var(--dsw-alias-label-primary,#e8e8f0)}",
        ".npp-btn:disabled{opacity:.4;cursor:default}",
        ".npp-btn[data-loading=true]{opacity:1;cursor:progress;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4FC3F7) 16%,transparent);color:var(--dsw-alias-brand-primary,#4FC3F7)}",
        ".npp-toast{position:fixed;bottom:80px;left:50%;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(40,40,52,.96));color:var(--dsw-alias-label-primary,#e8e8f0);border-radius:8px;padding:6px 14px;font-size:13px;line-height:20px;pointer-events:none;z-index:99999;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis}",
        ".npp-toast span[data-error=true]{color:var(--dsw-alias-state-error-primary,#ff7a85)}",
        ".npp-settings{max-width:560px;display:flex;flex-direction:column;width:100%}",
        ".npp-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
        ".npp-field+.npp-field{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,140,.18))}",
        ".npp-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#e8e8f0)}",
        ".npp-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8b8b9e)}",
        ".npp-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,140,.18));border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(24,24,32,.6));font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#e8e8f0)}",
        ".npp-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4FC3F7)}",
        ".npp-switchrow{display:flex;align-items:center;justify-content:space-between;gap:10px}",
        ".npp-switch{width:40px;height:22px;flex:none;border:none;border-radius:11px;cursor:pointer;padding:0;background:var(--dsw-alias-border-l4,rgba(127,127,140,.35));transition:background .15s}",
        ".npp-switch.on{background:var(--dsw-alias-state-business-primary,#4FC3F7)}",
        ".npp-switch .knob{display:block;width:16px;height:16px;border-radius:8px;background:#fff;margin-left:2px;transition:margin-left .15s}",
        ".npp-switch.on .knob{margin-left:22px}",
        ".npp-actions{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,140,.18))}",
        ".npp-save{height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-button-primary-fill,#2f6df6);font:inherit;font-size:14px;color:#fff;cursor:pointer}",
        ".npp-save:disabled{opacity:.5;cursor:default}",
        ".npp-msg{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-success-primary,#59c98d)}",
        ".npp-msg[data-ok=false]{color:var(--dsw-alias-state-error-primary,#ff7a85)}",
      ].join("\n");
      document.head.appendChild(styleTag);
    }

    function IconSparkle(size) {
      return createElement("svg", { viewBox: "0 0 16 16", width: size || 15, height: size || 15, fill: "none", "aria-hidden": true },
        createElement("path", { d: "M8 1.2c.3 0 .56.18.67.46l1.5 3.9 3.9 1.5a.72.72 0 0 1 0 1.34l-3.9 1.5-1.5 3.9a.72.72 0 0 1-1.34 0l-1.5-3.9-3.9-1.5a.72.72 0 0 1 0-1.34l3.9-1.5 1.5-3.9A.72.72 0 0 1 8 1.2ZM12.5 9c.2 0 .37.12.44.31l.65 1.65 1.65.65a.48.48 0 0 1 0 .88l-1.65.65-.65 1.65a.48.48 0 0 1-.88 0l-.65-1.65-1.65-.65a.48.48 0 0 1 0-.88l1.65-.65.65-1.65A.48.48 0 0 1 12.5 9Z", fill: "currentColor" }));
    }

    // ══ startPolishSubagent（0.2.0 主入口）══════════════════════════════════════
    // 单击主框 ✨ → 服务端起 continuable 子代理（/api/polish.start）→ openSubagent 打开它。
    // 服务端负责：草稿校验、意图判定、任务书文本、taskbook trace、子代理启动（fork provider 会 seed
    // 主会话已完成轮并继承父 Agent 选项）。客户端负责：调用 → 等目录就绪 → 打开 → 报错/提示。
    function startPolishSubagent(ctx, draft, sessionId) {
      // 红线 9：任一前置条件缺失 = 任务失败，直接 reject（不兑底单次 polish）
      if (!ctx || !ctx.sessions) {
        return Promise.reject(new Error("sessions 服务不可用（ctx.sessions 缺失）—— 0.2.0 主路径需 sessions 服务注入"));
      }
      if (typeof ctx.sessions.openSubagent !== "function") {
        return Promise.reject(new Error("sessions.openSubagent 不可用 —— 本内核不支持打开子代理会话"));
      }
      if (!sessionId) return Promise.reject(new Error("startPolishSubagent: 主会话 sessionId 缺失"));
      if (String(draft || "").trim() === "") return Promise.reject(new Error("草稿为空"));
      return api.polishStart({ sessionId: sessionId, text: draft, triggerSource: "main" }).then(function (result) {
        var childId = result && result.childId;
        if (!childId) throw new Error("服务端未返回 childId");
        return ensureSubagentAddressable(ctx, sessionId, childId).then(function () {
          // 打开子代理会话（parentSessionId＝本次点击所在的主会话）：continuable 子代理输入框可写，可多轮对话。
          ctx.sessions.openSubagent({ parentSessionId: sessionId, childSessionId: childId, mode: "continuable" });
          try { if (typeof ctx.sessions.setSubagentCatalogOpen === "function") ctx.sessions.setSubagentCatalogOpen(sessionId, true); } catch (e) { /* 目录展开失败不影响会话打开 */ }
          return result;
        });
      });
    }

    // 子代理由服务端创建；客户端目录（sessions.subagentsByParent）需要一次刷新生效。
    // 有界等待，超时显式失败（不静默）：子代理已存在，只是客户端还没拿到地址。
    function ensureSubagentAddressable(ctx, parentSessionId, childId) {
      var attempts = 0;
      var refresh = function () {
        try { if (typeof ctx.sessions.refreshSubagents === "function") ctx.sessions.refreshSubagents(parentSessionId); } catch (e) { /* 刷新失败交由轮询重试 */ }
      };
      var ready = function () {
        try { return !!ctx.sessions.subagentAddress(childId); } catch (e) { return false; }
      };
      refresh();
      var tick = function () {
        if (ready()) return Promise.resolve(true);
        attempts += 1;
        if (attempts > 12) {
          return Promise.reject(new Error("子代理已创建（childId " + String(childId).slice(0, 8) + "…）但客户端目录未就绪——可在会话列表的「子代理」目录里手动打开"));
        }
        return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(function () { refresh(); return tick(); });
      };
      return tick();
    }

    // ══ PolishButton（主框 ✨；0.2.0 起调 startPolishSubagent 起可对话子代理）════════════════
    function PolishButton(props) {
      var t = langStrings();
      // 0.1.5 契约（2026-09-13 实机取证）：会话作用域标准 props 不再提供 `input`，
      // 改为 `useInput`（SnapshotSelectorHook<InputState>，InputState.draft＝编辑器文档的剪贴板投影）
      // 与 `inputActions`（setDraft/submit…）。旧写法 `props.input.draft` 恒为 undefined ⇒ 按钮恒禁用。
      var selectInput = props.useInput || function () { return undefined; };
      var inputState = selectInput(function (s) { return s; });
      var draft = inputState && typeof inputState.draft === "string"
        ? inputState.draft
        : (props.input && typeof props.input.draft === "string" ? props.input.draft : "");
      var inputActions = props.inputActions;
      var sessionId = props.sessionId;
      var startSubagent = props.startSubagent;
      var draftRef = useRef(draft);
      draftRef.current = draft;
      var aliveRef = useRef(true);
      var busyRef = useRef(false);
      var toastTimer = useRef(0);
      var loadingState = useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var toastState = useState(null);
      var toast = toastState[0];
      var setToast = toastState[1];
      useEffect(() => () => {
        aliveRef.current = false;
        window.clearTimeout(toastTimer.current);
      }, []);
      var showToast = useCallback((text, isError) => {
        setToast({ seq: Date.now(), text: text, error: !!isError });
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => { if (aliveRef.current) setToast(null); }, 2600);
      }, [setToast]);

      var handleClick = useCallback(() => {
        // 0.2.0（2026-09-13）：点 ✨ → 起「可对话子代理」打磨（继承主会话上下文 + provider/model/预设）
        // 红线 9：不兑底，子代理起不来直接 toast 报错（不回退单次 polish）
        if (busyRef.current) return;
        var captured = draftRef.current;
        if (String(captured).trim() === "") { showToast(t.empty, false); return; }
        if (typeof startSubagent !== "function") { showToast(t.subagentFailed + "sessions 服务未注入", true); return; }
        busyRef.current = true;
        setLoading(true);
        startSubagent(captured, sessionId)
          .then(function (result) {
            if (!aliveRef.current) return;
            showToast(t.subagentStarted(String((result && result.childId) || "").slice(0, 8), result && result.intent), false);
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            showToast(t.subagentFailed + (error instanceof Error ? error.message : String(error)), true);
          })
          .finally(function () {
            busyRef.current = false;
            if (aliveRef.current) setLoading(false);
          });
      }, [draftRef, loading, sessionId, showToast, t, startSubagent]);

      return createElement("div", { className: "npp-wrap" },
        createElement("button", {
          type: "button",
          className: "npp-btn",
          "data-loading": loading ? "true" : "false",
          disabled: loading || String(draft).trim() === "",
          "aria-label": t.buttonAria,
          title: t.buttonTip,
          onClick: handleClick,
        }, IconSparkle(15)),
        toast ? createElement("div", { key: toast.seq, className: "npp-toast" },
          createElement("span", { "data-error": toast.error ? "true" : "false" }, toast.text)) : null);
    }

    // ══ PolishSettings（设置面板）═══════════════════════════════
    function Field(props) {
      return createElement("div", { className: "npp-field" },
        createElement("span", { className: "npp-label" }, props.label),
        props.children || null,
        props.hint ? createElement("p", { className: "npp-hint" }, props.hint) : null);
    }

    function SwitchRow(props) {
      var label = props.label;
      var value = props.value;
      var onChange = props.onChange;
      return createElement("div", { className: "npp-switchrow" },
        createElement("span", { className: "npp-label" }, label),
        createElement("button", {
          type: "button",
          className: "npp-switch" + (value ? " on" : ""),
          "aria-label": label,
          onClick: () => onChange(!value),
        }, createElement("span", { className: "knob" })));
    }

    function PolishSettings() {
      var t = langStrings();
      var loadedS = useState(false);
      var loaded = loadedS[0]; var setLoaded = loadedS[1];
      var savingS = useState(false);
      var saving = savingS[0]; var setSaving = savingS[1];
      var msgS = useState(null);
      var msg = msgS[0]; var setMsg = msgS[1];
      var formS = useState(null);
      var form = formS[0]; var setForm = formS[1];

      useEffect(() => {
        var cancelled = false;
        api.config().then(view => {
          if (!cancelled) { setForm(view); setLoaded(true); }
        }).catch(error => {
          if (!cancelled) { setMsg({ ok: false, text: String(error && error.message || error) }); setLoaded(true); }
        });
        return () => { cancelled = true; };
      }, []);

      if (!loaded || !form) return createElement("div", { className: "npp-settings" });
      var update = (field, value) => { setForm(Object.assign({}, form, (() => { var o = {}; o[field] = value; return o; })())); setMsg(null); };
      var save = () => {
        if (saving) return;
        setSaving(true); setMsg(null);
        api.configUpdate({
          contextMode: form.contextMode,
          intentEnabled: !!form.intentEnabled,
          subagentProvider: form.subagentProvider,
          mergeSidebarContextByDefault: !!form.mergeSidebarContextByDefault,
          provider: form.provider, model: form.model,
          reasoningEffort: form.reasoningEffort,
          maxOutputTokens: Number(form.maxOutputTokens),
          temperature: Number(form.temperature),
          timeoutMs: Number(form.timeoutMs),
          maxInputChars: Number(form.maxInputChars),
          recentWindowMessages: Number(form.recentWindowMessages),
          traceEnabled: !!form.traceEnabled,
          traceDir: form.traceDir,
        })
          .then(() => setMsg({ ok: true, text: "✓ 已保存，改动即时生效" }))
          .catch(error => setMsg({ ok: false, text: "保存失败：" + ((error && error.message) || error) }))
          .finally(() => setSaving(false));
      };
      var numberInput = (field, min, max, step) => createElement("input", {
        className: "npp-input", type: "number", min: min, max: max, step: step,
        value: String(form[field]),
        onChange: e => update(field, Number(e.target.value)),
      });
      var select = (field, choices) => createElement("select", {
        className: "npp-input",
        value: String(form[field]),
        onChange: e => update(field, e.target.value),
      }, choices.map(c => createElement("option", { key: c, value: c }, c)));

      return createElement("div", { className: "npp-settings" },
        createElement("div", null,
          createElement("h3", { style: { margin: "0 0 4px", fontSize: 18, fontWeight: 600, color: "var(--dsw-alias-label-primary,#e8e8f0)" } }, "提示词优化"),
          createElement("p", { className: "npp-hint" }, "主路径：点主框 ✨ → 在会话下起「可对话子代理」（继承已完成轮与模型）多轮打磨；事件总线仍走单次 polish（full 模式复刻会话命中 prompt cache）；trace 落盘 lore/traces/prompt-polish/。")),
        createElement(Field, { label: "上下文模式 contextMode", hint: "full=复刻完整会话（C 方案）｜partial=近期对话摘要｜none=仅草稿" },
          select("contextMode", ["full", "partial", "none"])),
        createElement(SwitchRow, { label: "意图分类（debug/implement/explain/chat 四骨架）", value: !!form.intentEnabled, onChange: v => update("intentEnabled", v) }),
        createElement(Field, { label: "子代理 subagentProvider", hint: "fork=继承会话已完成轮与模型（默认）｜spawn=全新子代理" },
          select("subagentProvider", ["fork", "spawn"])),
        createElement(Field, { label: "Provider", hint: "留空继承当前会话模型渠道" },
          createElement("input", { className: "npp-input", type: "text", value: form.provider || "", placeholder: "留空继承会话渠道", onChange: e => update("provider", e.target.value) })),
        createElement(Field, { label: "Model", hint: "留空继承会话模型" },
          createElement("input", { className: "npp-input", type: "text", value: form.model || "", placeholder: "留空继承会话模型", onChange: e => update("model", e.target.value) })),
        createElement(Field, { label: "温度 temperature" }, numberInput("temperature", 0, 1, 0.05)),
        createElement(Field, { label: "超时 timeoutMs" }, numberInput("timeoutMs", 5000, 120000, 1000)),
        createElement(Field, { label: "输入上限 maxInputChars" }, numberInput("maxInputChars", 500, 200000, 500)),
        createElement(Field, { label: "近期对话条数（partial 模式）" }, numberInput("recentWindowMessages", 1, 32, 1)),
        createElement(SwitchRow, { label: "默认合并 sidebar 上下文到润色输入", value: !!form.mergeSidebarContextByDefault, onChange: v => update("mergeSidebarContextByDefault", v) }),
        createElement(SwitchRow, { label: "写 trace（lore/traces/prompt-polish/）", value: !!form.traceEnabled, onChange: v => update("traceEnabled", v) }),
        createElement(Field, { label: "trace 目录 traceDir" },
          createElement("input", { className: "npp-input", type: "text", value: form.traceDir || "", onChange: e => update("traceDir", e.target.value) })),
        createElement("div", { className: "npp-actions" },
          createElement("button", { type: "button", className: "npp-save", disabled: saving, onClick: save }, saving ? "保存中…" : "保存"),
          msg ? createElement("p", { className: "npp-msg", "data-ok": msg.ok ? "true" : "false" }, msg.text) : null));
    }

    // ══ 事件总线（松耦合联动层）══════════════════════════════════
    // 0.2.0：better-sidebar 关联的「宿主扫描 + 悬浮 ✨ 按钮层」整体移除——该服务在 0.1.5 本部署
    // 永久缺位（better-sidebar 自身 disabled），且悬浮开关自 0.0.25 起默认关闭。
    // 保留并收窄为**纯事件总线契约**（docs/sidebar-integration.md）：
    //   window.dispatchEvent(new CustomEvent("narrative:prompt-polish:trigger",
    //     { detail: { triggerSource, draft?, targetElement? } }))
    //   → 本层代跑 /api/polish（单次直调，不占用子代理）→ CAS 回写 target → 广播 result。
    // 不带 targetElement 则仅广播（外部模块自理回写），本层不动作。

    function readTarget(el) {
      if (!el) return "";
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
      return el.innerText || el.textContent || "";
    }

    function writeTarget(el, text) {
      if (!el) return;
      try {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          // React 受控组件兼容：native setter + input 事件。
          var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        el.focus();
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        var ok = document.execCommand("insertText", false, text);
        if (!ok) {
          el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (e) { /* 回写失败由 result 事件 error 分支兜底 */ }
    }

    /** 抓取 target 所在面板的可见文本作联动上下文（每源截断，失败返回 null）。 */
    function grabPanelContext(el) {
      try {
        var panel = el && el.closest('[role="tabpanel"], [class*="panel"], [class*="view"], section');
        if (!panel) return null;
        var text = (panel.innerText || "").trim();
        if (!text) return null;
        return text.length > 400 ? text.slice(0, 400) + "…" : text;
      } catch (e) { return null; }
    }

    var bridge = null;
    function getBridge() {
      if (bridge) return bridge;
      var inflightByTarget = new Map();
      var cachedConfig = { mergeSidebarContextByDefault: false };

      function currentSessionId() {
        try {
          var m = location.hash.match(/session-([0-9a-f-]{8,})/i);
          return m ? m[0] : undefined;
        } catch (e) { return undefined; }
      }

      async function runPolish(target, draft, triggerSource, signal) {
        var t = langStrings();
        var payload = { sessionId: currentSessionId(), text: draft, triggerSource: triggerSource };
        if (cachedConfig.mergeSidebarContextByDefault) {
          payload.mergeSidebarContext = true;
          payload.sidebarContext = grabPanelContext(target);
        }
        try {
          var result = await api.polish(payload, signal);
          var casOk = readTarget(target) === draft;
          if (casOk) writeTarget(target, result.text);
          window.dispatchEvent(new CustomEvent(EVT_RESULT, {
            detail: {
              triggerSource: triggerSource,
              text: result.text,
              intent: result.intent,
              contextMode: result.contextMode,
              applied: casOk,
              reason: casOk ? undefined : "changed",
              targetElement: target,
            },
          }));
          // apply-report：CAS 结果回传服务端，按 result.traceTs 关联 dispatch 行。
          if (result && typeof result.traceTs === "string" && result.traceTs) {
            api.applyReport({
              traceTs: result.traceTs,
              applied: casOk,
              reason: casOk ? "applied" : "changed",
              triggerSource: triggerSource,
              sessionId: payload.sessionId || null,
            }).catch(function () { /* 上报失败不阻塞 UI */ });
          }
        } catch (error) {
          var message = error && error.code ? errorText(t, error) : (error instanceof Error ? error.message : String(error));
          window.dispatchEvent(new CustomEvent(EVT_RESULT, { detail: { triggerSource: triggerSource, applied: false, error: message, targetElement: target } }));
        } finally {
          inflightByTarget.delete(target);
        }
      }

      function onExternalTrigger(event) {
        var detail = event.detail || {};
        var target = detail.targetElement;
        if (!target || !target.isConnected) return;   // 无回写目标：仅广播，模块自理
        var draft = detail.draft !== undefined ? detail.draft : readTarget(target);
        if (String(draft).trim() === "") return;
        var previous = inflightByTarget.get(target);
        if (previous) previous.abort(new Error("superseded"));
        var controller = new AbortController();
        inflightByTarget.set(target, controller);
        runPolish(target, draft, detail.triggerSource || "external", controller.signal);
      }

      function start() {
        window.addEventListener(EVT_TRIGGER, onExternalTrigger);
      }
      function stop() {
        window.removeEventListener(EVT_TRIGGER, onExternalTrigger);
        inflightByTarget.forEach(function (ctl) { ctl.abort(new Error("stopped")); });
        inflightByTarget.clear();
      }

      bridge = {
        start: start,
        stop: stop,
        refreshConfig(next) { cachedConfig = Object.assign(cachedConfig, next || {}); },
      };
      return bridge;
    }

    // ══ apply：注册三件套 ══════════════════════════════════════
    async function apply(ctx) {
      // locale 字典注册（NS 唯一化）。
      try {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: { settingsLabel: "提示词优化" },
          en: { settingsLabel: "Prompt Polish" },
        }), "narrative-prompt-polish: dictionaries");
      } catch (e) { /* locale 缺位不影响核心功能 */ }

      // 1) 主框右座 ✨ 按钮（DSH `conversation.input.right` slot，kind=list / scope=session；
      //    0.1.5 该槽位契约未变）。注入面直接给出「起子代理」闭包，避免模块级 ctx 全局。
      try {
        ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
          name: "conversation.input.right",
          id: PLUGIN_ID,
          order: 0,
          inject: () => ({ startSubagent: (draft, sid) => startPolishSubagent(ctx, draft, sid) }),
        }, PolishButton));
      } catch (e) {
        console.warn("[narrative-prompt-polish] slots service unavailable at boot; conversation button not registered: " + (e && e.message || e));
      }

      // 2) 设置面板（settings.section 槽位 0.1.5 仍在用；本部署的「插件配置页」卡片是另一条通道）
      try {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: PLUGIN_ID,
          order: 50,
          label: () => langStrings().settingsNav,
          inject: () => ({}),
        }, PolishSettings));
      } catch (e) {
        console.warn("[narrative-prompt-polish] slots service unavailable at boot; settings panel not registered: " + (e && e.message || e));
      }

      // 3) 事件总线（外部模块联动；单次 polish + CAS 回写）
      var b = getBridge();
      b.start();
      api.config().then(view => b.refreshConfig(view)).catch(() => {});
    }

    // client cordis 守卫（§十七 line 263 教训）：apply 内 ctx 访问的服务必须在 exports.inject 声明。
    // slots=主框 ✨ 与设置页 slot 注入；locale=多语言字典；sessions=主路径子代理（spawn→打开）。
    module.exports = { apply: apply, inject: ["slots", "locale", "sessions"], PolishButton: PolishButton, PolishSettings: PolishSettings };
    return module.exports;
  },
});
