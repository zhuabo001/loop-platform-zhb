# Phase 4 Batch 2 验收测试记录

> 本文档记录 Phase 4 Batch 2（Task File、State 与 Finish 全链路）最终验收的完整执行证据。Batch 1 的批次内验收见 ADR-009 与其复审记录；本文档固定 **Batch 2 切片 5 收口时** 的全量证据。

## 测试环境

- **日期**: 2026-09-02
- **平台**: macOS (Darwin 25.6.0)
- **Node.js**: v22.17.0
- **pnpm**: 10.6.1
- **分支**: `feat/phase4-batch2-dev`
- **验收工作区**: 基线 `main@6af3b29`（Batch 2 + 第一/二轮审查修复的提交候选；`drizzle/0004_icy_black_crow.sql` 是 ADR-009 批准的唯一 additive migration；质量门时无构建产物混入）
- **计划**: `docs/plan/codex-phase4-batch2-plan.md`（切片 1 裁决已固化进 ADR-009 修订记录 2026-09-01）
- **进度**: `docs/handoff/progress/kimi-handoff-phase4-batch2-progress.md`

## 验收范围（Batch 2 目标复述）

- 新 Daemon 通过本地 `loopzhb` Journal 产生唯一 terminal command；wrapper 静态、无 secret、严格文法。
- Task File 成为必需执行入口：路径解析/jail/漂移重验/Run 后安全同步快照。
- 成功 state 晋升为 `loop.state`，下一 Run 经只读 `prev-state.json` 读取；失败、取消、非法 Journal、stale finish、Completed 后迟到 report 均不推进。
- Closed Loop 可 Finish；Completed/Reopen/Paused 与调度行为完整落地。
- capability 控制新旧版本交付；v0 Lease 永远 Phase 3 语义、字节不变。

## 测试编组与结果

