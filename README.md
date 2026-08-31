# narrative-prompt-polish

Shengyv's Writing Architecture 的提示词优化插件：主会话输入框右座 ✨ 一键把草稿
改写成清晰、具体、可直接交给 AI Agent 执行的提示词——并可在侧栏对话中与 Agent
多轮打磨，满意后手动回填主输入框。

## 核心特性
- **主框 ✨ → 侧栏对话打磨（默认主流程，0.0.20+）**：点击主框 ✨ 不再直接改草稿，
  而是启动 better-sidebar 侧边对话（sidechat 子会话）——继承主会话完整上下文 +
  preset/provider/model，任务书投递后 Agent 在侧栏开始打磨；可多轮追问，满意后
  用 SideChatView 自带复制按钮手动回填主输入框。better-sidebar 不可用时直接报错
  （红线：不兑底到普通单次 polish）。
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
- **sidebar 浮按钮（已停用，0.0.25）**：0.0.15 起 UI 收口为「仅主框 ✨」——sidechat 等
  侧栏输入框不再挂悬浮按钮；配置项 `sidebarFloatingButtonEnabled` 保留向后兼容（默认 false，
  设置页可手动开启）。

## 红线遵守
- 不写主会话历史：无 append、`llm.stream` 不传 sessionId（不进会话调度）。
- 无野生 DOM 注入：UI 走官方 slot `conversation.input.right` + `settings.section`。
- 服务端零 `@deepseek-ai/*` 静态 import（dsh-session 仅离线路径动态 import 且失败自动降级），
  杜绝缺依赖崩 web。

## API
| 方法 | 说明 |
|---|---|
| `POST /narrative-prompt-polish/api/polish` | `{sessionId,text,mode?,strictFull?,triggerSource?,mergeSidebarContext?,sidebarContext?}`（单次 polish 路径；侧栏对话打磨走 better-sidebar sidechat） |
| `POST .../api/config` `/config.get` `/config.update` | 配置读改（settings 服务缺位时 update 返回 503） |
| `POST .../api/traces.recent` | `{limit}` 最近 trace |
| `POST .../api/apply-report` | 客户端 CAS 结果回传（applied/changed），trace 行按 traceTs 配对 |

## 独立安装（GitHub）
```bash
dsh plugin --profile web add github:shengyvself/narrative-prompt-polish
# 或克隆后：
dsh plugin --profile web add ./narrative-prompt-polish
```
安装后重启 DSH Web 即生效。依赖 better-sidebar（侧栏对话打磨主流程）；默认配置开箱即用
（模型跟随当前会话；trace 写入 `<cwd>/lore/traces/prompt-polish/`，可在设置页改为绝对路径锚定你的工作区）。

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
src/client.bundle.js    客户端（PolishButton/PolishSettings/SidebarBridge + moduleStartInteractivePolish 侧栏对话打磨）
tests/unit.test.mjs     24 例单测（node --test）
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
| 客户端 | `src/client.bundle.js` | PolishButton + PolishSettings + SidebarBridge + moduleStartInteractivePolish |

构建流程: `src/*.js` → `scripts/build.mjs` 直拷 → `lib/*.js` (md5 一致; 用 `scripts/preflight.sh` 防回归)。

## 测试策略

- **单元测试**: `node --test tests/unit.test.mjs` (24 用例, 全绿)
- **Preflight**: `bash scripts/preflight.sh` (build 前 4 关: 语法 / 大小无异常翻倍 / 单一 __ModuleLoader__.load / 核心防御未丢)
- **端到端**: DSH web 装上 plugin → 主框输入草稿 → 点 ✨ → 侧栏对话弹出 → Agent 打磨 → 手动复制回填
- **回归**: 8/27 incident 教训——client.bundle.js 56K 重复 bug, 由 preflight 关 3 (单一 `__ModuleLoader__.load`) 防回归; 关 4 守 slots 服务防御

## 故障排查

| 现象 | 可能原因 | 处置 |
|---|---|---|
| 点 ✨ 没反应 | better-sidebar 未装 / 版本 < 0.16.1 | 装 omdsh-dev/DSH-better-sidebar, 版本升到 0.16.1+ |
| 侧栏对话弹出但 Agent 不响应 | 主会话 agent 不在线 / preset 未选 | 切回主会话, 在 Settings 选 preset |
| 提示词无变化 | strictFull=true 但会话非 live | 改 strictFull=false (允许降级到 partial/none) |
| 草稿被覆盖 | 草稿在 polish 期间被用户改了 | CAS 拒绝覆盖, 重试时用最新草稿 |
| TRACE 太大 | 没设置 pageSize 限制 | 设置页可关 / 设保留天数 |
| slots 注入失败 (console.warn) | DSH 启动顺序 race | 正常降级, 主壳照常加载, ✨ 与设置页暂时不可见 |

## 前置依赖

**必装**: `omdsh-dev/DSH-better-sidebar` (>=0.16.1)

本插件 0.0.20+ 的「点 ✨ → 侧栏对话打磨」主流程强依赖 better-sidebar。better-sidebar 缺失或版本低于 0.16.1 时, 插件**会显式报错**（不静默兑底到单次 polish 路径——这违背产品决策）。

```bash
dsh plugin --profile web add github:omdsh-dev/DSH-better-sidebar
sudo systemctl restart dsh-web
# 装完验证
dsh --profile web --dump-config | grep better-sidebar
```

**非必装但推荐**: 若 better-sidebar 不可用, `/api/polish` 单次路径仍可工作 (直接调 LLM, 不经侧栏); 此时适合 headless / 自动化场景, 但失去多轮打磨能力。
