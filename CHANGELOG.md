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
