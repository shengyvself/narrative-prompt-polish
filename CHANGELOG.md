# narrative-prompt-polish 变更日志

格式：YYYY-MM-DD HH:MM — 一句话描述

## 2026-08-31 — v0.1.0 首个语义化里程碑：侧栏润色链路可靠性修复

- **{{model}} 装配失败修复（2026-08-31 两轮）**：侧栏润色（sidechat.start 链路）在父会话被
  dsh-autoresume 冷恢复（其 resume 不传 agentOptions → 父 options 为空）后，子代理继承
  `{...parent.options}` 空对象 → 首轮装配报 `prompt variable "{{model}}" has no value
  (section "deployment:persona")`，润色任务无法执行。
  - 根因：`{{model}}` 主来源为 dsh-agent-loop 全局变量 `ctx.agent?.options.model`
    （dsh-agent-loop 1024-1026 行）；sidechat 路径不装 installModelSelection，纯靠 options。
  - 修复（集成层，本插件源码 0 改动）：better-sidebar 新增 `resolveChildAgentOptions`
    （父 options 缺 provider/model 时用部署默认模型补齐，descriptor 同步）+ `sidechat.prompt`
    冷恢复补 `agentOptions`（`resolveThreadAgentOptions`：优先取持久化 descriptor 路由，
    回退部署默认）；dsh-autoresume `resumeSession` 补 `agentOptions`（根除父会话空 options 复发）。
  - 验证：E2E 修复前复现（sidechat.start 子线程同错）→ 修复后原失败线程重试
    turn 8 `completed` 并产出润色结果；新线程首轮 request/header 带
    tokenrhythm/deepseek-v4-flash-0731；dsh-web 重启 Result=success、3 连测 200；
    node --check ×2 / autoresume build.mjs 通过。
- **版本语义**：0.0.x 系列收敛为 0.1.0——核心功能与链路定型（主框 ✨ → 侧栏打磨主流程、
  C 方案 prompt-cache、意图骨架、CAS 写回、trace 落盘），本版本含集成链路可靠性修复。
- **行为变更**：0（无 API/配置/流程变化）。上游集成注意事项：集成层补丁记录
  `PATCH-record-20260831-better-sidebar-model-var.md`（better-sidebar /
  dsh-autoresume 升级后需按记录重打补丁）。

## 2026-08-31 — v0.0.27 上游归属清理
- 全文档/源码移除 Max-Null / LCQ-1024 / peterliucius 归属表述与 5 层 baseline / 三家并取段落
- README 重写：去掉「与三家上游的关系」表 + Credits 段
- NOTICE 整文件删除；package.json `files` 数组同步去掉
- decisions.md 重写为纯内部设计取舍（不再附上游对比）
- CHANGELOG 0.0.5-0.0.7 条目改为「子层分解定型」
- src/* 注释去掉「血统」「baseline」「同款」等归属词；技术名词（trust-fence / readSurface / CAS / 意图骨架）保留
- 0 行为变更；preflight + build 通过

## 2026-08-27 14:25 — preflight + 已知能跑状态封存
- scripts/preflight.sh：build 前必过三关（语法 / 文件大小无异常翻倍 / 单一 __ModuleLoader__.load 顶层调用），失败 exit 1
- scripts/build.mjs 顶部接入 preflight；任何 ship 必先自检
- 当前 client.bundle.js 状态封存为健康标签：md5=a45b57b3...，34546 字节，含 2 处「slots service unavailable at boot」（shengyvself 补）

## 2026-08-27 ~14:10 — polish 0.0.8 shipped
- 主框按钮重定义：单击 ✨ 永远进入侧栏对话打磨模式（不再预生成单次润色结果）
- moduleStartInteractivePolish 流程：openTab(autoCreate) + 轮询 getTabs 捕获新 threadId + sidechat.prompt 投递任务书 + layout.toggleSidebar 强制展开侧栏
- 任务书加「【作者验证提示】」指令：让模型第一轮回复开头复述继承背景

## 2026-08-26 — polish 0.0.5~0.0.7（事件密集期；详情见维护会话 §十七与本模块外发 incident report）

## 2026-08-26 ~22:00 — v0.0.5~v0.0.7（事件密集期）
- 子层划分定型：trust-fence / 4 类意图骨架 / CAS 写回 / wire 信封 / 失败降级
- 详见 `docs/decisions.md`

## 2026-08-27 ~10:30 — v0.0.9 全域扫描
- 引入 `~/.dsh/sessions` 全域扫描（24h 窗口内），替代单目标模式
- 持久化事件流判定状态:interrupted / network-stopped / completed / settled
- 详见 `docs/decisions.md` §2

## 2026-08-27 ~13:00 — v0.0.10~v0.0.13 三档降级链
- full → partial(readSurface) → none(裸草稿) 三档降级链引入
- strictFull 可硬失败
- 8/27 13:08 incident 修复: client.bundle.js 56K 重复 bug → 回滚 + 加 preflight 关 3 防回归
- 详见 `运维/npp-incident-report-2026-08-27.md` (历史归档)

## 2026-08-27 ~14:48 — v0.0.13-now slots 服务防御
- 两处 `ctx.slots.inject` 加 try/catch 包裹（slots 服务未就位时仅 warn 一行）
- features: "slots service unavailable at boot" 字符串 2 处
- 8/27 incident 14:48 修复闭合

## 2026-08-27 ~16:00 — v0.0.14~v0.0.18 侧栏联动
- moduleStartInteractivePolish 流程引入: openTab(autoCreate) + 轮询 getTabs 捕获新 threadId
- sidechat.prompt 投递任务书
- layout.toggleSidebar 强制展开侧栏
- 任务书加「【作者验证提示】」指令：让模型第一轮回复开头复述继承背景

## 2026-08-28 ~12:00 — v0.0.19~v0.0.25 sidebar float 收口
- sidebar 浮按钮（主流程外的小入口）从默认开启 → 0.0.25 停用
- 配置项 `sidebarFloatingButtonEnabled` 保留向后兼容（默认 false, 设置页可手动开启）
- UI 收口为「仅主框 ✨」单一入口
- v0.0.25: 文档 / 注释 / CHANGELOG 同步
