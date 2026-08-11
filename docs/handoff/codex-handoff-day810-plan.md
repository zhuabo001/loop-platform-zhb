# Day 8–10 开发计划：故障注入与 Phase 1 收尾

## Summary

本批完成三件事：

- 交付生产可用的 inactivity Sweep，将失联 `running` Run 回收为可观察 `error`，保留 24h 单次迟到回报窗口。
- 新增本地 owner cancel HTTP 接口，确保取消立即撤销 Run Capability。
- 从 HTTP、文件数据库和真实 daemon runtime 接缝完成 T4–T6 故障注入，正式关闭 Phase 1。

不新增数据库表或迁移，不实现 cron、真实 Agent、progress 写入、认证、通知或持久化 report outbox。

## Interface 与实现变更

### 1. Inactivity Sweep 深模块

新增窄接口：

```ts
interface InactivitySweep {
  runOnce(): Promise<{
    scanned: number;
    reclaimed: number;
    pruned: number;
    failed: number;
  }>;
}
```

行为固定为：

- 只扫描 `running` Run；候选读取采用明确列投影和有界分页。
- Run 最近活动时间为 `max(run.ts, run.progress.at)`。
- 无效时间戳不构成活跃证据；容忍 5 分钟内的近未来时钟偏差，远未来污染值不能让 Run 永久存活。
- 活动时间达到 20 分钟超时边界时调用既有 `reclaimStaleRunTx`。
- Machine Heartbeat Watermark 必须通过 `classifyHeartbeatWatermark` / `heartbeatAgeMs` 分类，用于诊断；即使 Machine 心跳新鲜，也不能阻止自身已超时的 Run 被回收，保证 Delivery 响应丢失最终收敛。
- 单个异常候选失败不得阻塞同批其他 Run；记录安全日志并增加 `failed`。
- 同一 Sweep 实例的重叠 `runOnce()` 合并到同一个进行中 Promise，不重复扫描。
- 每次 Sweep 同时清除已经到期的 `terminal-grace` Lease；`now >= expiresAt` 即过期。
- `terminal-grace` 的 `expiresAt` 缺失或非法时 fail closed，删除 Lease；report 的读取和事务内复核同步执行该规则。
- `active` Lease 不按时间清理，仍只能由 report、cancel 或 reclaim 转换。

生产接线：

- 默认 Run inactivity timeout：20 分钟。
- 默认 Sweep interval：30 秒。
- 阈值通过模块构造依赖注入供测试覆盖，本批不新增环境变量。
- HTTP listener 成功启动后立即异步执行一次 Sweep，再启动 `unref()` interval。
- shutdown 顺序改为：停止 Sweep timer → 关闭 HTTP → 关闭数据库。
- timer tick 捕获异常并继续后续周期；Sweep 不暴露 HTTP 触发接口。

### 2. Owner cancel 深模块与管理接口

新增独立的 owner-control 模块，直接消费 `cancelRunTx`，不扩大 `RunCoordinator` 的三方法接口，也不让 HTTP 接触 Lease 状态机。

新增接口：

`POST /api/runs/:id/cancel`

请求：

- 空 body 归一化为 `{}`。
- protocol 新增 tolerant-reader `cancelRunRequestSchema`。
- 继续使用 2 MiB body cap。

响应：

- `200 {canceled:true}`：Run 从 `pending/running` 转为 `canceled`，同事务删除 Lease。
- `200 {canceled:false,reason:"not_cancelable"}`：Run 已经是终态；重复取消效果幂等。
- `404 {error:"not found"}`：Run 不存在。
- malformed/non-object JSON 返回 400，超大 body 返回 413。

protocol 新增对应的 `cancelRunResponseSchema`。`createServerApp` 增加第三个依赖 `ownerControl`；生产 boot 负责接线。非 loopback 无认证警告覆盖 `/api/runs/*`。

### 3. 保持结构性约束

