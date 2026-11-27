---
id: decision-tiers
title: "决策权限分级"
category: decision
status: active
tags: [governance, workflow]
created: "2026-11-13T23:25:20"
updated: "2026-11-13T23:25:26"
---

<!-- compiled_truth -->
## 决策权限分级（2026-11-13 起）

按「可逆性 × 影响面」分三级；Tier 1/2 自主推进，只有 Tier 3 等人确认。

- **Tier 1 — 自己做，做完报**：可逆、范围内、verify 通过。改本项目代码/测试/文档、跑既有 verify、修明确 bug、DCE、跑测量。完成后 `notify-main done` 一句话。
- **Tier 2 — 自己做、先记一条、再报**：改 runtime 语义、把已批准方向扩到更多文件、新增原语或入口。条件：仍在 brain 已写方向内、有数字/测试证据、可回滚。先 `scripts/decision add <项目> "<选择>" --evidence "<证据>" --reversible --tier 2`，再 notify，不等确认。
- **Tier 3 — 必须问**：发版、force-push、删数据、动 master/发布线、改网关或密钥、跳到新 pattern、跨项目影响、超出 brain 计划。先 `scripts/decision add --pending`，再 `notify-main blocked`，等一字确认。

判级顺序：能不能 `git revert`？不能 → Tier 3。在 brain 已批准方向内？不在 → Tier 3。碰 runtime 语义或扩面？是 → Tier 2。否则 Tier 1。

工具位置（跨项目约定，不在本仓）：决策日志用 `/home/gem/project/chat/scripts/decision`（写 `~/.local/state/ops/decisions.jsonl`）；通知用 `/home/gem/project/chat/scripts/notify-main <done|blocked|ask> "<一句话>"`。本仓没有 `scripts/decision`、`chat/` 或 `notify-main`，规则是跨项目治理，工具由 chat 仓提供。


## Timeline

- time: 2026-11-13T23:25:20
  kind: decision
  summary: "Created this page: 决策权限分级"
  source: main 2026-11-13
  affects: [decision-tiers]

- time: 2026-11-13T23:25:26
  kind: decision
  summary: "决策按可逆性与影响面分三级；Tier 1/2 自主，Tier 3 等人确认。"
  source: main 2026-11-13
  affects: [decision-tiers]
