# Phase 4 验收测试记录

> 本文档记录 Phase 4 的最终验收证据。**Batch 2（Task File、State 与 Finish 全链路）** 部分保留原样，作为该批次收口时的历史证据（Batch 1 的批次内验收见 ADR-009 与其复审记录）；**Batch 3（最小 Dashboard、Run Now no-supersede、安全装配）** 部分见文末「Batch 3 / Phase 4 收口验收」。

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

## 真实 Claude 门（已通过 — Issue #38，2026-09-07）

`packages/server/src/phase4-batch2-real-claude-e2e.test.ts` + 根脚本 `pnpm test:phase4:batch2:e2e`：Run 1 读 Task File 并 `loopzhb report --state '{"step":1}'`，Run 2 读 `prev-state.json` 并 `loopzhb finish`；断言 Completed、调度停用、Run Now/schedule enable 409、日志无 secret、进程组关闭、SIGTERM exit 0，且仅在 daemon 生产 probe 的 sha256 匹配 `LOOPZHB_EXPECTED_CLAUDE_SHA256` 批准值后才触发真实 Run。

**2026-09-07 真实执行结果（通过）**：

- 修复提交：`39627f9` + 审查跟进 `4112aa2`（分支 `feat/phase4-batch2-dev`）。
- Claude：`/opt/homebrew/Caskroom/claude-code/2.1.236/claude`，version 2.1.236，sha256 `6bc4ba992d2786cbf0237c4453ca53c1fdf0c3b3d83ffa0025c0d8190ed27848`（生产 probe 实测钉住并与批准值一致）。
- Node：`/usr/local/bin/node` v22.17.0（arm64）；macOS 26.6.2（25G83）。
- 命令：`LOOPZHB_EXPECTED_CLAUDE_SHA256=6bc4…7848 pnpm test:phase4:batch2:e2e`。
- 结果：**1 passed（46.99s）**——两 Run 链（report+state → prev-state 晋升 → finish → Completed）全绿，日志 sticky 脱敏扫描（含 provider bootstrap 收敛的全部 settings 凭据）零命中，全部观测进程组关闭。
- 前置：Issue #50 沙箱兼容性修复（wrapper launcher + 每 Run `CLAUDE_CODE_TMPDIR`）。同一固定 Claude 二进制上的 3 次生产 smoke 成功；历史拒绝检查只证明共享 tmp 写与 wrapper 篡改被拒。A/B/C/D 历史证据含两个未知费用调用，已知费用约 `$0.40`，不能表述为总费用。脱敏证据在仓库外 `~/loopzhb-compat-evidence/`。

历史记录：本节此前为「待执行」；#50（2026-09-02 登记的 2.1.236 沙箱双重缺陷）阻塞至本次修复。

**2026-09-08 独立复审整改状态**：上述 E2E 成功事实未被推翻，但 #50 的验收闭环被撤回。`pnpm test:claude:compat` 已恢复冻结旧/新能力的 A/B/C/D 四象限，并新增最终生产 P 与拒绝 R；R 现在覆盖另一 Run temp 直接及 symlink 读写、wrapper 和 OpenSSL 配置篡改，每项用同 shell attempt/denied marker 排除 Claude 权限层预拒绝，任何命令状态/顺序、目标完整性、唯一 terminal、副作用或清理失败都会使入口非零退出。旧诊断账本已超过 8 次且含未知费用，按固定持久账本门禁禁止继续诊断；P/R 使用独立账本、原子 reservation，最多 4 次且必须显式设置 `LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD`。本轮用户选择暂不批准新验收费用，因此真实 R 未运行；待预算裁决后复验，再由第二轮独立复审核销。

第二轮整改补充：两个账本现共享锁，并在每次调用前同时检查未完成、未知费用及格式损坏；旧诊断未知费用未核销前，显式设置 P/R 预算也不能启动调用。新增确定性入口反例覆盖跨账本双向阻断/并发、setup 与预留失败的资源回收、300 字符之后的 cwd/OpenSSL 错误检测。上述反例使用 fake CLI 和文件系统故障注入，不替代真实 R 隔离证据。

