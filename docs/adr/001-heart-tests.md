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
   `UPDATE runs SET phase='running', ... WHERE phase='pending' RETURNING`。
   禁止「先 SELECT 再 UPDATE」。数据库是唯一仲裁者，不靠应用层锁。
   **claim 与 RunLease 的持久化是同一个原子领取操作（同一事务）**——禁止出现
   `running` 状态的 run 没有对应 lease（有意偏离参考实现：参考的 claim 与
   lease 写入是两次独立调用）。
2. **持久化 RunLease**：每次 run 颁发仅授权本次 run 的租约凭证（存哈希，不存本体），
   携带状态机 `active → terminal-grace`：
   - server 的不活跃清扫（sweep）回收疑似死掉的 run 时，**不立即判负**，而是把 lease 翻为
     `terminal-grace`（24h 宽限）；
   - `report()` 在 `phase=error 且 lease=terminal-grace` 时放行**恰好一次**迟到回报：
     成功则把误判的失败翻正为 done，真失败则替换通用回收原因；放行后租约销毁。
   - lease 落库（`run_leases` 表），server 重启对在途 run 透明。
3. **效果幂等 report + 写前拦截**：「幂等」严格指**效果幂等（at-most-once effects）**——
   重复 report 不改变已落库终态、不重复推进 loop 游标/任务文件、不重复产生副作用，
   但**不保证**重复请求获得与第一次相同的成功响应：正常 finalize 消费并删除
   RunLease，同一 token 的第二次 report 在 resolve 处 401（daemon 视 401 为已确认）。
   owner cancel 把 run 转为 `canceled` 并**在同一事务中撤销 lease**；report 与 cancel
   必须在各自事务中锁定同一 Run 行（或使用覆盖整个写入区间的 CAS），锁定/比较后才
   检查 phase 并进行任何 loop 级写入。这样迟到 report 才会在 token resolve 或并发
   guard 处失败，在游标推进、任务文件内容等写入之前被拦截。

## 投递保证（MVP：at-most-once execution）

- poll 的原子 claim 保证同一 run 不被两台机器/两个 poll 重复领取。
- server 完成 claim 但 Delivery HTTP 响应丢失时，MVP **不自动重新派发**：该 run
  最终由 sweep 进入可观察的失败状态。Agent 可能产生外部副作用，自动重派比显式
  失败更危险。
- 因此本系统的精确承诺是：**run 不重复执行；未成功交付或未完成的 run 最终进入
  可观察的失败状态，不得静默消失；已成功提交的最终报告不因 HTTP 重试产生重复
  副作用。**
- 未来若要求 Delivery 丢包后仍保证执行，需另行设计 claim request ID、可重放
  Delivery 与可重建/加密保存的 run token——不进入当前 MVP。

## 心脏测试清单（Phase 1 完成标准）

| # | 名称 | Given / When / Then |
|---|---|---|
| T1 | 并发 claim 唯一 | 同一 pending run，N 个并发 `poll` | 恰好 1 个 200 拿到 run，其余空手 | run 只被执行一次 |
| T2 | 重复 poll 不重复执行 | daemon 已领取 run 后网络重试同一 poll | 再次 poll | 不返回已 running 的 run，不生成第二条 run 行 |
| T3 | 重复 report 效果幂等 | 第一次 report 已成功落库、lease 已 retire | 同一 token 再次 `report` | resolve 处 401；run/loop 状态与全部副作用（通知/游标）保持不变 |
| T4 | server 重启不丢在途 run | run 处于 running，lease 已落库 | server 进程重启 | run 不被误判失败；daemon 后续 report 正常受理 |
| T5 | 休眠迟到 report 翻正误判 | run 被 sweep 回收为失败（lease=terminal-grace） | daemon 醒来上报真实成功结果 | run 翻正为 done，记录消息/产物，lease 销毁；第二次迟到 report 在 resolve 处 401 |
| T6 | 取消的 run 迟到 report 被拦截 | owner cancel：run 转 `canceled` 且 lease 在同一事务中撤销 | 迟到 report 到达 | token resolve 或事务锁/CAS guard 处失败；游标/任务文件/loop 配置/通知均不变；cancel 后 run-token 的一切写操作失效（Phase 1 的 run-token 表面只有 report；set-\*/reschedule/finish 随其所在阶段落地时继承此规则） |
| T7 | 下一次触发 supersede 陈旧 pending | pending run 一直未被领取 | 下一次触发到达（Phase 1 为手动 trigger，coordinator 级测试；cron 阶段继承同一语义） | 旧 pending 转为 skipped（不计失败、不告警），新 pending 入队 |

## 通过标准

**T1–T6 全部绿是 Phase 1 的强制验收门**；T7 为 coordinator 级测试，随 Day 3–4 的
`supersedePendingRun` 一同交付（Phase 1 无 cron，手动 trigger 即「下一次触发」），
不构成进入 cron 阶段前的循环依赖。测试使用 PGlite + 内存 BlobStore + Fake Clock，
不需要真实 Agent 与真实网络。

## 后果

- 正面：可靠性成为骨架属性而非补丁；后续 cron/Agent/同步全部建立在已验证语义上。
- 代价：第一周没有「看得见的」功能（无 UI、无真实 Agent）；需要克制提前做 cron 的冲动。
- 约束：claim 事务是热路径，索引设计（`runs_pending_idx ON runs(machine_id) WHERE
  phase='pending'`）随第一版 schema 一起交付。

## 修订记录

- 2026-07-28：（1）T3 语义澄清——ADR-003 的租约级单发 retire 使第二次 report 在
  resolve 处 401，「幂等」统一为效果幂等（at-most-once effects），取代初版
  「第二次为 no-op」的措辞（该措辞在租约销毁模型下无法实现）。（2）cancel 权限
  收紧：cancel 与 lease 撤销同一事务，不再等待迟到 report 才 retire（原规定会在
  daemon 永不回报时留下永不过期且仍具控制能力的 active lease）。（3）验收门调整为
  T1–T6，T7 保留为 Phase 1 coordinator 级测试。（4）新增「投递保证」一节。
  （5）机制 1 补充 claim 与 lease 持久化为同一事务（有意的参考偏离）。
