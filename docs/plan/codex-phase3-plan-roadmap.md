# Phase 3 开发计划：Cron 调度与离线恢复

## 一、目标与固定语义

Phase 3 将现有手动触发链路扩展为可靠的自动调度链路，同时保持 at-most-once：

- 每个 Loop 使用标准五段 cron 和显式 IANA 时区；缺省时区为 `UTC`。
- DST 遵循 Croner 10：春季不存在的本地时间跳过；秋季重复时间只在第一次出现时触发。
- 机器离线时 pending 持久保留；后续触发原子 supersede 旧 pending，队列始终最多一个。
- 存在 running 时跳过新触发并记录调度水位，不排队补跑。
- Server 停机期间遗漏任意多次触发，恢复后只处理最新一次 occurrence。
- `enabled=false` 只暂停自动调度；现有 Run Now 继续允许。
- 单进程 PGlite 是本阶段部署边界；多实例 Scheduler 仲裁留 Phase 6。
- 不包含 Task File、跨 Run state、goal/finish、Dashboard、artifact、认证、通知、evolve/edit 或 Agent 自主改 cron。

Phase 3 分三个批次完成；本文件是测试编组、审查和收口引用的长期锚点。

## 二、接口与数据模型

### 数据库

在 `loops` 增加：

- `cron text nullable`：`null` 表示 manual-only。
- `timezone text not null default 'UTC'`。
- `next_run_at text nullable`：按 ADR-003 回迁，但 Phase 3 保持 write-closed，Scheduler 忽略它。
- `schedule_revision integer not null default 0`：拒绝旧 timer 和旧配置回调。
- `schedule_activated_at text nullable`：当前 revision 开始生效的时间。
- `last_scheduled_at text nullable`：当前 revision 已处理的最新 occurrence。
- 为 `enabled=true AND cron IS NOT NULL` 增加部分索引。

迁移后既有 Loop 保持 `cron=null`、`timezone='UTC'`、`enabled` 原值，不得自动运行。

### 管理 API

扩展创建请求：

```ts
{
  machineId: string;
  name?: string;
  workdir?: string;
  taskFile?: string;
  cron?: string;
  timezone?: string; // default UTC
}
```

新增：

```http
PATCH /api/loops/:id/schedule
```

```ts
{
  cron?: string | null; // null 清除调度
  timezone?: string;    // 必须是有效 IANA 时区
  enabled?: boolean;    // 仅控制自动调度
}
```

- 空对象或只有未知字段的对象是无副作用 no-op，保持 tolerant-reader。
- 有效修改返回 `200 {loop}`；Loop 不存在返回 404；非法 cron/timezone 返回 400。
- cron 必须恰好五段，使用 Croner 10 的五段语法；拒绝 `@daily`、秒字段和年份字段。
- cron/timezone 上限均为 255 字符，禁止 NUL。
- LoopSummary 增加 additive optional 字段 `cron`、`timezone`、`nextFireAt`；新 Server 始终显式返回，暂停或 manual-only 时 `nextFireAt=null`。
- `lastScheduledAt`、revision 和保留的 `nextRunAt` 不进入公共 wire。

### 调度触发接口

保持 RunCoordinator 仍只有三个方法，将现有方法扩展为：

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

省略 trigger 等价于 manual，现有 HTTP 和测试保持兼容。Scheduled enqueue 在一个事务中：

1. 重读 Loop，校验 cron、enabled 和 revision。
2. 拒绝 activation 之前或不晚于 `lastScheduledAt` 的 occurrence。
3. 原子推进 `lastScheduledAt`。
4. 若有 running，只提交水位并跳过。
5. 若有 pending，原子 supersede 后插入一个新 pending。
6. 任一 guard、ID 工厂或 INSERT 失败时，水位、supersede 和新 Run 全部回滚。

## 三、批次计划与验收

### Batch 1 — 时间语义与持久化基础（建议 2–3 天）

实施：

