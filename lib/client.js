// narrative-prompt-polish — web 客户端半边（ModuleLoader 自包含 bundle）。
// 三组注册：
//   1. conversation.input.right → PolishButton（主框 ✨，CAS 写回）
//   2. settings.section         → PolishSettings（配置表单）
//   3. sidebar 联动层           → SidebarBridge（MutationObserver 扫描 + CustomEvent 总线）
// 0.0.13 误删主框按钮，0.0.14 恢复（用户确认"按钮只出现在主页面的对话输入框"——
// 这是 §十六 line 279 设计的主入口）。PolishButton 组件保留。
// 约束：不野生注入 DSH 结构（悬浮按钮层是插件自有 DOM，只读 rect 定位，不碰 DSH 内部 API）；
//       联动松耦合（事件总线 narrative:prompt-polish:trigger / :result）。
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
        sidechatStarted: (id) => "已起侧栏对话（childId: " + id + "…）—— 在侧栏多轮打磨后手动回填主输入框",
        sidechatFailed: "起侧栏对话失败：",
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
        sidechatStarted: (id) => "Side chat started (childId: " + id + "…) — polish in the sidebar, then paste back manually",
        sidechatFailed: "Side chat failed: ",
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
        ".npp-float-layer{position:fixed;inset:0 auto auto 0;width:100%;height:0;pointer-events:none;z-index:99990}",
        ".npp-float-btn{position:absolute;pointer-events:auto;width:22px;height:22px;margin-left:-26px;display:grid;place-items:center;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(34,34,44,.92));color:var(--dsw-alias-brand-primary,#4FC3F7);box-shadow:0 1px 4px rgba(0,0,0,.28);cursor:pointer;font-size:12px;line-height:1}",
        ".npp-float-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4FC3F7) 22%,transparent)}",
        ".npp-float-btn[data-busy=true]{animation:npp-pulse 1.1s ease-in-out infinite}",
        "@keyframes npp-pulse{0%,100%{opacity:.55}50%{opacity:1}}",
      ].join("\n");
      document.head.appendChild(styleTag);
    }

    function IconSparkle(size) {
      return createElement("svg", { viewBox: "0 0 16 16", width: size || 15, height: size || 15, fill: "none", "aria-hidden": true },
        createElement("path", { d: "M8 1.2c.3 0 .56.18.67.46l1.5 3.9 3.9 1.5a.72.72 0 0 1 0 1.34l-3.9 1.5-1.5 3.9a.72.72 0 0 1-1.34 0l-1.5-3.9-3.9-1.5a.72.72 0 0 1 0-1.34l3.9-1.5 1.5-3.9A.72.72 0 0 1 8 1.2ZM12.5 9c.2 0 .37.12.44.31l.65 1.65 1.65.65a.48.48 0 0 1 0 .88l-1.65.65-.65 1.65a.48.48 0 0 1-.88 0l-.65-1.65-1.65-.65a.48.48 0 0 1 0-.88l1.65-.65.65-1.65A.48.48 0 0 1 12.5 9Z", fill: "currentColor" }));
    }

    // ══ moduleStartInteractivePolish（0.0.20 主入口；§十六 line 279 初衷真正落地）════════
    // 单击主框 ✨ → 起 better-sidebar sidechat 子会话（继承主会话上下文 + preset/provider/model）
    // → 任务书投在 sidechat.start 的 question 里（无需再 sidechat.prompt）
    // → 用户在侧栏多轮打磨 → 手动复制回填主输入框
    // 红线 9：betterSidebar/layout 不可用直接 throw，不兑底到 api.polish。
    // 0.0.16-0.0.18 失败线复盘（§三十一-§三十四）：
    //   - 0.0.16: sidechat.start HTTP 拿 childId 但 better-sidebar 不自动开 tab（用户看不到）
    //   - 0.0.17: ctx.betterSidebar.openTab({type:'sidechat'}) 走 createTab mint autoCreate tab，
    //             但 SideChatView 自己 startThread 起 childId（第二层 race 起点）
    //   - 0.0.18: polish 自己 sidechat.start + openTab + 轮询 getSnapshot + updateTab 阻止 race，
    //             但轮询用 snap.tabs 扁平数组（state 实为 splits/bottomSplits/floats 树）
    //             → 永远找不到新 tab；且 updateTab 晚于 SideChatView mount + startThread → 覆盖
    // 0.0.20 解（better-sidebar 0.16.1 实测）：
    //   - SideChatView useEffect 守卫 = `if (threadId !== void 0 || !autoCreate || !visible) return;`
    //     → 只要在 React mount 前把 threadId 种进 tab.meta，startThread 就不会跑（0.16.1 已具备）
    //   - openTab 是同步 store.reduce → openTab 返回后同一 tick 内 getSnapshot() 立即可见新 tab
    //     → 同步 updateTab 抢在 React 渲染前 → race 消除（不依赖 better-sidebar 上游改动）
    //   - 兜底：同步未命中时用树结构轮询（100ms × 30 = 3s）
    var SIDE_CHAT_ROUTE = "/sidebar/api";
    var MODULE_CTX = null; // apply 时赋值；handleClick 闭包经此取 ctx（0.0.20 新增）

    function sidechatCall(method, payload) {
      // 不传 signal (sidechat 是 fire-and-forget + 后续 followup, 不需要 abort)
      return fetch(SIDE_CHAT_ROUTE + "/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      }).then(function (response) {
        return response.json().then(function (parsed) {
          if (!response.ok || !parsed || parsed.ok !== true) {
            var err = parsed && parsed.error;
            throw new Error((err && (err.code + ": " + err.message)) || ("sidechat " + method + " HTTP " + response.status));
          }
          return parsed.value;
        });
      });
    }
    function buildPolishTaskbook(draft) {
      // 简版任务书（用户确认不加【作者验证提示】——§三十三）
      return [
        "【润色任务书】",
        "",
        "作者草稿：",
        draft || "（空）",
        "",
        "请按 polish 设计意图（4 类意图骨架 debug/implement/explain/chat + 共享重写规则）将上面草稿改写为可直接交给 AI 助手执行的高质量提示词。要求：保留事实、模糊→具体动作、缺背景标注待确认、拆编号子问题、长度匹配复杂度。完成后输出最终润色文本（不要解释过程）。"
      ].join("\n");
    }
    // better-sidebar state 是 splits/bottomSplits/floats 树；0.0.18 用 snap.tabs 扁平数组是错的。
    // 遍历树找 type==="sidechat" 的 tab。
    // 0.0.21 修复：ctx.betterSidebar.getSnapshot() 返回 { sessionId, state, prefs } 包装，
    // state 才是含 splits/bottomSplits/floats 树的对象（0.0.20 读 snap.splits 恒 undefined →
    // 永远找不到新 tab → 「等不到 sidechat tab」根因；0.0.18 用 snap.tabs 扁平数组同样是错的）。
    function eachSidechatTab(snapOrWrapper, fn) {
      var snap = snapOrWrapper;
      if (!snap) return;
      if (snap.state && snap.state.splits) snap = snap.state; // 剥 {sessionId,state,prefs} 包装
      function walk(node) {
        if (!node) return;
        if (node.kind === "leaf") {
          (node.tabs || []).forEach(function (tab) { if (tab && tab.type === "sidechat") fn(tab); });
          return;
        }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      }
      walk(snap.splits);
      walk(snap.bottomSplits);
      (snap.floats || []).forEach(function (f) { if (f && f.tab && f.tab.type === "sidechat") fn(f.tab); });
    }
    // openTab 前快照差集：返回 openTab 后新出现的 sidechat tab（按 id 差集；0.0.22 放宽——
    // 不限定 sidechat:new- 前缀，兼容 createTab 走 consumeSidechatSeed 生成 sidechat:<threadId> id 的场景）。
    function findNewSidechatTab(ctx, beforeIds) {
      var snap = null;
      try { snap = ctx.betterSidebar.getSnapshot(); } catch (e) { return null; }
      var found = null;
      eachSidechatTab(snap, function (tab) {
        if (found) return;
        var id = String(tab.id || "");
        if (!beforeIds[id]) found = tab.id;
      });
      return found;
    }
    // 兜底轮询（树结构遍历；同步路径未命中时用）。resolve null = 超时。
    function waitForNewSidechatTab(ctx, beforeIds, timeoutMs) {
      var deadline = Date.now() + (timeoutMs || 3000);
      return new Promise(function (resolve) {
        function poll() {
          var id = findNewSidechatTab(ctx, beforeIds);
          if (id) return resolve(id);
          if (Date.now() > deadline) return resolve(null);
          setTimeout(poll, 100);
        }
        poll();
      });
    }
    function moduleStartInteractivePolish(draft, sessionId) {
      var ctx = MODULE_CTX;
      // 红线 9：主路径不可用 = 任务失败，直接 throw，不兑底
      if (!ctx || !ctx.betterSidebar || typeof ctx.betterSidebar.openTab !== "function") {
        return Promise.reject(new Error("betterSidebar 服务不可用（ctx.betterSidebar.openTab 缺失）—— 0.0.20 主路径需 betterSidebar 服务注入"));
      }
      if (!ctx.layout || typeof ctx.layout.toggleSidebar !== "function") {
        return Promise.reject(new Error("layout 服务不可用（ctx.layout.toggleSidebar 缺失）—— 0.0.20 主路径需 layout 服务注入"));
      }
      if (!sessionId) return Promise.reject(new Error("moduleStartInteractivePolish: 主会话 sessionId 缺失"));
      var trimmed = (draft || "").trim();
      if (!trimmed) return Promise.reject(new Error("草稿为空"));
      var taskbook = buildPolishTaskbook(trimmed);
      // 1) polish 自己起 thread（不依赖 SideChatView 流程）——任务书投在 question
      return sidechatCall("sidechat.start", { sessionId: sessionId, question: taskbook }).then(function (startResult) {
        var childId = startResult && startResult.childId;
        if (!childId) throw new Error("sidechat.start 未返回 childId");
        // 2) 起 sidechat tab（createTab mint autoCreate:true tab，id=sidechat:new-<uuid>）
        var beforeIds = {};
        try { eachSidechatTab(ctx.betterSidebar.getSnapshot(), function (tab) { beforeIds[String(tab.id || "")] = true; }); } catch (e) {}
        // 0.0.22：openTab scope 用 better-sidebar store 当前会话 id，而非 PolishButton 的 props.sessionId。
        // targetsInactiveSession = scope.sessionId !== activeSessionId → true 时 openTab 走 store.reduceFor
        // 把 tab 写进另一会话的 store → 当前 getSnapshot() 永远找不到 → 「等不到 tab」根因二。
        // 参考实现对齐（g-yixuan/dsh-sidechat openOrFocusSideChat）：store 未就绪（state/sessionId 缺失）
        // 时显式失败，不做静默 openTab（openTab 内部 targetSessionId===void 0 会静默 return）。
        var storeSessionId = null;
        var storeStateReady = false;
        try {
          var snap0 = ctx.betterSidebar.getSnapshot();
          storeSessionId = snap0 && snap0.sessionId || null;
          storeStateReady = !!snap0 && !!snap0.state;
        } catch (e) {}
        if (!storeStateReady || !storeSessionId) {
          sidechatCall("sidechat.cancel", { childId: childId }).catch(function () {});
          throw new Error("better-sidebar store 未就绪（sessionId/state 缺失），无法起 sidechat tab");
        }
        // 2.5) 0.0.24：不手动 toggle 面板——openTab 的 seed 带 path 即触发 better-sidebar 原生自动展开
        //      （reducer 末尾判断 seed.path/url 存在 → !panelOpen → togglePanel，L1563-1572；
        //      这就是 better-sidebar 自带弹出 sidebar 窗口的触发方式，用户提示）。
        //      0.0.23 用 ctx.layout.toggleSidebar()（DSH layout store）与 better-sidebar 的 panelOpen
        //      不联动 → 没弹出，故弃用。seed.path 不会写进 tab（url 才会 patchTab 污染 tab.path）。
        //      顺序：openTab 同步 store.reduce 即展开面板 → 之后同步种 threadId → SideChatView mount 即 visible。
        try {
          ctx.betterSidebar.openTab({ type: "sidechat", path: "_npp_sidechat_" }, { sessionId: storeSessionId });
        } catch (e) {
          // tab 起失败 cancel 我们自己起的 thread（不让孤儿残留）
          sidechatCall("sidechat.cancel", { childId: childId }).catch(function () {});
          throw new Error("betterSidebar.openTab 失败: " + (e instanceof Error ? e.message : String(e)));
        }
        // 4) 同步种 threadId（0.0.20 关键：openTab 同步 store.reduce → 同一 tick 内 getSnapshot 可见
        //    新 tab → 立即 updateTab 抢在 React mount SideChatView 之前；0.16.1 守卫生效不再 startThread）
        var syncId = null;
        try { syncId = findNewSidechatTab(ctx, beforeIds); } catch (e) { syncId = null; }
        if (syncId) {
          try {
            ctx.betterSidebar.updateTab(syncId, { meta: { autoCreate: false, threadId: childId } });
          } catch (e) {
            throw new Error("updateTab 写 threadId 失败: " + (e instanceof Error ? e.message : String(e)));
          }
          return { ok: true, childId: childId, tabId: syncId, taskbook: taskbook };
        }
        // 5) 兜底：同步未命中（理论竞态窗口）→ 树结构轮询 3s
        return waitForNewSidechatTab(ctx, beforeIds, 3000).then(function (tabId) {
          if (!tabId) throw new Error("等不到 better-sidebar sidechat tab 出现（>3s）");
          try {
            ctx.betterSidebar.updateTab(tabId, { meta: { autoCreate: false, threadId: childId } });
          } catch (e) {
            throw new Error("updateTab 写 threadId 失败: " + (e instanceof Error ? e.message : String(e)));
          }
          return { ok: true, childId: childId, tabId: tabId, taskbook: taskbook };
        });
      });
    }

    // ══ PolishButton（主框 ✨；0.0.20 改调 moduleStartInteractivePolish 而非 api.polish）════════
    function PolishButton(props) {
      var t = langStrings();
      var draft = props.input ? props.input.draft : "";
      var setDraft = props.inputActions ? props.inputActions.setDraft : undefined;
      var sessionId = props.sessionId;
      var resolveModel = props.resolveModel;
      var draftRef = useRef(draft);
      draftRef.current = draft;
      var aliveRef = useRef(true);
      var abortRef = useRef(null);
      var busyRef = useRef(false);
      var toastTimer = useRef(0);
      var loadingState = useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var toastState = useState(null);
      var toast = toastState[0];
      var setToast = toastState[1];
      var cfgState = useState({ provider: "", model: "" });
      var channelCfg = cfgState[0];
      var setChannelCfg = cfgState[1];

      useEffect(() => () => {
        aliveRef.current = false;
        if (abortRef.current) abortRef.current.abort();
        window.clearTimeout(toastTimer.current);
      }, []);
      useEffect(() => {
        var cancelled = false;
        api.config().then(view => { if (!cancelled) setChannelCfg({ provider: view.provider || "", model: view.model || "" }); }).catch(() => {});
        return () => { cancelled = true; };
      }, []);

      var showToast = useCallback((text, isError) => {
        setToast({ seq: Date.now(), text: text, error: !!isError });
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => { if (aliveRef.current) setToast(null); }, 2600);
      }, [setToast]);

      var handleClick = useCallback(() => {
        // 0.0.20（§三十一 用户决策点 → 用户选 B）：点 ✨ → 进侧栏对话打磨（继承主会话上下文 + 多轮 followup）
        // 不再调 api.polish 立即改草稿 — 改成调模块级 moduleStartInteractivePolish 起 sidechat 子会话
        // 红线 9：不兑底，betterSidebar/layout 不可用时 moduleStartInteractivePolish 直接 reject → toast 报错
        if (busyRef.current) return;
        var captured = draftRef.current;
        if (String(captured).trim() === "") { showToast(t.empty, false); return; }
        busyRef.current = true;
        setLoading(true);
        moduleStartInteractivePolish(captured, sessionId)
          .then(function (result) {
            if (!aliveRef.current) return;
            if (result && result.ok) {
              showToast(t.sidechatStarted(String(result.childId || "").slice(0, 8)), false);
            } else {
              showToast(t.sidechatFailed + (result && result.error ? result.error : "unknown"), true);
            }
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            showToast(error instanceof Error ? (t.sidechatFailed + error.message) : t.sidechatFailed + String(error), true);
          })
          .finally(function () {
            busyRef.current = false;
            if (aliveRef.current) setLoading(false);
          });
      }, [draftRef, loading, sessionId, showToast, t]);

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
          sidebarFloatingButtonEnabled: !!form.sidebarFloatingButtonEnabled,
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
          createElement("p", { className: "npp-hint" }, "意图感知改写输入框草稿；full 模式复刻完整会话命中 prompt cache；trace 落盘 lore/traces/prompt-polish/。")),
        createElement(Field, { label: "上下文模式 contextMode", hint: "full=复刻完整会话（C 方案）｜partial=近期对话摘要｜none=仅草稿" },
          select("contextMode", ["full", "partial", "none"])),
        createElement(SwitchRow, { label: "意图分类（debug/implement/explain/chat 四骨架）", value: !!form.intentEnabled, onChange: v => update("intentEnabled", v) }),
        createElement(Field, { label: "Provider", hint: "留空继承当前会话模型渠道" },
          createElement("input", { className: "npp-input", type: "text", value: form.provider || "", placeholder: "留空继承会话渠道", onChange: e => update("provider", e.target.value) })),
        createElement(Field, { label: "Model", hint: "留空继承会话模型" },
          createElement("input", { className: "npp-input", type: "text", value: form.model || "", placeholder: "留空继承会话模型", onChange: e => update("model", e.target.value) })),
        createElement(Field, { label: "温度 temperature" }, numberInput("temperature", 0, 1, 0.05)),
        createElement(Field, { label: "超时 timeoutMs" }, numberInput("timeoutMs", 5000, 120000, 1000)),
        createElement(Field, { label: "输入上限 maxInputChars" }, numberInput("maxInputChars", 500, 200000, 500)),
        createElement(Field, { label: "近期对话条数（partial 模式）" }, numberInput("recentWindowMessages", 1, 32, 1)),
        createElement(SwitchRow, { label: "sidebar 输入框悬浮 ✨ 按钮", value: !!form.sidebarFloatingButtonEnabled, onChange: v => update("sidebarFloatingButtonEnabled", v) }),
        createElement(SwitchRow, { label: "默认合并 sidebar 上下文到润色输入", value: !!form.mergeSidebarContextByDefault, onChange: v => update("mergeSidebarContextByDefault", v) }),
        createElement(SwitchRow, { label: "写 trace（lore/traces/prompt-polish/）", value: !!form.traceEnabled, onChange: v => update("traceEnabled", v) }),
        createElement(Field, { label: "trace 目录 traceDir" },
          createElement("input", { className: "npp-input", type: "text", value: form.traceDir || "", onChange: e => update("traceDir", e.target.value) })),
        createElement("div", { className: "npp-actions" },
          createElement("button", { type: "button", className: "npp-save", disabled: saving, onClick: save }, saving ? "保存中…" : "保存"),
          msg ? createElement("p", { className: "npp-msg", "data-ok": msg.ok ? "true" : "false" }, msg.text) : null));
    }

    // ══ SidebarBridge（联动层；slot 缺失降级方案 B）══════════════
    // - 只扫 better-sidebar 宿主 [data-dsh-better-sidebar] 内的输入框（不碰主会话 DOM）
    // - 悬浮 ✨ 按钮挂在插件自有 fixed 层（按 target rect 定位，不修改 DSH 结构）
    // - 通信走 window CustomEvent 总线（松耦合契约，见 docs/sidebar-integration.md）

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

    /** 抓取 target 所在面板的可见文本作 sidebar 上下文（每源截断，失败返回 null）。 */
    function grabSidebarContext(el) {
      try {
        var panel = el && el.closest('[role="tabpanel"], [class*="panel"], [class*="view"], section');
        if (!panel) return null;
        var text = (panel.innerText || "").trim();
        if (!text) return null;
        return text.length > 400 ? text.slice(0, 400) + "…" : text;
      } catch (e) { return null; }
    }

    var bridge = null;
    function getBridge(getConfigCached) {
      if (bridge) return bridge;
      var layer = null;
      var entries = new Map();   // target element -> { btn, busy }
      var inflightByTarget = new Map();
      var observer = null;
      var scanTimer = 0;
      var cachedConfig = { sidebarFloatingButtonEnabled: false, mergeSidebarContextByDefault: false };

      function ensureLayer() {
        if (layer && layer.isConnected) return layer;
        layer = document.createElement("div");
        layer.className = "npp-float-layer";
        layer.setAttribute("data-npp-float-layer", "");
        document.body.appendChild(layer);
        return layer;
      }

      function positionBtn(entry, target) {
        var rect = target.getBoundingClientRect();
        var visible = rect.width > 0 && rect.height > 0;
        entry.btn.style.display = visible ? "grid" : "none";
        if (visible) {
          entry.btn.style.left = rect.right + "px";
          entry.btn.style.top = rect.top + "px";
        }
      }

      function repositionAll() {
        entries.forEach((entry, target) => {
          if (!target.isConnected) { detach(target); return; }
          positionBtn(entry, target);
        });
      }

      function attach(target) {
        if (entries.has(target)) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "npp-float-btn";
        btn.title = "提示词优化（携带当前会话上下文）";
        btn.setAttribute("aria-label", "提示词优化");
        btn.textContent = "✨";
        var entry = { btn: btn, busy: false };
        btn.addEventListener("click", () => onFloatClick(entry, target));
        entries.set(target, entry);
        ensureLayer().appendChild(btn);
        positionBtn(entry, target);
      }

      function detach(target) {
        var entry = entries.get(target);
        if (!entry) return;
        entry.btn.remove();
        entries.delete(target);
        var ctl = inflightByTarget.get(target);
        if (ctl) { ctl.abort(); inflightByTarget.delete(target); }
      }

      function scheduleScan() {
        window.clearTimeout(scanTimer);
        scanTimer = window.setTimeout(scan, 220);
      }

      function scan() {
        if (!cachedConfig.sidebarFloatingButtonEnabled) return;
        var hosts = document.querySelectorAll("[data-dsh-better-sidebar]");
        if (hosts.length === 0) return;   // sidebar 未挂载：等下一次 mutation
        hosts.forEach(host => {
          host.querySelectorAll('textarea:not([readonly]), [contenteditable="true"]').forEach(el => {
            if (!el.hasAttribute("data-npp-watched")) {
              el.setAttribute("data-npp-watched", "");
              attach(el);
            }
          });
        });
        repositionAll();
      }

      function onFloatClick(entry, target) {
        var draft = readTarget(target);
        if (entry.busy) return;
        if (String(draft).trim() === "") return;
        var triggerSource = inferSource(target);
        var ctl = inflightByTarget.get(target);
        if (ctl) ctl.abort(new Error("superseded"));
        var controller = new AbortController();
        inflightByTarget.set(target, controller);
        // 广播触发事件（外部模块可监听/接管）。
        window.dispatchEvent(new CustomEvent(EVT_TRIGGER, { detail: { triggerSource: triggerSource, draft: draft, targetElement: target } }));
        runPolish(entry, target, draft, triggerSource, controller.signal);
      }

      function inferSource(target) {
        try {
          var host = target.closest("[data-dsh-better-sidebar]");
          if (!host) return "main";
          var mod = target.closest('[role="tabpanel"]');
          var name = mod ? (mod.getAttribute("aria-label") || mod.getAttribute("data-tab") || "") : "";
          if (/term|pty/i.test(name)) return "sidebar:terminal";
          if (/editor|diff|file/i.test(name)) return "sidebar:file-viewer";
          if (/chat|qa|ask/i.test(name)) return "sidebar:qa";
          return "sidebar:" + (name || "auto").toLowerCase().replace(/\s+/g, "-").slice(0, 30);
        } catch (e) { return "sidebar:auto"; }
      }

      async function runPolish(entry, target, draft, triggerSource, signal) {
        entry.busy = true;
        entry.btn.setAttribute("data-busy", "true");
        var t = langStrings();
        var finish = () => {
          entry.busy = false;
          entry.btn.removeAttribute("data-busy");
          inflightByTarget.delete(target);
        };
        var payload = {
          sessionId: currentSessionId(),
          text: draft,
          triggerSource: triggerSource,
        };
        if (cachedConfig.mergeSidebarContextByDefault) {
          payload.mergeSidebarContext = true;
          payload.sidebarContext = grabSidebarContext(target);
        }
        try {
          var result = await api.polish(payload, signal);
          var current = readTarget(target);
          var casOk = current === draft;
          var detail = {
            triggerSource: triggerSource,
            text: result.text,
            intent: result.intent,
            contextMode: result.contextMode,
            applied: casOk,
            reason: casOk ? undefined : "changed",
            targetElement: target,
          };
          if (!casOk) {
            flashBtn(entry, t.changed);
          } else if (typeof target === "object" && target) {
            writeTarget(target, result.text);
            flashBtn(entry, null);
          }
          window.dispatchEvent(new CustomEvent(EVT_RESULT, { detail: detail }));
          // ── apply-report：把 CAS 结果回传给服务端, 按 result.traceTs 关联 dispatch 行 ──
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
          flashBtn(entry, message);
          window.dispatchEvent(new CustomEvent(EVT_RESULT, { detail: { triggerSource: triggerSource, applied: false, error: message, targetElement: target } }));
          // ── 失败路径也尝试上报（缺 traceTs 时服务端 reject 是预期行为）──
          // 服务端 PolishError 已被 callApi 包装为 code, 但 trace 落不到任何行 → 这里不强制
        } finally {
          finish();
        }
      }

      var flashTimer = 0;
      function flashBtn(entry, message) {
        var original = entry.btn.title;
        if (message) {
          entry.btn.title = message;
          window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => { entry.btn.title = original; }, 3000);
        }
      }

      function currentSessionId() {
        try {
          var m = location.hash.match(/session-([0-9a-f-]{8,})/i);
          return m ? m[0] : undefined;
        } catch (e) { return undefined; }
      }

      function start() {
        ensureLayer();
        scan();
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("scroll", repositionAll, true);
        window.addEventListener("resize", repositionAll);
        // 外部模块可直接广播 trigger（松耦合入口）：bridge 代跑 polish 并回写 targetElement。
        window.addEventListener(EVT_TRIGGER, onExternalTrigger);
      }

      function onExternalTrigger(event) {
        var detail = event.detail || {};
        var target = detail.targetElement;
        if (!target || !target.isConnected) return;   // 无回写目标：仅广播，模块自理
        if (entries.has(target)) return;               // 自家按钮触发已在跑
        if (entries.size < 400) attach(target);        // 外部目标临时纳入管理（便于 CAS/回写）
        var entry = entries.get(target);
        if (!entry) return;
        var draft = detail.draft !== undefined ? detail.draft : readTarget(target);
        var ctl = new AbortController();
        inflightByTarget.set(target, ctl);
        runPolish(entry, target, draft, detail.triggerSource || "sidebar:external", ctl.signal);
      }

      function stop() {
        if (observer) observer.disconnect();
        window.removeEventListener("scroll", repositionAll, true);
        window.removeEventListener("resize", repositionAll);
        window.removeEventListener(EVT_TRIGGER, onExternalTrigger);
        Array.from(entries.keys()).forEach(detach);
        if (layer) layer.remove();
      }

      bridge = {
        start: start,
        stop: stop,
        refreshConfig(next) { cachedConfig = Object.assign(cachedConfig, next || {}); if (!cachedConfig.sidebarFloatingButtonEnabled) stop(); else if (!observer) start(); },
      };
      return bridge;
    }

    // ══ apply：注册三件套 ══════════════════════════════════════
    async function apply(ctx) {
      // 0.0.20：缓存 ctx 供 moduleStartInteractivePolish（handleClick 闭包不在 apply 作用域内）
      MODULE_CTX = ctx;
      // locale 字典注册（NS 唯一化）。
      try {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: { settingsLabel: "提示词优化" },
          en: { settingsLabel: "Prompt Polish" },
        }), "narrative-prompt-polish: dictionaries");
      } catch (e) { /* locale 缺位不影响核心功能 */ }

      var t = langStrings();

      // 1) 主框右座 ✨ 按钮（DSH `conversation.input.right` slot；主框架底部主会话输入框）
      // 0.0.14 恢复主框按钮（0.0.13 误删后用户确认"按钮只出现在主页面的对话输入框"——
      // 这是 §十六 line 279 设计的主入口）。若 DSH 框架向 writing-pad 等其他视图也注入
      // conversation.input.right slot，需后续在 writing-pad 客户端或 DSH 框架层协调（不属本任务）。
      var connection = undefined;
      try { connection = ctx.connection; } catch (e) { /* client runtime has no connection service; fall back to server default model */ }
      var resolveModel = sessionId => {
        try {
          if (!connection || !connection.api || !connection.api.sessions || !connection.api.sessions.models) return Promise.resolve(undefined);
          return connection.api.sessions.models({ sessionId: sessionId }).then(response => {
            var current = response.result && response.result.ok ? response.result.value && response.result.value.current : undefined;
            if (!current || !current.provider) return undefined;
            return { provider: current.provider, model: current.model };
          }).catch(() => undefined);
        } catch (e) { return Promise.resolve(undefined); }
      };
      try {
        ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
          name: "conversation.input.right",
          id: PLUGIN_ID,
          order: 0,
          inject: () => ({ resolveModel: resolveModel }),
        }, PolishButton));
      } catch (e) {
        console.warn("[narrative-prompt-polish] slots service unavailable at boot; conversation button not registered: " + (e && e.message || e));
      }

      // 2) 设置面板
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

      // 3) sidebar 联动层（配置驱动；启动后拉一次配置校准开关）
      var b = getBridge();
      b.start();
      api.config().then(view => b.refreshConfig(view)).catch(() => {});
    }

    // client cordis 守卫（§十七 line 263 教训）：apply 内 ctx 访问的服务必须在 exports.inject 声明。
    // slots=主框 ✨ 按钮与设置页 slot 注入；locale=多语言字典注册；connection=resolveModel 模型跟随。
    module.exports = { apply: apply, inject: ["slots", "locale", "connection", "betterSidebar", "layout"], PolishButton: PolishButton, PolishSettings: PolishSettings };
    return module.exports;
  },
});
