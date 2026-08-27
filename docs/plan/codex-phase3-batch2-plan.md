# Phase 3 Batch 2 开发计划：在线调度、重叠保护与生产接入

## 1. 目标与固定边界

基线为 `1db043b`，当前分支 `feat/phase3-batch2-dev`，工作区干净。Batch 2 将 Batch 1 的 cron/timezone/revision 基础接入生产链路：

`Croner tick → Scheduler → RunCoordinator 原子事务 → 唯一 pending Run`

完成后必须保证在线期间：

- 每个 active Loop 恰好注册一个 `loopId + scheduleRevision` job。
- 同一 occurrence、旧 revision callback、配置更新竞争均不双跑。
- 机器离线时新 tick supersede 旧 pending，始终最多一个 pending exec Run。
- 已有 running 时只推进 `lastScheduledAt`，不创建或排队新 Run。
- `enabled=false` 只暂停自动调度，Run Now 继续可用。
- 停机 catch-up 留给 Batch 3；`next_run_at` 继续 write-closed。
- 单进程 PGlite 是部署边界；不增加 migration、多实例仲裁或真实 Claude 验收。

## 2. 接口与核心实现

### 管理 API

- 扩展 `CreateLoopRequest`：
  ```ts
  {
    machineId: string;
    name?: string;
    workdir?: string;
    taskFile?: string;
    cron?: string;
    timezone?: string; // 默认 UTC
  }
  ```
- 新增 `PATCH /api/loops/:id/schedule`：
  ```ts
  {
    cron?: string | null;
    timezone?: string;
    enabled?: boolean;
  }
  ```
  返回 `200 { loop }`；不存在返回 404；非法输入返回 400。空对象、未知字段和语义等值 patch 不写数据库。
- `LoopSummary` 增加 additive optional 的 `cron`、`timezone`、`nextFireAt`；新 Server 始终显式输出三个字段。暂停或 manual-only 时 `nextFireAt=null`，否则使用 `nextOccurrence(schedule, clock.now())` 计算，不写数据库。
- 新建 scheduled Loop 使用 revision `0` 作为初始配置版本；有 cron 时 `scheduleActivatedAt=createdAt`，无 cron 时 activation 为 null。创建校验、机器检查和插入保持原子，失败不得遗留半成品 Loop。
- 创建及有效 PATCH 提交后，通过注入的 `onScheduleCommitted(loop)` 同步内存 Scheduler；no-op 不替换 job。Scheduler 同步错误只记录固定分类，不回滚已提交配置或向日志暴露 cron/timezone。
- schedule PATCH 必须复用 `updateSchedule()`，不得在 HTTP/Admin 层复制 revision、activation 或 watermark 规则。

### RunCoordinator 原子 occurrence

- 将入口扩展为：
  ```ts
  type ExecTrigger =
    | { kind: "manual" }
    | {
        kind: "scheduled";
        scheduledFor: string;
        scheduleRevision: number;
      };

  enqueueExecRun(loopId, trigger?: ExecTrigger)
  ```
  省略 trigger 等价于 manual，现有 HTTP 行为不变；scheduled 拒绝原因保持 server 内部类型，不进入公共 wire。
- 新增 `latestOccurrence(schedule, atInclusive)`，使用同一五段 cron/timezone 将 callback 实际时间还原为规范 UTC occurrence；覆盖整分钟边界、DST gap 和 overlap，后续 Batch 3 catch-up 复用。
- scheduled enqueue 在单一数据库事务中：
  1. 重读 Loop，校验 active、revision、规范 occurrence、activation 和 watermark。
  2. 拒绝未来、非当前 cron occurrence、`<= activation` 或 `<= lastScheduledAt` 的输入。
  3. 条件更新 `lastScheduledAt=scheduledFor`，不修改 `updatedAt`。
  4. running 存在时提交水位并返回 skip。
  5. 否则条件 supersede 所有 pending exec，再插入唯一新 pending。
  6. claim guard 丢失、ID 工厂、watermark update 或 INSERT 失败时整个事务回滚。
- manual 与 scheduled 共用现有 per-loop serialization；manual/scheduled/claim 竞争最终不得留下两个可执行 exec Run。

### Scheduler 与生产生命周期