| 编组 | 文件 | 覆盖 |
|---|---|---|
| Journal / wrapper CLI | `packages/daemon/src/wrapper-main.test.ts`（43）、`journal.test.ts`（29） | report/finish 严格文法、22 个非法 case、`open(wx,0600)` 单条随机名、无用户值 invalid marker、env 派生脱敏、state 命中 secret→marker、恰好一条/零条/多条/symlink/损坏 JSON/invalid/policy 违规稳定分类、daemon 全量二次脱敏、**wrapper/collector 双层拒绝 raw/Base64/Base64URL/hex/percent/分片 secret（ADV-R2-1）**、**record 有界读取与第17项流式短路（ADV-R2-4）**、**`*-file` symlink/超限拒绝（SPEC-4）** |
| 控制根与控制目录 | `packages/daemon/src/control-root.test.ts`（12） | 0700 控制根、0500 静态 wrapper、0400 ESM marker、wrapper 内容 secret 扫描、每 Run 0700 控制目录、0400 紧凑 prev-state、fail-closed 释放、**构造写失败自清理、置换拒绝与幂等（STD-R2-3）** |
| Task File | `packages/daemon/src/task-file.test.ts`（32） | 绝对/相对/精确 `~`/`~/`/`~name`、missing/unreadable/outside_jail 前置分类、spawn 前漂移重验、改指/symlink→changed、消失→missing、NUL/非法 UTF-8/raw/派生编码 secret→unreadable、256 KiB 边界→too_large、原子替换允许、**no-follow fd 读取与确定性换链/inode 替换反例（SPEC-2/ADV-2）** |
| v1 prompt | `packages/daemon/src/v1-prompt.test.ts`（4） | Goal 最高优先、Spec 权威、Timeline/prev-state 不可信、恰好一次收口、Open Loop 无 finish 示例、插值 JSON 编码 |
| runner v1 接线 | `packages/daemon/src/claude-runner.test.ts`（V1–V18） | settings/env/prompt 注入、前置不 spawn、journal 各分类收口、Claude 失败永远优先、sync 失败不回滚、清理 fail-closed、**v0 无 journal 面且 argv/settings pin 未动** |
| bounded read / secret 分类 | `packages/daemon/src/bounded-read.test.ts`（8）、`agent-env.test.ts`（含 STD-3 表驱动+漂移检测） | O_NOFOLLOW 打开、fstat 尺寸闸门、有界缓冲、稀疏文件秒拒、确定性换链；`isSecretKey`/`collectSecretValues` 单一来源 |
| capability / claim / Delivery / 管理 API | `packages/server/src/http/phase4-live.test.ts`（L1–L7）、`coordinator/claim.test.ts`、`admin/*` | capability 快照/门控/非法 400 零写入、v1 Lease mint（terminalProtocolVersion/goalRevision/canFinish）、Delivery goal、Completed 不 claim、v0 Lease Phase 3 语义、升级前 pending Run 按 claim 时刻 mint、20k 深 state 400、管理路由 200/400/404/409 全 taxonomy |
| 最终 Report 事务 / Finish / Reopen | `store/report.test.ts`、`loop-lifecycle/*`、`schedule/state-machine.test.ts` | v1 分支表（failure/invalid/普通/finish/迟到冻结/wake）、stale_goal、finish 取消 pending 保留 running、Reopen 旧代际撤销、Completed 调度守卫、**revision OCC guard（SPEC-3）** |
| **竞态闭环 R1–R5**（review 修复新增） | `packages/server/src/loop-lifecycle/ops.race.test.ts`（5） | retarget/claim 双向真交错（含 claim resolve 后 retarget → claim CAS 重试并只交付新路径）、同时间戳双事务、reopen/retarget 竞争 |
| **并发矩阵 C1–C8** | `packages/server/src/phase4-concurrency.test.ts`（8） | 见下节（**C8** 为 HTTP 级 retarget/claim 真交错） |
| **Completed/调度守卫 G1–G10** | `packages/server/src/phase4-completed-guards.test.ts`（10） | finish 取消 pending 保留 running、顺序 Completed 拒绝；**Finish 在 manual/scheduled resolve-write 窗口提交**时 CAS 重解析为 `loop_completed`；反向 Finish→Run Now 因 finisher 仍 running 而稳定 `running_exists`、零写；**schedule PATCH ↔ scheduled callback 双向**均证明旧 revision CAS 零行并从新代际重解析，watermark 不受陈旧写污染 |
| **确定性 Batch 2 E2E** | `packages/server/src/phase4-batch2-e2e.test.ts`（1） | 见下节（含 **SIGTERM 后 control root 消失**，STD-4 端到端证据） |
| HTTP 窄接口与 taxonomy | `packages/server/src/http/app.test.ts`（41，含 taxonomy 钉死 2） | createServerApp 只装配窄接口（review STD-2）；fake 驱动的 (status, code) 全集钉死（STD-5） |
| 既有全链路与故障注入 | `daemon-e2e.test.ts`（2）、`fault-injection.test.ts`（T4/T5/T6/delivery-loss）、`restart-e2e.test.ts`、`roundrobin-liveness.test.ts`、`start.test.ts` | 全 HTTP 用户链、at-most-once、sweep reclaim/wake reconcile、cancel/report（T6，v1 body）、跨重启 lease 存活 |
| opt-in 真实 Claude 门（默认跳过） | `packages/server/src/phase4-batch2-real-claude-e2e.test.ts`（1 skipped） | 见「真实 Claude 门」一节 |

## 确定性 Batch 2 E2E 证据链（state→finish）

`phase4-batch2-e2e.test.ts`：文件型 PGlite（`bootstrapServer`）→ 真实 `127.0.0.1:0` HTTP listener → **生产 daemon CLI 子进程**（`dist/cli.js`，`LOOPZHB_CLAUDE_BIN` 指向 fake-claude fixture）→ 生产 Claude runner（真实 jail、真实 spawn、每 Run 0700 控制目录、wrapper PATH 前缀）。

1. Run 1（fixture 场景 `report-with-state`）：journal `report/resolved` + `{"cursor":2}` state → Run `done/exec`；DB 断言 `loop.state={"cursor":2}`、`taskFileContent` 逐字节等于 TASK.md、`taskFileSyncError=null`。
2. Run 2（fixture 场景 `finish-observe-prev-state`）：fixture 读取该 Run 控制目录的 `context/prev-state.json` 并把观测内容写进 finish reason → Run 2 message 恰为 `goal met; observed prev-state {"cursor":2}`——**跨 Run state 晋升的黑盒证明**；Loop 原子完成（completedAt/completionReason/enabled=false），Run 1 的 state 保留，lease 清空。
3. Completed 守卫：`POST /run`、`PATCH /schedule {enabled:true}`、`PATCH /goal` 全部 409 `loop_completed`；LoopSummary 显示 cron 保留但 enabled=false。
4. SIGTERM → daemon exit 0；所有观测到的 Claude 进程组关闭（`DetachedProcessSupervisor` 全程跟踪）；**per-start control root 与 jail scratch root 均随 daemon 退出消失**（`loopzhb-control-*`/`loopzhb-runs-*` 无残留）。

