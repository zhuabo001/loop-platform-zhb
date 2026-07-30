# Day 3–4 Step 1–7 代码审查

审查分两轮进行，固定范围分别为 `origin/main...ccd9772`（Step 1–3）与
`ccd9772...ba81965`（Step 4–7），即：

- Step 1：`dffa399`
- Step 2：`5999771`
- Step 3：`ccd9772`
- Step 4：`04eecbf`
- Step 5：`9165832`
- Step 6：`6337973`
- Step 7：`ba81965`

问题来自“plan/roadmap 一致性审查”和“对抗性代码审查”两个独立审查轴，重复项已合并。

| Step 序号 | 发现的问题（若有） | 修复状态 |
|---|---|---|
| Step 1 | 未发现需修复问题。 | 已完成 |
| Step 2 | **P1 — 未来 `lastSeen` 未按计划纠正。** `packages/server/src/store/machines.ts:131-150` 将未来水位当作 fresh；身份不变时直接返回，身份变化时也通过 `GREATEST` 保留未来值。异常的远未来水位会使 presence/sweep 长期误判 Machine 在线，与 `docs/handoff/codex-handoff-pollReport-plan.md`「未来水位纠正」的要求相反。`packages/server/src/coordinator/poll.test.ts:172-183` 目前反而把该偏差固化为绿色测试。建议将 future 与非法水位一样纠正为当前 Poll 时间，并改写测试。 | 已完成（`5c8025a` 语义落地 + `0710ed8` 并发 CAS）|
| Step 2 | **P1 — claim 的写时守卫不完整。** `packages/server/src/store/runs.ts:154-180` 的条件更新只校验 `run.id + phase=pending`，而 lease 的 `loopId/machineId/role` 来自候选扫描时的旧快照（调用点：`packages/server/src/coordinator/index.ts:133-143`）。若扫描与 UPDATE 之间归属、角色或 Loop 发生变化，旧 Machine 仍可能领取 Run，并生成元数据不一致的 capability/Delivery；现有测试只证明扫描时过滤，没有证明写入时仍满足全部领取条件。建议将 `machineId/loopId/role` 一并加入 UPDATE guard，并使用 `RETURNING` 的权威行生成 lease 和 Delivery。 | 已完成（`8a09c0c`） |
| Step 3 | **P1 — report 缺少覆盖整个写入窗口的锁或 CAS，现有并发测试不能证明单次消费。** `packages/server/src/store/report.ts:112-136` 在事务内普通读取 lease/Run，最终 UPDATE 仅按 `run.id`，DELETE 也未校验恰好删除一行。真实多连接 PostgreSQL 下，两个并发 report 可能都读取到 `active + running`，随后依次覆盖终态并都返回成功；report/cancel 也存在同类写入窗口。`packages/server/src/coordinator/report.test.ts:420-433` 基于单连接 PGlite，事务被串行化，无法证明该并发语义。建议使用 `SELECT ... FOR UPDATE`，或把 Run phase、lease state/token 纳入原子 CAS 并校验受影响行数；真实 PostgreSQL 多连接竞争测试按 roadmap 留到 Phase 6，但当前状态转换本身应先具备正确守卫。 | 已完成（`57a640a`） |
| Step 3 | **P1 — terminal-grace expiry 只在事务前检查。** `packages/server/src/coordinator/index.ts:156-161` 首次 resolve 后，到 `packages/server/src/store/report.ts:109-136` 的写事务之间可能跨过过期时间；事务内重新读取 lease 时没有复核 `expiresAt`，因此过期 capability 仍可 reconcile。`packages/server/src/store/leases.ts:27` 使用 `>`，还会放行 `now === expiresAt` 的边界。建议在写事务内用同一 Clock 快照再次校验 `expiresAt <= now`，过期时删除 lease 并返回统一 401；增加 FakeClock 在首次 resolve 后推进到/越过边界的测试。 | 已完成（`b7edeb4`） |
| Step 3 | **P2 — 复用已有 message 时未统一执行文本清理。** `packages/server/src/store/report.ts:70-78` 选择 `run.message` 分支时直接重写原值，未去除 NUL 或截断至 2000 字符；现有测试也没有覆盖 existing-message 分支。建议先完成 message 优先级选择，再对最终值统一执行 `cleanText`，并补齐 existing message 与 `finalText` fallback 测试。 | 已完成（`1c521d7`） |
| Step 4 | **P1 — reclaim 在没有 active lease 时仍会提交半套状态。** `packages/server/src/store/runs.ts:228-238` 只以 `runs.phase=running` 作为 Run 更新 guard；随后对 active lease 的 UPDATE 即使影响 0 行，也会提交 Run 的 `error/error` 并返回 `true`。这违反计划“仅 `running Run + active lease` 可 reclaim”的事务守卫，会制造没有 terminal-grace capability、无法由迟到 report reconcile 的终态。`packages/server/src/coordinator/lifecycle.test.ts:139-151` 只覆盖非-running Run，没有覆盖 running + missing/non-active lease。建议要求 lease UPDATE 恰好影响一行，否则抛出内部 guard error 回滚整个事务，并补两个零写入反例测试。 | 已完成（`7093dfb`） |
| Step 4 | **P2 — `RunCoordinator` 越过已锁定的三方法接口边界。** `packages/server/src/coordinator/index.ts:166-181` 新增公开的 `cancelRun`、`reclaimStaleRun`，而主计划 §1 与 `codex-handoff-pollReport-plan-clarify.md` A-02 明确包内接口仅包含 `enqueueExecRun`、`poll`、`report`。这也使“只有 sweep 编排可调用 reclaim”仅依赖注释而非结构约束。建议从 `RunCoordinator` 返回类型移除这两个方法，为 owner cancel 与 sweep 分别提供窄作用域的内部 seam，并增加接口 keys 的结构测试；若确实决定扩展 Coordinator，则应先修订 A-02 和主计划。 | 已完成（`e2fe462`） |
| Step 5 | 未发现需修复问题。 | 已完成 |
| Step 6 | **P1 — listener 启动失败不会关闭已打开的 DB，并会提前误报 ready。** `packages/server/src/start.ts:54-57,81-85` 在 `bootstrapServer` 打开 DB 后调用 `serve()`；该函数在 `server.listen()` 完成前即返回，`EADDRINUSE`、权限或地址错误通过异步 `error` 事件报告，无法被 `main().catch()` 捕获。当前代码还会立即输出 “server listening”，随后以未处理 error 崩溃，未按计划执行启动失败时的 HTTP/DB 有序清理。`packages/server/src/start.test.ts:52-107` 只测试 bootstrap，没有覆盖真实 listener 失败。建议等待 `listening/error` 事件后再记录 ready；失败时幂等关闭 server（若已创建）和 DB 后重新抛错，并增加端口占用/监听错误测试。 | 已完成（`1eba754`） |
| Step 7 | **P2 — handoff 的“完成态/全量收敛”声明早于实际验收完成。** `docs/handoff/003-phase1-day3-4.md:7-11,39-51` 声称计划已全量收敛、七步全部交付，并把 reclaim 描述为受限且原子；但 Step 4 的 active-lease guard、Coordinator 接口边界及 Step 6 启动失败清理仍未满足。建议修复上述问题后保留完成态声明；修复前应在 handoff 中明确记录偏差与待办。 | 已完成（评审记录见 003） |

