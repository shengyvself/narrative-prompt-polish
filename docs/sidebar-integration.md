# sidebar 联动层集成指南

本插件的 DSH-better-sidebar 联动层是**松耦合**的：不 import、不调用 better-sidebar 的任何
内部 API，只依赖两个公开契约——DOM 标记与 CustomEvent 事件总线。

## 依赖契约
### 1. DOM 标记（只读）
| 标记 | 含义 | 来源 |
|---|---|---|
| `[data-dsh-better-sidebar]` | sidebar 宿主元素（body 直接子级） | better-sidebar index.tsx mount() |
| `textarea` / `[contenteditable="true"]`（宿主内） | 可观察输入框 | 通用 DOM |

插件只**读取**这些标记做扫描与定位；悬浮 ✨ 按钮挂在插件自有层：
`body > div.npp-float-layer[data-npp-float-layer]`（fixed，pointer-events 分层），按目标
`getBoundingClientRect()` 定位右上角，绝不修改 better-sidebar 的 React 树。

### 2. 事件总线（双向）
| 事件方向 | 事件名 | detail 字段 |
|---|---|---|
| 触发 → 插件 | `narrative:prompt-polish:trigger` | `{ triggerSource, draft?, targetElement? }` |
| 插件 → 结果 | `narrative:prompt-polish:result` | `{ triggerSource, text, intent, contextMode, applied, reason?, error?, targetElement }` |

- `triggerSource` 约定：`main` / `sidebar:qa` / `sidebar:terminal` / `sidebar:file-viewer` /
  `sidebar:<自定义>`；bridge 会从 target 所在 tabpanel 推断（term→terminal、editor/diff/file→file-viewer、chat/qa/ask→qa），推断失败 `sidebar:auto`。
- trace 记录每次调用的 triggerSource。

## 你的模块如何接入（三种姿势）
### 姿势 A：什么都不做（零接入）
sidebar 输入框会自动出现 ✨ 悬浮按钮；点击后插件直接把润色结果回写该输入框
（native value setter + input 事件，React 受控组件兼容）。设置页可关
`sidebarFloatingButtonEnabled`。

### 姿势 B：订阅结果事件（自定义回写逻辑）
```js
window.addEventListener("narrative:prompt-polish:result", (e) => {
  const d = e.detail;
  if (d.triggerSource !== "sidebar:my-panel" || !d.applied) return;
  myPanel.setDraft(d.text);   // 用你自己的状态通道回写
});
```
广播 trigger 时**不带** `targetElement` 即为纯信号模式——bridge 只代跑 polish 与广播，不碰你的 DOM：
```js
window.dispatchEvent(new CustomEvent("narrative:prompt-polish:trigger", {
  detail: { triggerSource: "sidebar:my-panel", draft: currentDraft },
}));
```

### 姿势 C：带 targetElement 委托 bridge 全托管
```js
window.dispatchEvent(new CustomEvent("narrative:prompt-polish:trigger", {
  detail: { triggerSource: "sidebar:my-panel", draft, targetElement: myTextarea },
}));
// bridge 负责：polish 调用 → CAS（回写前比对 readTarget）→ 回写 → 广播 result
```

## 配置项
| 键 | 默认 | 说明 |
|---|---|---|
| `sidebarFloatingButtonEnabled` | true | 关闭后 bridge 完全停摆（observer 断开、按钮移除） |
| `mergeSidebarContextByDefault` | false | 开启后 polish 请求附带 target 所在面板文本（≤400 字符）作 `<sidebar-context>` |

## 失败语义（联动失败不影响主流程）
- better-sidebar 未挂载：扫描空转，等 MutationObserver 下一次通知；主框按钮不受影响。
- 目标元素在润色期间被卸载：result 仍广播，applied=false。
- CAS 不通过（用户改了草稿）：applied=false + reason="changed"，不覆盖用户输入。
- grabSidebarContext 抓不到面板文本：字段缺省，polish 正常进行。

## 已知边界
- 终端 PTY 输入框（xterm.js）不是 textarea，无法被扫描——对终端输出选中内容的润色需
  better-sidebar 未来暴露 selection slot 后以姿势 B 接入。
- contenteditable 回写走 Selection + execCommand("insertText")，execCommand 不可用时退
  textContent 直写（可能丢富文本格式，纯文本输入框无感）。
- 多个输入框同时触发按各自 inflight 串行保护；同一框新触发会 abort 前一个。