# Phase 3 Batch 3 开发计划：重启 Catch-up 与阶段收口

## 一、目标与当前基线

在 Batch 2 已完成的在线 Scheduler、occurrence 水位和原子 `enqueueExecRun()` 基础上，交付 Server 重启后的离线恢复：每个活跃 Loop 只处理停机期间最新的一个真实 cron occurrence，同时保持 at-most-once、最多一个可执行 pending Run、running skip 与 pending supersede 语义。

当前基线为 `37d4c92`（`feat/phase3-batch3-dev` 从 Batch 2 收口提交起步）。开始实现前，Scheduler、occurrence 与集成测试基线应保持通过；所有实现和测试按本计划的 `R`、`E`、`X` 编号组织。

本批次完成后必须满足：

- Server 停机跨越任意多次 occurrence，重启后最多只创建一个可执行 pending Run，且它对应最新的真实 occurrence。
- 连续重启、catch-up 与在线 callback、手动 Run Now、schedule 更新及 poll claim 交错时，不产生双跑。
- 单个 Loop 的损坏持久化配置或恢复错误不会阻塞其他 Loop、HTTP listener 或整体 readiness。
- 文件型 PGlite、真实 HTTP、Scheduler、daemon runtime 与 Fake Runner 的确定性 E2E 能证明“重启 → 唯一 pending → 唯一 claim → 唯一 report”闭环。

## 二、实现设计

### 2.1 Scheduler 启动恢复

扩展 `packages/server/src/scheduler/index.ts` 中的 `Scheduler.start()`：

1. 扫描 `enabled=true AND cron IS NOT NULL` 的 Loop；扫描级数据库错误继续作为启动失败向上抛出。
2. 对每个扫描结果验证持久化 schedule 状态：cron/timezone 可被共享时间语义模块接受；`scheduleRevision` 为非负安全整数；`scheduleActivatedAt` 是规范 UTC ISO；非空 `lastScheduledAt` 同样是规范 UTC ISO。非法项记录固定分类并跳过，不创建 job，也不执行 catch-up。
3. 先对所有有效 Loop 调用现有 `reconcile()` 注册 Croner job；仅在 Scheduler 的同一词法作用域内回读 registry，确认 `entry.revision === loop.scheduleRevision` 后，才将该 Loop 放入恢复集合。注册失败（`reconcile()` 只记录 `job_register_failed`）或 registry 不是当前 revision 时绝不 catch-up。这样恢复本身较慢时，正常 timer 已开始覆盖恢复 cutoff 之后的 occurrence。
4. 所有 job 注册完成后，统一截取一次 `recoveryCutoff = clock.now()`。逐个 Loop 调用 `latestOccurrence({ cron, timezone }, recoveryCutoff)`，不枚举历史 occurrence。
5. 只有 `latestOccurrence` 存在且严格晚于扫描行的 activation 和 watermark 时，才调用唯一的写入口：

   ```ts
   coordinator.enqueueExecRun(loop.id, {
     kind: "scheduled",
     scheduledFor: occurrence.toISOString(),
     scheduleRevision: loop.scheduleRevision,
   })
   ```

6. 每次 catch-up enqueue 必须 await，并与在线 callback 使用同一个 in-flight work 集合；每个 Loop 迭代前检查 `stopped`，在任何 `await` 前同步登记其 catch-up Promise。`stopAndDrain()` 停止 job 后等待两类工作，确保不会在 DB 关闭后继续写入。

Scheduler 的 snapshot eligibility 只用于减少无意义调用，最终裁决仍由 coordinator 事务中的最新数据库行完成。在线 callback 和 catch-up 指向同一 occurrence 时，先成功的一方推进 watermark，另一方收到受控 skip；schedule 更新后的旧 revision 同理由事务拒绝。

### 2.2 Scheduled enqueue 的 fail-closed 状态校验

在 `packages/server/src/store/runs.ts` 的 scheduled 分支中，复用/抽取 RFC 3339 解析与 canonical ISO 校验。规范 UTC ISO 的唯一判定为 `parse(value) !== undefined && new Date(ms).toISOString() === value`（即三位毫秒、`Z` 后缀的 round-trip 相等）；`scheduleRevision` 使用 `Number.isSafeInteger(revision) && revision >= 0`：

