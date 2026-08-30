# Phase 4 Batch 1 开发计划：领域、持久化与兼容协议基础

- 状态：计划已裁决，待实现
- 基线：`main@6ff951b`
- 目标分支：`feat/phase4-batch1-dev`
- 长期决策：新增 ADR-009，并修订 ADR-002
- 阶段范围：`docs/roadmap.md` Phase 4
- 上位计划：`docs/plan/codex-phase4-dev-roadmap.md`

## 1. 批次目标与硬边界

Batch 1 只交付“可迁移、可解析、可推演、可验证”的 Phase 4 基础：

1. 旧 PGlite 数据库无损前滚，新增 Goal、Completion、Task File 同步状态、Machine capability 与 Lease 协议快照字段。
2. 用纯领域内核固定 Open、Closed、Paused、Completed、Goal revision、Finish 与 Reopen 的确定性行为。
3. 用 additive optional wire 固定 Phase 4 DTO、terminal union、capability 与跨版本兼容形状。
4. 用纯 decision/write plan 和 ADR 固定最终 Report 的单事务边界，为 Batch 2 接线提供唯一行为来源。
5. 用专项黑盒回归证明 Batch 1 结束时生产语义仍与 Phase 3 相同。

本批采用严格的**完全休眠**边界：

- 不挂载 Goal、Task File、Reopen 管理路由。
- 不要求新建 Loop 必须携带 Task File。
- 不持久化 Poll capability，不基于 capability 过滤 claim，也不返回升级提示。
- Delivery 不发送 `terminalProtocol` 或 goal。
- Daemon 不创建 Journal，不改变 Agent prompt、执行或 Report 行为。
- 现有 Report 不进入 v1 事务；v0 Lease 继续走 Phase 3 finalize/reconcile。
- 不开放 Finish、跨 Run state 晋升、Task File 回写或 Completed 调度守卫。
- 不实现 Dashboard。

Protocol 可以解析新增 optional 字段，但生产 handler、coordinator、store 和 daemon 不消费其 Phase 4 语义。新 claim 必须显式写入：

```ts
terminalProtocolVersion: 0;
goalRevision: 0;
canFinish: false;
```

不得只依赖数据库默认值来维持休眠语义。

## 2. 已裁决代码行为

### 2.1 持久化字段与安全默认

新增：

```text
machines.capabilities                  jsonb nullable

loops.goal                            text nullable
loops.goal_revision                   integer not null default 0
loops.completed_at                    text nullable
loops.completion_reason               text nullable
loops.task_file_sync_attempted_at     text nullable
loops.task_file_sync_error            text nullable

run_leases.terminal_protocol_version  integer not null default 0
run_leases.goal_revision              integer not null default 0
```

迁移规则：

- 旧 Machine 的 `capabilities=null`。
- 旧 Loop 的 `goal=null`、`goalRevision=0`，Completion 和新增同步字段均为 null；原 task-file snapshot、state、schedule 与其他字段逐项不变。
- 旧 Lease 的 `terminalProtocolVersion=0`、`goalRevision=0`；原 token hash、状态、权限和 Run 关联逐项不变。
- 迁移不得创建、完成、取消或重新调度任何 Run。
- 历史 migration 前滚-only，不修改 0000–0002。

Completion 增加数据库 CHECK，和纯领域校验形成双层防线。合法持久态必须满足：

```text
(completed_at IS NULL AND completion_reason IS NULL)
OR
(goal IS NOT NULL AND completed_at IS NOT NULL
 AND completion_reason IS NOT NULL AND enabled = false)
```

CHECK 负责禁止半完成态落库；领域内核仍必须验证读取到的快照并 fail-closed，不能把数据库约束当成唯一业务判断。

### 2.2 Loop 状态判定

状态展示采用固定优先级，得到一个主状态：

