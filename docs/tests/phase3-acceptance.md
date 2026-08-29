# Phase 3 验收测试记录

> 本文档记录 Phase 3（cron 调度 + 重启 catch-up，Batch 1–3）最终验收的完整执行证据。Batch 1/2 的批次内验收见 ADR-007/008 与其复审记录；本文档固定 **Batch 3 收口时** 的全量证据。

## 测试环境

- **日期**: 2026-08-29
- **平台**: macOS (Darwin 25.6.0)
- **Node.js**: v22.17.0
- **pnpm**: 10.6.1
- **分支**: `feat/phase3-batch3-dev`
- **计划**: `docs/plan/codex-phase3-batch3-plan.md`（评审结论已并入正文，P3-1 标记 [无效审查]）
- **基线**: Batch 2 收口提交 `37d4c92`

## 验收范围（Batch 3 目标复述）

- Server 停机跨越任意多次 occurrence，重启后最多只创建一个可执行 pending Run，且对应最新的真实 occurrence。
- 连续重启、catch-up 与在线 callback、手动 Run Now、schedule 更新及 poll claim 交错时不产生双跑。
- 单个 Loop 的损坏持久化配置或恢复错误不阻塞其他 Loop、HTTP listener 或整体 readiness。
- 文件型 PGlite + 真实 HTTP + Scheduler + daemon runtime + Fake Runner 的确定性 E2E 证明"重启 → 唯一 pending → 唯一 claim → 唯一 report"闭环。

## 测试编组与结果

| 编组 | 文件 | 覆盖 |
|---|---|---|
| R1–R12 重启 catch-up | `packages/server/src/scheduler/catchup.test.ts` | 单次/长停机/latest-only、连续重启（文件库）、pending/running/manual-pending supersede、manual 双序交错、在线 callback 去重、schedule 更新竞态、DST gap/overlap、注入故障完整回滚与重启重试 |
| E1–E10 文件库 + 真实 HTTP E2E | `packages/server/src/restart-e2e.test.ts` | 配置跨重启持久化、HTTP 观察字段、停机多 occurrence 只恢复最新、claim 前再重启零新增、daemon 唯一 claim、Fake Runner 单次执行 done/exec、lease 消费、二次 poll 零投递、running 不重投、drain 后无已关闭 DB 回调 |
| X1–X3 故障隔离 | `packages/server/src/scheduler/catchup-isolation.test.ts` | 全维度损坏状态 fail-closed、单 Loop 故障不阻塞 readiness、日志固定分类（无 cron/timezone/异常消息） |
| V1–V6 fail-closed 校验 | `packages/server/src/coordinator/occurrence.test.ts` | 缺失/非规范 activation、非规范 watermark、非法 revision、损坏 cron 均 `invalid_schedule_state` 零写入；manual trigger 不受影响 |
| 规范 ISO 与持久化状态判定 | `packages/server/src/schedule/time-semantics.test.ts` | `parseRfc3339Ms` / `isCanonicalUtcIso`（round-trip 相等）/ `isValidPersistedScheduleState` |
| 组合根注入缝 | `packages/server/src/start.test.ts` | 单一注入 Clock 同时抵达 coordinator、admin、scheduler 与 HTTP app |

注：E6/E7/E8 为同一条不停机链路（claim → 执行 → report → lease 消费 → 二次 poll），合并为一个测试用例执行，三个编号在该用例内分别断言。X4 为下方的完整质量门本身。

## 停机 → 重启 → 唯一执行 → 唯一 report 证据链

E3–E8 链路（`* * * * *` 分钟级 cron，FakeClock 注入全部组合根组件）：

1. 09:00 创建 scheduled Loop（真实 HTTP `POST /api/loops`，文件型 PGlite），随后停机。
2. 停机跨越约 210 个 minutely occurrence（时钟推进至 12:30）。
3. 重启（同一数据目录重新 open + 真实 `127.0.0.1:0` listener + `scheduler.start()`）：catch-up 只创建 **1 个 pending Run**，watermark = `2026-08-27T12:30:00.000Z`（最新 occurrence），无历史 backlog。
4. claim 前再次重启：零新增 Run，pending 与 watermark 保持。
5. daemon runtime poll：唯一 pending 被唯一 claim；Fake Runner 恰好执行 1 次；真实 HTTP report 后 Run = `done/exec`；`run_leases` 表为空（lease 已消费）。
6. 第二次 poll：零投递、零重复执行。

## 完整质量门

