# Handoff：Phase 1 完成（Day 8–10）——故障注入与心脏收尾

> 日期：2026-08-11 ｜ 分支 `feat/day8-10-fault-injection`（基于含 PR #8 的 main）
> 用途：让任何新会话/新人在 5 分钟内接上当前进度。路线图全貌见 `docs/roadmap.md`；
> 上一阶段见 `docs/handoff/004-phase1-day6-7.md`。
>
> 本批次的验收契约是 `codex-handoff-day810-plan.md`（开发前经一轮对照 roadmap/ADR 的
> 计划审核，结论：计划与既有接缝全部对齐，按原案执行）。实现按 Slice A/B/C 以 TDD
> 逐段开发，但以**单次提交**落库（`fe6df0e`）——逐 Slice 的红态顺序无法从提交历史
> 审计，该声明仅为开发过程记录，不作为可审计事实（审查 P3 裁决）。实现后经一轮
> 对抗性代码审查并完成全部修复（见文末「代码审查与修复」）。测试基线更新为
> **359 全绿（94 protocol + 43 daemon + 222 server）**。

---

## 一句话现状

**Phase 1 完成。** ADR-001 心脏测试 T1–T6 全绿（T7 coordinator 级测试随 Day 3–4
交付，继续全绿），三条精确承诺全部成立：重复 poll 不重复执行、server 重启不丢
在途 run、迟到的成功 report 能翻正误判的失败。本批新增生产可用的 inactivity
Sweep（20min 超时回收 + 24h 单次迟到回报窗口）与本地 owner cancel 接口。
**下一步是 Phase 2：一个真实 Agent（子进程 spawn、进程组 kill、timeout、env
白名单、工作目录 jail、progress heartbeat）。**

## 本批新增接口与默认参数

### `POST /api/runs/:id/cancel`（本地管理面，无认证）

| 响应 | 条件 |
|---|---|
| `200 {canceled:true}` | Run 从 pending/running 转 `canceled`，Lease 同事务删除 |
| `200 {canceled:false,reason:"not_cancelable"}` | Run 已是终态（重复取消幂等） |
| `404 {error:"not found"}` | Run 不存在 |
| `400` / `413` | malformed 或非 object JSON / 超 2 MiB cap；空 body 归一化为 `{}` |

- protocol 单源：`cancelRunRequestSchema`（空 object，tolerant-reader）+
  `cancelRunResponseSchema`（`packages/protocol/src/admin.ts`）。
- server 新增 owner-control 深模块（`packages/server/src/owner/`），直接消费
  store 原语 `cancelRunTx`；`RunCoordinator` 公开键集保持
  `enqueueExecRun / poll / report`（结构钉继续全绿），HTTP 不接触 Lease 状态机。
- cancel 只写 `phase + ts`：不写 outcome/message/error，不推进 Loop state，无通知。

### Inactivity Sweep（`packages/server/src/sweep/`）

- `createInactivitySweep({db, clock, runInactivityMs?, pageSize?, log?})` →
  `runOnce(): Promise<{scanned, reclaimed, pruned, failed}>`；阈值构造注入，
  **本批未新增环境变量**。
- 生产默认：**Run inactivity timeout 20 分钟；Sweep interval 30 秒**
  （`DEFAULT_RUN_INACTIVITY_MS` / `DEFAULT_SWEEP_INTERVAL_MS`，有测试钉住）。
- 候选只扫 `running` Run，显式列投影 + keyset 有界分页（默认页 100）。
- 活动时间 = `max(run.ts, progress.at)` 的**有效**证据：垃圾时间戳无证据；
  ≤5min 近未来时钟偏差容忍；远未来污染值不给永生（fail closed → 回收）。
  共享谓词 `lastRunActivityMs` 居 `store/runs.ts`（审查后自 sweep 下沉）：
  扫描判定与回收事务内复核共用，规则不可能在两处之间漂移。
- Machine 心跳必须经 `classifyHeartbeatWatermark`/`heartbeatAgeMs` 分类，仅作
  回收日志诊断——**Machine 心跳新鲜不能阻止其自身超时 Run 被回收**（Delivery
  响应丢失最终收敛，ADR-001 投递保证）。诊断读 **fail-open**：抛错以
  `machineHeartbeat=unavailable` 继续回收，不计 `failed`、不中止整轮 pass。
- 回收走 `reclaimStaleRunTx`（terminal-grace 唯一生产者）：**事务内重读 Run
  并用同一谓词复核活跃度**——扫描后落盘的新鲜 ts/progress.at 使回收转为
  benign skip（`activity_fresh`，不回收、不计 `failed`；Phase 2 progress
  heartbeat 的前置防护）；单候选异常（running 无 active lease 的不变量违例）
  计入 `failed` 且不阻塞同批。
