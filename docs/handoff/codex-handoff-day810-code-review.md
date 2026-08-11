# Day 8–10 代码审查：Roadmap / Plan 双轨与对抗性审查

> 日期：2026-08-11
> 分支：`feat/day8-10-fault-injection`
> 审查固定点：`HEAD=75a48c7d21a65d6e60e5c9d7f00f899d68bc18d6`
> 审查范围：固定点之后的全部已跟踪与未跟踪工作区变更
> 复核裁决：已吸收 `docs/handoff/kimi-handoff-day810-code-review.md` 的逐条复核；
> 本文是后续修复的最终执行基线

## 结论

Day 8–10 的主体实现与 `docs/roadmap.md`、
`docs/handoff/codex-handoff-day810-plan.md` 基本一致。Phase 1 可以保留“在当前
PGlite / 单进程边界内完成”的状态，不要求撤回 roadmap 的完成标记。

仍需关闭四类当前缺口：候选级失败隔离、active Lease deadness、prune 规则/计数和
shutdown drain；同时有两个必须按阶段管理的高风险竞态：activity TOCTOU 是 Phase 2
progress 写入前的阻塞项，Sweep/report 多连接竞态是 Phase 6 真实 Postgres 前的阻塞
项。后者的应用层防护可以现在实现，但真实并发证明归 Phase 6。

## 一、Roadmap 规格轨道

### Phase 6 阻塞项（高风险）：Sweep/report 多连接竞态可能永久丢失真实报告

相关位置：

- `packages/server/src/sweep/index.ts:139`
- `packages/server/src/store/report.ts:156-169`
- `packages/daemon/src/client.ts:157-160`
- `docs/adr/001-heart-tests.md:72`

在真实多连接数据库中可能出现以下交错：

1. report 事务读到 `active lease + running run`；
2. Sweep 抢先提交，将 Run 写成 `error`，Lease 写成 `terminal-grace`；
3. report 的 phase CAS 因 Run 已不是 `running` 而影响 0 行；
4. report 对外返回 coded 401；
5. daemon 把 coded 401 当作终态确认并丢弃尚未实际消费的报告；
6. Run 永久停留在 `error/terminal-grace`，真实成功结果不再重试。

这会违反 ADR-001 T5“迟到报告翻正误判”的核心承诺，但当前 Phase 1 的 `Db` 只有
PGlite 单连接，该交错原理上不可达；roadmap 也把多个物理连接下的行锁、隔离级别、
死锁与重试证明明确放在 Phase 6。因此它不是撤回 Phase 1 完成状态的理由，而是进入
真实 Postgres 前必须关闭的兼容性缺陷。

应用层修复不能只是无条件“CAS 失败就 reconcile”，而应做一次**有界的完整状态机
重试/重解析**：

- `error + terminal-grace`：按原 report body 转入 reconcile；
- lease 已被另一 report 消费：返回 coded 401；
- cancel 已撤销 lease：返回 coded 401；
- 其他非法组合：fail closed，且不得产生 Run/Loop 副作用。

可以现在通过抽取状态解析/重试分支做确定性单测；真实多连接交错的最终证明必须留到
Phase 6 使用真实 Postgres 完成。任何未被消费的 report 都不得获得 daemon 会终止重试
的 coded 401。

### Roadmap 其余匹配项

以下内容与 roadmap 基本匹配：

- T4 的文件数据库持久性和原 credential 后续 report；
- T5 的 Sweep、terminal-grace、迟到 report reconcile 与第二次 report 401；
- T6 的 owner cancel、同事务撤销 Lease 与迟到 report 拦截；
- 无 cron、手动触发、JSON 只读观察面；
- `RunCoordinator`、HTTP adapter 与 owner-control 的模块边界。

### 规格文档内部冲突：T5 artifacts

`docs/adr/001-heart-tests.md:72` 要求迟到 report“记录消息/产物”，但：

- `docs/roadmap.md` 将 artifact sync 排在后续阶段；
- Day 3–4 的 A-08 明确规定 Phase 1 只写基础字段，不消费 `artifacts`；
- 当前 report 实现与既有测试也明确不写 artifacts。

因此这不是本批新引入的实现漂移，而是 ADR 措辞没有跟随后续裁决更新。建议将 ADR
修订为 Phase 1 只保证基础终态与 message，artifact 在其所属阶段落地。

## 二、Day 8–10 Plan 规格轨道

### P2：单候选失败隔离不完整

相关位置：`packages/server/src/sweep/index.ts:133-150`。

Machine heartbeat 只用于诊断，但 `getMachine()` 位于候选级 `try` 外。一次诊断查询失败
会直接中止整轮 `runOnce()`，导致：

