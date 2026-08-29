# ADR-007：Phase 3 批次一——时间语义与持久化基础

- 状态：Accepted
- 日期：2026-08-25
- 关联：docs/roadmap.md Phase 3 批次一；docs/plan/codex-phase3-batch1-plan.md；ADR-003（schema 演进纪律）
- 实现：migration `0002_wild_millenium_guard.sql`；初始实现 `51f3ceb`；Round 2 修复 `67cb80a`；Round 3 修复 `f69216c`；测试分组 M/D/C

## 背景

Phase 3 引入 cron 调度能力。批次一建立时间语义、配置状态机与持久化基础，为后续批次的在线 Scheduler 和重启恢复提供共同依赖，但不开放自动调度能力——既有 Loop 升级后仍为 manual-only，不产生意外 Run。

核心约束：
- 旧数据库可前滚升级，无破坏性变更
- 时间计算确定性、可测试
- 状态转换集中在唯一内部模块
- `next_run_at` 完成 schema 声明但保持 write-closed
- 不修改 protocol、HTTP 路由或生产启动流程

## 决策

### 1. 时间语义契约

采用 **Croner `^10.0.1`** 作为 cron 表达式解析和下次执行时间计算引擎。

**cron 表达式规范**：
- 只接受标准五段表达式（分 时 日 月 星期）
- 拒绝宏（`@daily`/`@hourly` 等）、秒字段、年份字段
- 段间空白规范化为单个空格
- 去除首尾空白
- 拒绝空串、包含 NUL、超过 255 字符的值

**时区规范**：
- 默认时区为 `UTC`
- 时区必须是运行时可识别的有效 IANA 时区（`Asia/Shanghai`、`America/New_York` 等）
- 去除首尾空白
- 拒绝空串、包含 NUL、超过 255 字符或无效的值

**DST 行为**：
- DST gap（spring forward，不存在的时间）：跳过该 occurrence，使用下一个有效时间
- DST overlap（fall back，重复的时间）：只采用第一次 occurrence，不重复触发

**时间表示**：
- 所有输入和输出时间均为绝对 `Date` 对象
- 持久化时统一转为 ISO 8601 字符串（`toISOString()`）
- 下次执行时间计算使用 `afterExclusive` 语义（不包含参考时间本身）

### 2. Schema 扩展与迁移

在 `loops` 表增加以下字段：

```sql
-- cron 表达式（nullable，null = manual-only）
cron text nullable

-- IANA 时区（not null，默认 UTC）
timezone text not null default 'UTC'

-- 下次计划执行时间（nullable，Phase 3 保持 write-closed）
next_run_at text nullable

-- 调度配置版本号（每次配置变更递增）
schedule_revision integer not null default 0

-- 当前调度配置激活时间（enabled=true && cron!=null 时设置）
schedule_activated_at text nullable

-- 上次自动调度触发时间（watermark，配置变更时清空）
last_scheduled_at text nullable
```

**索引**：
- `loops_active_schedule_idx`：部分索引，谓词为 `enabled=true AND cron IS NOT NULL`
  - 用于 Scheduler 扫描活跃调度配置（批次二引入）

**迁移纪律**：
- 由 Drizzle 生成，保持前滚-only
- 不修改历史 migration
- 旧 Loop 迁移后 `cron=null`，保持 manual-only
- 新字段均有安全默认值，不破坏既有数据

### 3. 时间语义模块

在 `packages/server/src/schedule/` 建立独立的调度时间计算模块：

```typescript
interface NormalizedSchedule {
  cron: string;
  timezone: string;
}

class ScheduleValidationError extends Error {
  constructor(
    public field: 'cron' | 'timezone',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

function validateSchedule(
  cron: string,
  timezone: string,
): NormalizedSchedule;

function nextOccurrence(
  schedule: NormalizedSchedule,
  afterExclusive: Date,
): Date | null;
```