**2026-09-08 最终真实 R 验收**：固定 HEAD `4ba3ea6f85b8c922b6aae18dcad59f6efc3dd83a`、Claude Code `2.1.236`、SHA-256 `6bc4ba992d2786cbf0237c4453ca53c1fdf0c3b3d83ffa0025c0d8190ed27848`、Node `v22.17.0`。旧 A/B 超时的实际费用无法恢复；保留原账本备份及 SHA-256 审计，以诊断阶段剩余预算 `$2.361416` 保守计提，使诊断账本恰好耗尽 `$3`，不声称该计提是实际账单。真实验收使用独立 `$1` 总预算：

- 首次 R（`compat-R-2026-09-08T15-00-02-465Z.json`）29.9s、`$0.144288`：六项 OS 拒绝及完整性均通过，但 Claude 追加 marker 检查 Bash，严格协议以 exit 1 拒绝；没有把隔离子项通过误报为整体通过。
- 将“marker 由 host 校验、禁止未编号检查”固定到任务/system prompt 后，以全新 Run 复验。`compat-R-2026-09-08T15-02-36-530Z.json`：17.1s、`$0.107987`、**exit 0 / verdict.ok=true**。Task File 首读一次；9 条编号命令各一次且顺序精确（总 Bash 10）；成功/故意失败状态正确；唯一 `loopzhb report` 成功、Journal 合法；无 cwd EPERM/OpenSSL abort；另一 Run temp 直接读写、根内 symlink 读写、wrapper 与 OpenSSL 配置篡改六项均 `attempted=true`、`outcome=denied`、目标完整；run temp 回收且 `cleanupFailures=[]`。
- 两次真实 R 合计 `$0.252275`，低于 `$1` 验收预算。证据扫描未发现 credential/run credential 明文。生产 runner/profile 未因复验放宽；首轮额外命令只促成测试提示约束提交 `4ba3ea6`。

至此 #50 的两类阻塞、确定性反例、独立三轨整改核销、真实隔离 R 及既有完整 Batch 2 E2E 证据齐备。结论仍限定为“固定 2.1.236/hash 在旧 profile 下不兼容、在修复 profile 下通过”，不推导版本回归。

## 显式边界核对（相对基线 `6af3b29` 的变更面）

- DB migration：Batch 2 开发期保持「无 migration」边界；**首轮 review 修复引入 1 个 additive 列** `loops.revision`（`drizzle/0004_icy_black_crow.sql`，ADR-003 只增不删纪律；`db:check` = generate 后无 diff）。复用 Batch 1 已落库字段，无其他 schema 变化。
- 无 Dashboard、artifact 同步、认证、通知、workflow/evolve/edit（Batch 3+ 范围）。
- v0 Lease 路径字节不变：daemon A 组 argv/settings pin 与 server v0 分支未动；`LOOPZHB_REAL_CLAUDE_E2E` 观察缝复用 Phase 2 既有机制。
- 新增 npm 脚本仅 `test:phase4:batch2:e2e`（opt-in，默认跳过）。

## 复审与 Issue 收口

按 `AGENTS.md` 文档分层：本节只保留蒸馏结论与指针。