- 后续 stale Run 不再回收；
- terminal-grace Lease prune 不再执行；
- 当前候选不计入 `failed`；
- 与计划“单个异常候选失败不得阻塞同批其他 Run”不符。

诊断查询应 fail-open，或者纳入候选级异常隔离；即使无法读取 Machine，也应以
`machineHeartbeat=unavailable` 继续执行回收。

### P2：active Lease 仍可能被按时间删除

相关位置：

- `packages/server/src/store/leases.ts:30-36`
- `docs/handoff/codex-handoff-day810-plan.md:41`

计划规定 active Lease 不按时间清理，只能由 report、cancel 或 reclaim 处理；但
`isLeaseDead()` 会把携带非空且已过期 `expiresAt` 的 active Lease 判为 dead，随后由
resolve/report 路径删除。

即使正常写入的 active Lease 当前总是 `expiresAt=null`，数据库 schema 并未禁止异常或
遗留数据。共享谓词不得因 `expiresAt` 按时间删除 active Lease。对异常的
`active + non-null expiresAt`，允许 report 继续走 active 状态机，同时记录不包含
credential 的 invariant violation；不能静默把异常数据当作完全正常，也不能删除
Lease 后制造永不自愈的 `running without active lease`。

### P2：T4 完整重启验收被过度声明

相关位置：

- `packages/server/src/fault-injection.test.ts:72-83`
- `packages/server/src/fault-injection.test.ts:312-367`
- `docs/handoff/005-phase1-day8-10.md:79`

当前测试创建两个 Hono/DB composition graph，并在 B 上手动调用 `sweep.runOnce()`；它没
有启动真实的两个 server 进程，也没有经过 `main()`、listener 和生产 timer 接线。

因此测试证明了“文件 PGlite close/reopen + 真实 daemon runtime + HTTP adapter + 同一
Sweep pass”，但 completion handoff 所称“文件 PGlite 双进程”和“B 启动立即 Sweep”
并不准确。

本轮的正确关闭方式是保留计划已批准的分层黑盒测试，把 handoff 描述收窄到实际覆盖
的 composition/boot seam。真实 `main()`/listener 双进程测试可以作为增强，但**不属于
Day 8–10 验收门，也不应为关闭此 finding 扩大测试范围**。

### P2：shutdown 没有等待在途 Sweep

相关位置：`packages/server/src/start.ts:86-96`。

`sweepTimer.stop()` 只清除 interval，不会等待已经开始的立即 Sweep 或周期 Sweep。随后
HTTP close callback 会关闭数据库并直接 `process.exit(0)`。如果 SIGTERM 恰好落在慢
Sweep 中，可能出现：

- 数据库关闭时 Sweep 仍在查询或事务中；
- Sweep 异常被后台 catch 后进程仍以 0 退出；
- 注释声称的“停止 Sweep → HTTP → DB”并未覆盖 in-flight pass。

建议 timer/controller 暴露 `stopAndDrain()`，先阻止新 tick，再等待当前 `runOnce()`
settle，之后才关闭 HTTP 和数据库。

### P3：TDD 顺序不可追溯

`docs/handoff/005-phase1-day8-10.md:8` 声称按 Slice A/B/C 以 TDD 逐段交付，但本批实现
仍全部位于未提交工作区，无法从提交历史证明 red-first 顺序。

这不等价于功能缺陷，但在 completion handoff 中应避免写成可审计事实；若需要保留该
声明，应通过按 Slice 提交测试红态/实现绿态，或附上可复现的开发记录。

## 三、对抗性代码质量审查

### Phase 2 阻塞项（高风险）：stale 判定与回收事务之间存在 TOCTOU

相关位置：

- `packages/server/src/sweep/index.ts:126-139`
- `packages/server/src/store/runs.ts:268-283`
- `docs/handoff/codex-handoff-day810-plan.md:152`

Sweep 在事务外读取并判断 `max(run.ts, progress.at)`，但 `reclaimStaleRunTx()` 只复核
`running + active lease`，没有复核决定 stale 的 activity watermark。

Phase 2 开始写 progress heartbeat 后，如果 daemon 在候选扫描完成后、回收事务开始前
写入新的 `progress.at`，Sweep 仍会把刚刚证明活跃的 Run 误回收为 `error`。现有测试只
验证预先存在的静态 progress，不能证明 scan/reclaim 窗口安全。

当前 Phase 1 没有 progress 写入方，claim/finalize 对 `ts` 的修改又伴随 phase 变化，
所以该窗口在当前运行面不可达；它不是撤回 Phase 1 完成状态的理由，但必须在 Phase 2
开放 progress heartbeat 写入前关闭。