1. 合法 Completion 三字段组存在 → `Completed`。
2. 未完成且 `enabled=false` → `Paused`。
3. 未完成、启用且 `goal=null` → `Open`。
4. 未完成、启用且 `goal!=null` → `Closed`。

其中 goal 维度仍可独立读取：Paused Loop 可以是 Open 或 Closed；只有 Closed Loop 才有 Finish 资格。

### 2.3 Goal 规范化与 revision

Goal 规范：

- `null` 表示 Open Loop。
- 字符串先执行 JavaScript `trim()`，持久化规范化后的值。
- trim 后为空、包含 NUL、CR 或 LF、或超过 2000 UTF-8 字节时拒绝。
- 等值比较使用规范化后的字符串；只差首尾空白属于 no-op。
- Completed Loop 的 Goal 只读，必须先 Reopen。
- Goal 变化不改变 `enabled`，不取消 pending/running Run，也不重建 schedule activation。

`goalRevision` 是单调变更计数：

- 创建时恒为 0，无论初始 goal 是 null 还是非空。
- 每次规范化后的有效 set/change/clear 恰好加 1。
- no-op 不写行、不改 `updatedAt`、不递增 revision。
- clear 不重置 revision。
- 达到 PostgreSQL int32 上界后拒绝继续修改，不允许溢出或回绕。

Batch 1 的 Goal 行为由无 I/O 纯函数表达；函数接收 Loop 快照与命令，返回 no-op、稳定拒绝或待写入 patch，不访问 DB、不读取系统时间。

### 2.4 Completion、Finish 与稳定分类

Completion 三字段锁步：

- 未完成时 `completedAt` 与 `completionReason` 必须同时为 null。
- Completed 时 goal、completedAt、completionReason 必须同时存在，且 `enabled=false`。
- Reopen 必须同时清空 completedAt/completionReason。
- reason 使用 terminal policy 的规范值；message 缺失时由 Batch 2 回退到 reason。

Batch 1 必须实现纯 Finish eligibility/write-plan，不写数据库。输入包含当前 Loop、Run/Lease 授权快照、规范化 terminal finish 和外部提供的 `nowIso`；输出 completion patch 或唯一稳定失败分类。

失败分类按以下固定顺序判定，首个命中即为唯一结果：

1. `invalid_loop_state`：持久快照违反 Completion/Goal/revision 不变量。
2. `already_completed`：Loop 已合法完成。
3. `finish_not_allowed`：非 exec role、`canFinish=false` 或当前为 Open Loop。
4. `stale_goal`：Lease 捕获的 goal revision 与当前 Loop 不同。

Paused Closed Loop 的手动 exec Run 可以 Finish；`enabled=false` 本身不是拒绝条件。

合法 Finish 的纯 patch 必须表达：

- `completedAt=nowIso`、`completionReason=reason`、`enabled=false`。
- `scheduleRevision + 1`、`scheduleActivatedAt=null`、`lastScheduledAt=null`。
- goal、goalRevision、cron、timezone、历史 Run 保持不变。
- state 和 Task File 是否晋升由最终 Report write-plan 决定，不混入 eligibility 判断。

### 2.5 Reopen 与 schedule 复用

Reopen 只接受合法 Completed Loop；其他状态稳定返回管理冲突 `loop_not_completed`。

合法 Reopen：

- 同时清空 `completedAt`、`completionReason`。
- 设置 `enabled=true`。
- 保留 goal、goalRevision、Loop state、Task File snapshot、cron、timezone 和全部 Run 历史。
- `scheduleRevision + 1`、`lastScheduledAt=null`、`nextRunAt` 继续为 null。
- cron 非空时 `scheduleActivatedAt=nowIso`；manual-only 时为 null。
- 不补跑完成期间的 occurrence。

为防止 Reopen 和 Phase 3 schedule 语义漂移，从现有 schedule state-machine 抽取无 I/O transition core：

