# narrative-prompt-polish

Shengyv's Writing Architecture 的提示词优化插件：主会话输入框右座 ✨ 一键起一个
**可对话的子代理**，把草稿打磨成清晰、具体、可直接交给 AI Agent 执行的提示词——
在子代理会话里多轮追问，满意后手动复制回主输入框。

## 核心特性
- **主框 ✨ → 可对话子代理打磨（默认主流程，0.2.0+）**：点击主框 ✨ **不**直接改草稿，
  而是由服务端 `POST /api/polish.start` 在主会话下起一个 **continuable 子代理**
  （`ctx.subagents.startContinuable`，provider 默认 `fork`：seed 主会话**已完成轮**、
  继承父 Agent 的 provider/model/推理档与预设），把「任务书 + 草稿」投进它的首轮；
  客户端随后 `ctx.sessions.openSubagent` 打开该子代理会话——它是原生会话界面，
  输入框可写，可多轮追问，满意后复制回主输入框。子代理起不来时**显式报错**
  （红线 9：绝不静默降级到单次 polish）。
  - 0.2.0 前该主流程依赖 better-sidebar 的 sidechat；better-sidebar 已从本部署架构移除
    （0.1.5 起右侧栏面板一律走官方 keyed 槽位），故主路径改为**内核原生子代理**。
- **C 方案（full，默认）**：`ctx.sessions.get()` → `deriveMessages()` + `requestHeader().system/config`，
  完整复刻 `[system]+[...history]` 前缀直调 `ctx.llm.stream`——前缀与主会话一致即命中 prompt cache，
  只增量计算草稿与润色指令。非 live 会话走 `sessionQuery.readSession()` 离线折叠兜底。
- **降级链**：full → partial（readSurface 近期对话）→ none（裸草稿），
  每次降级在响应 `fallbackReasons` 与 trace 中留痕；`strictFull: true` 可改为硬失败（no-session）。
- **意图骨架**：本地正则分类 debug/implement/explain/chat；partial/none 下骨架进 system，
  full 下骨架折进末尾 user 指令（不动 system 前缀以保缓存）。
- **CAS 写回**（历史单次 polish 路径）：点击时捕获草稿指纹，返回后若草稿已变则弹
  「草稿已变，未应用润色」且不覆盖。
- **错误细分**：rejected(empty/references/too-large)、no-session、route-unavailable、
  stream-failed、empty-result、context-fallback、settings-unavailable。
- **trace**：每次调用追加 JSONL 到 `lore/traces/prompt-polish/YYYY-MM-DD.jsonl`
  （intent/contextMode/fallbacks/cacheHit/tokens/hash 等；hash 不落全文）。设置页可关。
- **事件总线（外部模块联动，0.2.0 收窄）**：`window` 上广播
  `narrative:prompt-polish:trigger`（`{triggerSource, draft?, targetElement?}`）→ 本插件代跑
  **单次** `/api/polish`（不占用子代理）→ CAS 回写 target → 广播 `…:result`；不带
  `targetElement` 则只广播、模块自理回写。契约见 `docs/sidebar-integration.md`。
- **sidebar 浮按钮（0.2.0 已移除）**：随 better-sidebar 一并删除（宿主 DOM 标记
  `[data-dsh-better-sidebar]` 在本部署已不存在）；配置键 `sidebarFloatingButtonEnabled`
  仅保留以免已存设置文档失配，**无任何行为**。

## 红线遵守
- 不写主会话历史：无 append、`llm.stream` 不传 sessionId（不进会话调度）。
- 无野生 DOM 注入：UI 走官方 slot `conversation.input.right` + `settings.section`。
- 服务端零 `@deepseek-ai/*` 静态 import（dsh-session 仅离线路径动态 import 且失败自动降级），
  杜绝缺依赖崩 web。

## API
| 方法 | 说明 |
|---|---|
| `POST /narrative-prompt-polish/api/polish.start` | `{sessionId,text,triggerSource?,provider?}` → `{childId,messageId,intent,subagentProvider}`（**主路径**：起可对话子代理，任务书投首轮） |
| `POST /narrative-prompt-polish/api/polish` | `{sessionId,text,mode?,strictFull?,triggerSource?,mergeSidebarContext?,sidebarContext?}`（单次直调路径：事件总线 / headless / 自动化） |
| `POST .../api/config` `/config.get` `/config.update` | 配置读改（settings 服务缺位时 update 返回 503） |
| `POST .../api/traces.recent` | `{limit}` 最近 trace |
| `POST .../api/apply-report` | 客户端 CAS 结果回传（applied/changed），trace 行按 traceTs 配对 |

## 独立安装（GitHub）
```bash
dsh plugin --profile web add github:shengyvself/narrative-prompt-polish
# 或克隆后：
dsh plugin --profile web add ./narrative-prompt-polish
```
安装后重启 DSH Web 即生效。**无第三方依赖**：主路径走内核原生 `ctx.subagents`（continuable）
+ `ctx.sessions.openSubagent`，要求内核版本含子代理编排服务（DSH ≥ 0.1.5 实测）。
默认配置开箱即用（子代理继承当前会话的 provider/model/预设；trace 写入
`<cwd>/lore/traces/prompt-polish/`，可在设置页改为绝对路径锚定你的工作区）。

## License

本项目以 [MIT](./LICENSE) 发布。

## 开发
```bash
npm run build   # src → lib 直拷
npm test        # node --test tests/
```