- 先提交本计划，创建 ADR-007，记录 cron/timezone、DST、manual-only 迁移、revision 和原子水位决策。
- 增加 migration、Drizzle schema、部分索引和数据库往返测试。
- 建立内部 schedule config 模块，负责 cron/timezone 校验、next-fire 计算和 schedule revision 状态转换。
- 本批不修改 HTTP DTO，不启动 Scheduler，不产生自动 Run。
- 配置变更规则：
  - 首次启用 cron：revision 递增，`scheduleActivatedAt=now`，水位清空。
  - 修改 cron/timezone 或重新启用：revision 递增并重新建立 activation boundary。
  - 暂停：revision 递增，activation 清空，保留 cron 配置。
  - 清除 cron：revision 递增，cron/activation/watermark 清空。
  - 等值 patch：revision、`updatedAt` 和水位均不改变。

测试编组：

- `M1–M6`：旧库迁移、默认值、索引、字段往返、前滚 migration。
- `D1–D6`：五段校验、非法时区、UTC/Asia-Shanghai、纽约 DST gap、DST overlap、next-fire。
- `C1–C8`：启用、修改、暂停、恢复、清除、等值更新、activation、水位重置。

批次验收：

- Phase 2 数据库升级后，旧 Loop 不会获得自动调度。
- `2026-03-08 America/New_York 02:30` 不产生 occurrence。
- `2026-11-01 America/New_York 01:30` 只产生第一次 occurrence。
- `next_run_at` 存在但没有任何生产写入或定时行为。
- `pnpm test`、`pnpm typecheck`、`pnpm build`、server `db:check`、`git diff --check` 全绿。

文档收口：

- ADR-007 状态为 Accepted，记录本批全部长期裁决。
- roadmap 增加 Batch 1 完成状态，但 Phase 3 保持进行中。
- 不更新 README，不宣称 cron 已可用。
- 创建 GitHub `phase-3` label；审查发现按 Issue Tracker 规则落 Issue。

### Batch 2 — 正常调度、重叠保护与生产接入（建议 4–5 天）

实施：

- 开放 CreateLoop schedule 字段、schedule PATCH 和 LoopSummary 调度观察字段。
- 实现 Scheduler 深模块：每个 active Loop 一个 Croner job，注册表以 `loopId + revision` 标识。
- Croner 固定使用 `mode:'5-part'`、显式 timezone、overrun protection、unref timer 和固定错误分类。
- callback 使用同一 cron/timezone 重建规范化 `scheduledFor`，只调用 `enqueueExecRun()`。
- schedule 更新提交后同步替换内存 job；已进入回调的旧 job 由数据库 revision guard 拒绝。
- Scheduler 在 HTTP listener 成功绑定后启动；shutdown 先 stop 并 drain Scheduler，再 drain sweep、关闭 HTTP 和 DB。
- Batch 2 只处理 Server 在线期间的触发；停机 catch-up 留 Batch 3。

测试编组：

- `A1–A12`：创建、更新、清除、暂停、恢复、无效输入、no-op、404、summary 和 nextFireAt。
- `O1–O12`：相同 occurrence 去重、revision guard、watermark、pending supersede、running skip、事务回滚、手动/定时竞争。
- `S1–S12`：注册、替换、删除、异常隔离、并发 callback、启动顺序和 shutdown drain。
- `F1–F6`：机器离线、多次在线触发、恢复领取、迟到 claim 竞态、手动 Run Now 在 paused 状态仍可运行。

批次验收：

- 在线 Scheduler 到点后恰好创建一个 pending exec Run。
- 机器离线跨越多个触发点后，历史可有 skipped Run，但始终只有一个 pending。
- running Run 跨越触发点时不生成第二个 Run，且对应水位已推进。
- 同一 occurrence 重复回调、旧 revision callback、cron 更新与 callback 竞争均不双跑。
- 暂停后 cron 不触发，Run Now 仍保持现有行为。
- 停止 Scheduler 后不存在访问已关闭 DB 的 callback。
- 全仓测试、类型检查、构建、migration 检查和 diff 检查全绿。

文档收口：

