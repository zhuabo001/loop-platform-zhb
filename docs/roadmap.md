# Loop Platform ZHB — 复刻路线图

> 目标：以「能力复刻」为标准重建 loop-platform（Loopany）的核心——多用户可调度 Agent 循环平台。
> 本文档是仓库的第一份文档，确定实现顺序及其理由。分析底稿：loop-platform-github `docs/retro-roadmap.md`。

---

## 核心原则

这个系统的价值不在 cron，也不在 Agent，而在 **「调度—领取—执行—回报」链路在
重试、重启、休眠下的精确承诺**：Run 不重复执行；未成功交付或未完成的 Run 最终
进入可观察的失败状态，不得静默消失；已成功提交的最终报告不因 HTTP 重试产生
重复副作用（at-most-once，见 ADR-001「投递保证」）。
因此实现顺序服从四条规则：

1. **心脏先行**：Run 状态机 + 原子 claim + RunLease 凭证模型是第一周的产出物，可靠性语义第一天就进入数据模型，而不是事后补丁。
2. **一切皆可假**：Runner、Blob 存储、Dashboard 先全部用最薄实现（Fake Runner、内存 BlobStore、只读 JSON 页面），它们不影响骨架正确性。「实现最薄」指**行为**最薄，不指 protocol/schema 形状最薄（ADR-002 决策 6）。
3. **链路上做插件**：cron、真实 Agent、artifact 同步都是已验证链路上的插件，排在心脏测试（ADR-001）全绿之后。
4. **跨阶段 Definition of Done**：安全边界、数据上限和可观察性是每个阶段的完成定义的一部分，不是最后的扫除项。

## 三条架构不变量

后续所有模块围绕它们设计，任何 PR 不得破坏：

1. Server 只调度、存储、认证、通知，**绝不执行用户代码或调用 LLM**。
2. Agent 只在用户本机由 daemon 启动；代码、凭证、本地工具默认不离开该机器。
3. HTTP 重试、Server 重启、电脑休眠**不导致**重复执行、丢失最终报告或越权操作。

**部署边界**：认证（Phase 5）完成之前，server 仅允许 localhost / 受信网络使用，
**不得公开暴露**——机器注册与触发端点在 auth 之前没有任何身份边界。

## 里程碑

不以固定周数承诺「接近完整核心能力」；按行为标志划分四个里程碑：

| 里程碑 | 到达标志 |
|---|---|
| 学习骨架 | ✅ Phase 1 完成（2026-08-11）：T1–T6 绿，手动触发端到端跑通 |
| 可演示 MVP | ✅ Phase 2 完成（2026-08-24）：真实 Claude E2E 验收通过，生产 daemon 已切换 |
| 可靠单用户 | Phase 5 完成：artifact 同步 + 单用户使用闭环 |
| 可公开部署多用户 | Phase 6 生产硬化完成 + auth 上线 |

每个阶段用**行为验收标准**收尾（见各阶段「验收」），不用「完成某模块」当作
完成定义；估算保留未知量与生产硬化缓冲。

## 工程结构

```text
packages/
  protocol/   # server/daemon 共用的 wire DTO + zod 运行时校验（唯一耦合点，单一来源）
  server/     # 调度、状态、认证、存储、Dashboard
  daemon/     # poll、Agent 启动、回报、文件同步、本机 jail
docs/adr/     # 架构决策记录
```

复杂逻辑收敛在少量深模块中（RunCoordinator / AgentRunner / ArtifactHome），HTTP route 只做解析与返回。

---

## Phase 1 — 心脏（第 1–2 周）

> 状态：✅ **已完成**（2026-08-11，`feat/day8-10-fault-injection`）——T1–T6 全绿、
> T7 coordinator 测试绿，三条精确承诺成立；完成记录见
> `docs/handoff/005-phase1-day8-10.md`。

目标：端到端闭环跑通，ADR-001 心脏测试全绿。**本阶段不写一行 cron。**

| 时间 | 产出 |
|---|---|
| Day 1 | `packages/protocol`：wire DTO + zod 校验；workspace 骨架 |
| Day 1–2 | 四张表 `machines / loops / runs / run_leases` + 状态枚举（从 loop-platform `db/schema.ts` 提炼语义，不照抄）；lease 状态机 `active → terminal-grace` 此刻定型 |
| Day 3–4 | `POST /api/machine/poll` 原子 claim + `POST /api/machine/report`；**先写心脏测试 T1–T3 再写实现**；交付 T7 coordinator 测试与 report/cancel 应用层交错测试 |
| Day 5–7 | daemon 前台 poll 循环 + Fake Runner（假装执行、直接回报），端到端打通 |
| Day 8–10 | 完整故障注入：心脏测试 T4–T6（server 重启、daemon 休眠迟到 report、取消）；T7 已在 Day 3–4 以 coordinator 级测试交付 |