- active scheduled Loop 的 `scheduleActivatedAt` 缺失或不是规范 UTC ISO 时，返回包内 skip 原因 `invalid_schedule_state`，零写入。
- 非空 `lastScheduledAt` 非规范 UTC ISO，或 revision 非法时，也返回 `invalid_schedule_state`，零写入。
- manual trigger 保持既有行为；公共 HTTP wire 与 protocol 不新增任何 reason。
- 其余顺序保持不变：重读 Loop → revision/active/occurrence/future/state 边界校验 → canonicalize → watermark 原子推进 → running skip 或 pending supersede + insert。

这使损坏的持久化行在在线 callback 与启动 catch-up 两条路径上都 fail-closed，而不会把错误的时间字符串用于字典序比较并污染 watermark。

### 2.3 竞态、隔离与日志

- catch-up 遇到 running Run：仅推进 watermark，不创建 pending。
- catch-up 遇到任意 pending exec Run（包括 manual pending）：沿用 T7，取消旧 pending 并仅插入最新 scheduled pending。
- catch-up 与 manual Run Now 并发：沿用 coordinator 的 per-loop 串行化；先到的一方可以被后到的一方 supersede，但任意时刻最多一个 pending，不出现双跑。
- catch-up 与 schedule 更新并发：旧 revision 不能污染新 activation/watermark；新 schedule 只从自己的 activation 之后开始。
- 单 Loop 的时间计算、job 注册或 enqueue 错误只记录固定分类后跳过；不输出 cron、timezone、异常消息或其他不可信值。正常的无 occurrence/已处理 occurrence 不记录错误日志。
- 不增加后台 catch-up retry worker。恢复失败后，由下一次 Server 重启或下一个正常 cron tick 合并恢复；多实例仲裁仍明确留给 Phase 6。

### 2.4 确定性 E2E 组合根

为测试增加仅内部可见的 composition override，使 `bootstrapServer()` 或等价测试构造可注入 `Clock` 与 `CronFactory`。注入的 Clock 必须一致替换组合根中 coordinator、admin、ownerControl、sweep、scheduler 与 HTTP app 所使用的全部 `systemClock`，避免 occurrence/watermark 与 Run/lease/progress 时间源分裂。生产路径仍固定使用 `systemClock` 和 `productionCronFactory`，不改变公开 API、protocol、数据库 schema 或 migration。

测试使用临时文件数据目录、真实 `127.0.0.1:0` listener、同一数据目录上的多次 open/close、FakeClock、FakeCronFactory 和 daemon runtime 的 Fake Runner。通过真实 HTTP 创建 Loop、poll、claim 与 report；对 watermark、activation、revision 等未暴露在 wire 的内部状态，测试仅通过自己持有的 `DbHandle` 做只读断言，不为此新增 protocol 字段；不依赖真实 Claude 或等待真实分钟级 timer。

## 三、测试编组

### R1–R12：重启 Catch-up

- **R1**：短停机遗漏一次 occurrence；重启产生一个 pending，watermark 指向该 occurrence（HTTP 驱动，DbHandle 只读验证水位）。
- **R2**：长停机跨越大量 occurrence；只恢复最新一个，不枚举或创建历史 backlog。
- **R3**：activation 后、首次 occurrence 前重启；不创建 Run。
- **R4**：同一文件数据库连续重启两次；同一 occurrence 不新增第二个可执行 Run。
- **R5**：已有 scheduled pending；catch-up 取消旧 pending 并留下最新 pending。
- **R6**：已有 running；catch-up 不入队但推进 watermark。
- **R7**：已有 manual pending；catch-up 继承 T7 supersede，最终只有一个 scheduled pending。
- **R8**：manual trigger 与 catch-up 两种先后交错；最终最多一个 pending，且没有双跑。
- **R9**：在线 callback 与 catch-up 命中同一 occurrence；watermark 去重，只成功一次。
- **R10**：schedule 更新与启动恢复交错；旧 revision 被拒绝，新配置不回填 activation 之前的 occurrence。
- **R11**：DST gap 不虚构 occurrence；DST overlap 只恢复第一次真实 occurrence。
- **R12**：注入 ID 工厂、INSERT 或事务错误；watermark、取消和新 Run 完整回滚，后续重启可重试。

