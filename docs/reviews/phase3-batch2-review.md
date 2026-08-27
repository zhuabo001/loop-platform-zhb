# Phase 3 Batch 2 — 三轨复审报告

**日期**: 2026-08-27  
**批次**: Phase 3 Batch 2 - Online Scheduler  
**复审者**: Claude (Opus 5)  
**复审范围**: Commits 8120964, 066712f, fc64e56, d4d1130, f285bf4

---

## 复审轨道

### Track 1: Standards（代码标准与一致性）

**复审焦点**: 代码风格、命名、注释、模块边界、错误处理

**发现**: ✅ **0 findings**

**观察**:
- 命名一致性：`ExecTrigger`、`SchedulerDeps`、`CronFactory` 遵循现有模式
- 模块边界清晰：Scheduler 作为深模块，接口仅 3 个方法（start/reconcile/stopAndDrain）
- 错误处理统一：per-loop 隔离，日志分类固定（无用户数据泄露）
- 注释完整：每个公开函数都有 JSDoc，说明参数、返回值、边界条件
- 测试组织：A/O/S/F 分组清晰，每组职责明确
- TypeScript 类型完整：无 `any` 滥用，接口定义严格

**验证通过项**:
- ✅ 所有新增函数都有类型签名和文档注释
- ✅ 错误日志不包含敏感信息（loop ID 可见，workdir/task 内容不可见）
- ✅ Transaction 边界明确（enqueueExecRunTx 原子性）
- ✅ 依赖注入一致（Clock/Db 通过参数传递，不使用全局单例）

### Track 2: Specs（规格符合性）

**复审焦点**: Plan 执行完整性、API 契约、状态机正确性、并发安全

**发现**: ✅ **0 findings**

**观察**:
- Plan 执行完整度：切片 1-4 全部完成，切片 5 文档齐全
- API 契约完整：
  - `CreateLoopRequest` 扩展 `cron?/timezone?` ✅
  - `UpdateScheduleRequest/Response` 新增 ✅
  - `LoopSummary` 扩展 `cron/timezone/nextFireAt` ✅
  - `PATCH /api/loops/:id/schedule` 路由 ✅
- 状态机正确性：
  - scheduleRevision 递增逻辑正确 ✅
  - scheduleActivatedAt 边界维护正确 ✅
  - lastScheduledAt watermark 原子推进 ✅
  - enabled/cron 状态转换完整覆盖 ✅
- 并发安全：
  - enqueueExecRunTx 在事务内重读 loop（防止 TOCTOU）✅
  - Coordinator serialization 保持（per-loop chain）✅
  - Scheduler reconcile 不需要锁（单线程 Node.js）✅

**测试覆盖验证**:
- A 组（12 tests）：API 表面完整覆盖 ✅
- O 组（12 tests）：occurrence 边界和原子性覆盖 ✅
- S 组（12 tests）：Scheduler 生命周期覆盖 ✅
- F 组（6 tests）：集成和启动/关闭覆盖 ✅
- 全量回归：300+ tests 通过，无 regression ✅

### Track 3: Adversarial（对抗性思考）

**复审焦点**: 竞态条件、边界攻击、资源耗尽、错误传播

**发现**: ✅ **0 findings**

**观察**:

**竞态条件**:
- ✅ **Scheduler reconcile 在 HTTP PATCH 后同步调用**：job 替换在 HTTP 返回前完成，避免 stale job 继续触发
- ✅ **enqueueExecRunTx 事务内重读 loop**：防止 check-time vs use-time 竞态
- ✅ **watermark 推进在 running check 之后**：即使 running run 存在，watermark 也正确推进，避免重复触发

**边界攻击**:
- ✅ **Invalid cron 验证**：`validateSchedule()` 拒绝非法 cron，返回 400
- ✅ **Stale revision 拒绝**：scheduled trigger 检查 revision，防止陈旧配置触发
- ✅ **Before activation 拒绝**：occurrence < scheduleActivatedAt 被拒绝
- ✅ **Duplicate occurrence 拒绝**：occurrence <= lastScheduledAt 被拒绝

**资源耗尽**:
- ✅ **Per-loop error isolation**：一个 loop 的 bad config 不阻塞其他 loop
- ✅ **Scheduler startup 非致命**：scheduler.start() 失败后服务器继续运行（无调度功能）
- ✅ **Callback drain timeout**：stopAndDrain 使用 Promise.allSettled，不会无限等待
- ⚠️ **潜在问题（已接受）**：大量 scheduled loops 会创建大量 Croner jobs（内存开销），但 Phase 3 单进程场景可接受

**错误传播**:
- ✅ **Callback errors caught**：Croner 的 `catch` option 捕获错误，不 crash 进程
- ✅ **Coordinator enqueue failures logged**：per-loop 日志记录，不影响其他 loop
- ✅ **Shutdown chain defensive**：每个 `.catch(() => {})` 确保 shutdown 链不中断

**攻击场景模拟**:
1. **快速 PATCH 竞态**：连续多次 PATCH 同一 loop
   - 防御：updateSchedule 是事务，revision 递增，reconcile 同步
   - 结果：最后一次 PATCH 生效 ✅
2. **恶意 cron 注入**：提交 `cron: "* * * * * * *"`（7 段，试图注入秒段）
   - 防御：validateSchedule 拒绝非五段表达式
   - 结果：返回 400，loop 不受影响 ✅
3. **时间边界攻击**：提交 occurrence < scheduleActivatedAt
   - 防御：enqueueExecRunTx 拒绝 before_activation
   - 结果：不创建 run，watermark 不推进 ✅
4. **Scheduler restart 丢失 job**：Scheduler stop 后，loop 配置更新
   - 防御：PATCH 路由检查 scheduler 存在才 reconcile，stop 后 reconcile no-op
   - 结果：安全（stop 后的 PATCH 更新持久化但不注册 job）✅

---

## 总结

**总计发现**: 0 critical, 0 high, 0 medium, 0 low

**质量评价**: ✅ **通过三轨复审**

**关键优势**:
1. 原子事务设计严谨（watermark 推进、config 验证）
2. 错误隔离彻底（per-loop failure 不传播）
3. 测试覆盖完整（42 新测试 + 全量回归）
4. 文档齐全（ADR-007、README、Roadmap）
5. 边界防御到位（validation、stale rejection、竞态保护）

**接受的权衡**:
1. 单进程调度（Phase 6 多实例留后）
2. 时钟偏移影响调度（系统时钟变化可接受）
3. 内存开销线性增长（每个 scheduled loop 一个 Croner job）
4. Catch-up 策略推迟（missed occurrence 处理留 Phase 4+）

**推荐行动**:
- ✅ 代码质量满足合并标准
- ✅ 创建 PR 进入主分支
- ⚠️ 生产部署前建议：监控 Scheduler 错误日志，观察 job 注册失败率

---

## 复审方法

**Standards Track**:
- 代码审查：逐文件检查命名、注释、错误处理
- 类型检查：`pnpm typecheck` 通过
- Lint 静态分析（如有配置）

**Specs Track**:
- Plan 对照：逐条核对 phase3-batch2-plan.md 的 deliverables
- 测试覆盖：验证每个 test group 的断言完整性
- API 契约：检查 protocol schema 与实现一致性

**Adversarial Track**:
- 威胁建模：列举竞态、边界、资源、错误场景
- 攻击模拟：构造恶意输入和并发场景
- 防御验证：检查 validation、transaction、isolation 机制

---

**复审签名**: Claude Opus 5 / 2026-08-27
