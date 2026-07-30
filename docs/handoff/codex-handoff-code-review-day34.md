# Day 3–4 Step 1–3 代码审查

审查范围固定为 `origin/main...ccd9772`，即：

- Step 1：`dffa399`
- Step 2：`5999771`
- Step 3：`ccd9772`

后续 Step 4/5 代码不在本次审查范围内。问题来自“plan/roadmap 一致性审查”和“对抗性代码审查”两个独立审查轴，重复项已合并。

| Step 序号 | 发现的问题（若有） | 修复状态 |
|---|---|---|
| Step 1 | 未发现需修复问题。 | 已完成 |
| Step 2 | **P1 — 未来 `lastSeen` 未按计划纠正。** `packages/server/src/store/machines.ts:131-150` 将未来水位当作 fresh；身份不变时直接返回，身份变化时也通过 `GREATEST` 保留未来值。异常的远未来水位会使 presence/sweep 长期误判 Machine 在线，与 `docs/handoff/codex-handoff-pollReport-plan.md`「未来水位纠正」的要求相反。`packages/server/src/coordinator/poll.test.ts:172-183` 目前反而把该偏差固化为绿色测试。建议将 future 与非法水位一样纠正为当前 Poll 时间，并改写测试。 | 未完成 |
| Step 2 | **P1 — claim 的写时守卫不完整。** `packages/server/src/store/runs.ts:154-180` 的条件更新只校验 `run.id + phase=pending`，而 lease 的 `loopId/machineId/role` 来自候选扫描时的旧快照（调用点：`packages/server/src/coordinator/index.ts:133-143`）。若扫描与 UPDATE 之间归属、角色或 Loop 发生变化，旧 Machine 仍可能领取 Run，并生成元数据不一致的 capability/Delivery；现有测试只证明扫描时过滤，没有证明写入时仍满足全部领取条件。建议将 `machineId/loopId/role` 一并加入 UPDATE guard，并使用 `RETURNING` 的权威行生成 lease 和 Delivery。 | 未完成 |
| Step 3 | **P1 — report 缺少覆盖整个写入窗口的锁或 CAS，现有并发测试不能证明单次消费。** `packages/server/src/store/report.ts:112-136` 在事务内普通读取 lease/Run，最终 UPDATE 仅按 `run.id`，DELETE 也未校验恰好删除一行。真实多连接 PostgreSQL 下，两个并发 report 可能都读取到 `active + running`，随后依次覆盖终态并都返回成功；report/cancel 也存在同类写入窗口。`packages/server/src/coordinator/report.test.ts:420-433` 基于单连接 PGlite，事务被串行化，无法证明该并发语义。建议使用 `SELECT ... FOR UPDATE`，或把 Run phase、lease state/token 纳入原子 CAS 并校验受影响行数；真实 PostgreSQL 多连接竞争测试按 roadmap 留到 Phase 6，但当前状态转换本身应先具备正确守卫。 | 未完成 |
| Step 3 | **P1 — terminal-grace expiry 只在事务前检查。** `packages/server/src/coordinator/index.ts:156-161` 首次 resolve 后，到 `packages/server/src/store/report.ts:109-136` 的写事务之间可能跨过过期时间；事务内重新读取 lease 时没有复核 `expiresAt`，因此过期 capability 仍可 reconcile。`packages/server/src/store/leases.ts:27` 使用 `>`，还会放行 `now === expiresAt` 的边界。建议在写事务内用同一 Clock 快照再次校验 `expiresAt <= now`，过期时删除 lease 并返回统一 401；增加 FakeClock 在首次 resolve 后推进到/越过边界的测试。 | 未完成 |
| Step 3 | **P2 — 复用已有 message 时未统一执行文本清理。** `packages/server/src/store/report.ts:70-78` 选择 `run.message` 分支时直接重写原值，未去除 NUL 或截断至 2000 字符；现有测试也没有覆盖 existing-message 分支。建议先完成 message 优先级选择，再对最终值统一执行 `cleanText`，并补齐 existing message 与 `finalText` fallback 测试。 | 未完成 |

## 验证记录

在 `ccd9772` 的独立快照中执行：

- `pnpm -r typecheck`：通过。
- `pnpm -r test`：通过（protocol 62/62，server 82/82）。
- `pnpm -r build`：通过。

绿色测试不消除上表问题：其中部分边界未覆盖，另有测试把与计划相反的行为固化为当前预期。