- 现有 `updateSchedule` 继续拥有 DB transaction 和 Clock 适配职责。
- schedule core 只计算规范化后的变化、revision、activation 与 watermark patch。
- Reopen 复用同一 core。
- 抽取前后的 Phase 3 schedule 用例必须完全等价；不得借重构改变任何生产结果。

### 2.6 State 兼容与新写入规则

- 旧 `loops.state` 与 Delivery `prevState` 继续按 `unknown` 宽容读取，不迁移、不包装、不丢弃。
- 只有 terminal protocol v1 的新 state 写入必须是顶层 JSON object；数组、null、字符串和数字均非法。
- state 缺失表示保留旧 Loop state；`{}` 表示晋升为空对象。
- 64 KiB 上限按解析后 `JSON.stringify(state)` 的紧凑 UTF-8 表示计算，`<= 65_536` 字节合法。
- 旧非 object state 可以原样传给后续 Run；首次合法 v1 state 成功晋升时再覆盖。

### 2.7 Task File 同步结果

terminal protocol v1 的成功 Report 必须恰好携带一种同步结果：

```ts
taskFileContent?: string;
taskFileSyncError?: "missing" | "unreadable" | "outside_jail" | "changed" | "too_large";
```

- 两者同时存在或同时缺失均为非法 v1 成功报告。
- 空字符串是合法 content。
- content 的 256 KiB 上限按 UTF-8 字节计算。
- 成功同步：更新 content、`taskFileSyncedAt=nowIso`、`taskFileSyncAttemptedAt=nowIso`，并清空旧 error。
- 同步失败：保留旧 content/syncedAt，只更新 attemptedAt/error。
- v1 `ok=false` 走执行失败路径，忽略 terminal/state/Task File 扩展，任何 Loop 字段都不得变化。
- v0 Report 始终按 Phase 3 规则处理并忽略新增扩展。

Batch 1 只固定 policy 和 write-plan；不执行文件读取、jail 校验或快照写入。

### 2.8 Capability 快照与协议版本

Capability 是当前完整快照，不是“曾经见过”的累积集合。Batch 2 接线时每次认证 Poll 的语义固定为：

- `capabilities` 缺失 → 写回 null。
- 显式空数组 → 写 `[]`。
- 非空数组 → 去重、排序后替换旧值。
- 未知 capability 保留；当前只按 `terminal-journal-v1` 成员关系判断资格。
- 不做 daemon semver 字符串比较。

Batch 1 只提供 optional wire 字段和纯规范化测试，不把该快照接到 machine store。

Poll 响应新增：

```ts
requiredCapabilities?: string[];
```

Batch 2 仅当该 Machine 存在可领取 Run、但缺少所需 capability 时返回 `['terminal-journal-v1']`；空闲 Poll 不发送。Batch 1 不产生该字段。

Lease 的 `terminalProtocolVersion` 是 Report 行为的权威开关：

- v0 Lease 无条件使用 Phase 3 Report 语义，即使请求意外带 terminal。
- v1 Lease 的 `ok=true` 必须携带合法 terminal 和恰好一种 Task File 同步结果。
- v1 Lease 的 `ok=false` 使用旧失败收口，忽略 terminal/state/sync 扩展。
- capability 或请求体本身不能把 v0 Lease 升级为 v1。

### 2.9 Protocol 与 terminal policy 分层

Protocol 主 schema 负责：

- additive optional 字段、discriminant、枚举和 tolerant-reader。
- terminal discriminated union。
- `report/new|resolved` 必须携带 message；`nothing-new` 可省略 message。
- `finish.reason` 必填，message 可省略。
- state 顶层必须为 JSON object。

独立 `@loopzhb/protocol` terminal-policy 子模块负责双端必须一致的值策略：

- Goal 的 trim、非空、单行、NUL 和 UTF-8 字节规则（唯一来源仍是 §2.3）。
- message/reason 保留原文和换行；只拒绝 NUL 与超过 2000 UTF-8 字节的值。finish reason 还必须非空；`report/new|resolved` 的 message 必须出现，但不额外 trim 或改写。
- state 的 JSON 合法性和 64 KiB 紧凑编码上限。
- Task File content 的同步结果互斥与 256 KiB 上限。
- capability 快照规范化。