## 关于kimi核心反驳澄清

经独立复核，接受 Kimi 对 Step 2 第一项发现的核心反驳：该项不应继续被直接定性为
确定的 P1 实现缺陷。A-13 同时要求“未来水位刷新/纠正”和
`lastSeen(new) = max(lastSeen(stored), pollTime)`、并发写不得倒退；ADR-003 还把
`lastSeen` 的单调性写成正式约束。将任何未来值无条件回写为当前 Poll 时间会破坏
更底层的并发单调承诺，因此当前实现选择保持未来水位具有规范与参考实现依据。

裁决结论如下：

- 表中 Step 2 第一项应视为**语义裁决项**，而不是已确定的 P1 缺陷；裁决完成前维持
  当前代码与测试，不执行“所有 future 均回写 pollTime”的原修复建议。
- 当前“任意远未来值始终 fresh”的行为也不应直接固化为最终契约。推荐先在 A-13
  明确有界 clock-skew 容忍窗口：小幅未来偏移保持单调，超出窗口的远未来值视为非法，
  允许修复为当前 Poll 时间。
- presence/sweep 消费侧必须采用同一窗口，把超出范围的未来值视为异常而非持续
  fresh；否则 Machine 在写入污染值后停止 Poll，单靠写入侧纠正无法消除长期在线误判。