**职责边界**：
- 只计算时间，不持有 timer
- 不访问 HTTP、数据库或 RunCoordinator
- 纯函数，确定性输出
- 使用 Croner 的 `mode: "5-part"` 和显式 timezone

**校验失败**：
- 抛出稳定的 `ScheduleValidationError`
- 字段分类仅为 `cron` 或 `timezone`
- 错误消息清晰，不暴露内部实现细节

### 4. 调度配置状态机

建立唯一内部写入口 `updateSchedule`，集中管理所有调度配置变更：

```typescript
type SchedulePatch = {
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
};

type UpdateScheduleResult =
  | { found: false }
  | { found: true; changed: false; loop: Loop }
  | { found: true; changed: true; loop: Loop };

async function updateSchedule(
  loopId: string,
  patch: SchedulePatch,
): Promise<UpdateScheduleResult>;
```

**状态转换规则**（在一个数据库事务内完成）：

1. **先重读 Loop**，再对 patch 做规范化和语义比较
2. **空 patch 或等值 patch**：零写入，revision、`updatedAt`、activation 和 watermark 全部不变
3. **任意有效配置变化**：
   - `scheduleRevision + 1`
   - `updatedAt = clock.now()`
   - `lastScheduledAt = null`（清空 watermark）
4. **更新后满足 `enabled=true && cron!=null`**：
   - `scheduleActivatedAt = clock.now()`（建立 activation boundary）
5. **更新后为暂停或 manual-only**：
   - `scheduleActivatedAt = null`
6. **暂停**（`enabled=false`）：保留 cron 和 timezone
7. **清除 cron**（`cron=null`）：保留 enabled 和 timezone
8. **恢复启用**：重新建立 activation boundary，不补算暂停期间的 occurrence
9. **Loop 不存在**：返回 `{found: false}`，不得插入或修改任何记录
10. **校验或数据库错误**：完整回滚

**不变式**：
- `next_run_at` 在 Phase 3 保持为 null（write-closed）
- 所有状态转换不得创建 Run 记录
- 批次二的管理 API 只能调用该入口，不得重新实现 revision 或 watermark 规则

### 5. 并发与一致性

Phase 3 仅承诺**单进程 PGlite**：
- 不处理多实例并发调度
- 不实现分布式锁或仲裁机制
- 多实例部署的调度仲裁留给 Phase 6

单进程内的并发安全：
- 数据库事务保证 `updateSchedule` 的原子性
- Scheduler（批次二引入）使用单一事件循环，无并发修改

## 测试计划

测试按 **M（Migration）、D（DST & Time）、C（Configuration）** 三组分别先提交失败测试，再提交最小实现使其转绿。

### M：迁移与 schema

- **M1**：旧数据库升级——通过仅含旧 migration 的 fixture 创建数据库、写入旧 Loop，再应用完整 migration；旧字段原值不变，新字段为安全默认值
- **M2**：新数据库插入 Loop 时得到 `cron=null`、`timezone='UTC'`、`scheduleRevision=0` 和三个 nullable 时间字段
- **M3**：所有新增字段可完整写入和读取
- **M4**：系统表中存在名称、索引键和谓词均正确的部分索引 `loops_active_schedule_idx`
- **M5**：同一文件数据库重复执行 migration 无错误、无重复对象、数据不变
- **M6**：迁移和配置变更后 `next_run_at` 始终为 null

### D：cron、时区与 DST

- **D1**：接受合法五段 cron；规范化段间空白
- **D2**：拒绝宏、四段、六段、七段、非法值、NUL 和超长值
- **D3**：接受 `UTC`、`Asia/Shanghai`、`America/New_York`；拒绝非法时区
- **D4**：相同 `09:00` 本地触发在 UTC 与上海得到不同且准确的绝对时间
- **D5**：纽约 `30 2 * * *` 从 2026-03-07 向后计算时，跳过不存在的 2026-03-08 02:30，下一次为 2026-03-09 02:30 EDT
- **D6**：纽约 `30 1 * * *` 在 2026-11-01 只返回第一次 01:30；继续向后计算不得返回第二个重复 01:30