`terminal-policy.ts` 是 protocol 包内的源模块，并从 `@loopzhb/protocol` 主入口 re-export；不新增 package subpath、workspace package 或 Node 专属依赖。ADR-002/009 必须记录：terminal policy 是 daemon/server 一致执行同一命令契约的窄例外；普通 server 裁剪策略仍不进入 protocol 主 schema，也不得在 daemon/server 各复制一套规则。

### 2.10 管理 API 兼容形状

Batch 1 在 protocol 中声明但不挂路由：

- Create Loop 的 optional `goal?: string | null`。
- `PATCH /api/loops/:id/goal` 请求/响应。
- `PATCH /api/loops/:id/task-file` 请求/响应。
- `POST /api/loops/:id/reopen` 请求/响应。
- `LoopSummary` 的 optional goal/completion/task-file sync 字段。

Completed Loop 的 Run Now 不扩展现有成功 union 的 literal reason。现有 Phase 3 reader 会拒绝新 literal，因此固定为：

```http
409
{ "error": "<non-contract text>", "code": "loop_completed" }
```

管理冲突只新增两个稳定 code：

- `loop_completed`：Completed Loop 上的 Goal 修改或 Run Now。
- `loop_not_completed`：非 Completed Loop 上的 Reopen。

error 文案不是机器契约。Batch 1 只定义 protocol 常量/schema 和兼容测试，不挂载这些行为。

### 2.11 剩余边界裁决与显式右移项

**`updatedAt`。** 有效 Goal 修改、已接受 v1 成功 Report 对 Loop state 或 Task File 同步状态的任何写入、合法 Finish 与 Reopen，均使用各自事务内同一 Clock 快照更新 `loops.updatedAt`。Goal no-op、wire/policy 拒绝及非法 Finish 不得修改任何 Loop 字段，包括 `updatedAt`。

**revision 上界。** Goal revision 已按 §2.3 拒绝溢出。schedule pure core 在 `scheduleRevision` 达到 PostgreSQL int32 上界时返回 `schedule_revision_exhausted` 且生成零 Loop 写入 patch；合法 Finish 因此走既有 `invalid_loop_state` Run failure 路径。Batch 1 不挂管理路由；Batch 2 在暴露 Reopen/Schedule API 前必须把该领域结果映射为稳定 HTTP 冲突，不能让数据库溢出成为 500。

**升级前 pending Run。** Batch 1 的所有 claim 无论 Run 创建时间和 Poll capability 如何，均显式 mint v0 Lease。Batch 2 启用 capability 后，协议版本以 claim 时刻决定：已有 Lease 永远按其持久化 v0 语义完成；尚未领取的 pending Run 视为新交付，只有 capability 合格时才能领取并 mint v1 Lease。无需向 `runs` 增加版本列。

**语义非法的 v1 Report。** wire 结构无法通过 protocol schema 的请求仍在 HTTP 边界返回 400，Lease 不消费。结构合法、Bearer 指向 live v1 Lease、但 `ok=true` 违反 terminal policy（例如 terminal 缺失、同步结果不恰好一种、字节超限）时，Server 必须原子收口为 `terminal_protocol_invalid` Run failure 并删除 Lease；Loop state、Completion、schedule、Task File snapshot 与 `updatedAt` 全部零写入。该规则是对 Daemon 本地稳定失败报告的服务端防御层。

**深层 JSON。** terminal policy 的 JsonObject 遍历和紧凑序列化必须避免递归栈溢出；任何深度/遍历/序列化异常稳定视为非法 state，而不得泄漏为未分类 500。Batch 1 不另设公开 JSON 深度数字上限。