- 单调性契约应相应澄清为“合法水位域内必须单调；非法远未来值允许向下修复”，并补充
  近未来不倒写、远未来修复、消费侧异常判定及并发 Poll 不回退等测试。

## 验证记录

Step 1–3 在 `ccd9772` 的独立快照中执行：

- `pnpm -r typecheck`：通过。
- `pnpm -r test`：通过（protocol 62/62，server 82/82）。
- `pnpm -r build`：通过。

Step 4–7 在 `ba81965` 固定快照中执行：

- `pnpm -r typecheck`：通过。
- `pnpm -r test`：通过（protocol 62/62，server 127/127，共 189）。
- `pnpm -r build`：通过，产物包含 `dist/start.js`。
- `pnpm --filter @loopzhb/server db:check`：通过，无 schema drift。
- `git diff --check ccd9772...ba81965`：通过。

绿色测试不消除上表问题：其中部分边界未覆盖，另有测试把与计划相反的行为固化为当前预期。

## 修复记录（2026-07-30,kimi)

独立复核结论见 `kimi-response-code-review.md`。上表 #2–#9 已逐项修复并附
提交锚点;#1 为计划文本自相矛盾的语义裁决项(单调水位 vs 未来纠正),
待裁决后回写 clarify 再改代码。复核中额外指出:#3 修复说明里 cancelRunTx
已是 CAS 形态(点名合规);#5 的 NUL 臂无法经 DB 播种(Postgres 拒绝
text 列存 0x00),已在纯函数层钉死。

## 二次审核（2026-07-30）

固定范围为 `ba81965...fd59241`，并额外检查当前未提交的
`docs/handoff/003-phase1-day3-4.md`。继续沿用“plan/roadmap 一致性”和
“代码质量/逻辑对抗性”两条独立审查轴。