触发方式：手动 `POST /api/loops/:id/run`。
完成标准：ADR-001 心脏测试 **T1–T6 全绿**（T7 为 coordinator 级测试，随
`supersedePendingRun` 一同交付），且三者全部成立——重复 poll 不重复执行、
server 重启不丢在途 run、迟到的成功 report 能翻正误判的失败。阶段末尾提供
**CLI 或 JSON 只读观察面**（loop/run 列表与最终消息），不做 Dashboard。

## Phase 2 — 一个真实 Agent（第 3–4 周）

claude-code 或 codex 选一：子进程 spawn、进程组 kill、timeout、env 白名单、
工作目录 jail、progress heartbeat。

| 验收 |
|---|
| 一条真实 Agent E2E 绿；agent 无法越出允许的根目录 |

### 状态

- **Batch 1 — 执行容量与 progress 心跳（Day 1–2）：已完成**（2026-08-19，分支 `codex/phase2-day-1-2`，ADR-004）
  - 协议：`PollRequest.availableSlots?: 0|1` 协作式背压（additive，无 migration）。
  - server：poll 携带 progress 心跳转正（server 独占 `at`、machine+phase 守卫、last-wins、绝不碰 `ts`）；`availableSlots` 门控（0 跳过扫描、1 成功即停、缺省保持批量）。
  - daemon：poll/heartbeat 与执行解耦；容量固定 1（`inFlight ∪ queue ∪ pendingReports` 背压）；轮转 progress 快照；fatal 终止时丢弃队列、join 活动 pipeline。
  - 兼容：Phase 2 server + Phase 1 daemon 兼容；Phase 2 daemon + Phase 1 server 不承诺长任务/批量队列 liveness；升级先 server 后 daemon。
- **Batch 2 — 本机执行隔离原语（Day 3–5）：已完成**（2026-08-19，分支 `feat/phase2-batch2`，ADR-005）
  - 配置：`LOOPZHB_ALLOWED_ROOTS` 必填（纯语法解析，零 FS 副作用）+ `LOOPZHB_CLAUDE_BIN` / `LOOPZHB_AGENT_TIMEOUT_MS` 默认值。
  - jail：daemon roots 启动 canonicalize；server roots 逐 Delivery 重校验；`path.relative()` 交集（只窄不宽）；per-run scratch（0700、永不复用、release fail-closed）。
  - subprocess：一 spawn 一进程组；TERM → 5s → KILL；先到触发器定 kind；返回前 reap 残留孙进程；stdio 1 MiB 头尾各半 + 有序 chunk 回调。
  - env：allow-list 白名单（`LOOPZHB_*` 与云/CI 密钥天然排除）；secretValues 长度降序脱敏。
  - 边界：**不切换生产 Runner**（Fake Runner 保持，I6 守护）；jail 只选 cwd，不是运行时安全边界——Batch 3 的 OS sandbox 才是。
- **Batch 3 — Claude Code adapter 与生产切换（Day 6–8）：已完成**（2026-08-20，分支 `feat/phase2-batch3`，ADR-006）
  - Runner seam：`run(delivery, { signal, onProgress })`；runtime 拥有 progress sink（inFlight 门禁、child-controlled 事件固定语义标签、去 NUL/单行/200 字符、每事件 step+1、reporting = lastStep+1 单调不回退）。
  - adapter：固定 argv + fail-closed 动态 settings；只开放 `Bash`（内建 Read/Edit/Write 不在 OS sandbox 边界内）；sandbox 不可用即失败，禁止降级；`codex`/`grok` 固定 unsupported 不 spawn。
  - stream-json 增量 parser：跨 chunk UTF-8、1 MiB 行上限、terminal result 恰好一次、数值字段卫生、内容无关的稳定失败。
  - jail `revalidate` 把 resolve→spawn TOCTOU 收窄到最小窗口（残余由 fail-closed OS sandbox 兜底）；scratch finally release，清理失败判 Run 失败。
  - 生产切换：`prepareDaemon` = config → startup jail → 无凭据 Claude 探测（10s、≥2.1.219、flags 检查，每次前后 stat+sha256）→ client → Claude Runner → runtime；真实 Run 在携带凭据前再复核身份，Fake Runner 退为测试 fixture。
  - Issue #12 跨层 round-robin liveness 验收落地（L1–L2：窗口内零误回收 + 对照回收 + 静默后全量回收）；opt-in 真实 sandbox smoke 备妥（默认跳过）。
  - Batch 3 复审核销：四轮三轨复审全部通过、无 P1/P2/P3 finding（对比 `5f0263c...1ec7506`）；签字后 smoke 命令形态修复（`6de4a6f`）经聚焦复审核销，Issue #15 已关闭（2026-08-21）。