**capability 资源限制。** Batch 1 只定义缺失/null、空数组、去重排序与未知名称保留，且不持久化 capability。数组数量、名称长度和非法名称的持久化前限制明确右移到 Batch 2 machine-store 接线；在该批实现前不得写入 `machines.capabilities`。

## 3. 最终 Report 单事务设计

Batch 1 不重写 `executeReportTx`。交付物是 ADR 中的事务 branch table，加可执行的纯 decision/write-plan 与测试；Batch 2 必须按该计划接线，不能重新发明语义。

### 3.1 权威输入与读取顺序

1. Bearer credential 只解析为 token hash；Lease 决定 Run、Loop、role、授权、terminal protocol 与捕获的 goal revision。
2. 写事务内用同一 coherent snapshot 重读 Lease、Run、Loop；Lease/Run 生命周期判定继续遵守 ADR-001 的 active/finalize 与 terminal-grace/reconcile 分支。
3. 单一 Clock 快照同时用于 expiry 判断、Run transition、Completion 与 Task File 时间戳。
4. v0 分支保持 Phase 3 行为与既有 CAS/retry。
5. v1 failure 先于 terminal 分支；v1 success 才进入 terminal/sync 决策。
6. Finish 在任何 Loop 写入前运行固定 eligibility 顺序。

### 3.2 成功写集

普通 v1 terminal report 的原子写集：

1. Run → `done/exec/<reported-status>`，保存规范化 message 和本次 Run state。
2. state 存在时晋升为 `loop.state`；缺失时保留旧值。
3. 应用 Task File 成功或失败同步 patch。
4. 删除 Lease。

合法 Finish 在同一事务中额外：

1. Run → `done/exec/resolved`，保存 reason/message/state。
2. 应用 Completion 与 schedule patch。
3. 晋升 state、应用 Task File patch。
4. 删除 Lease。

任何 guarded write 影响行数不符合预期都触发现有有界 CAS re-resolve；不得提交半套状态。

### 3.3 非法 Finish 与禁止写集

非法或 stale Finish 必须在同一事务内被消费为稳定 Run failure：

- Run 写 `error/error` 和四类之一的稳定分类。
- Lease 被删除，HTTP 返回现有已收口成功确认形状。
- Loop goal、goalRevision、Completion、schedule、跨 Run state、Task File snapshot/sync 状态全部不变。
- 网络重试不能重复完成或产生第二次 Loop 副作用。

### 3.4 并发与旧 Lease

- Report/cancel/sweep/twin-report 继续通过同一 Lease/Run guard 和有界重试仲裁。
- Goal 在 Run 执行期间有效修改后，Lease revision 不匹配，旧 Finish 只能得到 `stale_goal` failure。
- 竞争 Run 已完成 Loop 时，后到 Finish 得到 `already_completed` failure。
- 升级前已领取的 v0 Lease 在升级后仍可 finalize/reconcile，新增 terminal 字段不影响结果。

## 4. 验收用例

### 4.1 M 组：Migration 与 schema

- M1：用冻结的 `test-fixtures/phase3-migrations`（0000–0002 + journal）创建文件型数据库，在 machines/loops/runs/run_leases 写入代表数据；关闭重开后由生产 migration runner 升级，全部旧列逐项相等，新列为安全默认。
- M2：升级库中的 running Run + v0 active Lease 使用已知 credential，经真实 coordinator Report 按 Phase 3 成功完成并消费 Lease。
- M3：新库新增字段可完整 round-trip；Drizzle inferred defaults 与 SQL 默认一致。
- M4：Completion CHECK 接受全部合法组合，拒绝半完成、无 goal 完成、完成但 enabled=true 等非法组合。
- M5：同一文件库重复关闭、重开、运行 migration，journal、CHECK、数据和索引保持唯一且不变。
- M6：迁移过程 runs 数量、phase、Lease 状态、Loop schedule/state/task-file snapshot 均无意外变化。

