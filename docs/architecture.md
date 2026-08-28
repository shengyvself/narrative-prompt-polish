# Architecture — narrative-prompt-polish

> 适用于想理解 / 改本插件源码的开发者。

## 数据流（点 ✨ → 侧栏对话）

```
[composer 草稿]
    │
    │ 1. 点 ✨
    ▼
[PolishButton.click]
    │
    │ 2. event:trigger 'narrative:prompt-polish:trigger'
    ▼
[SidebarBridge (client.bundle.js)]
    │
    │ 3. sidechat.start (HTTP) → 起子代理
    │ 4. openTab(autoCreate) + seed.path 触发 better-sidebar 展开
    │ 5. 轮询 getTabs 捕获新 threadId
    │ 6. updateTab (种 threadId 绕开 better-sidebar 0.16.1 守卫)
    │ 7. sidechat.prompt 投递任务书
    │ 8. layout.toggleSidebar 强制展开
    ▼
[SideChatView (better-sidebar)]
    │
    │ 9. Agent 多轮打磨
    ▼
[用户复制终稿] → [手动回填主输入框]
```

## 服务端 API 路由（src/api.js）

| 方法 | 路由 | 作用 |
|---|---|---|
| POST | `/narrative-prompt-polish/api/polish` | 单次 polish（{sessionId, text, mode?, strictFull?, triggerSource?, ...}） |
| POST | `/.../api/config` | 配置读 |
| POST | `/.../api/config.update` | 配置写 |
| POST | `/.../api/traces.recent` | 拉最近 trace |
| POST | `/.../api/apply-report` | CAS 写回结果回传 |

## 错误细分（src/wire.js 分类）

| code | 触发条件 | 用户提示 |
|---|---|---|
| rejected.empty | 草稿为空 | 「草稿为空, 请先输入再点 ✨」 |
| rejected.references | 草稿含 1k+ 引用块 | 「草稿含大量引用, polish 可能偏离意图」 |
| rejected.too-large | 草稿超 maxDraftChars | 「草稿过长, 请先精简」 |
| no-session | sessionId 找不到主会话 | 「会话已关闭, 重新打开再试」 |
| route-unavailable | ctx.llm.stream 不可达 | 「模型路由不可用, 请检查 provider/model 配置」 |
| stream-failed | LLM stream 异常中断 | 「生成中断, 重试或换模型」 |
| empty-result | LLM 返回 0 字符 | 「润色为空, 请重试或调整草稿」 |
| context-fallback | full → partial → none 降级 | (透明, 响应里 fallbackReasons 留痕) |
| settings-unavailable | 设置项读不到 | 「设置不可用, 用默认配置」 |

## Trace 落盘（src/trace-recorder.js）

每次调用追加一行 JSONL 到 `lore/traces/prompt-polish/YYYY-MM-DD.jsonl`:

```json
{
  "ts": "ISO",
  "sessionId": "...",
  "triggerSource": "main|sidebar|api",
  "intent": "debug|implement|explain|chat",
  "draftLength": 20,
  "draftHash": "sha256[:16]",
  "contextMode": "full|partial|none",
  "historyCount": 0,
  "fallbacks": ["..."],
  "sidebarContextMerged": false,
  "systemPromptHash": "sha256[:16]",
  "systemSource": "intent-skeleton|requestHeader",
  "messagesHash": "sha256[:16]",
  "model": "...",
  "provider": "...",
  "cacheHit": true|false,
  "inputTokens": 0,
  "outputTokens": 0,
  "durationMs": 0,
  "resultLength": 0,
  "applied": true|false,
  "error": null|"code"
}
```

`hash` 字段不落全文（隐私）。
