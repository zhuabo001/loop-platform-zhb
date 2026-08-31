# ADR-009：Phase 4——有状态 Loop 语义（Goal/Completion/Terminal Protocol）

- 状态：Accepted
- 日期：2026-08-30
- 关联：docs/roadmap.md Phase 4；docs/plan/codex-phase4-dev-roadmap.md；docs/plan/codex-phase4-batch1-plan.md；ADR-001（事务可靠性）；ADR-002（wire 演进，本次修订）；ADR-007/008（schedule revision/activation/watermark）
- 实现：Batch 1 切片 1（本文档先于此批次全部行为代码）

## 背景

Phase 4 把 Loop 从「定时执行的任务」升级为「有目标、可完成的有状态实体」：Goal、Finish/Reopen、跨 Run state 晋升、Task File 同步和 Daemon capability 协商。这些语义横跨 wire、持久化、领域规则与最终 Report 事务，任何一处漂移都会破坏「Daemon 与 Server 一致执行同一命令契约」的前提。本 ADR 一次性固定全部长期裁决；Batch 1 只交付可迁移、可解析、可推演、可验证的基础，生产行为保持完全休眠（决策 10）。

## 决策

### 1. Loop 生命周期状态

状态展示采用固定优先级，得到一个主状态：

1. 合法 Completion 三字段组存在 → `Completed`
2. 未完成且 `enabled=false` → `Paused`
3. 未完成、启用且 `goal=null` → `Open`
4. 未完成、启用且 `goal!=null` → `Closed`

goal 维度独立于主状态：Paused Loop 可以是 Open 或 Closed；只有 Closed Loop 才有 Finish 资格。术语定义见 CONTEXT.md。

### 2. Goal 规范化与 revision

- `goal=null` 表示 Open Loop；字符串先执行 JavaScript `trim()`，持久化规范化后的值。
- trim 后为空、包含 NUL、CR 或 LF、或超过 2000 UTF-8 字节时拒绝。
- 等值比较使用规范化后的字符串；只差首尾空白属于 no-op。
- Completed Loop 的 Goal 只读，必须先 Reopen。
- Goal 变化不改变 `enabled`，不取消 pending/running Run，也不重建 schedule activation。
- `goalRevision` 是单调变更计数：创建时恒为 0；每次规范化后的有效 set/change/clear 恰好加 1；no-op 不写行、不改 `updatedAt`、不递增；clear 不重置；达到 PostgreSQL int32 上界后拒绝继续修改，不允许溢出或回绕。

Goal 行为由无 I/O 纯函数表达：接收 Loop 快照与命令，返回 no-op、稳定拒绝或待写入 patch，不访问 DB、不读取系统时间。

### 3. Completion 不变量（双层防线）

合法持久态必须满足：

```text
(completed_at IS NULL AND completion_reason IS NULL)
OR
(goal IS NOT NULL AND completed_at IS NOT NULL
 AND completion_reason IS NOT NULL AND enabled = false)
```

数据库 CHECK 禁止半完成态落库；领域内核仍必须验证读取到的快照并 fail-closed——数据库约束不是唯一业务判断。Reopen 必须同时清空 `completedAt`/`completionReason`。

### 4. Finish eligibility 与稳定分类

纯 Finish eligibility/write-plan（不写数据库）：输入为当前 Loop、Run/Lease 授权快照、规范化 terminal finish 和外部提供的 `nowIso`；输出 completion patch 或唯一稳定失败分类。失败分类按固定顺序判定，首个命中即为唯一结果：

1. `invalid_loop_state`：持久快照违反 Completion/Goal/revision 不变量
2. `already_completed`：Loop 已合法完成
3. `finish_not_allowed`：非 exec role、`canFinish=false` 或当前为 Open Loop
4. `stale_goal`：Lease 捕获的 goal revision 与当前 Loop 不同

Paused Closed Loop 的手动 exec Run 可以 Finish；`enabled=false` 本身不是拒绝条件。

合法 Finish 的纯 patch：`completedAt=nowIso`、`completionReason=reason`、`enabled=false`、`scheduleRevision+1`、`scheduleActivatedAt=null`、`lastScheduledAt=null`；goal、goalRevision、cron、timezone、历史 Run 保持不变；state 与 Task File 是否晋升由最终 Report write-plan 决定，不混入 eligibility 判断。