| Step 序号 | 发现的问题（若有） | 修复状态 |
|---|---|---|
| Step 1 | 未发现回归。 | 已完成 |
| Step 2 | **P1 — 远未来水位纠正仍可能被并发旧 Poll 倒写。** `packages/server/src/store/machines.ts:169-195` 基于调用前读取的 `machine.lastSeen` 判定污染，但纠正分支最终只按 `machine.id` 无条件写入 `pollIso`。两个 Poll 若同时读到同一远未来污染值，较新请求先修复为 `T2`、较旧请求后提交时仍会覆盖为 `T1`，使已经回到合法域的水位再次倒退，违反 A-13 `codex-handoff-pollReport-plan-clarify.md:733-735`“旧请求晚提交不得倒写、数据库写入 guard”的要求。现有并发测试是顺序重新读取后的普通 `GREATEST` 路径，未覆盖同一污染快照的逆序提交。建议污染/非法纠正按观测到的原始 `lastSeen` 做 optimistic CAS；CAS 失败后重读并重新合并身份与水位，再补 `T2 → T1` 逆序提交测试。 | 未完成 |
| Step 2 | claim 写时守卫已覆盖 `id + pending + machineId + loopId + role`，lease/Delivery 使用 `RETURNING` 权威行；反例测试有效。 | 已完成 |
| Step 3 | report 终态 phase CAS 与两次写入行数校验、事务内 expiry 复核（含等号边界）、最终 message 统一清理均已落地，未发现回归。真实多连接 PostgreSQL 竞争证明仍按原 roadmap 留到 Phase 6。 | 已完成 |
| Step 4 | reclaim 已要求 active lease 恰好一行，否则抛错回滚；无 lease 与非 active lease 反例均证明零写入。Coordinator 公开面也已收窄为三方法。 | 已完成 |
| Step 4 | **P3 — 注释仍描述已不存在的调用边界。** `packages/server/src/store/runs.ts:214-215` 与 `packages/server/src/coordinator/lifecycle.test.ts:7` 仍称 owner adapter 调用 Coordinator，但当前实现与 A-02 已改为未来 adapter 直接调用窄 store 原语。建议统一注释，避免后续实现重新越过三方法边界。 | 已完成（`434cf0b`） |
| Step 5 | 未发现回归。 | 已完成 |
| Step 6 | 原 listener 启动失败问题的核心路径已修复：成功监听后才记录 ready，启动错误会关闭 DB 并向上抛出。 | 已完成 |
| Step 6 | **P2 — `waitForListening` 会残留互斥事件监听器。** `packages/server/src/start.ts:86-91` 同时注册一次性的 `listening` 与 `error`，任一分支完成后未移除另一监听器。正常启动后残留的 `error` listener 会消费后续 server error，却只尝试 reject 一个已 settled 的 Promise，导致运行期错误被静默吞掉。建议使用具名 handler，并在 resolve/reject 前移除另一监听器。 | 已完成（`55806aa`） |
| Step 7 | **P2 — handoff 再次提前声明“全部闭环”。** 当前未提交的 `docs/handoff/003-phase1-day3-4.md:87,100-105` 声称 9 项发现全部闭环，但 Step 2 的污染水位并发 CAS 尚未实现。应在该 P1 修复并复核前恢复为未完成/待办表述。 | 已完成（003 已补二次审核记录） |

二次审核验证：

- `pnpm -r typecheck`：通过。
- `pnpm -r build`：通过，产物包含 `dist/start.js`。
- `pnpm --filter @loopzhb/server db:check`：通过，无 schema drift。
- `git diff --check ba81965...fd59241` 与工作区 `git diff --check`：通过。
- `pnpm -r test`：protocol 62/62 通过；server 141/142 通过。唯一未完成用例为
  `start.test.ts` 的真实回环端口测试，当前受执行沙箱禁止 `listen`
  （`EPERM 127.0.0.1`）影响，不能据此判定代码失败，也未在本环境独立确认文档所写
  的 204/204 全绿。

二次审核结论：原 #2–#9 的核心修复均通过复核；#1 的语义与共享阈值已落地，但
写入侧并发纠正仍缺数据库 CAS，因此不能认定“所有问题均已修复”。presence/sweep
实际消费者尚未在 Day 3–4 实现；当前只落地了共享 helper，待 Day 8–10 接线时必须
再次验证所有消费路径确实使用同一谓词。

## 二次审核修复记录（2026-07-31,kimi)

二次审核 4 项新发现全部复核成立并已修复:远未来纠正按观测值 optimistic
CAS、逆序提交不倒写(`0710ed8`,含 T2→T1 逆序测试);waitForListening
具名 handler 移除落选监听器(`55806aa`,运行期 error 不再被静默吞掉);
cancel/reclaim 调用边界注释统一为 store 直调(`434cf0b`);handoff 003
已补二次审核记录。server 基线 145 全绿(总 207)。另注:二次审核环境
的 EPERM listen 沙箱限制不影响本机验证——204→207 全绿已在开发环境
独立确认。presence/sweep 实际消费者接线(Day 8–10)时须再次验证其所
有路径使用同一谓词,已在 003 的 Day 5–7 备注中登记。