- 同实例重叠 `runOnce()` 合并为同一进行中 Promise。
- 每次 Sweep 同步修剪 terminal-grace Lease：死证判定共享 `isLeaseDead`（与
  report 读侧 resolve、事务内复核同一谓词），只按 `returning` 实际删除行数
  计 `pruned`；**active Lease 永不按时间清理**（异常携带 expiresAt 的 active
  Lease 保持 LIVE 并记无凭证 invariant 日志，正常 report 可使其自愈）。
- 生产接线（`start.ts`）：HTTP listener 绑定成功后 `armInactivitySweep` 立即
  异步执行一次 Sweep，再挂 `unref()` interval；timer tick 捕获异常继续后续周期；
  shutdown 顺序为 **drain 在途 Sweep（`stopAndDrain`）→ 关 HTTP → 关 DB**。
  Sweep 无 HTTP 触发接口。
- `bootstrapServer` 返回值新增 `sweep` 实例（timer 不上挂），测试经
  `sweep.runOnce()` 驱动与 boot 完全相同的 pass。

### terminal-grace fail-closed 规则（report 侧同步执行）

共享谓词 `isLeaseDead`（`store/leases.ts`，输入收窄为 `state/expiresAt` 两列）：
terminal-grace Lease 的 `expiresAt` 缺失或不可解析即视为死证（删除 + 401）；
**active Lease 永不按时间判死**——只有 report、cancel、reclaim 能使其退役。
三处（读侧 resolve `resolveLiveLease`、事务内复核 `executeReportTx`、sweep
prune）真正走同一谓词——「dead」定义不可能在表面之间漂移。异常的
`active + 非空 expiresAt` 记录不含 credential 的 invariant 日志后照常走
active 状态机（report finalize 即自愈）。

## ADR-001 心脏测试最终落位（全部全绿）

| # | 位置 | 形态 |
|---|---|---|
| T1 并发 claim 唯一 | `coordinator/claim.test.ts`（两个并发 poll 恰好一个 delivery；并发分批不重复） | coordinator 级 |
| T2 重复 poll 不重复执行 | `coordinator/claim.test.ts`（claimed 永不重投）+ `daemon-e2e.test.ts`（二次 poll 不重执行） | coordinator + E2E |
| T3 重复 report 效果幂等 | `coordinator/report.test.ts`（第二次 coded 401，零副作用） | coordinator 级 |
| T4 重启不丢在途 run | `start.test.ts`（boot 级重启持久化）+ `fault-injection.test.ts`（文件 PGlite close/reopen 双 composition graph + 真实 daemon：B 的 boot 同源 `sweep.runOnce()` 立即 Sweep 不误回收、原 credential 翻正 done/exec、重复 report 401） | **本批补齐完整链路** |
| T5 休眠迟到 report 翻正 | `fault-injection.test.ts`（gated runner 模拟休眠 + FakeClock + 真实 `Sweep.runOnce()`：error → 醒来报成功 → done/exec + `reconciled:true` → 二次 coded 401）+ Delivery 丢包追加场景（心跳新鲜仍回收、从不重派） | **本批交付** |
| T6 cancel 拦截迟到 report | `fault-injection.test.ts`（HTTP cancel → 迟到成功 report coded 401 → daemon 清空 pending）+ `http/app.test.ts`（路由全分支）+ `coordinator/lifecycle.test.ts`（report/cancel 事务交错，既有保留） | **本批交付** |
| T7 原子 supersede | `coordinator/enqueue.test.ts` + `http/app.test.ts` trigger 路由 | 既有，继续全绿 |

## 实现相对计划的偏差（如实记录）

1. **`BootedServer` 形状变化**：新增 `sweep` 字段（计划未指定 T4 step 6 的测试
   接缝）——boot 的「立即 Sweep」就是 `sweep.runOnce()`，测试直接调用同一入口；
   timer 挂在 `main()` 监听成功之后（`armInactivitySweep` 从 sweep 模块导出，
   有 fake-timers 单测钉住「立即一次 + 异常吞掉继续 + stop 停干净」）。
2. **`store/runs.ts` 新增只读 `getRun`**：`cancelRunTx` 对「不存在」与「终态」同返
   false，owner-control 在事务后补一次读来区分 404 / not_cancelable（计划响应
   契约的必然推论；单进程 Phase 1 下 classify-after-tx 竞态 benign，模块注释已
   记录）。
3. **fail-closed 判定的实现位置**：计划要求「report 的读取和事务内复核同步执行
   该规则」，实现提取为共享谓词 `isLeaseDead`（读侧 resolve、事务内复核），比
   逐点复制更符合本仓库「同一谓词不漂移」的既有裁决风格（machine 心跳谓词同款）。
   如实记录：本批 sweep prune 最初内联了同规则的第三份拷贝，审查（A3）抓获后
   已收敛为真正三处共享。