## 并发矩阵（plan §4.1 并发）

`phase4-concurrency.test.ts`（文件 PGlite + 真实 HTTP app + 生产 daemon runtime + FakeClock，runner 门控）：

| # | 配对 | 构造 | 裁决证据 |
|---|---|---|---|
| C1 | goal/report | claim（goalRevision 0）→ 执行中 PATCH goal（rev 1）→ finish report | Run 稳定失败 `stale_goal`；Loop 零写入（goal 保持新值、无完成、无 state）；lease 消费后重放 401 |
| C2 | task-file/claim | Run 1 同步 content → Run 2 pending 时 PATCH 重定向 → claim | PATCH 不被 pending 阻塞；sync 快照四项全清；claim 事务权威快照投递**新** taskFile |
| C3 | finish/report | 双 daemon runtime 共享一个 credential：Run 1 休眠被 sweep 回收；Run 2 finish 完成 Loop；Run 1 醒来普通 report | wake-report 命中 v1_late_success：`reconciled:true`、Run 1 done/exec 带 status/message/state、Loop 逐字段冻结 |
| C4 | finish/sweep | claim → 时钟推进 21min → sweep 回收 → 醒来的 finish | wake-report 走同一 v1 分支表：合法 finish 恰好完成一次（`reconciled:true`、completionReason、enabled=false） |
| C5 | reopen/late-report | C3 构造到 Completed → reopen → 旧代际迟到 report | reopen 事务删除**全部** lease（含 terminal-grace）；迟到 report 401；Run 1 保持 sweep 误判、Run 2 done/exec 不动、Loop 快照不变 |
| C6 | 重复网络请求 | 捕获 daemon 成功 report 的原始字节 → 逐字节重放 | 编码 401；runs/loops 快照逐字节不变；state 不重复晋升 |
| C7 | 双 Report | 同一 lease 先普通 report 后 finish | 第二次编码 401；Loop 永不完成；第一次结果保持 |
| **C8**（review 修复新增） | task-file/claim 真交错 | PATCH 经 `LifecycleOpsHooks.afterResolve` 在 resolve/write 窗口内提交**真实 claim**（revision bump） | PATCH → 409 `a run is in progress`；旧路径与快照零写入；claim 到的 Run 仍属旧路径 |
| T4–T6 | cancel/report、跨重启、delivery-loss | 既有 `fault-injection.test.ts`（v1 body） | 见该文件 |

## 安全审计（plan §4.1 安全）

- **控制目录 0700 / 记录 0600**：`control-root.test.ts` 固定控制根 0700、wrapper 0500、ESM marker 0400、每 Run 控制目录 0700、prev-state 0400；`wrapper-main.test.ts` 固定 journal 记录 `open(wx,0600)`。E2E 级复核：glob diff 发现新控制根并断言 0700/0500/0400。
- **env/prompt 无 secret**：E2E 读取 fake-claude sidecar——agent env 中 `LOOPZHB_MACHINE_CREDENTIAL`/`GITHUB_TOKEN` 为 null，仅注入 PATH 前缀（控制根 bin）与 `LOOPZHB_JOURNAL_OUTBOX`；v1 prompt 含 goal 与规范 task 路径、不含 task 内容/TOKEN/Server URL/植入的 provider key。
- **日志无 secret**：`DaemonLogObserver` 对 daemon 全生命周期 stdout/stderr 做跨 chunk 流式扫描（TOKEN + 植入的 `sk-ant-e2e-batch2-planted-secret`），`secretSeen=false`；失败诊断缓冲 64 KiB 封顶且脱敏。
- **wire 无 secret**：E2E 观测到的全部 HTTP 响应体（machines/loops/runs/run/schedule/goal）逐一扫描 TOKEN 与 provider key，均无命中。
- **wrapper/Journal/Task File 无 secret**：共享 protected-form matcher 覆盖 raw、JSON escape、Base64/Base64URL、hex、二次编码、percent 与分隔符拆分；wrapper 与 collector 双层对 state fail-closed，Task File 返回 `unreadable`，错误/marker 不回显原值。

## 完整质量门