### C：配置状态转换

- **C1**：enabled Loop 首次设置 cron，revision 递增、activation 写入、水位清空
- **C2**：修改 cron，revision 和 activation 更新，旧水位清空
- **C3**：修改 timezone，行为与修改 cron 相同
- **C4**：暂停后保留 cron/timezone，清空 activation 和 watermark
- **C5**：恢复后 revision 再递增，以恢复时刻建立 activation
- **C6**：清除 cron 后成为 manual-only，activation 和 watermark 为空
- **C7**：空 patch、等值 patch 及仅空白差异的 cron patch 均为零写入
- **C8**：Loop 不存在、非法配置和注入的数据库失败均为零写入或完整回滚

所有测试同时断言 `runs` 表保持为空（无意外自动执行）。

## 边界与显式不做

**本批次完成**：
- Schema 扩展与迁移
- 时间语义模块（cron 验证与下次执行时间计算）
- 调度配置状态机（集中的写入口）
- 完整测试覆盖（M/D/C 三组）

**显式不做**（留给后续批次）：
- 在线 Scheduler（批次二）
- 调度管理 HTTP API（批次二）
- `next_run_at` 在 Phase 3 全程保持 write-closed（未来 Phase 需要时重新评估）
- 重启恢复与 watermark 推进（批次三）
- 多实例仲裁（Phase 6）
- 不修改 protocol 定义
- 不修改 HTTP 路由
- 不修改生产启动流程
- 不创建 Scheduler 或 timer

## 批次验收

| 验收目标 | 验收方式 | 必须保留的证据 |
| --- | --- | --- |
| 旧数据库安全升级 | 运行 M1、M5 文件型 PGlite 测试 | 旧 Loop 升级前后快照及新字段默认值 |
| 无意外自动执行 | 检查所有 M/C 测试中的 runs 快照 | 全部为零 Run |
| 五段 cron 和时区正确 | 运行 D1–D4 | 精确的 UTC 时间断言 |
| DST 语义固定 | 运行 D5、D6 | gap 日期不存在、overlap 第二次不出现 |
| 状态机持久化正确 | 运行 C1–C8 | 每次转换的完整 Loop 行快照 |
| `next_run_at` 保持关闭 | M6 加生产代码搜索 | 仅 schema 声明，无生产写入调用 |
| Batch 1 未越界 | 审查相对基线的变更文件 | 无 protocol、HTTP、start、coordinator 或 Scheduler 行为变化 |
| 全仓无回归 | 执行完整质量门 | 所有命令退出码为 0 |

**完整质量门**：

```bash
pnpm --filter @loopzhb/server test
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

**附加结构检查**：

```bash
# 确认 next_run_at 仅在 schema 声明，无生产写入
rg -n "nextRunAt|next_run_at" packages/server/src --glob '!**/*.test.ts'