`scheduleRevision` 达到 int32 上界时，schedule pure core 返回 `schedule_revision_exhausted` 且生成零写入 patch；合法 Finish 因此走既有 `invalid_loop_state` Run failure 路径。暴露 Reopen/Schedule 管理路由前（Batch 2），该领域结果必须映射为稳定 HTTP 冲突，不能让数据库溢出成为 500。

### 5. Reopen 与 schedule core 复用

Reopen 只接受合法 Completed Loop；其他状态稳定返回管理冲突 `loop_not_completed`。合法 Reopen：同时清空 `completedAt`/`completionReason`、设置 `enabled=true`；保留 goal、goalRevision、Loop state、Task File snapshot、cron、timezone 和全部 Run 历史；`scheduleRevision+1`、`lastScheduledAt=null`、`nextRunAt` 继续为 null；cron 非空时 `scheduleActivatedAt=nowIso`，manual-only 时为 null；不补跑完成期间的 occurrence。

为防止 Reopen 和 Phase 3 schedule 语义漂移，从 `updateSchedule` 抽取无 I/O transition core：现有 `updateSchedule` 继续拥有 DB transaction 和 Clock 适配职责；core 只计算规范化后的变化、revision、activation 与 watermark patch；Reopen 复用同一 core。抽取前后 Phase 3 schedule 用例完全等价，不借重构改变任何生产结果。

### 6. State 与 Task File 同步规则

- 旧 `loops.state` 与 Delivery `prevState` 继续按 `unknown` 宽容读取，不迁移、不包装、不丢弃。
- 只有 terminal protocol v1 的新 state 写入必须是顶层 JSON object；数组、null、字符串、数字均非法。state 缺失表示保留旧 Loop state；`{}` 表示晋升为空对象。64 KiB 上限按解析后 `JSON.stringify(state)` 的紧凑 UTF-8 表示计算（`<= 65_536` 字节合法）。旧非 object state 原样传给后续 Run；首次合法 v1 state 成功晋升时覆盖。
- v1 成功 Report 必须恰好携带一种 Task File 同步结果：`taskFileContent`（空字符串合法，256 KiB UTF-8 上限）与 `taskFileSyncError`（`missing|unreadable|outside_jail|changed|too_large`）互斥且必居其一。同步成功：更新 content、`taskFileSyncedAt=now`、`taskFileSyncAttemptedAt=now`、清空旧 error；同步失败：保留旧 content/syncedAt，只更新 attemptedAt/error。
- v1 `ok=false` 走执行失败路径，忽略 terminal/state/Task File 扩展，任何 Loop 字段都不得变化。v0 Report 始终按 Phase 3 规则处理并忽略新增扩展。
- terminal policy 的 JsonObject 遍历和紧凑序列化必须避免递归栈溢出；任何深度/遍历/序列化异常稳定视为非法 state，不泄漏为未分类 500。不设公开 JSON 深度数字上限。

### 7. Terminal protocol 版本与 capability

- Lease 的 `terminalProtocolVersion` 是 Report 行为的权威开关：v0 Lease 无条件使用 Phase 3 Report 语义（即使请求意外携带 terminal）；v1 Lease 的 `ok=true` 必须携带合法 terminal 和恰好一种 Task File 同步结果；v1 `ok=false` 使用旧失败收口。capability 或请求体本身不能把 v0 Lease 升级为 v1。
- 协议版本以 claim 时刻决定：升级前已领取的 v0 Lease 永远按其持久化语义完成；尚未领取的 pending Run 视为新交付，只有 capability 合格时才能领取并 mint v1 Lease。`runs` 不增加版本列。
- Capability 是当前完整快照，不是累积集合：缺失 → 写回 null；显式空数组 → 写 `[]`；非空数组 → 去重、排序后替换；未知 capability 保留；只按 `terminal-journal-v1` 成员关系判断资格；不做 daemon semver 字符串比较。数组数量、名称长度和非法名称的持久化前限制右移到 Batch 2 machine-store 接线。
- Poll 响应的 `requiredCapabilities` 仅在该 Machine 存在可领取 Run 但缺少所需 capability 时返回 `['terminal-journal-v1']`；空闲 Poll 不发送。
- 语义非法的 v1 Report：wire 结构非法仍是 HTTP 400、Lease 不消费；结构合法、Bearer 指向 live v1 Lease、但 `ok=true` 违反 terminal policy 时，Server 原子收口为 `terminal_protocol_invalid` Run failure 并删除 Lease，Loop 全部字段零写入。这是对 Daemon 本地稳定失败报告的服务端防御层。