- 新增深模块 `createScheduler({db, coordinator, clock, cronFactory?, log?})`，公开：
  ```ts
  start(): Promise<void>;
  reconcile(loop): void;
  stopAndDrain(): Promise<void>;
  ```
- 注册表为 `Map<loopId, {revision, cron, timezone, job}>`。相同 revision/config reconcile 为 no-op；revision 改变时停止旧 job 并注册新 job；paused/manual-only 时移除 job。
- Croner 10.0.1 固定使用：
  ```ts
  {
    mode: "5-part",
    timezone,
    protect: overrunHandler,
    unref: true,
    catch: errorHandler
  }
  ```
- callback 捕获注册时的 revision 和 schedule，通过 `latestOccurrence()` 生成 `scheduledFor`，只调用 Coordinator。所有 callback promise 进入 in-flight 集合，异常按固定分类记录；不得输出异常消息、cron 或 timezone。
- 单个 Loop 注册或 callback 失败不得阻塞其他 Loop。测试使用注入的 fake cron factory，不等待真实分钟。
- 启动顺序固定为：
  `DB/migration → HTTP listener bind → Scheduler start → sweep arm → ready log`
- Scheduler 扫描级 DB 错误视为启动失败，执行 Scheduler/HTTP/DB 清理；单 Loop 注册错误仅隔离并记录。
- 关闭顺序固定为：
  `Scheduler stop+drain → sweep stop+drain → HTTP close → DB close`
  `stopAndDrain()` 先禁止新注册和 callback，停止所有 Croner job，再等待已进入 Coordinator 的 callback settle。

## 3. 实施切片

1. **计划与 A 组**：提交 Batch 2 计划；扩展 protocol、Admin、HTTP、summary 与 nextFireAt。
2. **O 组**：先建立 scheduled trigger tracer tests，再实现 occurrence guard、watermark 和原子 enqueue。
3. **S 组**：实现 fake cron factory、Scheduler 注册表、异常隔离、动态 reconcile 和 drain。
4. **F 组**：接入 bootstrap/main，完成离线机器、claim、manual Run Now 和生命周期集成测试。
5. **收口**：全量回归、三轨 Standards/Spec/Adversarial 复审、Issue 核销、ADR/roadmap/README 更新。

每个切片按 tracer test 的 red→green 推进；测试与对应最小实现放在同一可独立验收提交中，不伪造不存在的红灯历史。

## 4. 测试与验收

- **A1–A12**：manual 默认创建、scheduled 创建、timezone-only 创建、设置/修改、暂停、恢复、清除、no-op、非法输入、404、summary、nextFireAt。
- **O1–O12**：首次 occurrence、重复/更旧 occurrence、旧 revision、inactive、activation guard、running 水位、pending supersede、完整回滚、claim guard、并发 callback、manual/scheduled/update 竞争。
- **S1–S12**：active 扫描、过滤 inactive、Croner 固定参数、幂等注册、revision 替换、移除、旧 callback、occurrence 重建、overrun、异常隔离、启动失败清理、shutdown drain。
- **F1–F6**：离线 pending、多次 tick 合并、恢复只领取最新 Run、tick/claim 竞态、running overlap、paused 状态下 Run Now。

最终质量门：

```bash
pnpm --filter @loopzhb/server test
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

当前非 listener 基线为 59/59 通过；`start.test.ts` 的三个监听用例在受限沙箱中因 `listen EPERM` 失败，最终验收必须在允许绑定 `127.0.0.1` 的环境中执行，不将该环境限制误判为代码回归。

## 5. 文档与完成定义

- ADR-007 追加在线 Scheduler、规范 occurrence、原子 watermark 和关闭顺序裁决。
- roadmap 标记 Batch 2 完成，同时明确重启 catch-up 尚未完成。
- README 增加创建、PATCH、暂停 schedule 的 JSON 示例，以及五段 cron、UTC、DST、manual Run Now 语义。
- 审查发现的 P1/P2 必须创建带 `phase-3` label 的 GitHub Issue；只有修复提交、测试和后续复审核销齐备后才能关闭。
- Batch 2 仅在 A/O/S/F 全部通过、完整质量门全绿、无未核销 P1/P2、文档完成收口后标记完成。