### 4.2 P 组：Protocol 与 policy

- P1：Poll request/response、Delivery、Report、Create/Update/Reopen、LoopSummary 的新增字段全部 optional，并加入穷尽 tolerant-reader 清单。
- P2：terminal report/finish 两个 union 分支的合法 golden、缺失字段、非法 status、非 object state、嵌套未知字段剥离。
- P3：Goal 覆盖 trim、空白、NUL、CR/LF、2000 UTF-8 字节边界；message/reason 覆盖保留原文/换行、NUL 与字节边界；同时覆盖 64 KiB state、`undefined` 与 `{}` 差异、256 KiB Task File 边界和同步结果恰好一种。
- P4：冻结的最小 Phase 3 Zod reader 读取 Phase 4 golden 并剥离新增字段；当前 reader 读取 Phase 3 golden。冻结 reader 不从当前 schema import，避免同源漂移。
- P5：Phase 3 trigger success reader 不接触 `loop_completed` literal；新协议用 apiError 409 + stable code 表达冲突。
- P6：Capability 缺失/null/空数组/重复/乱序/未知名称规范化结果确定。
- P7：terminal policy 从 protocol 主入口导出；深层 JsonObject 与 `JSON.stringify` 异常稳定拒绝，不发生未分类异常。

### 4.3 D 组：纯领域内核

- D1：Goal create/set/change/clear、首尾空白规范化、等值 no-op、Open/Closed 转换。
- D2：空白、NUL、CR/LF、2000/2001 ASCII 字节和多字节 UTF-8 边界。
- D3：revision 初始 0、每次有效变化 +1、no-op/clear 不重置、int32 上界拒绝。
- D4：主状态优先级与 Open/Closed 维度；Paused Open、Paused Closed、Completed 和每个非法快照。
- D5：Completion 三字段锁步的纯校验，与数据库 CHECK 用例一一对应。
- D6：Finish 合法矩阵：Closed exec + canFinish + revision 相同；Paused Closed 允许。
- D7：四类失败优先级的组合反例，确保多个 guard 同时失败时只返回固定首因。
- D8：Reopen 只接受 Completed，保留 goal/revision/state/history/config，重建 activation、清 watermark、不补跑。
- D9：抽取后的 schedule core 与原 `updateSchedule` 在现有全部配置转换上产生等价 patch/DB 结果。
- D10：有效 Goal、v1 Loop 写入、Finish、Reopen 的 `updatedAt` 规则，以及 goal/schedule revision 上界的零写入与分类。

### 4.4 T 组：Report decision/write-plan

- T1：v0 Lease 忽略 terminal/state/sync，得到与 Phase 3 builder 相同的 write-set。
- T2：v1 `ok=false` 忽略扩展，Loop 禁止写集为空。
- T3：v1 普通成功缺失 state、携带 `{}`、携带非空 object 的 Run/Loop write-plan。
- T4：Task File sync success/error 两分支及禁止部分写入。
- T5：合法 Finish 的 Run/Loop/Lease/state/schedule 全写集。
- T6：每个非法 Finish 分类只写 Run failure + Lease retire，Loop 写集严格为空。
- T7：事务中断点模型证明任一后续步骤失败时没有可提交的部分计划；ADR 明确真实 DB fault/CAS 交错测试归 Batch 2 接线。
- T8：live v1 Lease 的结构合法但 policy 非法成功 Report 收口为 `terminal_protocol_invalid`；wire 结构非法仍为 HTTP 400 且 Lease 未消费。

### 4.5 R 组：完全休眠与回归

