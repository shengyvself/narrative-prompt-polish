# 决策记录：三家源码对比与本插件取舍

> 源码基线（2026-08-26 读毕）：Max-Null/dsh-draft-polish@0.2.1、LCQ-1024/dsh-prompt-enhancer@0.2.13、peterliucius/dsh-prompt-optimize（master）。本机 DSH 接口探测同日完成。

## 1. 整体架构选型：HTTP prefix 路由（Max-Null 形态）
- Max-Null：webServer.register({kind:"prefix"}) + trust fence + wire 信封。测试可直接驱动方法表，无需 cordis 运行时。
- peterliucius：TypertRemoteService/Remote RPC（强类型漂亮但依赖 dsh-typert-protocol 服务端包，违反本项目「零 @deepseek-ai 服务端静态依赖」红线）。
- LCQ：单 exact 路由 + remoteAddress loopback 判断（弱于 Host-header fence）。
- **取舍**：Max-Null 形态全盘继承；fence 用其完整版（Host authority + trustedHosts + sec-fetch-site + origin），不用 LCQ 的 remoteAddress 版。

## 2. LLM 直调消息构造：手写 vs @deepseek-ai/dsh-llm 导入
- LCQ/peterliucius import createUserMessage/BlockAssembler from "@deepseek-ai/dsh-llm"。
- Max-Null 手写 userMessage() + assembleText()（结构性 mirror）。
- **取舍**：手写（红线 2：服务端包必须在插件 node_modules 存在才允许装；dsh-llm 曾因 npm 无 rc.5 版本引发崩溃连锁）。行为等价：text-delta 累积 + finish.kind 校验一致。

## 3. 上下文策略：三档 contextMode
- Max-Null 只有 readSurface 折叠（≈我们的 partial）+可选 background 压缩。
- 设计文档要求 C 方案为默认差异化能力。
- **实测结论**：DSH 暴露 Session.deriveMessages()（deep-frozen 完整派生历史）与 requestHeader()（含渲染后的 system 与 config.provider/model）→ C 方案可行且实现简单。
- 非 live 会话：sessionQuery.readSession(id) raw log + foldRequestHeader/deriveEventMessage 离线重建（dsh-session 动态 import，失败降 partial）。
- partial 模式暂不做 background 压缩二次调用（Max-Null 有此增强）：保持单次直调的延迟可预测性；需要时可在 assembleContext 内加回。

## 4. 意图骨架：正则预分类 + 双落位
- LCQ v5 把四类组织法写进单一 system prompt 由模型自分类。
- 设计文档 INTENT_SIGNALS 用本地正则预分类。
- **取舍**：两者合体——本地 classifyIntent 选骨架；partial/none 时骨架即 system（LCQ 血统）；full 时骨架作为末尾 user 指令的组织要求（system 保持会话原文，前缀不动才命中 cache——这是对两家都没有的场景的新解法）。
- intentEnabled=false 回退 Max-Null POLISH_SYSTEM 单一指令。

## 5. CAS 写回：客户端职责
- peterliucius：captured=draftRef.current → 返回后比较 → toast changed 不覆盖；组件卸载 abort。
- **取舍**：原样采纳（ref 快照 + AbortController + aliveRef 三件套）；并扩展到 sidebar target（readTarget 快照 vs 回写前 readTarget）。

## 6. 错误细分：两家并集
- Max-Null：no-provider/stream-failed/empty-result/bad-request/not-found/settings-conflict/settings-rejected。
- peterliucius：session-not-found/route-unavailable/rejected{empty,references,too-large}。
- **取舍**：验收清单 6 种业务码 no-session/route-unavailable/rejected/stream-failed/empty-result/context-fallback 全部落地，另保留 bad-request/not-found/settings-unavailable/forbidden 基建码。context-fallback 在 strictFull 失败路径与组装异常路径出现；软降级走 fallbackReasons 字段不报错。

## 7. 引用 chip 拒绝
- peterliucius 发现 composer 引用占位符 U+FFFC 送模型会产生幽灵引用。
- **取舍**：照抄（draft 含 \uFFFC → rejected:references）。

## 8. inflight supersession
- peterliucius Map<sessionId,AbortController> 新请求废前请求。
- **取舍**：主框按钮由组件 abortRef 承担；sidebar bridge 按 target 记 inflight，同框新触发 abort 旧的。

## 9. 设置持久化：settings 服务优先、patch config 兜底
- Max-Null：settingsService.register(ns, schemastery schema)，注册失败防御式回退默认值。
- **取舍**：同构，但 schema 用纯 JSON Schema 形状且 register 包 try/catch——不引入 schemastery 硬依赖；settings 缺位时 config.update 返回 503 settings-unavailable（诚实暴露不可持久化，静默内存态会造成「重启丢配置」困惑）。

## 10. trace：文件不数据库
- 设计文档裁决：lore/traces/prompt-polish/YYYY-MM-DD.jsonl，与 lore 系统对齐可被 narrative 工具分析。
- hash 截断 sha256 前 16 位存指纹不存全文（上下文可能含敏感代码）；cacheHit 从 usage.prompt_cache_hit_tokens（DeepSeek 口径）尽力提取。

## 11. sidebar 联动：slot 缺失的现实
- 实测 better-sidebar 仅暴露 conversation.chat.turnTail / settings.section，无 floating-tools slot → 设计预设的分叉点落在 B 方案：MutationObserver 扫描 [data-dsh-better-sidebar] 宿主内的 textarea/[contenteditable]。
- 悬浮按钮挂插件自有 fixed 层（body 直挂 data-npp-float-layer），按 getBoundingClientRect 定位——不修改 DSH DOM，规避 React reconciliation 冲突。
- 通信 CustomEvent 总线（trigger/result），外部模块可不带 targetElement 广播 trigger 自理回写，或带 targetElement 由 bridge 代跑 CAS+回写。

## 12. 安全边界
- fence：Host loopback 或连接行 trustedHosts；cross-site/跨源 origin 拒绝（DNS rebinding 防御，非认证——Max-Null 同款声明）。
- 会话只读：deriveMessages/requestHeader/readSession/readSurface 全部只读投影；llm.stream 无 sessionId 参数——物理上不可能污染主会话历史。
- 密钥零接触：provider/model 继承自会话 header 或用户显式配置，无任何凭据读写。