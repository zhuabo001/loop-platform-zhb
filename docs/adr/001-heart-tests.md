# ADR-001：心脏测试——Run 生命周期的可靠性语义先行

- 状态：Accepted
- 日期：2026-07-23
- 关联：docs/roadmap.md Phase 1

## 背景

Loop 平台的全部价值建立在一条链路上：调度产生 pending run → 本机 daemon 领取 → 执行 → 回报终态。
这条链路天然暴露在四类故障下：HTTP 重试、并发领取、server 重启、笔记本休眠。
参考实现（loop-platform）的线上事故史表明：这些故障的修复无法事后叠加——幂等语义、租约状态机、
reconcile 分支必须在第一版数据模型中就位，否则后续每个可靠性阶段都在打补丁。

## 决策

以下三个机制进入第一版数据模型与协议，**先于** cron、真实 Agent 与任何 UI：

1. **原子 claim**：`pending → running` 的领取是单条
   `UPDATE runs SET state='running', ... WHERE state='pending' RETURNING`。
   禁止「先 SELECT 再 UPDATE」。数据库是唯一仲裁者，不靠应用层锁。
2. **持久化 RunLease**：每次 run 颁发仅授权本次 run 的租约凭证（存哈希，不存本体），
   携带状态机 `active → terminal-grace`：
   - server 的不活跃清扫（sweep）回收疑似死掉的 run 时，**不立即判负**，而是把 lease 翻为
     `terminal-grace`（24h 宽限）；
   - `report()` 在 `phase=error 且 lease=terminal-grace` 时放行**恰好一次**迟到回报：
     成功则把误判的失败翻正为 done，真失败则替换通用回收原因；放行后租约销毁。
   - lease 落库（`run_leases` 表），server 重启对在途 run 透明。
3. **幂等 report + 写前拦截**：终态 report 可安全重复（第二次为 no-op）；
   已取消 run 的迟到 report 在任何 loop 级写入（游标推进、任务文件内容）**之前**被丢弃。

## 心脏测试清单（Phase 1 完成标准）

| # | 名称 | Given / When / Then |
|---|---|---|
| T1 | 并发 claim 唯一 | 同一 pending run，N 个并发 `poll` | 恰好 1 个 200 拿到 run，其余空手 | run 只被执行一次 |
| T2 | 重复 poll 不重复执行 | daemon 已领取 run 后网络重试同一 poll | 再次 poll | 不返回已 running 的 run，不生成第二条 run 行 |
| T3 | 重复 report 幂等 | run 已 done | 同一结果再次 `report` | 状态不变、副作用（通知/游标）不重复，返回 no-op 语义 |
| T4 | server 重启不丢在途 run | run 处于 running，lease 已落库 | server 进程重启 | run 不被误判失败；daemon 后续 report 正常受理 |
| T5 | 休眠迟到 report 翻正误判 | run 被 sweep 回收为失败（lease=terminal-grace） | daemon 醒来上报真实成功结果 | run 翻正为 done，记录消息/产物，lease 销毁；第二次迟到 report 被拒 |
| T6 | 取消的 run 迟到 report 被拦截 | run 已被 owner 取消 | 迟到 report 到达 | 在任何 loop 级写入之前被丢弃，游标/任务文件不动 |
| T7 | 下一次触发 supersede 陈旧 pending | pending run 一直未被领取 | 下一次调度触发到达 | 旧 pending 转为 skipped（不计失败、不告警），新 pending 入队 |

## 通过标准

T1–T7 全部绿，才允许开始 Phase 2（cron 调度）。测试使用 PGlite + 内存 BlobStore + Fake Clock，
不需要真实 Agent 与真实网络。

## 后果

- 正面：可靠性成为骨架属性而非补丁；后续 cron/Agent/同步全部建立在已验证语义上。
- 代价：第一周没有「看得见的」功能（无 UI、无真实 Agent）；需要克制提前做 cron 的冲动。
- 约束：claim 事务是热路径，索引设计（`runs(state)` 部分索引）随第一版 schema 一起交付。