### E1–E10：文件型数据库与真实 HTTP E2E

- **E1**：文件型 PGlite 中的机器与 scheduled Loop 配置跨 close/reopen 保持。
- **E2**：经真实 HTTP 创建 scheduled Loop，并验证 schedule 观察字段。
- **E3**：Server 停机跨越多个 occurrence 后重启，只生成最新 pending。
- **E4**：daemon claim 前再次重启，不新增 Run，原 pending 与 watermark 保持（HTTP 驱动，DbHandle 只读验证内部状态）。
- **E5**：daemon runtime 只 claim 唯一 pending。
- **E6**：Fake Runner 只运行一次，经真实 HTTP report 后 Run 为 `done/exec`。
- **E7**：report 成功后 RunLease 被消费。
- **E8**：第二次 poll 没有新的 delivery，不重复执行或 report。
- **E9**：重启前已 running 的 Run 不被重新投递；catch-up 只推进水位。
- **E10**：Scheduler shutdown drain 后关闭 HTTP/DB；重启与后续恢复不出现已关闭 DB callback。

### X1–X4：故障隔离与回归

- **X1**：非法持久化 cron、timezone、activation 或 watermark fail-closed，健康 Loop 仍正常恢复。
- **X2**：一个 Loop 的 catch-up DB/enqueue 失败不阻塞其他 Loop 恢复与 readiness。
- **X3**：日志不包含恶意 cron/timezone、异常消息或其他不可信配置。
- **X4**：全量测试、类型检查、构建、migration 检查和 diff 检查均通过。

## 四、验收、文档与收口

完整质量门：

```bash
pnpm --filter @loopzhb/server test
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

完成实现后：

- 新增 `docs/tests/phase3-acceptance.md`，记录固定提交、Node/pnpm 环境、全部测试命令和停机 → 重启 → 唯一执行 → 唯一 report 证据。
- 在 ADR-007 追加最终 catch-up、故障隔离和接受边界，并明确：catch-up 与 manual Run Now 竞争时，依既有 T7 允许较晚写入者 supersede 较早的 pending（包含 manual pending）；在 ADR-008 更新“Batch 3 尚未实现”的历史边界并交叉引用最终裁决。
- README 明确“停机跨越任意多次只恢复最新一次”的承诺；roadmap 标记 Batch 3 与整个 Phase 3 完成，移除当前 catch-up 右移项。
- 按 R/E/X 测试先行实施，并进行 Standards、Spec、Adversarial 三轨复审。
- 新发现的 P0/P1 或实质性 P2 必须创建 `phase-3` Issue；只有修复、补测和后续复审核销后才能关闭。
- 不提交 handoff 物流文档；最终 PR 仅引用 ADR、Phase 3 验收文档和实际 Issue。

## 五、显式边界

- 不新增公开 HTTP API、protocol 字段、数据库 migration 或 `next_run_at` 写入。
- 不支持多实例调度、分布式锁或持久化 catch-up 队列。
- 不运行真实 Claude、不会产生付费 Agent 调用。
- Phase 2 已验收的 daemon、Runner、HTTP、poll/report 与 sweep 语义不得回归。

## 六、计划评审结论（对照 Batch 2 代码基线 `37d4c92`）

计划评审（实施前）处置结论：

- **已采纳并并入正文（实施不得回退）**：P1-1（§2.4 注入 Clock 必须替换组合根全部 `systemClock` 使用点）、P1-2（§2.1 步骤 3 的注册成功判定为 registry 回读 `entry.revision === loop.scheduleRevision`）、P2-1（§2.1 步骤 6 逐 Loop 检查 `stopped` + catch-up 共享 in-flight drain）、P2-2（§2.2 规范 UTC ISO 判定为 round-trip 相等）、P2-3（§2.4 watermark/revision 经测试自持 DbHandle 只读断言，不新增 wire 字段）、P3-2（manual pending 可被 catch-up supersede 的取舍显式进 ADR-007）。
- **[无效审查]**：P3-1（单 Loop catch-up 挂起拖住 readiness）——裁决理由沉淀于 ADR-007 批次三追加裁决第 6 条，不在本节保留。

逐轮审查证据与发现细节属当批物流：保存于 `docs/handoff/`（不进库）与 GitHub Issues（`phase-3`），本节不复制。
