# narrative-prompt-polish 变更日志

格式：YYYY-MM-DD HH:MM — 一句话描述

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
- 5 层工程 baseline 选型完成：trust-fence (Max-Null) / 4 类意图骨架 (LCQ-1024) / CAS 写回 (peterliucius) 三家并取
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