- R1：HTTP route table 对 Goal、Task File、Reopen 仍返回 404；Create 不要求 Task File，也不启用传入 goal。
- R2：带 capability 的 Poll 可解析，但不持久化 capability、不改变 claim 候选；新 Lease 显式为 v0/0/false。
- R3：Delivery 不含 terminalProtocol/goal/requiredCapabilities，prompt 与 Phase 3 golden 不变。
- R4：v0 Report 携带 terminal/state/sync 扩展仍只产生 Phase 3 Run finalize，Loop state/task-file/completion 不变。
- R5：所有 Phase 1–3 既有测试、typecheck、build、migration drift check 全绿。
- R6：迁移前已存在但未领取的 pending Run 在 Batch 1 仍按 v0 claim；测试固定“版本由 claim 时刻、而非 Run 创建时刻决定”的 Batch 2 接线契约。

## 5. 模块开发计划与依赖顺序

### 5.1 文档契约

文件：

- `docs/adr/009-phase4-stateful-loop-semantics.md`（新建）
- `docs/adr/002-protocol-package.md`（修订记录）
- `CONTEXT.md`（领域词汇）
- `docs/plan/codex-phase4-dev-roadmap.md`（修正 Completed Run Now 的兼容响应）

动作：

1. 先写 ADR-009 的状态、不变量、版本分支、事务表和休眠边界。
2. ADR-002 只追加 capability 协商与 terminal-policy 窄例外，不重写历史裁决。
3. CONTEXT 增加 Open Loop、Closed Loop、Paused Loop、Completed Loop、Finish、Reopen、Terminal Journal、Terminal Protocol 等唯一术语。
4. 上位计划把 `loop_completed` 从成功 reason 澄清为 409 apiError code。

依赖：无。该组先于行为代码，作为后续测试命名与审查依据。

### 5.2 Protocol

主要文件：

- `packages/protocol/src/report.ts`
- `packages/protocol/src/poll.ts`
- `packages/protocol/src/admin.ts`
- `packages/protocol/src/errors.ts`
- `packages/protocol/src/terminal-policy.ts`（新建）
- `packages/protocol/src/index.ts`
- 对应 golden、policy、tolerant-reader 和 frozen-reader tests

动作：

1. 定义 JSON value/object 类型与 Zod schema。
2. 加 terminal union、sync error enum、Report optional 字段。
3. 加 Poll capabilities、requiredCapabilities、Delivery terminalProtocol/goal。
4. 加管理 DTO、LoopSummary optional 字段与两个 stable conflict code。
5. 实现纯 terminal policy/capability normalization。
6. 从 protocol 主入口 re-export terminal policy，建立冻结 Phase 3 reader，并完成 P1–P7。

依赖：5.1 的 ADR 契约。

### 5.3 Schema 与 migration

主要文件：

- `packages/server/src/db/schema.ts`
- `packages/server/drizzle/0003_*.sql` 与 meta
- `packages/server/test-fixtures/phase3-migrations/`（新建冻结夹具）
- schema/migration tests 与 testkit fixtures

动作：

1. Drizzle 加字段、JSON 类型和 Completion CHECK。
2. 由 drizzle-kit 生成单个前滚 migration，不手改旧 migration。
3. 复制并冻结 0000–0002 及其 journal 作为真实旧库来源。
4. 更新测试 seed/full-row assertions，显式覆盖新默认。
5. 完成 M1–M6，尤其是升级后旧 Lease 的真实 Report。

依赖：5.2 的共享类型；不依赖领域模块。

### 5.4 Schedule pure core 与 Loop lifecycle

主要文件：

- `packages/server/src/schedule/state-machine.ts`
- `packages/server/src/schedule/transition.ts`（新建纯 core，具体命名可在实现时保持同义）
- `packages/server/src/loop-lifecycle/`（新建）

Loop lifecycle 模块拥有：

- Goal normalization/update plan。
- Loop 状态分类与持久态 invariant。
- Finish eligibility、稳定分类与 completion write-plan。
- Reopen plan。
- v1 Report 的纯 Loop/Task File/state write-plan 组合。

Loop lifecycle 模块不拥有：

- DB transaction、Clock、HTTP mapping、Run Credential 解析。
- Poll capability 持久化或 daemon Journal I/O。
- Scheduler reconcile 副作用。