把 activity 判定下沉到回收事务，或把扫描时观察到的 `ts/progress.at` 作为 CAS 前置
条件；CAS 失败应视为 benign race，不回收、不计失败。回归测试可以先使用确定性 hook
或存储层分支测试，Phase 2 再用真实 progress 写入链路补齐端到端证明。

### P3：Lease deadness 规则重复实现并可能虚报 prune

相关位置：

- `packages/server/src/sweep/index.ts:165-170`
- `packages/server/src/store/leases.ts:30-36`
- `docs/handoff/005-phase1-day8-10.md:67-70`

Sweep prune 手写了 terminal-grace deadness，而 read-side resolve 和 report 事务复核使
用 `isLeaseDead()`。这与 handoff 所称“三处共享同一谓词”不符，属于 Duplicated Code
风险，后续规则调整可能再次漂移。

此外，prune delete 没有检查 affected-row count；如果 report 并发消费了同一 Lease，
Sweep 的 delete 影响 0 行仍会增加 `pruned`，造成观测统计虚报。

建议把共享谓词收窄为只依赖 `state/expiresAt` 的输入，供三处直接复用；delete 使用
`returning` 或 affected-row count 决定是否增加 `pruned`。

## 验证结果

本次审查未修改源码。验证结果：

- `pnpm -r typecheck`：通过；
- `pnpm -r test`：通过，347/347（94 protocol + 43 daemon + 210 server）；
- `pnpm -r build`：通过；
- `git diff --check HEAD`：通过；
- schema 与 `packages/server/drizzle/` 无本批变更；本轮审查未执行会生成文件的
  `pnpm --filter @loopzhb/server db:check`。

测试期间曾因三条审查轨同时运行 Vitest，造成 PGlite/WASM 资源竞争和超时；清理并发
测试进程后，在允许绑定本地 `127.0.0.1` 临时端口的环境中进行干净复验，最终 347 项
全部通过。因此不把此前超时归类为产品回归。

## 最终执行清单

后续执行代理应按以下边界工作，不得自行扩张 T4 为真实双进程验收。

### A. 当前 Day 8–10 分支提交前关闭

1. 将 Machine 诊断读改为候选级 fail-open/隔离；诊断失败不得中止后续 reclaim/prune，
   并按计划更新 `failed`/安全日志语义；
2. active Lease 永不因 `expiresAt` 被按时间删除；异常 non-null expiry 记录安全的
   invariant 日志，正常 report 仍可使 Run 自愈收口；
3. Sweep prune 复用共享 Lease deadness 规则，delete 以 `returning`/affected-row
   决定 `pruned`；
4. timer/controller 增加可等待 in-flight pass 的 `stopAndDrain()`，shutdown 顺序变为
   阻止新 tick → 等待当前 Sweep → 关闭 HTTP → 关闭 DB；
5. 收窄 completion handoff 的 T4 表述：保留分层黑盒验收，不声称“双进程”或实际经过
   `main()` timer；
6. 修订 ADR-001 T5 artifacts 措辞；TDD 若无可审计提交记录，只修正文档声明，不得
   伪造历史。

### B. Phase 2 progress 写入前关闭

7. 将 stale activity 复核纳入回收事务/CAS；在 scan 后 activity 变化时 benign skip，
   不得误回收、不计 `failed`。

由于 Phase 2 是下一阶段，建议在本分支一并完成该防护和确定性测试，避免把已知窗口带
入 progress heartbeat 开发。

### C. Phase 6 真实 Postgres 前关闭

8. 为 report CAS guard-loss 增加有界状态机重试/重解析，正确区分 sweep、cancel、另一
   report 三种竞争者；未消费报告不得返回终态 coded 401；
9. Phase 6 使用多个真实 Postgres 物理连接补充最终并发验收。当前 PGlite 单测只能证明
   分支逻辑，不能宣称已经证明真实隔离级别交错。

应用层防护可在本分支提前实现，但若缺少可信的确定性测试，不得仅凭不可复现的并发
猜测加入复杂重试；至少应把它作为明确的 Phase 6 blocker 写入 ADR/handoff。

## 审查判定

- Roadmap：主体匹配，但 T5 在真实并发交错下仍有语义缺口；
- Day 8–10 Plan：接口和大部分行为匹配，存在失败隔离、active Lease、shutdown 与 T4
  验收证据偏差；
- 对抗性质量：发现两个需要在进入后续多连接/progress 阶段前关闭的竞态窗口；
- Phase 1 状态：可保留“当前 PGlite / 单进程范围内完成”，无需撤回 roadmap 标记；
- 提交建议：先关闭执行清单 A；清单 B 是 Phase 2 前置，清单 C 是 Phase 6 前置。T4
  仅收窄文档，不新增双进程验收门。