- **Batch 4 — 真实 Claude 全链路验收与阶段收口：已完成**（2026-08-24，分支 `feat/phase2-batch4`，加固修复 `0481e3d`、`4a818d3`，验收记录 `ee123f6`）
  - Issue #10 修复：sweep 错误分类固定化（`ReclaimGuardLostError` → `reclaim_guard_lost`，其他 → `reclaim_failed`，日志不泄漏敏感信息）；report transaction 最终成功路径复用 `deleteObservedLease()` helper。
  - 真实 Claude 全链路 E2E 验收落地（`real-claude-e2e.test.ts`，`LOOPZHB_REAL_CLAUDE_E2E=1` opt-in）：生产 bootstrapServer + 文件型 PGlite + 真实 HTTP listener → daemon CLI 子进程（生产 prepareDaemon、Claude probe、原生 fetch、真实 runner）→ 真实 Claude Code → Report → DB 持久化完整闭环验证。
  - 旧 harness 的人工执行结果因 cleanup、secret 扫描和 provenance 可 false-pass 已撤回；加固后 Standards / Spec 复核均通过，Claude Code 侧重新执行真实 E2E 1/1（约 51s）与 sandbox smoke 3/3（约 78s）均通过，完整证据见 `docs/tests/phase2-batch4-acceptance.md`。
  - **Phase 2 已最终收口**：Batch 4 复审、无付费回归和加固版人工验收均已完成。

### 右移项

