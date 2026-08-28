# narrative-prompt-polish

Shengyv's Writing Architecture 的提示词优化插件：主会话输入框右座 ✨ 一键把草稿
改写成清晰、具体、可直接交给 AI Agent 执行的提示词——并可在侧栏对话中与 Agent
多轮打磨，满意后手动回填主输入框。

## 与三家上游的关系（各取所长，不依赖任何一家的缺陷）
| 来源 | 采纳 |
|---|---|
| Max-Null/dsh-draft-polish | 5 层工程 baseline：trust fence / surface 读取 / 消息过滤 / draft-last attention / 失败降级 |
| LCQ-1024/dsh-prompt-enhancer | 4 类意图骨架（debug/implement/explain/chat）作为 system prompt 与指令来源 |
| peterliucius/dsh-prompt-optimize | CAS 写回（captured !== current 即拒绝覆盖）+ 业务错误细分 + 引用 chip 拒绝 |
| 本插件新增 | C 方案全会话复刻（prompt cache）、trace JSONL、三档降级链、侧栏对话打磨 |

详见 `docs/decisions.md`（逐家对比）与设计文档
`narrative-studio/设计/narrative-prompt-polish-design.md`。

## 核心特性
- **主框 ✨ → 侧栏对话打磨（默认主流程，0.0.20+）**：点击主框 ✨ 不再直接改草稿，
  而是启动 better-sidebar 侧边对话（sidechat 子会话）——继承主会话完整上下文 +
  preset/provider/model，任务书投递后 Agent 在侧栏开始打磨；可多轮追问，满意后
  用 SideChatView 自带复制按钮手动回填主输入框。better-sidebar 不可用时直接报错
  （红线：不兑底到普通单次 polish）。
- **C 方案（full，默认）**：`ctx.sessions.get()` → `deriveMessages()` + `requestHeader().system/config`，
  完整复刻 `[system]+[...history]` 前缀直调 `ctx.llm.stream`——前缀与主会话一致即命中 prompt cache，
  只增量计算草稿与润色指令。非 live 会话走 `sessionQuery.readSession()` 离线折叠兜底。
- **降级链**：full → partial（readSurface 近期对话，Max-Null 风格）→ none（裸草稿），
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

## Credits & License

三家上游均为 MIT 许可，来源与采纳范围详见 [NOTICE](./NOTICE) 与 [docs/decisions.md](./docs/decisions.md)。本项目以 [MIT](./LICENSE) 发布。

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
docs/decisions.md       三家对比决策记录
docs/sidebar-integration.md  联动层集成指南
```