### 8. 最终 Report 单事务边界

不重写 Phase 3 `executeReportTx` 的行为契约，只固定扩展后的分支表（Batch 2 按此接线，不重新发明语义）：

权威输入与读取顺序：Bearer credential 只解析为 token hash；写事务内用同一 coherent snapshot 重读 Lease、Run、Loop；Lease/Run 生命周期判定继续遵守 ADR-001 的 active/finalize 与 terminal-grace/reconcile 分支；单一 Clock 快照同时用于 expiry 判断、Run transition、Completion 与 Task File 时间戳；v0 分支保持 Phase 3 行为与既有 CAS/retry；v1 failure 先于 terminal 分支；Finish 在任何 Loop 写入前运行固定 eligibility 顺序。

普通 v1 terminal report 的原子写集：Run → `done/exec/<reported-status>`（保存规范化 message 和本次 Run state）；state 存在时晋升为 `loop.state`；应用 Task File 同步 patch；删除 Lease。合法 Finish 在同一事务中额外：Run → `done/exec/resolved`（保存 reason/message/state）；应用 Completion 与 schedule patch。任何 guarded write 影响行数不符合预期都触发现有有界 CAS re-resolve，不提交半套状态。

非法或 stale Finish 在同一事务内被消费为稳定 Run failure：Run 写 `error/error` 和四类之一的稳定分类；Lease 被删除，HTTP 返回现有已收口成功确认形状；Loop goal、goalRevision、Completion、schedule、跨 Run state、Task File snapshot/sync 状态全部不变；网络重试不能重复完成或产生第二次 Loop 副作用。

并发与旧 Lease：Report/cancel/sweep/twin-report 继续通过同一 Lease/Run guard 和有界重试仲裁；Goal 在 Run 执行期间有效修改后，旧 Finish 只能得到 `stale_goal`；竞争 Run 已完成 Loop 时，后到 Finish 得到 `already_completed`；升级前已领取的 v0 Lease 升级后仍可 finalize/reconcile。

### 9. updatedAt 规则

有效 Goal 修改、已接受 v1 成功 Report 对 Loop state 或 Task File 同步状态的任何写入、合法 Finish 与 Reopen，均使用各自事务内同一 Clock 快照更新 `loops.updatedAt`。Goal no-op、wire/policy 拒绝及非法 Finish 不得修改任何 Loop 字段，包括 `updatedAt`。

### 10. 管理 API 冲突形状

管理冲突只新增两个稳定 code：`loop_completed`（Completed Loop 上的 Goal 修改或 Run Now）与 `loop_not_completed`（非 Completed Loop 上的 Reopen）。Completed Loop 的 Run Now 固定为 `409 { "error": "<non-contract text>", "code": "loop_completed" }`——不扩展现有成功响应 union 的 reason literal，以免旧 Phase 3 reader 解析失败。error 文案不是机器契约。

### 11. Batch 1 完全休眠边界

Batch 1 交付以上全部契约的 schema、migration、wire 形状与纯领域/write-plan 实现，但生产语义保持与 Phase 3 完全相同：

- 不挂载 Goal、Task File、Reopen 管理路由；不要求新建 Loop 必须携带 Task File。
- 不持久化 Poll capability，不基于 capability 过滤 claim，不返回升级提示。
- Delivery 不发送 `terminalProtocol` 或 goal；Daemon 不创建 Journal，不改变 Agent prompt、执行或 Report 行为。
- 现有 Report 不进入 v1 事务；v0 Lease 继续走 Phase 3 finalize/reconcile。
- 不开放 Finish、跨 Run state 晋升、Task File 回写或 Completed 调度守卫；不实现 Dashboard。
- 新 claim 必须显式写入 `terminalProtocolVersion: 0`、`goalRevision: 0`、`canFinish: false`，不得只依赖数据库默认值维持休眠语义。

## 修订记录

### 2026-08-31：实现期裁决固化

在不改变任何已裁决语义的前提下，固化实现期确认的八处裁决：

