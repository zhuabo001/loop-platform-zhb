# Phase 3 Batch 1 开发计划：时间语义与持久化基础

- 状态：实现完成，等待 Round 3 三轨复审核销
- 基线：`f9f3025d0ac80b1f9f947a9392e82549207bdb2b`
- 初始实现：`51f3cebcf8e8f4e8346b26d0cfbe81eb31303276`
- Round 2 修复：`67cb80a`
- 长期决策：ADR-007
- 范围状态：`docs/roadmap.md` Phase 3

## 1. 批次目标

Batch 1 只建立后续在线 Scheduler 所依赖的持久化和时间语义基础：

1. 旧 PGlite 数据库可前滚升级，既有 Loop 保持 manual-only，升级过程不创建 Run。
2. 提供确定性的标准五段 cron、IANA timezone 和 DST occurrence 计算。
3. 提供唯一内部 schedule 配置写入口，集中维护 revision、activation boundary 和 watermark。
4. 为 Batch 2/3 固定可复用的 schema、时间语义和状态转换契约。

本批次不开放 HTTP schedule API，不启动 Scheduler/timer，不修改 protocol、生产启动顺序或 RunCoordinator，也不创建自动 Run。

## 2. 已裁决语义

### 2.1 Schedule 数据

`loops` 新增：

- `cron text null`：`null` 表示 manual-only。
- `timezone text not null default 'UTC'`。
- `next_run_at text null`：Phase 3 全程 write-closed。
- `schedule_revision integer not null default 0`。
- `schedule_activated_at text null`。
- `last_scheduled_at text null`。

增加部分索引 `loops_active_schedule_idx`，谓词为 `enabled=true AND cron IS NOT NULL`。

### 2.2 Cron 与时间

- 只接受标准五段 cron；Croner 所有构造显式使用 `mode: "5-part"`。
- 接受标准 weekday `0` 和 `7` 作为 Sunday。
- 拒绝宏、四/六/七段表达式、非法值、NUL、空串和超过 255 字符的原始输入。
- cron 段间空白归一化为单个空格；timezone 去除首尾空白。
- timezone 必须是运行时可识别的 IANA timezone，默认 `UTC`。
- `nextOccurrence(schedule, afterExclusive)` 返回严格晚于参考时间的绝对 `Date`。
- DST gap 不产生 occurrence；DST overlap 只采用第一次 occurrence。
- gap 规则适用于字面量、列表、范围和步长等所有合法五段表达式，不只适用于固定小时。

### 2.3 配置状态机

所有 schedule 配置变更必须调用：

```ts
updateSchedule(
  deps,
  loopId,
  patch: { cron?: string | null; timezone?: string; enabled?: boolean },
)
```

事务规则：

1. 事务内重读 Loop；不存在返回 `{ found: false }`。
2. 原始输入先通过共享时间语义入口校验，再规范化并比较。
3. 空 patch、等值 patch、仅规范化空白不同的 patch 为零写入。
4. 有效变化令 `scheduleRevision + 1`、`updatedAt=clock.now()`、`lastScheduledAt=null`。
5. 最终为 `enabled=true && cron!=null` 时重建 `scheduleActivatedAt`；否则清空。
6. pause 保留 cron/timezone；清除 cron 保留 enabled/timezone；resume 不补算暂停期 occurrence。
7. 校验错误或数据库错误完整回滚；任何转换都不得创建 Run 或写入 `next_run_at`。

## 3. 实施批次与依赖

Batch 1 内按可独立验收的 M/D/C 三组推进；同一组测试、实现和证据放在同一提交切片中。

### 3.1 M 组：Migration 与 schema

- 生成前滚 migration `0002_wild_millenium_guard.sql`，不得修改历史 migration。
- 使用只包含 0000–0001 SQL 和 Drizzle journal 的 fixture 创建旧文件库。
- 关闭旧库、重开同一 dataDir，由生产 `runMigrations()` 应用完整 migration。
- 在同一文件库关闭重开并重复执行 migration，验证 journal、索引及业务数据幂等。

验收用例：

- M1：真实旧文件库升级，旧字段逐项不变，新字段得到安全默认值。
- M2：新库插入 Loop 得到全部 schedule 默认值。
- M3：新增字段可完整写入读取。
- M4：部分索引名称、键和谓词正确。
- M5：文件库关闭重开后重复 migration 无错误、无重复对象、数据不变。
- M6：迁移和配置变化后 `next_run_at` 始终为 null。