- ADR-007 追加 Scheduler、原子 occurrence 和关闭顺序的修订记录。
- roadmap 标记 Batch 2 完成，并明确重启 catch-up 尚未完成。
- README 增加创建/修改/暂停 schedule 的 JSON 示例、五段 cron、UTC 默认值、DST 与 manual Run Now 语义。
- Batch 2 的 P1/P2 Issue 必须经修复、测试和后续复审核销；未核销不得标记完成。

### Batch 3 — 重启 Catch-up、全链路验收与阶段收口（建议 3–4 天）

实施：

- Scheduler 启动时对每个 active Loop 计算最新过去 occurrence。
- 仅当 occurrence 晚于 `scheduleActivatedAt` 且晚于 `lastScheduledAt` 时调用 scheduled enqueue。
- 无论停机跨越多少 occurrence，只传递最新一个；DST gap 不虚构补跑。
- catch-up 遇到 running 时仅推进水位；遇到 pending 时继承 T7 supersede；同一 revision 重复启动由水位去重。
- 单个 Loop 的损坏配置或 catch-up DB 错误记录固定分类并跳过，不阻塞其他 Loop 或 HTTP readiness。
- 增加文件型 PGlite、真实 HTTP、Scheduler、daemon runtime 和 Fake Runner 的确定性 E2E；不新增付费真实 Claude 验收。

测试编组：

- `R1–R12`：短停机、长停机、多次重启、首次触发前重启、running/pending/manual 竞争、DST 停机窗口、水位回滚。
- `E1–E10`：文件型 DB 重启、离线 daemon 恢复、真实 poll/report、唯一执行、lease 消费、关闭 drain。
- `X1–X4`：无效持久化配置隔离、catch-up 单 Loop 失败隔离、日志不含不可信配置、全量回归。

阶段验收：

- Server 停机跨越一个或多个触发点，重启后最多产生一个可执行 pending。
- 同一数据库连续重启两次不会为同一 occurrence 新增第二个可执行 Run。
- 机器离线恢复后 daemon 只领取合并后的唯一 pending，并只 report 一次。
- 已 running 的 Run 在重启后不会被重新投递；原有 sweep/reconcile 行为保持通过。
- cron tick、手动 Run Now、schedule 更新和 poll claim 的测试交错均不产生双跑。
- `pnpm test`、`pnpm typecheck`、`pnpm build`、server `db:check`、`git diff --check` 全绿。

文档收口：

- 新增 `docs/tests/phase3-acceptance.md`，记录固定提交、测试命令、环境、结果和重启/离线行为证据。
- ADR-007 追加最终 catch-up、故障隔离和已接受边界。
- roadmap 记录三个批次完成日期，并将 Phase 3 标记为完成。
- README 去除“catch-up 尚未完成”提示，记录最终恢复承诺。
- 所有 Phase 3 阻塞 Issue 必须关闭；获准右移的非阻塞项改挂目标阶段标签，并在 roadmap 只保留 Issue 指针。
- handoff 只保留当批物流且不提交；长期裁决必须进入 ADR，范围与状态必须进入 roadmap。
- 最终 PR 描述引用 ADR-007、Phase 3 验收文档和实际 Issue，不引用 handoff。

## 四、阶段 Definition of Done

1. cron、timezone、DST、动态更新、暂停和观察 API 全部可用。
2. 旧 Loop 升级后保持 manual-only，零意外自动执行。
3. 正常 tick、离线 pending、running overlap 和重启 catch-up 共享同一个 coordinator 事务入口。
4. schedule revision、activation boundary 和 last-scheduled watermark 在崩溃及重复启动下保持原子去重。
5. 同一 Loop 任意时刻最多存在一个可执行 exec Run。
6. Scheduler 启停与 Server 资源生命周期完整收口。
7. 确定性 Phase 3 E2E 和全仓回归全部通过。
8. ADR、roadmap、README、验收记录和 GitHub Issues 按仓库规约完成收口。
9. Phase 3 不以真实 Claude 重跑为阶段门；Phase 2 已验收的 Runner/HTTP/report 链路不得回归。
