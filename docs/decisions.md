# 决策记录：narrative-prompt-polish 内部设计取舍

> 本文档只记录本插件**自身**的设计抉择与权衡依据；不再附上游对比。

## 1. 整体架构选型：HTTP prefix 路由
- 用 `webServer.register({kind:"prefix"})` + 信任围栏 + JSON 信封。
- 理由：测试可直接驱动方法表，无需 cordis 运行时；围栏与信封解耦便于纯函数单测。

## 2. LLM 直调消息构造：手写 userMessage / assembleText
- 不 import `@deepseek-ai/dsh-llm` 的 createUserMessage / BlockAssembler。
- 理由：服务端包必须真存在才允许装；该包曾因 npm 缺版本引发过崩溃连锁。行为等价：text-delta 累积 + finish.kind 校验一致。

## 3. 上下文策略：三档 contextMode
- `full`（默认）：`ctx.sessions.get().deriveMessages()` + `requestHeader().system/config` 复刻完整前缀直调 `ctx.llm.stream`——前缀与主会话一致即命中 prompt cache。
- `partial`：`sessionQuery.readSurface` 过滤折叠近期 user/assistant 段。
- `none`：只发草稿。
- 非 live 会话走 `sessionQuery.readSession(id)` raw log + foldRequestHeader/deriveEventMessage 离线重建（dsh-session 动态 import，失败降 partial）。
- partial 模式暂不做 background 压缩二次调用：保持单次直调的延迟可预测性；需要时可在 assembleContext 内加回。

## 4. 意图骨架：正则预分类 + 双落位
- 本地正则预分类 debug/implement/explain/chat。
- partial/none 时骨架进 system；full 时骨架作为末尾 user 指令的组织要求（system 保持会话原文，前缀不动才命中 cache）。
- `intentEnabled=false` 回退单一 POLISH_SYSTEM 指令。

## 5. CAS 写回：客户端职责
- `ref` 快照 + `AbortController` + `aliveRef` 三件套；并扩展到 sidebar target（`readTarget` 快照 vs 回写前 `readTarget`）。

## 6. 错误细分
- 业务码 `no-session / route-unavailable / rejected / stream-failed / empty-result / context-fallback` 全部落地。
- 另保留基建码 `bad-request / not-found / settings-unavailable / forbidden`。
- context-fallback 在 strictFull 失败路径与组装异常路径出现；软降级走 fallbackReasons 字段不报错。

## 7. 引用 chip 拒绝
- composer 引用占位符 U+FFFC 送模型会产生幽灵引用——草稿含 \uFFFC → `rejected:references`。

## 8. inflight supersession
- 主框按钮由组件 abortRef 承担；sidebar bridge 按 target 记 inflight，同框新触发 abort 旧的。

## 9. 设置持久化：settings 服务优先、patch config 兜底
- settingsService.register(ns, JSON Schema) + try/catch——不引入 schemastery 硬依赖；settings 缺位时 config.update 返回 503 settings-unavailable（诚实暴露不可持久化，静默内存态会造成「重启丢配置」困惑）。

## 10. trace：文件不数据库
- 落盘到 `lore/traces/prompt-polish/YYYY-MM-DD.jsonl`，与 lore 系统对齐可被 narrative 工具分析。
- hash 截断 sha256 前 16 位存指纹不存全文（上下文可能含敏感代码）；cacheHit 从 `usage.prompt_cache_hit_tokens` 尽力提取。

## 11. sidebar 联动：slot 缺失的现实
- 实测 better-sidebar 仅暴露 `conversation.chat.turnTail` / `settings.section`，无 floating-tools slot → 走 B 方案：MutationObserver 扫描宿主内的 textarea/[contenteditable]。
- 悬浮按钮挂插件自有 fixed 层（body 直挂 `data-npp-float-layer`），按 getBoundingClientRect 定位——不修改 DSH DOM，规避 React reconciliation 冲突。
- 通信 CustomEvent 总线（trigger/result），外部模块可不带 targetElement 广播 trigger 自理回写，或带 targetElement 由 bridge 代跑 CAS+回写。

## 12. 安全边界
- fence：Host loopback 或连接行 trustedHosts；cross-site/跨源 origin 拒绝（DNS rebinding 防御，非认证）。
- 会话只读：deriveMessages/requestHeader/readSession/readSurface 全部只读投影；llm.stream 无 sessionId 参数——物理上不可能污染主会话历史。
- 密钥零接触：provider/model 继承自会话 header 或用户显式配置，无任何凭据读写。