- `terminal-grace` 仍只能由 Sweep 内部调用 `reclaimStaleRunTx` 产生。
- 不导出通用 `terminalizeLease`。
- `RunCoordinator` 公开键集保持 `enqueueExecRun / poll / report`。
- cancel 不写 `outcome/message/error`，不推进 Loop state，不产生通知。
- Sweep/reconcile/cancel 的时间全部来自注入的 `Clock`。
- 不修改现有 schema；无需生成 migration。

## TDD 实施顺序

### Slice A：Sweep 与 T5

先写失败测试，再实现最小 Sweep：

- 超时前一毫秒保留，等于超时边界时 reclaim。
- `progress.at` 比 `run.ts` 新时延后 reclaim。
- fresh Machine heartbeat 不阻止 stale Run reclaim。
- anomalous-future `lastSeen` 不构成存活证据。
- reclaim 后 Run 为 `error/error`，Lease 为首次 `terminal-grace + now+24h`。
- 重复 Sweep 不延长 grace。
- 到期、空或非法 expiry 被清理；未到期 Lease 保留。
- 一个不满足 `running + active lease` 的异常候选不阻塞其他合法候选。

随后完成完整 T5：

1. daemon 通过 HTTP 领取 Run，测试 Runner 在执行中被 gate 暂停，模拟休眠。
2. Fake Clock 推进超过 20 分钟，调用真实 `Sweep.runOnce()`。
3. GET Run 观察到 `error`。
4. Runner 醒来返回成功，daemon 用原 Run Credential report。
5. Run 翻正为 `done/exec`，真实 message 被保留，响应含 `reconciled:true`。
6. 相同 Credential 第二次 report 返回 coded 401。

追加 Delivery 响应丢失场景：server 已 claim，但客户端丢弃响应；Machine 后续 poll 保持心跳新鲜，Sweep 仍最终将孤儿 Run 回收为可观察错误，且从未重派。

### Slice B：Owner cancel 与 T6

先写 protocol、HTTP 和完整链路红测，再实现 owner-control：

1. daemon 领取 Run，Runner gate 暂停。
2. owner 调用 cancel HTTP，收到 `{canceled:true}`。
3. Run 变为 `canceled`，Capability 同事务撤销。
4. Runner 迟到成功 report 得到 coded 401；daemon 将其视为终态确认并清空 pending report。
5. GET Run 仍是 `canceled`；Run 终态字段和 Loop 快照没有迟到写入。
6. 覆盖 pending cancel、重复 cancel、已完成 Run、未知 Run、malformed body 和 413。
7. 保留既有 report/cancel 事务交错测试，证明事务内二次校验仍能拦截竞态。

### Slice C：T4 完整重启验证

T4 是既有持久化能力的强化验收，不为制造红测而修改实现：

1. 使用文件 PGlite 启动 server A。
2. 真实 daemon runtime 经 HTTP 领取 Run，Runner gate 暂停并持有 Run Credential。
3. 关闭 server A 和数据库，以相同 dataDir 启动 server B。
4. 释放 Runner，使 report 发往 server B。
5. 验证 report 成功、Run 为 `done`、Capability 被消费，重复 report 为 401。
6. 验证 server B 启动时的立即 Sweep 不会误回收尚未达到超时阈值的在途 Run。

## Final verification

完成后必须全部通过：

- ADR-001 T1–T6 全绿，T7 coordinator 测试继续全绿。
- protocol、daemon、server 全量测试。
- `pnpm -r typecheck`
- `pnpm -r test`
- `pnpm -r build`
- `pnpm --filter @loopzhb/server db:check`
- `git diff --check`

最后新增 Day8–10 goal/completion handoff，记录新增接口、默认时间参数、完整故障注入结果和测试总数，并将 roadmap 的 Phase 1 标记为完成。

## Assumptions

- 本批测试接缝采用已确认的“分层黑盒”：HTTP + 文件 PGlite + 真实 daemon runtime，同时以 `Sweep.runOnce()` 精确覆盖时间边界。
- owner cancel 在本批交付本地无认证 HTTP 接口；仍只能部署在 localhost/受信网络。
- Machine 心跳只提供诊断信息，不是 stale Run 的否决条件。
- Phase 2 才让真实 AgentRunner 发送 progress heartbeat；Day8–10 只消费已有 `progress.at` 语义。