动作顺序：

1. 先以 parity tests 抽 schedule pure core，保持现有 updateSchedule 适配器结果不变。
2. 实现 Goal/invariant/status reducer。
3. 实现 Finish/Reopen/write-plan。
4. 完成 D1–D10、T1–T8。

依赖：5.2 类型和 5.3 schema row shape。

### 5.5 休眠集成与回归

主要文件：

- `packages/server/src/store/runs.ts`
- coordinator/http/gateway 的专项回归 tests

动作：

1. claim 显式写 v0/0/false，不依赖 DDL 默认。
2. 不把纯领域模块接到现有 handler/coordinator/report。
3. 通过真实 HTTP/coordinator 和 migration fixture 完成 R1–R6。
4. 用结构审查确认 daemon 只有 protocol 类型编译影响，无行为改动。

依赖：5.2–5.4 完成。

## 6. 提交切片

建议保持 5 个可独立审查切片：

1. `docs(phase4): lock batch1 domain and compatibility contracts`
   - 本计划、ADR-009、ADR-002 修订、CONTEXT 和上位计划兼容修正。
2. `feat(protocol): add dormant phase4 wire contracts and policy`
   - P1–P7 全部通过；不改 server/daemon 行为。
3. `feat(server): add phase4 persistence migration`
   - schema、0003、冻结夹具、M1–M6。
4. `refactor(server): extract schedule core and add loop lifecycle plans`
   - D1–D10、T1–T8；现有 schedule 回归全绿。
5. `test(server): pin phase4 batch1 dormant production behavior`
   - 显式 v0 mint、R1–R6、完整质量门。

每个切片先运行对应包的定向测试；不得在单个提交中同时混入 Batch 2 daemon Journal、HTTP 接线或 Dashboard。

## 7. 质量门与结构检查

定向测试按实现文件使用 Vitest file filter。批次收口必须依次通过：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check "$(git merge-base HEAD main)"...HEAD
```

附加结构检查：

```bash
git diff --name-only "$(git merge-base HEAD main)"...HEAD
rg -n "terminalProtocol|terminal-journal-v1|requiredCapabilities" packages/daemon/src packages/server/src
rg -n "loops/:id/(goal|task-file|reopen)" packages/server/src/http
```

结构搜索结果必须逐项解释：允许 protocol 类型、纯 policy、schema、测试和显式 v0 mint；不得出现 daemon Journal、v1 Delivery、capability claim guard、新管理 route 或 v1 Report store 接线。

Batch 1 不运行真实 Claude Phase 4 E2E；该门属于 Phase 4 总收口。若现有测试因沙箱禁止监听 `127.0.0.1` 而失败，应在获准环境复跑并记录真实原因，不得把环境失败写成代码通过。

## 8. 审查与完成定义

Batch 1 只有同时满足以下条件才能标记完成：

1. M1–M6、P1–P7、D1–D10、T1–T8、R1–R6 全部通过。
2. 完整质量门与结构检查全绿，migration generate 为零 diff。
3. 旧数据库无损升级、旧 Lease 真实完成、双向 frozen-reader 兼容均有确定性证据。
4. 专项黑盒测试证明 Phase 4 生产语义完全休眠。
5. ADR-009、ADR-002、CONTEXT 与 roadmap 已蒸馏真实实现结果，没有提前宣称 Batch 2 行为可用。
6. 对抗审查无未核销 P1/P2；需右移的问题进入带 `phase-4` label 的 GitHub Issue，并按 `docs/agents/issue-tracker.md` 核销。
7. `docs/roadmap.md` 只在上述条件完成后更新 Batch 1 状态；Phase 4 整体保持进行中。

本计划是 Batch 1 的长期引用锚点。实现过程中若必须改变已裁决行为，先修订 ADR/本计划并记录理由，再修改代码和测试；不得让实现静默成为新的事实来源。