- 本批新增：[Issue #38](https://github.com/zhuabo001/loop-platform-zhb/issues/38)（真实 Claude 门执行与证据记录，phase-4）。
- 首轮/第二轮复审 Issues #39–#47 已在第三轮 Standards/Spec/Adversarial 确定性三轨 PASS 后核销关闭；审计记录见 `docs/handoff/codex-handoff-phase4-batch2-code-review.md` 的“第三轮审查与核销”。
- 既有 Batch 1 复审 Issue 的状态提示（**未改动其状态，留待下一轮复审核销**）：
  - #36（finish 可选 message 绕过 terminal policy）：Batch 2 的 `planReportWrites` 单一穷尽 variant pass 已对 finish 的 `reason` 与可选 `message` 一并执行 policy（`packages/server/src/loop-lifecycle/index.ts` finish 分支），daemon 侧 `collectJournal` 同口径复验。
  - #33（state 的 stack-safe wire 与 PG 可写域）：Batch 2 terminal-policy 固定 64 KiB compact + PG 可写域 + canonical clone；phase4-live L7 固定 20k 深 state 稳定 400 且 Lease 不消费。
- 长期裁决只沉淀于 ADR-009（2026-09-01 修订记录，10 条）。

## 结论

Phase 4 Batch 2 的确定性验收目标及第二轮审查反例均有对应测试，Issues #39–#47 已核销关闭。**真实 Claude 业务门已于 2026-09-07 通过**，#38/#49 保持核销；#50 的三轨整改及最终真实 R 已于 2026-09-08 完成核销。该事实不能用于把 Claude Code 2.1.236 认定为版本根因。Batch 3 在真实门脚本上追加 Dashboard 与重启断言。

---

# Batch 3 / Phase 4 收口验收

> 本节记录 Phase 4 Batch 3（最小 Dashboard、Run Now no-supersede、安全装配、切片五真实门）的收口证据。上方 Batch 2 记录未被改动，作为历史证据保留。

## 测试环境

- **日期**: 2026-09-26
- **平台**: macOS 26.6.2（Darwin 25.6.0），arm64
- **Node.js**: v22.17.0
- **pnpm**: 10.6.1
- **分支**: `feat/phase4-batch3-dev`
- **验收提交**: `86bd353`（切片五实现：确定性 E1–E2 门、真实门 harness 与根脚本 `pnpm test:phase4:e2e`）；批次一–四的代码提交为 `690e395`、`e1dd98b`、`6198680`、`34ea6b9`
- **计划**: `docs/plan/codex-phase4-batch3-plan.md`、`docs/plan/codex-phase4-batch3-slice5-plan.md`
- **Claude**: `/opt/homebrew/Caskroom/claude-code/2.1.273/claude`，version `2.1.273`，sha256 `953e9880dbcb0b70f31c1f508de6a3fd389753d131688557fd992da9184693fb`（操作者批准值；生产 probe 实测与其一致后才触发真实 Run）

## 验收范围（Batch 3 目标复述）

- 本机只读 Dashboard：`GET /`（服务端渲染、无客户端 JavaScript、100 条展示上限），仅在回环绑定时存在。
- `POST /dashboard/loops/:id/run`：每 boot 一枚 CSRF token 的表单；触发采用 **no-supersede**（任意 role 的 pending/running 都零写跳过），cron 与 catch-up 的 T7 语义不变。
- 真实门：从页面触发两次真实 Claude Run，验证 state 晋升、Task File 同步与改写、Finish 原子完成，并在 Completed 后连续重启两次不产生新 Run。

## 确定性门 E1–E2（`packages/server/src/phase4-batch3-e2e.test.ts`）

生产装配全链路：文件型 PGlite（`bootstrapServer`）→ 真实 `127.0.0.1` listener → 生产 daemon CLI 子进程 → 生产 Claude runner → fake-claude fixture；两次 Run **都经页面表单 + CSRF token** 触发（不是 JSON API）。

1. 反空转设计：Task File 携带两个**测试期随机标记**。Run 1（fixture `batch3-e2e-record`）把标记 A 从 Timeline 移入所报 state 并把该行从文件删除；Run 2（`batch3-e2e-finish`）从该 Run 的 `context/prev-state.json` 读回 A、从改写后的 Timeline 读回 B，finish reason 逐字节等于 `goal met; state-marker=<A>; timeline-marker=<B>; task-file-clean=yes`，并原样成为 `loops.completionReason` 与页面「完成原因」。断言含 `runs.state`（标记 A 的行内快照）、磁盘 TASK.md、`loops.taskFileContent`（等于改写后内容）、`enabled=false`、lease 清空。
2. Completed 页面与守卫：页面渲染 `data-lifecycle="completed"`、禁用按钮与原因文字；`POST /api/loops/:id/run`、`PATCH /schedule`、`PATCH /goal` 全部 `409 loop_completed`。
3. 连续重启：生产关闭顺序（scheduler drain → listener → DB）后推进测试时钟跨越约 210 个 minutely occurrence，同一数据目录重启两次。**对照未完成 Loop 必须补跑**（恰好 1 条 pending、水位推进到 `2026-08-27T12:30:00.000Z`、启动扫描恰好注册 1 个 job），而 Completed Loop 整行逐字段与重启前相等、Run 数恒为 2——因此「0 新 Run」是测量而非同义反复。
4. **变异核销**（施加于 fixture，随后按字节还原，`git status` 无残留）：① 令 Run 1 不删除 step-1 行 → Task File 快照断言转红；② 令 Run 2 读不到 `prev-state.json` → completionReason 断言在 `state-marker=<missing>` 处转红。

## 真实 Claude 门（`pnpm test:phase4:e2e`）

生产 daemon CLI + 真实 Claude（批准 sha256）+ 真实 OS sandbox + 真实 HTTP + 文件型 PGlite；仅注入 Clock/CronFactory 以确定性跨越重启时间，未替换业务路径或 Claude runner。两次 Run 均由 `GET /` 取 token 后 `POST /dashboard/loops/:id/run` 触发。

**2026-09-26 第一次执行：未通过（不记为通过）**

- 通过部分：生产 probe 报出的 Claude provenance 与批准 sha256 一致；daemon 启动与轮询正常；Claude 进程组正常开启并关闭；页面 token 抓取与表单 POST 正常（303）。
- 失败点：Run 1 以 `journal_multiple` 收口。分类按 ADR-009 修订 8/9 刻意不含内容，**outbox 内的实际条目无法从该分类读出**；本次执行未保留 outbox（每 Run 控制目录随 Run 释放）。
- 判定：这是**验收协议**问题而非产品缺陷——`journal_multiple` 是（多记录/非普通条目）的既定 fail-closed 语义，ADR-009 已冻结 outbox 恰好一条的契约。最可能成因是模型对同一 Run 调用了两次 wrapper（首次命令万一未如愿即重试），或以文件形式向 outbox 落过临时产物；两者都会产生第二条条目。
- 修复（不改产品语义）：① 任务协议改为显式声明后果——「终端命令整个 Run 只能调用一次」，重复调用或向 outbox 留任何文件都会使该 Run 失败；禁止 `--state-file`/`--message-file` 与任何 outbox 写入；并说明「命令几乎无输出即成功，不要重跑确认」。② 真实门新增失败诊断：失败时打印 agent 工作目录清单、TASK.md 现内容与 Run 行（phase/error/message/sessionId），使下一次 `journal_multiple` 有可观测上下文。**未自动重试任何真实调用。**

**2026-09-26 第二次执行（提交 `2a301fa`）：未通过（不记为通过）**

- 通过部分：provenance 与批准 sha256 一致；**Run 1 全绿**——`done/exec`、`status=new`、`message="step 1 recorded the task file"`、`sessionId` 非空；诊断 dump 显示磁盘 TASK.md 中 `- step-1 marker:` 行已删除、`- step 1 recorded` 已追加到 Timeline。收紧后的「恰好一次」协议在 Run 1 上奏效（第一次执行的 `journal_multiple` 未复现）。
- 失败点：**Run 2 以 `journal_missing` 收口**（outbox 零记录），即该 Run 从未成功调用 wrapper；进程组正常开启并关闭，`message`/`sessionId` 均为 null。
- 根因（均在**验收协议**，不在产品）：① Task File 的 `## Current understanding` 写死「Step 1 has not been recorded yet」，而 run prompt 明确告诉模型该节是**已知基线**——第二个 Run 时它与 `prev-state.json`、Timeline 直接矛盾，"无需动作"因此成为一条合理路径，而零调用即失败。② 更根本：step 2 的命令把两个标记值**预先代入**，模型照抄即可——那样 `completionReason` 只证明"抄写"，不证明"读过 `prev-state.json` 与更新后的 Timeline"，削弱了本门的跨 Run 测量语义（与计划 §2.2 相悖）。该缺陷是**验收设计缺陷**，本次记录在案。
- 修复（不改产品语义）：任务协议改为**单一决策规则**——每次 Run 恒以恰好一条命令收尾，分支由 `prev-state.json` 是否为 null 决定（Branch A 记录 state 并改写 Timeline；Branch B 必须**在运行时读出**两个标记并替换进 finish reason 的两个槽位）；删除与之矛盾的 `## Current understanding` 内容，改为指向 `prev-state.json` 的中性说明；继续禁止任何 outbox 写入与二次调用。

**2026-09-26 第三次执行（提交 `95711a3`）：未通过（不记为通过）**

- 通过部分：provenance 与批准 sha256 一致；**Run 1 再次全绿**（`done/exec`、`status=new`、message 正确、Timeline 已改写：`- step-1 marker:` 行删除、`- step 1 recorded` 追加）。
- 失败点：**Run 2 再次 `journal_missing`**（零调用），与第二次完全同型；进程组正常开启并关闭，`message`/`sessionId` 为 null。整测 36.28s（两次真实 Run + 两次重启）。
- 判定：**不是替换错误**——若模型执行了带占位符的命令，outbox 仍会得到一条记录（成功或 wrapper 拒绝都会落盘），failure 会是"reason 断言不符"而非 `journal_missing`。零调用意味着该 Run 根本没有执行任何 `loopzhb` 命令。三次尝试的模式一致：**Branch A（读 Task File + 执行命令）稳定成功，Branch B（先读 `prev-state.json` 再组合命令）连续两次零调用**。
- 未定项（诚实记录）：本门现有证据**无法观测模型的命令与实际输出**（`journal_missing` 是按 ADR-009 修订 8/9 刻意 content-free 的分类；runner 在该失败路径不上报子进程 finalText；未读取 agent 会话记录）。因此成因仍属假设：可能是分支判定受阻、命令未被执行，或 Bash 调用被环境拒绝。
- 处置：按计划「记录实际失败并修复后复验」，**未自动重试**；下一步选项与费用由操作者裁决。产品侧链路本身在本次三次执行中未发现异常——确定性门已独立证明 state 晋升、Task File 改写/同步、Finish 原子完成与 Completed 守卫。

**2026-09-26 第四次执行（提交 `a549978`）：未通过（不记为通过）——但排除了一整类假设**

- 通过部分：Run 1 再次全绿。失败点：Run 2 再次 `journal_missing`。
- 新增仪器（`RUN-NOTES.md`，由 agent 自己写）：记录到 `marker-read: mk-a-…` 与 `command: loopzhb finish --reason "goal met; state-marker=<A>; timeline-marker=<B>"`——**模型成功读取了 `prev-state.json` 并正确替换了两个标记**。
- 结论：失败**不在**模型的读取或组合环节；问题收窄为"那条命令是否真的落盘"。

**2026-09-26 第五次执行（提交 `254fef7`）：未通过（不记为通过）——定位到根因**

- 通过部分：Run 1 再次全绿。失败点：Run 2 `journal_multiple`；`RUN-NOTES.md` 记录 `exit-status: not-run`，并附 agent 的完整说明。
- **F1（产品级发现，可能阻塞）**：agent 报告——每次执行命令都在**执行前**被 `--permission-mode dontAsk` 拒绝（"Permission to use Bash has been denied because Claude Code is running in don't ask mode"），对裸 PATH、绝对路径、单引号 reason、`node --openssl-config=…` 解释器四种形式均可复现；触发点是 reason 模板中的 `=`（`state-marker=…` / `timeline-marker=…`）。agent 自测 A/B：`loopzhb bogus --reason "goal met"` **执行**、`loopzhb bogus --reason "foo=bar"` **被拒**。即：**权限分析器只在没有参数 token 含 `NAME=value` 时才放行这个未识别二进制**。这与四次失败的形状完全自洽——Run 1 的命令（`--status new` / `--message "…"` / `--state '{"step":1,…}'`）不含 `=` 故始终通过；Run 2 的 reason 因需要报告测量值而必然含 `=`，故永远无法执行。该结论来自 agent 自述及其自测，本次未做独立复验（属 Claude Code 内部行为，本仓无法本地验证）。
- **F2（产品级发现，已由代码确证，无需付费运行）**：`wrapper-main.ts:141` 对任何非 `report`/`finish` 的调用执行 `invalid()` 并写记录，因此 `loopzhb --help` 这类**纯探测**同样落盘。第五次的 `journal_multiple` 正是 agent 诊断期间 7 次探测各自的 `{kind:"invalid"}` 记录。也就是说，agent 只要探一下 CLI，就会破坏"恰好一条"契约并使 Run 失败；agent 明确拒绝删除这些文件（删除等于篡改 host 校验目录、掩盖错误），该判断与 ADR-009 修订 8 的边界一致。
- 处置：两项均登记为待裁决发现；**未自动重试**，也未为绕开拒绝而修改验收任务或做任何混淆。

**由第五次执行登记的两个 Phase 4 收口阻塞项（本次真实门未通过的直接原因）**

- [Issue #57](https://github.com/zhuabo001/loop-platform-zhb/issues/57)：终端收口命令在参数含 `NAME=value` 时被权限层拒绝。**直接阻塞本门**——验收要求 Run 2 在 finish reason 中报告两个运行时读出的标记，而该 reason 必然含 `=`。
- [Issue #58](https://github.com/zhuabo001/loop-platform-zhb/issues/58)：wrapper 对任何调用（含 `loopzhb --help`）都写记录，agent 一次探测即破坏"恰好一条"契约。第五次的 `journal_multiple` 即由此产生。

**结论：真实 Claude 门尚未通过，Phase 4 不收口。** 上述两项修复并复验前，Batch 3 与 Phase 4 保持进行中（roadmap 已同步）。

## 两个阻塞项的修复与本地权限探针（#57 / #58，2026-09-26）

修复在**真实门复验之前**完成，且不消耗任何模型调用。理由：权限判定发生在已安装的 CLI 内部，**与模型无关**——用 mock provider 提供 canned `Bash` tool_use，真实 CLI 就会在**生产 argv、生产 settings、真实控制根 / 每 Run 临时根 / OS sandbox** 下作出真实裁决，而"命令是否真的执行"由 **outbox 里是否出现记录**回答（记录在，即 wrapper 真的在沙箱内跑过）。

**F1 修复（放行 wrapper 入口）**：v1 Run 的 sandbox settings 增加唯一的权限放行 `permissions.allow: ["Bash(loopzhb:*)"]`；v0 不新增任何键，A3 的 settings pin 逐字节未动。裁决与安全论证见 ADR-006 2026-09-26 修订与 ADR-009 同日修订第 1 条。

**F2 修复（探测惰性化）**：显式 `--help`/`-h`/`help`/`--version` 探测不再写记录（打印文法，exit 0）；判定是**位置性**的（命令槽或 flag 槽），`loopzhb finish --reason --help` 仍是"reason 恰为 `--help`"的合法调用。裁决见 ADR-009 同日修订第 2 条。

**本地权限探针（`packages/daemon/src/claude-permission-probe.test.ts`，opt-in、零费用）**

```text
$ LOOPZHB_CLAUDE_PERMISSION_PROBE=1 pnpm --filter @loopzhb/daemon test src/claude-permission-probe.test.ts
 Test Files  1 passed (1)      Tests  3 passed (3)      Duration  8.53s
```

| 终端命令 | 无放行规则 | 有放行规则（本次修复） |
|---|---|---|
| `loopzhb report --status new --message "…" --state '{"step":1,…}'` | 允许（sandbox auto-allow） | 允许 |
| `loopzhb finish --reason "goal met; state-marker=<A>; timeline-marker=<B>"` | **拒绝**（`… don't ask mode`，outbox 空） | **执行**，outbox 恰好一条且 reason 逐字节相符 |
| `loopzhb-helper finish --reason "goal met; state-marker=<A>"`（同前缀兄弟名） | — | **拒绝**（放行只覆盖 wrapper 本身，不覆盖同前缀名） |

第二行就是全部要点：同一命令、同一 profile、只差一个键。它同时否证了另一个假设——"引号内的 `;` 会被当作子命令切分从而使规则失配"：规则匹配在含 `;`/`=` 的引号参数上照常成立。第三行用**非简单形态**（简单形态会被 auto-allow 放行，因而无法说明规则边界）证明放行是窄的：若改成 `Bash(loopzhb*)` 即变红。**残余不确定性**：探针依赖本机 CLI 版本（2.1.273）的内部判定，因此它是**证据补充而非替代**；两 Run 全绿仍只能由真实门证明。

**结论（修复落地时点）**：两项修复已落地并通过确定性门与全仓离线套件；真实 Claude 门**尚未复验**，Phase 4 仍不收口。复验需操作者的费用批准，并按切片五纪律单独取证、失败只记录不自动重试。

### 修复提交的完整质量门（`2326a8f`）

```text
$ pnpm test            # 全仓（protocol + daemon + server）
packages/protocol: Test Files  11 passed (11)         Tests  174 passed (174)
packages/daemon:   Test Files  22 passed | 2 skipped  Tests  529 passed | 6 skipped (535)
packages/server:   Test Files  50 passed | 3 skipped  Tests  599 passed | 3 skipped (602)

$ pnpm typecheck       # Done（三包）
$ pnpm build           # Done（三包）
$ pnpm --filter @loopzhb/server db:check
No schema changes, nothing to migrate

$ git diff --check     # 无输出（clean）
```

（daemon 侧 2 个 skipped 文件 = 既有 opt-in `claude-smoke.test.ts` + 本次新增的本地权限探针 `claude-permission-probe.test.ts`（opt-in，零费用）。修复提交：`0c1bc8e`（#57）、`2a86826`（#58）、`2326a8f`（文档）。）

## 完整质量门（`86bd353`）

```text
$ pnpm test            # 全仓（protocol + daemon + server）
packages/protocol: Test Files  11 passed (11)         Tests  174 passed (174)
packages/daemon:   Test Files  22 passed | 1 skipped  Tests  518 passed | 3 skipped (521)
packages/server:   Test Files  50 passed | 3 skipped  Tests  599 passed | 3 skipped (602)

$ pnpm typecheck       # Done（protocol / daemon / server 全部通过）
$ pnpm build           # Done（三包）
$ pnpm --filter @loopzhb/server db:check
No schema changes, nothing to migrate

$ git diff --check     # 无输出（clean）
```

（server 侧 3 个 skipped 文件为 opt-in 真实 Claude 门：`real-claude-e2e.test.ts`、`phase4-batch2-real-claude-e2e.test.ts`、`phase4-batch3-real-claude-e2e.test.ts`。）

## 显式边界核对（相对基线 `main@e51894b`）

- 无 DB migration（`db:check` 无 diff）、无新增公共 JSON DTO、无客户端 JavaScript、无新依赖。
- Dashboard 页面入口是 `GET /`，写路由是 `POST /dashboard/loops/:id/run`；`pendingPolicy` 与 `pending_exists` 均不进入公共 wire 契约。
- 新增 npm 脚本仅 `test:phase4:e2e`（opt-in，默认跳过）；`pnpm test:phase4:batch2:e2e` 行为未变。
- 右移项：JSON API 的同源意图校验、`Content-Type` 门禁与拒绝空体属 [Issue #56](https://github.com/zhuabo001/loop-platform-zhb/issues/56)（Phase 5），不在本批范围。


## 2026-09-27 — 收口补充取证（执行中）

前述 #57 根因的范围收窄：参数含 `NAME=value` 并非一概不可执行，独立 finish 的 wrapper 放行已生效；真实门调试后缀 `; echo "exit=$?"` 是仍未被覆盖的命令形态。固定 Claude 2.1.273、批准 SHA-256 下，零费用探针证明：旧完整命令被拒且 outbox 空；移除后缀的同一 reason 写出正确单条 finish；帮助探测后 finish 仍恰好一条记录。

验收任务取消 shell 退出状态后缀，诊断改用 Bash 工具返回结果，成功判定仍来自 host Journal 与数据库。marker A 只植入可删除的 Timeline 行，Run 2 前核查 Task File 和工作目录文件均不含 A。shutdown 前捕获实际存在的控制根和 scratch root，再断言退出后不存在。secret E2E 的 daemon TMPDIR 也改为独占目录，以避免并行测试误认控制根。

本轮操作者批准一次两 Run、总费用上限 $3；真实门使用每 Run $1 的 CLI 停止阈值，保留 $1 余量，Run 1 费用缺失或剩余不足时拒绝 Run 2，失败不重试。本节目前不声明真实门通过；最终固定提交、结果和独立核销将在执行后追加。

### 本轮离线质量门与独立复审

- 固定实现：`552b632e34e1cafbd4e3081bacef3827aaed0505`；当前阶段指针整改 `936f672`。
- protocol：11 files / 174 passed；daemon 最终复验：22 passed files + 2 skipped / 532 passed + 7 skipped；server：51 passed files + 3 skipped / 602 passed + 3 skipped。
- typecheck、build、db:check（无 schema 变化）、相对 main merge-base 的 diff --check 全部通过。
- 零费用真实 CLI 权限探针与 config/runner/wrapper：4 files / 139 passed；server 验收任务协议、Dashboard E1–E2、settings-secret E2E：3 files / 5 passed；最终 prompt/config/runner/wrapper：4 files / 140 passed。
- Standards 文档 P2 经 `936f672` 后续独立复审核销；Spec 实现 PASS；Adversarial 除费用授权边界外技术 PASS。五个遗留 Issue 的技术条件均有后续独立核销意见。
- 费用裁决待答复：CLI 阈值按请求检查，预留余量不能证明用户原 $3 绝对上限。已向操作者说明；真实门尚未执行，#57/#58 与 Phase4 保持待收口。

### 切片四遗留 Issue 最终核销

2026-09-27，#33/#36/#51/#52/#53 均已按仓库流程追加固定修复、测试和后续独立三轨核销证据并关闭。独立审查范围包括本轮修复和 Batch3 相对 `main@e51894b` 的最终批次范围；#33/#36 同时直接复核既有实现与回归。切片四已完成。#57/#58 仍为 OPEN，真实门尚未执行，Phase4 保持进行中。

## 2026-09-27 — 第六次真实门：费用来源断言失败（不记为通过）

- 固定候选：`8957f83271c1ff8cf503b62b9c24f2cac1ca5cee`，其 CI `36257101286` SUCCESS。
- macOS26.6.2 / Nodev22.17.0 / pnpm10.6.1；Claude2.1.273，生产 provenance 实测与批准 SHA256 `953e9880dbcb0b70f31c1f508de6a3fd389753d131688557fd992da9184693fb` 相符。
- 用户明确接受每 Run $1 CLI 停止阈值、总目标 $3、末次请求可能超额；Adversarial 后续独立核销原预算授权 P2。该裁决不将阈值称为硬限额。
- 命令：`LOOPZHB_PHASE4_ACCEPTANCE_BUDGET_USD=3 LOOPZHB_EXPECTED_CLAUDE_SHA256=953e9880dbcb0b70f31c1f508de6a3fd389753d131688557fd992da9184693fb pnpm test:phase4:e2e`。
- 结果：1 failed，26.28s（测试体25.66s）。Run1 report / state晋升 / Task File改写及 marker A来源排除断言全部通过，随后 `expect(firstCost).not.toBeNull()` 得到null。Run2 **未触发**，没有额外付费重试。
- 直接原因：[Issue #59](https://github.com/zhuabo001/loop-platform-zhb/issues/59)。生产 `cost` 是 parse-only，Server故意不将 Report cost写入 `runs.costUsd`；新验收门错误地从该列取费用。此失败不证明 #57/#58 修复回归，但也不满足其真实两Run核销条件。
- 本次 Run1 **实际费用未知**：没有在请求接受边界保留该 numeric cost，临时资源已清理，数据库null不等于费用0，不把 $1 停止阈值当作实际收费。
- 零费用复现：fake Claude明确输出0.125，生产 CLI→Report→DB 后字段仍null，使同一成本断言红。修复观察已被真实HTTP app接受的 Report numeric USD，两次fake Run各0.125，数据库仍null。拒绝请求、缺失/非法cost、重复accepted证据均fail-closed。无生产持久化/DTO/schema改变。
- 定向回归：Report观察器 + 完整Dashboard E1–E2 + coordinator report，3 files / 41 passed。最终全量质量门与独立复审另补。新的付费复验须重新获得授权，本轮不自动重试。

### #59 最终技术核销与复验候选

- 固定修复候选：`d25dcfd2598d750998a2275b64c3937cc0949b72`（ccc433a费用观察修复 + d25dcfd单测类型安全）；相对8957f83的新增改动经独立Standards/Spec/Adversarial全部技术PASS，无未解决P1/P2。
- 完整离线质量门：protocol174 passed；daemon532 passed +7 skipped；server609 passed +3 skipped。typecheck/build/db:check/相对main merge-base diff --check全部通过。
- #59已在远端追加修复、测试、后续独立核销记录并关闭，不替代最终真实门。#57/#58仍OPEN。
- 下一次真实验收需新的明确费用批准，不能把前次“唯一一次”授权复用为失败后自动重试。当前仅已执行一次真实入口、一个Run1，实际费用未知，Run2未执行。费用阈值边界已获接受，后续新增两Run费用仍须另批准。
