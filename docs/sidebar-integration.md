# 事件总线契约（联动层集成指南）

> 0.2.0（2026-09-13）：本插件的 **主路径已改为「点 ✨ → 内核原生可对话子代理」**，
> 事件总线只服务**单次 polish**（外部模块触发的代跑 + CAS 回写）。
> 旧版的 better-sidebar 宿主扫描与悬浮 ✨ 按钮层已随 better-sidebar 一并移除。

## 契约（两件事）

### 1. 事件总线（双向，window CustomEvent）
| 方向 | 事件名 | detail 字段 |
|---|---|---|
| 触发 → 插件 | `narrative:prompt-polish:trigger` | `{ triggerSource, draft?, targetElement? }` |
| 插件 → 结果 | `narrative:prompt-polish:result` | `{ triggerSource, text?, intent?, contextMode?, applied, reason?, error?, targetElement? }` |

- 带 `targetElement`：本插件代跑 `POST /api/polish`（单次直调，**不占用子代理**），
  回写前对 target 做 CAS 比对（`readTarget(target) === draft`）；一致才写入，不一致则
  `applied=false, reason="changed"`，绝不覆盖用户输入。
- 不带 `targetElement`：只广播 result（此时无回写，模块自理）——本层在无目标时不动作。
- `triggerSource` 约定：`main` / `sidebar:qa` / `sidebar:terminal` / `sidebar:file-viewer` /
  `sidebar:<自定义>`；trace 记录每次调用的 triggerSource。

### 2. 回写目标（DOM，可选）
`targetElement` 需是 `<textarea>` / `<input>` / `contenteditable`：
- 表单元素走 native setter + `input` 事件（React 受控组件兼容）；
- `contenteditable` 走 Selection + `execCommand("insertText")`，失败退 `textContent` 直写
  （可能丢富文本格式）。

## 三种接入姿势
### 姿势 A：什么都不做
主框 ✨ 自动可用（主路径＝子代理打磨，与本总线无关）。

### 姿势 B：订阅结果事件（自定义回写逻辑）
```js
window.addEventListener("narrative:prompt-polish:result", (e) => {
  const d = e.detail;
  if (d.triggerSource !== "my-panel" || !d.applied) return;
  myPanel.setDraft(d.text);
});
```

### 姿势 C：带 targetElement 委托代跑（单次直调 + CAS + 回写）
```js
window.dispatchEvent(new CustomEvent("narrative:prompt-polish:trigger", {
  detail: { triggerSource: "my-panel", draft: currentDraft(), targetElement: myTextarea },
}));
```

## 配置项
| 键 | 默认 | 说明 |
|---|---|---|
| `mergeSidebarContextByDefault` | false | 开启后单次 polish 请求附带 target 所在面板文本（≤400 字符）作 `<sidebar-context>` |
| `sidebarFloatingButtonEnabled` | false | **0.2.0 起无行为**（悬浮按钮层已移除），键保留仅为兼容已存设置文档 |

## 失败语义（联动失败不影响主路径）
- 目标元素在润色期间被卸载：result 仍广播，`applied=false`。
- CAS 不通过（用户改了草稿）：`applied=false` + `reason="changed"`，不覆盖用户输入。
- 抓不到面板文本：字段缺省，polish 正常进行。
- 同一 target 新触发会 abort 上一个（inflight supersession）。

## 已知边界
- 终端 PTY 输入框（xterm.js）不是 textarea，无法被回写；对终端输出选中内容的润色需
  以姿势 B 接入。
