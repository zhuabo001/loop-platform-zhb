# Kimi 复核：Day 8–10 代码审查意见裁决

> 日期：2026-08-11 ｜ 分支 `feat/day8-10-fault-injection`
> 对象：`docs/handoff/codex-handoff-day810-code-review.md`（针对 Day 8–10 实现的
> Roadmap/Plan 双轨 + 对抗性审查）
> 用途：记录对该审查意见的逐条裁决——哪些成立、哪些部分成立、哪些定级有异议，
> 以及认可的修复顺序。审查所评实现的完成记录见
> `docs/handoff/005-phase1-day8-10.md`。

---

## 总体判断

这份审查**质量很高，是真正意义上的对抗性审查**——两个 P1 竞态都是真问题，
其中一个正打在 T5 承诺的要害上；P2 里有三条是对实现/文档的准确指控。只有一处
严重度定级（P1 阻塞 Phase 1 收口）和一处验收口径（T4 进程级重启）提出异议。

## 成立的真问题（实现方漏掉的）

### ① P1 Sweep/report 竞态——本轮最重的一击，成立

核验链路：report 事务内 re-resolve 看到 `active + running`
（`packages/server/src/store/report.ts:118-138`）→ sweep 抢先提交 → CAS
`WHERE phase='running'` 影响 0 行（`report.ts:154-159`）→ 抛
`consumed_or_revoked` → coded 401 → daemon 按
`packages/daemon/src/client.ts:157-161` 映射为 `confirmed` → **丢弃尚未被消费
的报告**。Lease 因事务回滚仍是 terminal-grace，但再没有人会来 report——真实
结果永久丢失。这正是 T5 存在的意义场景（休眠唤醒恰逢 sweep 触发），审查指出
的修复方向（CAS 失败后 re-resolve，发现 `error + terminal-grace` 转 reconcile）
是对的，且与既有分支表模式完全兼容。

### ② P1 扫描/回收 TOCTOU——成立，且正确地限定了射程

`considerCandidate` 在事务外判定活跃度，`reclaimStaleRunTx` 只复核
`running + active lease`（`packages/server/src/store/runs.ts:268-283`），不复核
让它判定 stale 的 watermark。Phase 1 不可达（`runs.progress` 没有任何写入方，
claim/finalize 的 ts 写入都伴随 phase 变化、被现有 guard 覆盖），但 Phase 2
progress heartbeat 一落就是真 bug。审查明确写了「Phase 2 开始写 progress 后」，
没有夸大。把观测到的 `ts/progress.at` 作为 CAS 前置条件下沉进回收事务，是正确
且廉价的修法。

### ③ P2 诊断查询在候选级 try 之外——成立，是对计划的执行偏差

`getMachine()` 位于 `considerCandidate` 的 try 块外
（`packages/server/src/sweep/index.ts`），诊断读一旦抛错会中止整轮 pass：后续
候选不回收、prune 不执行、当前候选不计 `failed`——直接违反计划「单个异常候选
失败不得阻塞同批其他 Run」。既有隔离测试只覆盖了 `reclaimStaleRunTx` 抛错路径，
没测诊断读抛错。

### ④ P3 prune 谓词逐点复制——成立，而且抓得很疼

完成 handoff 明写「三处共享同一谓词，比逐点复制更符合本仓库风格」，然后 sweep
的 prune 段就内联手写了一份 deadness 判定。审查把这俩并排引用，属于当场抓获。
`pruned` 不查 affected-row 的虚报也成立（PGlite 上可达：page 读取与 delete 之间
report 事务可提交，delete 影响 0 行仍计数）——严重性只是计数器虚报，但
`.returning()` 一行就能修。

### ⑤ P2 active Lease 按时间删除——成立，且后果比审查写的更糟

`isLeaseDead` 对 active 分支保留了批前的旧行为（非空且过期即删）。这不只违反
计划「active 不按时间清理」的字面规则，还有个审查没展开的级联：删掉 active
Lease 会制造「running 无 active lease」的孤儿 Run，此后每轮 sweep 都
`ReclaimGuardLostError` 刷 `failed` 日志，且永不自愈。反过来按审查建议让
active 直接返回存活，daemon 的正常 report 可以把 Run finalize 掉——自愈。

### ⑥⑦⑧ 其余成立项

- **P2 shutdown 不等在途 Sweep**：成立。`sweepTimer.stop()` 只清 interval，
  慢 pass 在 closeDb 下裸奔；事务原子性保证无部分写入，但与注释声称的顺序不符，
  `stopAndDrain()` 形状正确。
- **P2 T4 措辞过度**：成立。handoff 写「文件 PGlite 双进程」确属夸大（是同进程
  两个 composition graph）；「B 启动立即 Sweep」实际是手动调用 `sweep.runOnce()`
  （与 boot 同一入口，但 timer 接线未经端到端演习）。
- **P3 TDD 不可追溯**：成立。「按 TDD 逐段交付」在未提交的工作区里不可审计，
  应按 Slice 提交使其成为可审计事实。
- **ADR-001 T5 artifacts 措辞**：成立。属文档漂移（A-08 已定 Phase 1 不写
  artifacts），非本批实现漂移，ADR 应修订。

## 两点保留意见（对审查定级/口径的异议）

### 1.「修复 P1 前 Phase 1 不算完成」的判定与 roadmap 存在张力

roadmap Phase 6 明确把「多个物理连接验证行锁竞争、隔离级别」划为后置，且该交错
在 PGlite 单连接上**原理性不可复现**（写事务持连接期间 reclaim 事务只能排队——
单连接恰好把破损窗口串行化掉了，审查自己也承认这点）。这意味着修复的回归测试
在 PGlite 上写不出来，只能做单测分支 + Phase 6 真验证。所以更准确的表述不是
「Phase 1 不算完成」，而是「**应用层防护现在就位，多连接形态的证明归 Phase 6**」
——结论相同（现在就修），但收口口径应与 roadmap 的诚实注记对齐。

### 2. T4 的「进程级重启」要求超出了本批计划自己批准的接缝

计划的 Assumptions 第一条就是「测试接缝采用已确认的分层黑盒：HTTP + 文件
PGlite + 真实 daemon runtime」。审查给的选项 2（保留分层黑盒、收窄 handoff
表述）才是与计划一致的关法；选项 1（真 `main()`/listener 双进程）可以作为增强，
但不该作为验收门。

## 审查质量评分

| 维度 | 评价 |
|---|---|
| 准确性 | 9 条 finding 全部核验属实，无误报；每条都给了 file:line 和交错时序 |
| 深度 | 抓到了两个实现方意识外的竞态窗口，且正确区分了「Phase 1 可达」与「Phase 2/6 才可达」 |
| 诚实度 | 验证部分如实披露了并发测试导致的 PGlite 资源竞争，没有把环境超时误报为回归 |
| 可改进 | P1 的阻塞性判定宜与 roadmap Phase 6 注记对齐；T4 验收口径宜尊重计划已批准的接缝 |

## 认可的修复顺序

1. report CAS 失败 re-resolve → reconcile（P1）；
2. 回收事务下沉活跃度 CAS（P1）；
3. 诊断读纳入候选级失败隔离（P2）；
4. active Lease 不按时间判死（P2）；
5. prune 复用共享谓词 + `returning` 计数（P3）；
6. shutdown `stopAndDrain`（P2）；
7. handoff/ADR 措辞修订 + 按 Slice 提交（P3）。