### 3.2 D 组：Cron、timezone 与 DST

- D1：合法五段 cron 和空白规范化。
- D2：非法段数、宏、非法值、NUL、超长输入；标准 weekday `7` 必须接受。
- D3：UTC、上海、纽约等 IANA timezone；非法 timezone 拒绝。
- D4：相同本地 09:00 在不同时区得到精确且不同的 UTC 时间。
- D5：纽约 2026 spring-forward 跳过不存在的 02:30；同时覆盖小时列表和范围。
- D6：纽约 2026 fall-back 的 01:30 只返回第一次，继续计算到次日。

### 3.3 C 组：配置状态转换

- C1：首次设置 cron。
- C2：修改 cron。
- C3：修改 timezone。
- C4：pause 并保留 cron/timezone。
- C5：resume 并重建 activation boundary。
- C6：清除 cron 回到 manual-only。
- C7：空 patch、等值 patch和空白差异均零写入。
- C8：not-found、非法配置、manual-only 非法 timezone、超长 no-op 绕过和真实事务内数据库故障均零写入或完整回滚。

M/C 每个用例必须检查 runs 为空；C8 数据库故障必须比较更新前后的完整 Loop 行。

## 4. TDD 与提交要求

测试 seam 固定为：

- 时间语义：`validateSchedule()`、`nextOccurrence()`。
- 状态转换：`updateSchedule()`。
- 迁移：文件型 `createDb/openMigratedDb/runMigrations` 加真实 Drizzle fixture。

对新增行为执行单个 tracer test 的 red→green；若生产行为已正确而缺少验收证据，测试应直接通过并明确记录为 evidence-only correction。不得声称不存在的 red→green 提交历史。

## 5. 批次验收条件

| 目标 | 验收方式 | 收口证据 |
| --- | --- | --- |
| 旧库安全前滚 | M1、M5 文件型 PGlite + journal + runner + close/reopen | 旧 Loop 前后快照、新默认值、唯一索引 |
| Cron/timezone 正确 | D1–D4 | 规范化结果和精确 UTC 断言 |
| DST 语义完整 | D5/D6 + 组合小时回归 | gap 不返回无效本地时间；overlap 不重复 |
| 状态机原子 | C1–C8 | 完整 Loop 行、revision、activation、watermark、runs |
| manual-only 安全 | M1/M2/C6/C8 | cron=null、合法 timezone、零自动 Run |
| write-closed | M6 + 生产代码搜索 | `next_run_at` 只有 schema 声明，无生产写入 |
| 未越界 | 相对基线审查文件和结构搜索 | 无 API、protocol、Scheduler/timer、自动 Run |
| 全仓无回归 | 完整质量门全部退出 0 | 命令、环境、测试计数 |

完整质量门：

```bash
pnpm --filter @loopzhb/server test
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

附加结构检查：

```bash
rg -n "nextRunAt|next_run_at" packages/server/src --glob '!**/*.test.ts'
git diff --name-only "$(git merge-base HEAD main)"...HEAD
```

## 6. 文档与 Issue 收口标准

1. 全部质量门通过后，ADR-007 才可设为 Accepted，并记录真实 migration、测试分组和实现提交。
2. 三轨复审通过后，`docs/roadmap.md` 才可标记 Batch 1 完成；Phase 3 整体保持进行中。
3. P1/P2 使用带 `phase-3` label 的 GitHub Issue 跟踪；只有具备修复提交、测试和后续复审核销记录后才能关闭。
4. 审查证据只 append 到 `docs/handoff/codex-handoff-phase3-batch1-code-review.md`；不另建 Round 结论文件，handoff 不提交。
5. 根目录不保留完成总结；README 不更新，不对外宣称 cron 已可用。
6. roadmap 只保留仍开放 Issue 的链接，不复制 Issue 描述；ADR 只保留长期决策，不写 PR 占位符或无证据声明。

## 7. 完成定义

Batch 1 只有同时满足以下条件才完成：M1–M6、D1–D6、C1–C8 和新增对抗回归全部通过；完整质量门全绿；三轨复审无未核销 P1/P2；GitHub Issues 已由复审决定关闭；ADR、roadmap 与 canonical handoff 完成收口。