```text
$ pnpm test            # 全仓（protocol + daemon + server）
packages/protocol: Test Files  11 passed (11)         Tests  174 passed (174)
packages/daemon:   Test Files  19 passed | 1 skipped  Tests  425 passed | 3 skipped (428)
packages/server:   Test Files  43 passed | 2 skipped  Tests  556 passed | 2 skipped (558)

$ pnpm typecheck       # Done（protocol / daemon / server 全部通过）
$ pnpm build           # Done
$ pnpm --filter @loopzhb/server db:check
No schema changes, nothing to migrate 😴   # review 修复引入的 loops.revision 列已 generate 为 0004_icy_black_crow.sql 并纳入变更集

$ git diff --check main  # 无输出（clean）；基线 6af3b29
```

（server 侧 2 个 skipped 文件为 opt-in 真实 Claude 门 `real-claude-e2e.test.ts` 与 `phase4-batch2-real-claude-e2e.test.ts`，非本批引入的回归；daemon 3 个 skipped 为既有用例。）

## 真实 Claude 门（待执行 — Issue #38）

`packages/server/src/phase4-batch2-real-claude-e2e.test.ts` + 根脚本 `pnpm test:phase4:batch2:e2e` 已落地：Run 1 读 Task File 并 `loopzhb report --state '{"step":1}'`，Run 2 读 `prev-state.json` 并 `loopzhb finish`；断言 Completed、调度停用、Run Now/schedule enable 409、日志无 secret、进程组关闭、SIGTERM exit 0，且仅在 daemon 生产 probe 的 sha256 匹配 `LOOPZHB_EXPECTED_CLAUDE_SHA256` 批准值后才触发真实 Run。

- 默认跳过行为已验证（无 env 时 1 skipped）；脚本与类型随全量门通过。
- **真实执行待进行**：需在允许监听 127.0.0.1 且明确接受模型费用的环境运行 `LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256> pnpm test:phase4:batch2:e2e`，并把固定提交、命令、hash、Claude version 与结果追加到本节。跟踪：[Issue #38](https://github.com/zhuabo001/loop-platform-zhb/issues/38)。Batch 3 在此脚本上追加 Dashboard 与重启断言。

## 显式边界核对（相对基线 `6af3b29` 的变更面）

- DB migration：Batch 2 开发期保持「无 migration」边界；**首轮 review 修复引入 1 个 additive 列** `loops.revision`（`drizzle/0004_icy_black_crow.sql`，ADR-003 只增不删纪律；`db:check` = generate 后无 diff）。复用 Batch 1 已落库字段，无其他 schema 变化。
- 无 Dashboard、artifact 同步、认证、通知、workflow/evolve/edit（Batch 3+ 范围）。
- v0 Lease 路径字节不变：daemon A 组 argv/settings pin 与 server v0 分支未动；`LOOPZHB_REAL_CLAUDE_E2E` 观察缝复用 Phase 2 既有机制。
- 新增 npm 脚本仅 `test:phase4:batch2:e2e`（opt-in，默认跳过）。

## 复审与 Issue 收口

按 `AGENTS.md` 文档分层：本节只保留蒸馏结论与指针。

- 本批新增：[Issue #38](https://github.com/zhuabo001/loop-platform-zhb/issues/38)（真实 Claude 门执行与证据记录，phase-4）。
- 既有 Batch 1 复审 Issue 的状态提示（**未改动其状态，留待下一轮复审核销**）：
  - #36（finish 可选 message 绕过 terminal policy）：Batch 2 的 `planReportWrites` 单一穷尽 variant pass 已对 finish 的 `reason` 与可选 `message` 一并执行 policy（`packages/server/src/loop-lifecycle/index.ts` finish 分支），daemon 侧 `collectJournal` 同口径复验。
  - #33（state 的 stack-safe wire 与 PG 可写域）：Batch 2 terminal-policy 固定 64 KiB compact + PG 可写域 + canonical clone；phase4-live L7 固定 20k 深 state 稳定 400 且 Lease 不消费。
- 长期裁决只沉淀于 ADR-009（2026-09-01 修订记录，10 条）。

## 结论

Phase 4 Batch 2 的确定性验收目标及第二轮审查反例均有对应测试，确定性质量门全绿（修订记录见 ADR-009 2026-09-01（二）与 2026-09-02）。Batch 2 当前仍为**待最终验收**：提交后复审核销 Issues #39–#47，并完成真实 Claude 门 Issue #38（固定 commit/hash/version/命令/结果）后方可收口。