验证链（改插件红线）：node --check → preflight 4 关 → build → import 冒烟 → 加 bundle → 重启 → 3 连测 200 → dump-config → 日志扫描。

## 文件结构
```
src/index.js            host 入口（围栏路由 + settings 防御式注册）
src/api.js              方法表 + polish 主流程（校验→意图→上下文→直调→清洗→trace）
src/context-assembler.js C 方案探测链 full→partial→none
src/surface-fold.js     readSurface 过滤折叠（纯函数）
src/intent.js           4 类意图骨架
src/polish.js           流组装/输出清洗/usage 提取（纯函数）
src/trace-recorder.js   JSONL trace
src/trust-fence.js      浏览器信任围栏
src/wire.js             JSON 信封
src/taskbook.js         主路径任务书文本（服务端；与 /api/polish 共用意图判定）
src/client.bundle.js    客户端（PolishButton/PolishSettings + 事件总线 + startPolishSubagent 子代理打磨）
tests/unit.test.mjs     32 例单测（node --test）
scripts/smoke-apply.mjs 服务端 apply 冒烟（真 apply + 假 cordis ctx，16 断言）
docs/decisions.md       设计决策记录
docs/sidebar-integration.md  联动层集成指南
```
## 架构概览

本插件按职责划分为以下子层:

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `src/index.js` | DSH host 半边挂载点 + trust fence 围栏 |
| API 路由 | `src/api.js` | `/api/polish` `/api/config` `/api/traces.recent` `/api/apply-report` 方法表 |
| 上下文 | `src/context-assembler.js` | C 方案: deriveMessages + requestHeader 复刻 `[system]+[history]` |
| 表面 | `src/surface-fold.js` | partial 降级时 readSurface 读近期对话 |
| 意图 | `src/intent.js` | 4 类意图骨架: debug / implement / explain / chat |
| 流组装 | `src/polish.js` | 拼请求 + 调 ctx.llm.stream + 清洗 |
| Trace | `src/trace-recorder.js` | 每次调用追加 JSONL 到 `lore/traces/prompt-polish/YYYY-MM-DD.jsonl` |
| 错误细分 | `src/wire.js` + `src/api.js` | rejected / no-session / route-unavailable / stream-failed / empty-result / context-fallback / settings-unavailable |
| 主路径 | `src/taskbook.js` + `src/api.js#polish.start` | 任务书 → `ctx.subagents.startContinuable`（continuable 子代理） |
| 客户端 | `src/client.bundle.js` | PolishButton + PolishSettings + 事件总线 + startPolishSubagent |

构建流程: `src/*.js` → `scripts/build.mjs` 直拷 → `lib/*.js` (md5 一致; 用 `scripts/preflight.sh` 防回归)。

## 测试策略

- **单元测试**: `node --test tests/unit.test.mjs` (32 用例, 全绿)
- **Preflight**: `bash scripts/preflight.sh` (build 前 5 关: 语法 / 大小无异常翻倍 / 单一 __ModuleLoader__.load / 核心防御未丢 / better-sidebar 耦合为 0)
- **apply 冒烟**: `node scripts/smoke-apply.mjs` (真 apply + 假 cordis ctx: 围栏 403 / 405 / polish.start 200 / no-live-agent 409 / rejected 400)
- **端到端**: DSH web 装上 plugin → 主框输入草稿 → 点 ✨ → **子代理会话被打开**（任务书进首轮）→ 多轮追问 → 手动复制回填
- **回归**: 8/27 incident 教训——client.bundle.js 56K 重复 bug, 由 preflight 关 3 (单一 `__ModuleLoader__.load`) 防回归; 关 4 守 slots 服务防御

## 故障排查

| 现象 | 可能原因 | 处置 |
|---|---|---|
| 点 ✨ 报「sessions 服务未注入」 | 客户端插件未挂载（0.1.5 需重启生效） | 重启 DSH Web 后刷新页面 |
| 点 ✨ 报「主会话没有 live agent」 | 会话未激活 / agent 已被回收 | 在当前会话里重试 |
| 报「子代理已创建但客户端目录未就绪」 | 客户端会话目录刷新延迟 | 在会话列表的「子代理」目录里手动打开该 childId |
| 子代理起不来 | 内核缺 `ctx.subagents` / provider 未注册 | `dsh --profile web --dump-config \| grep subagent` 核对 |
| 提示词无变化 | strictFull=true 但会话非 live | 改 strictFull=false (允许降级到 partial/none) |
| 草稿被覆盖 | 草稿在 polish 期间被用户改了 | CAS 拒绝覆盖, 重试时用最新草稿 |
| TRACE 太大 | 没设置 pageSize 限制 | 设置页可关 / 设保留天数 |
| slots 注入失败 (console.warn) | DSH 启动顺序 race | 正常降级, 主壳照常加载, ✨ 与设置页暂时不可见 |

## 前置依赖

**无第三方依赖（0.2.0 起）**。主路径需要内核提供 `ctx.subagents`（continuable 子代理）与
`ctx.sessions.openSubagent`；本部署（DSH 0.1.5-rc.2）已具备。子代理 provider 默认 `fork`
（`dsh-subagent-fork-in-process`，seed 母会话已完成轮），可在设置里切 `spawn`（全新子代理）。

```bash
# 自检：两个 provider 在组合树里
dsh --profile web --dump-config | grep -A2 subagent
```

**降级说明**: `/api/polish` 单次直调路径仍在（事件总线 / headless / 自动化用），但**主框 ✨
不会**在子代理失败时退到它（红线 9）。
