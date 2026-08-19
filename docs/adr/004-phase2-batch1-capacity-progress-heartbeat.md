# ADR-004：Phase 2 批次一——执行容量与 progress 心跳

- 状态：Accepted
- 日期：2026-08-19
- 关联：docs/roadmap.md Phase 2 批次一（Day 1–2）；ADR-001（T5 progress 心跳证据）；ADR-002（决策 4：protocol 钉 shape、server 钉 size）
- 实现：分支 `codex/phase2-day-1-2`，红→绿成对提交

## 背景

Phase 2 把 daemon 从「串行 poll→执行」改为「poll/heartbeat 与执行解耦」，并让 server 在 poll 中接收 progress 心跳、按 `availableSlots` 限流交付。`runs.progress` 列与 sweep 的读取/CAS 防护在 Phase 1 已就绪，本批把 progress 从 parse-only 转正为活跃行为，并引入协作式执行容量信号。多轮计划评审（plan-review 两轮）与实现后代码评审（code-review 第一轮）的裁决一并记录。

## 决策

1. **执行容量固定 1，`inFlight ∪ queue ∪ pendingReports` 三位一体构成容量状态**：queued Run 仅在无执行中且无未确认 report 时启动。未确认 report 是占用容量，不是空闲时间——防旧 server 批量/异常响应下 pending report 堆积（plan-review 一轮修订 2）。
2. **`PollRequest.availableSlots?: 0|1` 是协作式背压信号，不是安全边界**：0 = busy（跳过 claim 扫描），1 = 至多交付一个（成功 claim 后 break，guard 输须继续），缺省（老 daemon）= 保留 Phase 1 批量 claim。错误发送 `1` 的最坏后果有界（每 poll 多交付一个 Run）；字段缺省回退无界批量——该字段防不住恶意或错误客户端，server 不为其做校验（plan-review 二轮 P3）。
3. **poll 携带 progress 心跳转正**（wire shape 不变）：
   - `at` 由 server 独占生成（注入 clock，整批一个快照），daemon 永不提供——它是 sweep 的活跃度证据，sweep 的 anomaly 防护对由此写者退化为纯纵深。
   - 条件 UPDATE 守卫 `id + machineId + phase='running'`：machineId 合取即授权边界；迟到/取消/reclaim/他人/未知 runId 全部零写（静默，常态非异常）。
   - **绝不触碰 `ts`**——report/reclaim CAS 依赖 ts 仅表示转换时间。
   - 明确接受 arrival-order last-wins（同 machine 正常部署单 daemon 顺序 poll；同 token 并发属误配置，不做 step 防回滚）。
   - 条数/label 上限在 server 侧（`PROGRESS_ENTRIES_CAP=20`、label 200/兜底 "working"），不进 schema（ADR-002 决策 4；schema 层 `.max()` 会把超限变成 400 → poll fatal）。
   - 写失败传播（fail-closed，同 `applyMachinePollContact` 先例）——静默吞心跳会让长跑 agent 被 sweep 误回收。
4. **兼容矩阵**：Phase 2 server + Phase 1 daemon = 兼容（不发新字段，保留批量）；Phase 2 daemon + Phase 1 server = **不承诺长任务与批量队列 liveness**（旧 server 忽略 `availableSlots` 与 progress，排队 Run 可能被 sweep 回收）；升级顺序**先 server 后 daemon**。daemon 收到批量 delivery 后本地顺序排队（FIFO、跨周期去重）仅作防御行为，不称完整兼容（plan-review 一轮修订 1）。
5. **daemon `pollOnce()` 契约 = poll + dispatch**：发 poll、enqueue、返回，不等待执行与首报。fatal 传播收敛为：poll fatal 同步抛出；后台 report fatal 经 `setFatal`（abort 运行时 signal）→ 下一次 `pollOnce()` 抛出（**poll 前检查 + transient 分支后检查**——abort 会被真实客户端归类为 transient，提前 return 不得吞掉 fatal；code-review 一轮 P1 修复）或 `run()` 循环顶抛出。
6. **fatal 终止语义**：fatal 转换时统一丢弃 never-started queue 并通知 settle waiters（code-review 一轮 P2 修复）——`executionSettled()` 因此必然 settle，不永久挂起；未确认 report 保留作 postmortem，不 drain。
7. **`executionSettled()` 是唯一新增公开 lifecycle seam**：`run()` 的 shutdown join（先 abort、join 活动 pipeline、不 drain report outbox、queue 清空且永不启动）与测试同步共用；仅在执行管线静止时 resolve，不因 abort alone resolve（plan-review 一轮修订 3、二轮 P1 最终裁定）。
8. **progress 发送采用 daemon 轮转**：executing/reporting 条目每轮必发（sweep 误回收风险最高），queued 条目在剩余 ≤20 条预算内轮转（游标推进）；承诺边界为「健康网络 + 有界积压」前提下的公平刷新，对旧 server 的无界批量交付不承诺 liveness（plan-review 一轮修订 4、二轮 P2）。
9. **step 是 runtime 独占的 per-run 非递减计数器**：仅活动状态迁移时递增（0=queued、1=starting、2=reporting result）；相同状态重复心跳保持相同 step。批次三 runner `onProgress` 事件经 runtime 写同一 activities map 续增（tool/turn 只覆盖执行态 label，queued/reporting 逐字保留）——本批测试不因批次三失效。
10. **测试纪律**：新增行为测试先写（red）再实现（green），red/green 成对提交保证 TDD 顺序可审计（day8-10 评审 P3 前车之鉴）；既有测试的契约适配与实现同提交。

## 修订记录

- 2026-08-19：初始 Accepted。决策 1–10 含 plan-review 两轮（P1 pollOnce 契约、P2 轮转承诺边界、P3 availableSlots 最坏后果）与 code-review 第一轮（P1 transient 吞 fatal、P2 executionSettled 挂起）的修复裁决。