- [Issue #10](https://github.com/zhuabo001/loop-platform-zhb/issues/10)：Batch 4 收口项；加固版 harness 已通过复核并完成真实验收，本次收口关闭。

## Phase 3 — cron 与离线恢复（第 5–6 周）

cron（croner）+ loop 时区 + DST + 离线 pending 保留 + 重叠保护（下一次触发
supersede 未领取的 pending——T7 语义在 cron 表面继承）+ 重启 catch-up 合并。

| 验收 |
|---|
| server 重启 / 机器离线恢复后最多补跑一次，绝不双跑 |

### 状态

- **Batch 1 — 时间语义与持久化基础（Day 1–3）：已完成**（2026-08-25，ADR-007）
  - schema：`loops` 表新增 6 个调度字段（`cron`、`timezone`、`next_run_at`、`schedule_revision`、`schedule_activated_at`、`last_scheduled_at`）；migration 0002 安全升级旧库（默认值：`cron=null`、`timezone='UTC'`、`schedule_revision=0`）。
  - index：`loops_active_schedule_idx` 部分索引（`WHERE enabled=true AND cron IS NOT NULL`），Scheduler 扫描活跃调度配置专用。
  - 时间语义：`validateSchedule()` 五段 cron 校验（拒绝 macro/秒/年字段）+ IANA 时区验证；`nextOccurrence()` 计算下次执行时间，DST gap 跳过到下一有效时间，DST overlap 仅首次。
  - 状态机：`updateSchedule()` 集中式配置管理，原子事务（revision 递增、activation 边界维护、watermark 生命周期、no-op 检测、先校验后归一化）；manual-only Loop（`cron=null`）的 timezone 变更也触发校验，防止持久化非法时区。
  - 测试覆盖：M 组（迁移与 schema，6 tests）、D 组（cron/timezone/DST，8 tests）、C 组（配置状态机，8 tests）——22 tests；M1/M5 使用文件型 PGlite、Drizzle journal/runner 和关闭重开路径。
  - 边界：`next_run_at` 完成 schema 声明但 Phase 3 全程保持 write-closed（未来 Phase 需要时重新评估）；无 protocol 变更、无 HTTP 路由、无 Scheduler 或 timer——批次 1 只建立持久化与语义基础，不开放自动调度。
  - 复审：Round 1–3 发现的问题由 `67cb80a`、`f69216c` 修复；Round 4 Standards、Specs、Adversarial 均 0 finding，完整质量门通过。
  - **Batch 1 已最终收口**（2026-08-25）；Phase 3 整体仍进行中，下一目标为 Batch 2 在线 Scheduler。
- **Batch 2 — 在线 Scheduler 与 Protocol 扩展（Day 4–6）：已完成**（2026-08-28，ADR-008；Issue #23 已关闭）
  - Protocol：`CreateLoopRequest` 扩展 `cron?/timezone?`；新增 `UpdateScheduleRequest/Response`；`LoopSummary` 扩展 `cron/timezone/nextFireAt`（additive，向后兼容）。
  - Admin API：`createLoop()` 支持创建 scheduled loop（validation + scheduleRevision=0 + scheduleActivatedAt；timezone-only 创建也经过共享校验）；`updateSchedule()` 已在 Batch 1 完成，Batch 2 通过 HTTP 路由暴露。
  - ExecTrigger：定义 `manual | { scheduled; scheduledFor; scheduleRevision }`；`RunCoordinator.enqueueExecRun()` 接受可选 trigger 参数；scheduled trigger 验证 revision/cron/enabled/occurrence 真实性（`isOccurrence`，拒绝非当前 cron occurrence 与未来时间）/activation/watermark；`scheduledFor` 解析后立即规范为 canonical UTC ISO，比较与持久化只用规范形式（等价 offset 表示不可绕过水位去重）；running run 时跳过 pending 创建但 watermark 仍推进。
  - Scheduler 深模块：in-memory job 注册表（`Map<loopId, JobEntry>`）；`start()` 扫描 active loops 并注册 Croner jobs；`reconcile(loop)` 动态更新/移除 job（no-op 检测、job 替换、removal on pause/clear）；`stopAndDrain()` 停止所有 job 并等待回调完成；callback await enqueue（Croner protect 真实生效）+ stopped guard。
  - latestOccurrence：Croner callback 用此函数将实际触发时间还原为规范 occurrence（指数向后探测 + 毫秒级二分边界；无任意年份上限，复杂度与中间 occurrence 数量无关；任意延迟的在线 callback 均可重建，不静默丢 tick）。
  - FakeCronFactory：测试用 factory，job 按需触发（`triggerAll()`）；production 使用 `productionCronFactory`（封装真实 Croner，固定 `mode: "5-part"` + `unref: true`）。
  - 集成：HTTP 路由 `PATCH /api/loops/:id/schedule`（validation + updateSchedule，响应为 LoopSummary 视图）；创建/有效 PATCH 提交后经统一 `onScheduleCommitted(loop)` seam 同步 Scheduler（seam 失败只记固定分类，不回滚已提交配置）；`main()` 在 listener bind 后启动 scheduler（扫描级失败 = 启动失败：scheduler drain → HTTP drain → DB close → 非零退出，入口日志不输出 scan 原异常消息）；shutdown 顺序：scheduler drain → sweep drain → HTTP close → DB close。
  - 日志纪律：scheduler 与 schedule 校验路径只输出固定分类（不含异常消息、cron、timezone 等用户输入）。
  - 测试覆盖：A 组（API 表面与 schedule 校验）、O 组（occurrence 原子性：真实回滚/未来时间/非 occurrence/等价 ISO 规范化/并发 callback/manual-scheduled 竞争）、S 组（Scheduler 生命周期：固定参数/旧回调/occurrence 重建/长延迟重建/overrun/启动失败传播/stopped guard/update-callback 竞态）、F 组（集成：multi-tick 合并/恢复只领最新/tick-claim 竞态/暂停后 Run Now/热注册/seam 故障）；全量回归通过。
  - 边界：单进程 scheduler（Phase 6 多实例调度留后）；时钟偏移接受（系统时钟变化影响调度，Phase 3 可接受）；per-loop 错误隔离（一个 loop 的 bad config 不阻塞其他）。
  - 复审状态：Round 1–3 的 Standards/Specs/Adversarial 发现均已修复；Round 4 三轨 0 finding，完整质量门通过，Issue #23 已关闭。Phase 3 整体仍进行中，下一目标为 Batch 3 重启 catch-up。
- **Batch 3 — 重启 catch-up 与阶段收口（Day 6）：已完成**（2026-08-29，ADR-007 批次三追加裁决；验收证据 `docs/tests/phase3-acceptance.md`）
  - `Scheduler.start()` 重启恢复：fail-closed 持久化状态校验（扫描侧跳过损坏 Loop）→ 先注册全部 job → registry 回读定义恢复集合（`entry.revision === loop.scheduleRevision`）→ 统一截取 recoveryCutoff → 逐 Loop 只恢复 `latestOccurrence` 重建的最新真实 occurrence（严格晚于 activation 与 watermark）；catch-up 串行 await、与在线 callback 共用 in-flight 集合统一 drain、逐 Loop 检查 `stopped`。
  - Scheduled enqueue fail-closed：活跃 scheduled Loop 的 activation 缺失/非规范、非空 watermark 非规范、revision 非法时返回内部 skip 原因 `invalid_schedule_state`，零写入；规范 UTC ISO 判定为 round-trip 相等；判定规则单一实现（`isValidPersistedScheduleState`）供扫描与事务两路共享。
  - 组合根注入缝（仅内部可见）：`bootstrapServer(config, overrides)` 的单一注入 Clock 替换全部 `systemClock` 使用点（coordinator/admin/ownerControl/sweep/scheduler/HTTP app），CronFactory 与 test-only coordinator hooks 可注入；生产路径不传 overrides。
  - 测试覆盖：R 组（重启 catch-up R1–R12）、E 组（文件型 PGlite + 真实 HTTP + daemon runtime + Fake Runner 的确定性 E2E E1–E10）、X 组（故障隔离与日志纪律 X1–X3，X4 为完整质量门）、V 组（fail-closed 校验 V1–V7）；watermark/revision 等内部状态经测试自持 DbHandle 只读断言，不新增 wire 字段。
  - 边界：无 protocol/HTTP 路由/migration/`next_run_at` 变更；无多实例调度与后台 retry worker（Phase 6）；无真实 Claude 调用。
  - 复审状态：计划评审与实施后两轮三轨复审的全部发现已登记为 `phase-3` Issues #26–#32（核销状态以 Issue 为准）；逐轮审查证据留 `docs/handoff/`（不进库），裁决见 ADR-007 批次三追加裁决与 ADR-008。
  - **Phase 3（cron 与离线恢复）整体收口**：server 重启 / 机器离线恢复后最多补跑一次，绝不双跑。

### 右移项

- 无。（Phase 3 Batch 3 的 catch-up 右移项已随本批交付移除。）

## Phase 4 — Loop 产品语义（第 7–8 周）

Task File + 跨 run state + open/closed loop（goal/finish 语义）+ 最小 Dashboard
（loop 列表、Run Now、run 状态与最终消息）。

| 验收 |
|---|
| 连续 run 能读到前次状态；closed 达标即停；Dashboard 只读 + 一个按钮，不做花活 |

### 状态

- **Batch 1 — Schema、Protocol 与领域基础：已完成**（2026-08-31，`main@6af3b29`，ADR-009）
  - loops/runs/leases 的 Phase 4 字段与 CHECK、terminal command wire、goal/task-file/state 列、领域 planner 纯函数。
  - Batch 1 遗留 state 可写域与 finish message 复审项已于 2026-09-27 经后续独立三轨复审核销。
- **Batch 2 — Task File、State 与 Finish 全链路：业务链路及 sandbox 兼容性核销完成**（2026-09-08，分支 `feat/phase4-batch2-dev`，ADR-006/ADR-009；证据 `docs/tests/phase4-acceptance.md`「真实 Claude 门」）
  - Daemon：0700 控制根 + 静态无 secret `loopzhb` wrapper（严格 report/finish 文法、`open(wx,0600)` 单条 journal、双层脱敏）；每 Run 控制目录（只读 prev-state + outbox）；Task File 解析/jail/漂移重验/Run 后同步快照；v1 prompt 由 Daemon 构建（v0 golden 字节不变）。
  - Server：capability 快照与门控（`terminal-journal-v1`）、claim 事务权威 Loop 快照 mint v1 Lease、最终 Report 单事务分支表（stale_goal/迟到冻结/wake finish）、Finish 取消 pending 保留 running、Reopen 旧代际撤销、Completed 全部守卫（claim/cron/catch-up/Run Now/schedule enable/goal）。
  - 首轮/第二轮 code review 发现已全部修复；第三轮 Standards/Spec/Adversarial 确定性三轨 **PASS**，Issues #39–#47 已核销关闭。修复含 `loops.revision` OCC additive 列、双向真实交错、no-follow 有界读取、encoding-aware 秘密边界、control/scratch root 生命周期与 HTTP 窄接口收口；全量确定性质量门全绿。
  - 2026-09-07 的固定二进制完整 `test:phase4:batch2:e2e`（1/1，46.99s）与三次生产 smoke 保持有效，#38/#49 已核销；#50 的三项复审 P2 已由独立 Standards/Spec 核销，2026-09-08 最终生产 R 在同一固定 Claude 2.1.236/hash 上通过另一 Run temp 直连及 symlink 读写、wrapper/OpenSSL 配置篡改拒绝检查，#50 核销证据完整。版本因果关系仍未被证明。
- **Batch 3 — 最小 Dashboard 与阶段收口：已完成**（分支 `feat/phase4-batch3-dev`，scope 见 `docs/plan/codex-phase4-dev-roadmap.md` 与 `docs/plan/codex-phase4-batch3-plan.md`）
  - 切片一（只读数据与页面）已完成：`690e395`，新增 `packages/server/src/dashboard/` 读模型与 SSR 页面（D1–D5）。
  - 切片二（路由与安全装配）已完成：`e1dd98b`，两个 HTML 路由、loopback 挂载门禁、每 bootstrap CSRF、CSP/`no-store`（H1–H9）。
  - 切片三（禁止 Dashboard 替换已有 pending）已完成：`6198680`，manual trigger 的 `pendingPolicy: "skip"`、零写跳过与按钮规则（Q1–Q6）；本批新增 Issue #54 已核销关闭。
  - 切片四（核销遗留 Issue）已完成：`34ea6b9` 的修复与复验证据经 2026-09-27 后续独立三轨核销，五个遗留 Issue 均已关闭；完整证据见 `docs/tests/phase4-acceptance.md`。
  - 切片五（真实 Claude 门与阶段收口）：2026-09-27 固定 `fb2b17e` 的完整真实门 1/1 PASS（60.97s），两 Run、state/Task File继承、Completed守卫、连续两次重启、资源/秘密检查全部通过；后续独立 Standards/Spec/Adversarial 核销 #57/#58，二者已关闭。真实功能验收证据见 `docs/tests/phase4-acceptance.md`。收口后另行授权的独立确认运行在 `10275c9`（相对 `fb2b17e` 仅 `package.json` 日志留存修复与 docs，被测系统未变）再次 1/1 PASS（58.83s），并首次留存真实费用 $0.370838（0.259125 + 0.111713，未触及阈值超额）。
  - **Phase 4 已完成（2026-09-27）**：真实门与后续独立三轨复审通过，全部 Phase4 阻塞 Issue 已核销。用户明确接受第七次的费用记录限制：合计经门内断言证明 <= $3，该次精确金额未留存且不得回填（收口后的确认运行已补上实测数字，见上条）；未来成功日志入口已修复并零费用验证，裁决见 ADR-009。代码候选 `4fa825e` 远端 CI SUCCESS。**PR #55 已于 2026-09-27 04:40:40 UTC 合入 `main`**（merge commit `c7d8ff2`，父 `e51894b` + `f5fd492`；开发分支 `feat/phase4-batch3-dev` 按惯例保留），该 merge commit 的 `main` push CI 通过。

### 右移项

- [Issue #56](https://github.com/zhuabo001/loop-platform-zhb/issues/56)：**Phase 5 加固**——JSON API 的状态变更路由缺同源意图校验（无 `Origin`/`Referer` 检查）、缺 `Content-Type` 门禁，且触发/取消路由接受空体（`parseJsonBodyOrEmpty` 把空文本归一为 `{}`）。切片三决议只记录不改代码；当前不构成可利用漏洞（Loop/Run id 为随机 UUID 不可猜，且全仓无 CORS 响应头 ⇒ 跨站读不到 id），但该边界只押在 id 不可猜上，加固排入 Phase 5 的认证层。

## Phase 5 — 存储与协作（第 9–14 周）

按依赖顺序，每层独立可验：

1. **Artifact 同步**：chokidar watcher、全量 sha256 manifest（删除=缺席）、增量哈希、协商上传（needHashes + PUT 验哈希）、每文件/每 loop 上限、never-sync 目录双侧一致、run 快照与 diff。
2. **团队与认证**：GitHub 登录、Team/Membership、connect key（24h TTL、不存本体）、机器归属、跨团队 fail-closed。**此层完成前 server 不得公开暴露。**同一暴露面下的加固项见 [Issue #56](https://github.com/zhuabo001/loop-platform-zhb/issues/56)（状态变更路由的同源意图校验、`Content-Type` 门禁与拒绝空体）。
3. **通知**：失败告警 + 连续失败熔断自动暂停。

环境与验收维护项：[Issue #61](https://github.com/zhuabo001/loop-platform-zhb/issues/61)——运行时 preload 环境隔离的明确防回归证据与验收环境记录；不重新打开已收口的 Phase4。

### 状态

- **Batch 1 — Artifact 领域、协议与存储基础：已完成**（2026-10-03，分支 `feat/phase5-batch1-dev`，ADR-010 与 ADR-002 修订；权威计划 `docs/plan/codex-phase5-batch1-plan.md`；验收证据 `docs/tests/phase5-acceptance.md`）
  - 契约冻结：Artifact DTO、`artifact-sync-v1` capability、tolerant-reader 增量、canonical 顺序无关指纹、9 码错误与重试分类、8 MiB 有界解析。
  - 数据模型：迁移 `0005` 前滚（Phase 4 `0000–0004` 冻结 fixture 无损升级）、配置事务与快照绑定计划、唯一键与 revision 规则。
  - BlobStore：内存/本地双 adapter 共享契约；独占临时文件、流式验证、fsync 后 `link(2)` 原子发布、symlink/特殊文件拒绝。
  - ArtifactHome 状态机：prepare/PUT/commit、Loop CAS、requestId 幂等与固定回执、当前视图与不可变快照读取；并发、交错与故障注入验收（AC4–AC6/AC9、AB5/AB7）。
  - 生产休眠：AD1–AD4 全部在测——Artifact 路由未挂载、Create/Poll 行为不变、Report 忽略新字段、启动不构造 BlobStore、Daemon 不发同步请求。
  - 收口：内部集成链（文件型 PGlite + 本地 BlobStore 的真实磁盘路径）与五道质量门全绿；收口三轨复审零阻断，唯一 P3 证据措辞项经定点复核核销。
  - 批次 PR #68（分支 `feat/phase5-batch1-dev`）已于 2026-10-03 转待合入；Batch 3（认证）另行规划。
- **Batch 2 — Artifact 持续同步、Run 快照与文件视图：进行中**（分支 `feat/phase5-batch2-dev`，8 切片共用 PR [#84](https://github.com/zhuabo001/loop-platform-zhb/pull/84)，权威计划 `docs/plan/codex-phase5-batch2-plan.md`）
  - 片 1（契约、归属与生产边界）已完成：错误码 11 与重试类 5、客户端失败分类法与落库域、Delivery Artifact 配置、10 个端点的 wire 形状（含读取端 DTO）冻结；Machine namespace 归属解析器与生产门面（Blob 根 `<dataDir>/blobs`）实现但不接线；HTTP 失败映射矩阵逐操作域固定。AD1–AD4 休眠守卫零修改全绿。
  - 片 1 三轨审查唯一须处理项 [#83](https://github.com/zhuabo001/loop-platform-zhb/issues/83)（读取失败域遗漏 `attribution_missing`）已修复（`0a0b5a9`，变异验证），并经第二轮独立复审核销关闭（2026-10-04）。
  - 片 2（Server 配置、同步 HTTP 与 Poll 接线）已完成：生产 ArtifactHome 经 `bootstrapServer` 接线、6 条路由挂载（配置 PATCH、machine 读取、prepare／流式 PUT／commit、同步错误上报；读取端 4 条留片 7）；真实 HTTP prepare → 多块流式 PUT → commit 全通且落盘 `<dataDir>/blobs`，幂等重放返回固定回执；Create 的可选 `artifactDir` 经同一 planner 与创建同语句落库（初始代际 1）；Poll 向声明 `artifact-sync-v1` 的 Machine 下发 watch（缺 digest ≡ 空集合摘要，busy Poll 同样处理），claim 对已配置 Loop 做逐候选 capability 门控并在 Delivery 携带配置代际；AD1／AD2(a)／AD2(b)／AD4 守卫按实际解除范围重写，AD3 与 daemon 零改动。
  - 片 2 三轨审查两项 P2：[#85](https://github.com/zhuabo001/loop-platform-zhb/issues/85)（认证与读取归属的可恢复 SQLSTATE 漏稳定错误码）已修复（`c139168`，操作级 `withStorageError` + facade／路由双份故障注入回归）、[#86](https://github.com/zhuabo001/loop-platform-zhb/issues/86)（prepare schema 拒绝无码 400）已修复（`6b81de8`，coded 400 `artifact_validation_failed`），AH8 路由级 base 漂移证据已补（`85fbf5a`）；三项均经变异验证并经第二轮独立复审核销关闭（2026-10-05）。
  - 片 3（Artifact 安全扫描器）已完成：daemon 新增四个本地库模块——`artifact-jail`（复用 jail roots 交集且零 scratch；相对路径只在显式 workdir 下解析、绝不落到进程 cwd；realpath 先于容器检查，故根 symlink 跟随判落点，树内 symlink 一律整扫失败且不读目标）、`artifact-scan`（never-sync 剪枝先于一切 I/O；路径不可 wire 表示时整扫失败、绝不跳过或截断；无跟随有界读取 + 读后身份五元组与字节数复验；目录子树终检；标脏整轮丢弃重扫、三次仍脏判 `unstable`；容量在读取前判定、另有本地 dirent 防 DoS 上限；收口由共享 policy 唯一完成）、`artifact-hash-cache`（dev/ino/size/mtime/ctime 五元组全等才可复用、FIFO 上界、调用方持有）与 `artifact-verify`（上传前一律重读重算、越界路径不读盘、只在验证成功后写回缓存）；`jail.ts` 仅新增两处 `export`（零逻辑改动，`jail.test.ts` 零修改全绿）。扫描要么返回完整可提交 manifest，要么返回封闭失败类——**结构上不存在部分清单**（失败结果无 entries 字段）。
  - 片 3 变异验证六项全部被对应用例抓住（删 never-sync 剪枝、删条目数早停、删目录终检、身份比较退化为 size-only、删读后复验、删包含守卫）；缓存快路径变异暴露一处弱用例（只钉身份失效、未钉「身份匹配但缓存撒谎」），已补齐并复验。
  - 片 3 三轨审查 Round 1 四项须处理项已修复（待下一轮独立复审核销）：[#87](https://github.com/zhuabo001/loop-platform-zhb/issues/87) 终端在检查后换成 FIFO 会挂起 `open`（共享有界读取增加 `O_NONBLOCK`，仍由同 fd `fstat` 拒绝）、[#88](https://github.com/zhuabo001/loop-platform-zhb/issues/88) 读后与目录终检把权限拒绝误报为 `unstable`（改为确定性 `unreadable`，`ENOENT` 与身份变化仍有界重扫）、[#89](https://github.com/zhuabo001/loop-platform-zhb/issues/89) server root 的 realpath 后 stat 故障逃出封闭失败域（一律转 `JailError` ⇒ `outside_jail`）、[#90](https://github.com/zhuabo001/loop-platform-zhb/issues/90) 计划口径同步（根 symlink 例外、树内拒绝、事件 hash 缓存复用条件与全量／上传前必重读边界）。前三项均有对应回归并经变异验证（去掉修复即失败），#90 为文档口径同步。
  - 片 3 休眠边界不变：不接线 `runtime.ts`/`cli.ts`/`index.ts`、不声明 `artifact-sync-v1`、不启动 watcher、不访问网络、零新依赖、server/protocol 零改动；AD4 的 daemon 半（`identity.test.ts`）零修改全绿。
  - 片 4–8 未开始。

### 右移项

- [Issue #11](https://github.com/zhuabo001/loop-platform-zhb/issues/11) / [Issue #72](https://github.com/zhuabo001/loop-platform-zhb/issues/72)：Phase 6 阻塞项（真实 Postgres 多物理连接并发验收），指针见 Phase 6 节。
- [Issue #56](https://github.com/zhuabo001/loop-platform-zhb/issues/56)：Phase 5 认证层加固（状态变更路由同源意图校验、`Content-Type` 门禁、拒绝空体）——随团队与认证层（Batch 3）处理。
- [Issue #61](https://github.com/zhuabo001/loop-platform-zhb/issues/61)：运行时 preload 环境隔离的防回归证据与验收环境记录——随 Phase 5 后续批次处理。
- [Issue #91](https://github.com/zhuabo001/loop-platform-zhb/issues/91)：Artifact 根自身落在 never-sync 区域（如 `.config/gcloud`）的配置面防护——启用生产持续同步前明确配置面责任、处理阶段与根／祖先／根 symlink 指向敏感区域的规则；片 3 已按裁决不拓宽冻结失败域。

## Phase 6 — 生产硬化（独立阶段）

Postgres（托管分层）/R2、迁移预检、body/rate/storage caps、SSRF 防护、GC、
健康检查、部署形态，以及**真实 Postgres 的并发验证**：使用多个物理连接验证行锁
竞争、隔离级别、死锁与重试（PGlite 在 Phase 1 只验证应用层交错编排与真实事务提交，
不代表托管 PG 的并发语义）。

**显式阻塞项**：[Issue #11](https://github.com/zhuabo001/loop-platform-zhb/issues/11)
——Day 8–10 report/reclaim 竞态防护的多物理连接并发验收（ADR-001 修订记录
2026-08-11）；[Issue #72](https://github.com/zhuabo001/loop-platform-zhb/issues/72)
——Artifact 快照绑定与配置切换的多连接行锁验收。两项关闭前不得进入真实 Postgres。

## Phase 7 — 高阶能力（按需）

每一项都可独立裁掉，心脏不依赖它们：

- evolve / edit run（自进化与 owner 派发修改）
- 确定性 workflow（async function body）+ `tools.call` MCP 桥
- 模板市场、生成式 Dashboard
- 多 Agent provider（grok 等）与流式 telemetry 适配

## MVP 暂缓清单

第一版只证明「Loop 能可靠地在本机执行并回报」。以下全部后置：
evolve/edit、生成式 Dashboard 与模板、MCP workflow、多 Agent、R2 与复杂 diff、多通知渠道、复杂 Team 管理、daemon 自动升级。

## 与初版路线图（retro-roadmap.md）的两处关键差异

1. **可靠性语义从 Phase 3 提前到 Phase 1 的设计中**（实现仍最薄）：原子 claim、lease 状态机、效果幂等 report 无法事后 retrofit，事后补的每一步都在打补丁。
2. **真实 Agent 与 cron 都排在心脏测试绿之后**，且**真实 Agent 先于 cron**——daemon/runner 契约的不确定性高于纯 server 侧的 cron，先验证契约；cron 是链路上的插件，不是链路本身。