# 审查变更文件范围
git diff --name-only "$(git merge-base HEAD main)"...HEAD
```

Batch 1 只有在上述目标全部通过时才能标记完成；任何自动 Run、公共 schedule API、生产 timer 或未解释的 `next_run_at` 写入都直接判定验收失败。

## 文档与 Issue 收口

- ADR-007 在全部质量门通过后改为 Accepted，并记录最终 migration 名称和测试分组
- `docs/roadmap.md` 标记 Phase 3 Batch 1 完成，记录完成日期和提交引用；Phase 3 整体仍为进行中，下一目标明确为 Batch 2 在线 Scheduler
- `docs/plan/codex-phase3-plan-roadmap.md` 保持 Phase 3 长期计划锚点；Batch 1 测试提交引用 M/D/C 编号
- README 不更新，不对外宣称 cron 已可用
- 创建 GitHub 标签 `phase-3`，描述为"Phase 3 cron scheduling and offline recovery"
- 验收前审查 Phase 3 Issues：P0/P1 和实质性 P2 必须修复并复核，或经明确批准右移到后续批次
- PR 描述记录基线提交、迁移文件、M/D/C 结果、完整质量门结果和开放 Issue；不引用或提交 handoff 文档

## 批次三追加裁决（2026-08-29，重启 catch-up 收口）

以下裁决在 Batch 3 落地，与本 ADR 的既有决策同属 Phase 3 调度语义的一部分：

1. **重启 catch-up 语义**：Server 停机跨越任意多次 occurrence，重启后每个活跃 Loop 最多恢复**最新的一个真实 occurrence**（`latestOccurrence` 对数重建，不枚举历史）；最终裁决由 `enqueueExecRun` 事务内的最新行完成，启动扫描的快照只做 eligibility 提示。DST gap 不虚构 occurrence；DST overlap 只恢复第一次真实 occurrence。
2. **注册先于恢复**：`start()` 先完成所有 Croner job 注册，再以同一词法作用域内的 registry 回读（`entry.revision === loop.scheduleRevision`）定义恢复集合——注册失败的 Loop 绝不 catch-up；恢复较慢时正常 timer 已开始覆盖 cutoff 之后的 occurrence。
3. **fail-closed 持久化状态校验**：活跃 scheduled Loop 的 `scheduleActivatedAt` 缺失或非规范 UTC ISO、非空 `lastScheduledAt` 非规范、或 `scheduleRevision` 非非负安全整数时，启动扫描与 scheduled enqueue 两条路径统一 fail-closed（扫描侧跳过该 Loop；enqueue 侧返回包内 skip 原因 `invalid_schedule_state`，零写入）。规范 UTC ISO 的唯一判定为 round-trip 相等：`parse(value) !== undefined && new Date(ms).toISOString() === value`。判定规则只有一份实现（`isValidPersistedScheduleState`），两条路径共享。
4. **catch-up 与 manual Run Now 竞争**：沿用 T7——较晚写入者 supersede 较早的 pending，**包括 manual pending**（停机期间的 manual Run Now 可能被重启 catch-up 取消）。任意时刻最多一个 pending，不出现双跑；这是已接受的产品语义取舍（评审 P3-2）。
5. **故障隔离**：单 Loop 的时间计算、job 注册或 enqueue 错误只记固定分类后跳过，不阻塞其他 Loop 或 readiness；日志永不输出 cron、timezone、异常消息或其他不可信值。不引入后台 catch-up retry worker——恢复失败由下一次重启或下一个正常 cron tick 合并恢复。
6. **catch-up 串行与停机安全**：每个 Loop 的 catch-up enqueue 串行 await、与在线 callback 共用同一 in-flight 集合统一 drain；每迭代一个 Loop 前检查 `stopped`，`stopAndDrain()` 后绝不写入正在关闭的数据库。单 Loop catch-up 挂起拖住 boot gate 的问题经评审裁决（P3-1，[无效审查]）不引入并发恢复：并发仍需等待全部 catch-up 完成，无法改变 boot gate 语义；真实挂起的超时/中断/可观测性如需处理，须先形成独立的启动裁决。
7. **测试观察面**：watermark、activation、revision 不进入公共 wire；E2E 经真实 HTTP 驱动行为，对内部状态的断言只经测试自持的 DbHandle 只读完成，不为此新增 protocol 字段。

## 修订记录

- 2026-08-25：初始 Proposed。
- 2026-08-25：Round 2 修复统一 DST gap、真实文件库迁移与数据库故障回滚证据；等待 Round 3 复审后决定是否 Accepted。
- 2026-08-25：Round 3 修复 overlap `afterExclusive` 单调性和 M1 全字段快照；Round 4 Standards/Specs/Adversarial 均 0 finding，状态改为 Accepted。
- 2026-08-29：追加批次三裁决（重启 catch-up 语义、fail-closed 状态校验、T7 与 manual pending 的竞争明示、故障隔离与日志纪律）；验收证据见 `docs/tests/phase3-acceptance.md`。