1. **State wire 校验非递归化。** `jsonObjectSchema` 不使用递归 `z.lazy`：wire 层只做非递归顶层 object 形状判断，嵌套 JSON 合法性由 stack-safe、全函数的严格 JSON 检查承担。深层或循环 state 稳定降级为 schema 拒绝（HTTP 400、Lease 不消费），不存在 `RangeError` 逃逸为 500 的路径。64 KiB 上限与可写域规则仍在 terminal-policy，不进入 wire。
2. **State wire 不得重建输入对象的键。** 解析合法 state 必须按引用透传：以普通对象赋值重建键会把顶层 `__proto__` own property 变成原型设置而静默丢键。合法内容只允许被接受（逐字节保真）或被拒绝，不允许"成功但删除"。
3. **Policy 合法域 = PostgreSQL 可写域。** NUL 与未配对 UTF-16 surrogate 在 jsonb/text 中不可逐字节存储（jsonb 拒绝两者；text 拒绝 NUL，驱动会把孤立 surrogate 静默改写为 U+FFFD）。因此：state 的字符串 key/value 拒绝这两类（归入 `not_json`）；task-file content 拒绝（失败分类 `content_not_representable`）；goal/message/reason 拒绝（失败分类 `malformed_unicode`）。**Task File NUL 裁决**：含 NUL 或孤立 surrogate 的 content 属于 policy 非法而非合法同步结果，server 防御层收口 `terminal_protocol_invalid`；daemon 本地如何把此类文件归类为同步失败（读取阶段分类）右移 Batch 2 接线裁决。
4. **state 校验是单次受控读取并直接产出 canonical clone。** 校验遍历对输入每个属性恰好读取一次，并在同一趟构建规范化克隆（键以 defineProperty 定义，`__proto__` 等特殊键保持真实 own property）；序列化、字节上限与可写域检查只作用于该克隆。调用方持久化的正是通过全部校验的值；getter/Proxy 无法借多次读取改写已校验数据，任何深度/遍历/序列化异常稳定视为非法 state。
5. **v1 success 统一 invariant guard。** 任何 v1 成功分支（普通 report 与 finish）在规划 Loop 写入前都对读取快照 fail-closed；普通 report 命中损坏快照时收口为稳定 Run failure（`invalid_loop_state`、零 Loop 写入、Lease 消费），finish 命中时仍走 `finish_rejected` 形状且分类不变。
6. **Completion reason 快照校验复用 policy。** `isValidLoopSnapshot` 的 Completed 分支要求 `completionReason` 通过 finish reason 校验——写入路径只存 policy 规范值，违规即行外损坏。
7. **Finish 的可选 message 无条件过 policy。** terminal 校验为单次穷尽 switch：每个 variant 在同一处完成文本校验与 message/status 归一化，finish 的 `message` 与 `reason` 一样必须合法。
8. **Batch 1 生产观察面不输出 Phase 4 字段。** `LoopSummary` 的 goal/completion/sync 字段保持 protocol 声明（optional），但 Batch 1 的 projection/mapper 不包含它们——Create/List 响应与 Phase 3 逐字节一致；Batch 2 通过在 projection 中 opt-in 打开。

## 后果

- Phase 4 的领域行为有一个无 I/O、可穷举测试的单一事实来源；Batch 2 的接线工作是把既有纯 plan 接到事务适配层，不再发明语义。
- terminal policy 是 ADR-002 决策 4 的窄例外：它是 daemon/server 必须一致执行的同一命令契约，因此放进 `@loopzhb/protocol` 的独立 `terminal-policy.ts` 子模块并从主入口 re-export；普通 server 裁剪策略仍不进入 protocol 主 schema，也不得在 daemon/server 各复制一套规则。
- capability 协商是 ADR-002 决策 2「无协商」的明确例外：仍保持 additive optional wire、无握手、无版本比较，只按 capability 成员关系开放 Phase 4 语义（见 ADR-002 修订记录）。
- 双层 Completion 防线（DB CHECK + 领域 fail-closed）使半完成态既不能落库、也不能被读取方采信。
- 代价：Batch 1 的测试面（M/P/D/T/R 五组）大于代码面；冻结的 Phase 3 reader 夹具必须维护到 Phase 3 兼容承诺结束。