4. **协议测试穷尽表扩容**：tolerant-reader CASES 23 → 26 行（计数钉同步更新）。

## 安全限制（必须随交接传达）

- 管理面与 machine 面均无认证：**Phase 5 认证上线前 server 只允许
  localhost/受信网络，不得公开暴露**；非 loopback 启动警告已覆盖
  `/api/machine/*`、`/api/machines`、`/api/loops*`、`/api/runs*`（任何可达客户端
  现在还能**取消** Run——警告文案与本批测试同步更新）。
- Sweep 无 HTTP 触发接口；owner cancel 只作用于 pending/running，对已终态 Run
  零写入。

## 代码审查与修复（2026-08-11）

实现落库后经一轮对抗性代码审查（`codex-handoff-day810-code-review.md`：
Roadmap/Plan 双轨 + 对抗性轨道，9 条 finding）与一轮逐条复核裁决
（`kimi-handoff-day810-code-review.md`：9 条全部核验属实，2 处定级/口径
保留意见）。全部修复以独立 fix 提交落位：

| 提交 | 修复 |
|---|---|
| `706ec61` | **P1 sweep/report 竞态**：report CAS 失败有界重解析——sweep 赢则 reconcile 原 body，cancel/另一 report 赢则 coded 401（报告确已被消费），重试再败返回非终态 500（`ReportRaceLostError`），未消费报告永不获得 daemon 视为终态的 coded 401 |
| `d1c8e70` | **P1 scan/reclaim TOCTOU**：回收事务内重读 Run 并复核活跃度 watermark（与扫描共享 `lastRunActivityMs`），扫描后变活跃即 benign skip；Phase 2 progress heartbeat 的前置防护 |
| `eba7292` | **P2/P3**：诊断读 fail-open 纳入候选级隔离（`machineHeartbeat=unavailable` 继续回收）；prune 复用 `isLeaseDead` + `returning` 实删计数；`stopAndDrain` 阻止新 tick 并等待在途 pass |
| `4c709fc` | **P2**：active Lease 永不按时间判死（旧行为会制造 running 无 lease 孤儿且永不自愈）；异常 `active+expiresAt` 记无凭证 invariant 日志后走正常状态机自愈 |

两处按复核裁决的口径保留：**（1）两个 P1 竞态在 PGlite 单连接上原理性不可
复现**（写事务持连接期间竞争者只能排队），应用层防护已就位并以确定性单测
钉住分支逻辑，**真实多物理连接交错证明是 Phase 6 的显式阻塞项**（已写入
ADR-001 修订记录与下文 Phase 2 一节），不以此撤回 Phase 1 完成状态；**（2）T4
验收口径**保持计划已批准的分层黑盒接缝（HTTP + 文件 PGlite + 真实 daemon
runtime），本文 T4 表述已收窄到实际覆盖（不声称「双进程」或经过 `main()`
timer 接线），真实双进程测试可作为后续增强而非本批验收门。ADR-001 T5 的
「记录消息/产物」措辞同步修订（Phase 1 只保基础终态与 message，artifact 随
Phase 5 落地——A-08 早已裁定，系 ADR 文档漂移）。

## 完成验证（分支 HEAD）

- `pnpm -r typecheck` ✅
- `pnpm -r test` ✅ **359 全绿**（94 protocol + 43 daemon + 222 server）
- `pnpm -r build` ✅
- `pnpm --filter @loopzhb/server db:check` ✅（No schema changes——本批无迁移，
  与计划一致）
- `git diff --check` ✅

## 下一步：Phase 2 —— 一个真实 Agent（第 3–4 周）

claude-code 或 codex 选一：子进程 spawn、进程组 kill、timeout、env 白名单、
工作目录 jail、progress heartbeat。验收：一条真实 Agent E2E 绿；agent 无法越出
允许的根目录。注意接缝已备好：Sweep 已消费 `progress.at` 语义（schema 注释的
last-heard-from），且**回收事务内复核活跃度**已就位——真实 AgentRunner 的
progress heartbeat 写入即接入既有回收判定，scan/reclaim 窗口对它是安全的；
daemon 的 report 重试/coded-401 契约 Phase 2 原样继承。

**Phase 6 显式阻塞项（审查裁决落档）**：sweep/report 与 scan/reclaim 两个竞态
的应用层防护虽已就位并钉住分支逻辑，但 PGlite 单连接原理性不可复现真实交错；
进入真实 Postgres 前必须以多个物理连接完成最终并发验收（行锁、隔离级别、
重试），见 ADR-001 修订记录（2026-08-11）。