```text
$ pnpm --filter @loopzhb/server test
 Test Files  33 passed | 1 skipped (34)
      Tests  387 passed | 1 skipped (388)

$ pnpm test            # 全仓（protocol + daemon + server）
      Tests  387 passed | 1 skipped (388)   # server；其余包随构建链通过

$ pnpm typecheck       # Done（protocol / daemon / server 全部通过）
$ pnpm build           # Done
$ pnpm --filter @loopzhb/server db:check
No schema changes, nothing to migrate 😴   # 无新增 migration（显式边界成立）

$ git diff --check     # 无输出（clean）
```

（1 个 skipped 为 Batch 前既有的跳过用例，非本批引入。`packages/server/vitest.config.ts` 的 `hookTimeout` 已提升至 60s——复审发现默认 10s 在高负载并行下是 PGlite WASM 启动超时的实际来源；见下文复审记录。）

## 显式边界核对（相对基线 `37d4c92` 的变更面）

```text
docs/plan/codex-phase3-batch3-plan.md        # 计划文档（当批锚点，按例外裁决入库）
packages/server/src/schedule/time-semantics.ts        # 共享 RFC 3339 / canonical ISO / 持久化状态判定
packages/server/src/schedule/index.ts                 # 上述判定函数的出口
packages/server/src/store/runs.ts                     # scheduled 分支 fail-closed（invalid_schedule_state）
packages/server/src/scheduler/index.ts                # start() 重启 catch-up
packages/server/src/start.ts                          # 仅内部可见的 Clock/CronFactory 注入缝
packages/server/src/**/*.test.ts                      # R/E/X/V 编组与既有 S/F 组口径更新
```

- 无 protocol 变更、无新增/修改 HTTP 路由、无 DB migration、无 `next_run_at` 写入。
- 无多实例调度、分布式锁或持久化 catch-up 队列（Phase 6 范围）。
- 无真实 Claude 调用，无付费 Agent 调用。
- 生产 `main()` 路径不传 overrides，`systemClock` 与 `productionCronFactory` 不变。

## 复审与 Issue 收口

- 计划评审（P1-1/P1-2/P2-1/P2-2/P2-3/P3-2 已采纳并入正文；P3-1 经裁决为 [无效审查]，理由留存于计划 §6.3）。
- 实施后 Standards / Spec / Adversarial 三轨复审（2026-08-29，范围为 `37d4c92..HEAD` 全量 diff）：
  - **Standards 轨：0 finding**（仅一条 diff 范围外的既有观察：`scheduler/index.ts` 的启动计数行使用 `console.log` 而非注入的 log seam——不含任何不可信数据，维持现状）。
  - **Adversarial 轨：1 × P2（已修复核销）+ 2 × P3**。
    - P2（实质性）：非规范化持久化 cron/timezone（如 `"  UTC  "`）绕过 fail-closed 校验后在 Croner 内静默破坏该 Loop。修复：`isValidPersistedScheduleState` 增加规范化 round-trip 相等检查；补测 time-semantics 单测 + X1b + V7；修复提交 `a4edbbc`。对应 `phase-3` Issue 创建被会话权限策略拦截，需人工补建后关闭（发现、修复、测试均已记录于 `a4edbbc` 提交信息）。
    - P3-1（已修复）：启动扫描 SQL 补 `cron IS NOT NULL` 谓词（计划 §2.1 步骤 1 口径，命中部分索引）——同提交 `a4edbbc`。
    - P3-2（不处理）：启动计数日志走 `console.log`（同 Standards 轨观察，仅计数无不可信数据）。
    - 主动攻击面均验证无误：catch-up 与在线 callback 竞态不双跑、stopAndDrain 中 drain 语义、registry 回读拒绝 stale revision、cutoff 后 occurrence 由已注册 timer 覆盖、注入缝生产默认值不变。
  - **Spec 轨：1 × P2（已修复）+ 2 × P3，计划符合性逐项核验通过**（P1-1/P1-2/P2-1/P2-2/P2-3/P3-2 与 §2.1/§2.2/§2.3/§2.4 全部落地）。
    - P2：默认并行测试在高负载下因 vitest 默认 `hookTimeout`(10s) 对 PGlite WASM 启动过短而间歇超时。修复：`hookTimeout: 60_000`（仅为竞争余量，健康运行远低于此）。修复后全量套件 387 passed 稳定通过。
    - P3（已修复）：本文档测试计数与首跑结果不一致——已按最终全量结果更正为 387 passed | 1 skipped。
    - P3（无需处理）：复审期间其他轨道的临时复现文件一度残留工作区（未入库），复审结束已自清。

## 结论

Phase 3 Batch 3 的全部验收目标达成；连同已收口的 Batch 1/2，**Phase 3（cron 与离线恢复）整体完成**：server 重启 / 机器离线恢复后最多补跑一次，绝不双跑。
