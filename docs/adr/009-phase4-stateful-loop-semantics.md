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

### 2026-09-01：Batch 2 接线裁决固化

Batch 2 把本 ADR 的纯领域/write-plan 接到事务适配层（决策 8 的预定工作）。在不改变任何已裁决语义的前提下，固化接线期确认的十处裁决：

1. **Capability 资源策略的位置与写放大。** Poll capability 声明的持久化前限制（原始数组 ≤32 项、每项匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`、违规整次 Poll 400）是 server 侧策略，落 `store/machines.ts` 纯函数并在 coordinator 的 Poll 流水线中于任何 heartbeat/snapshot/claim 写入之前执行——credential 失败（401）仍先于 capability 拒绝（400），未认证请求不做资源校验。快照持久化语义不变（完整替换、缺失写 null、空数组写 `[]`、未知名保留），但按值等价的快照不重复落盘：能力快照视同 identity 字段搭 `applyMachinePollContact` 的同一 UPDATE，无变化时 idle Poll 保持只读热路径。
2. **迟到普通 v1 成功 Report 的冻结分支。** 普通 report（非 finish）抵达时已合法 Completed 的 Loop：Run 自身照常记 `done/exec/<status>` 并保存 message 与本次 Run state，但 Loop 全部字段零写入（state 不晋升、Task File 不同步、updatedAt 不动）。该分支在 terminal/state/sync policy 全部通过且快照合法之后才判定；finish 抵达时已 Completed 仍走 `already_completed`（决策 4 顺序不变）。
3. **v1 Lease 的 Loop 缺失。** claim 后 Loop 被删除（cascade 删 Run 是既有约定，但孤儿 Lease 防御层仍在）时，v1 Report 收口为稳定 `invalid_loop_state` Run failure 并消费 Lease——与损坏快照同族，不发明新分类。
4. **合法 Finish 的附带写集与调度信号。** 合法 Finish 在同一事务内：将同 Loop 的其他 pending Run 标为 `canceled/skipped`（保留 running Run），删除本 Lease。事务提交后必须 reconcile Scheduler；该需求通过 Report 内部结果的显式字段传回 HTTP 适配层（wire response 只序列化原有 Report ack，内部 Loop 行不得泄露），由适配层复用既有 schedule-commit seam。非法/stale Finish 不产生调度信号。
5. **Reopen 的旧代际撤销。** Reopen 事务在 planReopen 计算成功后：把该 Loop 遗留的 pending/running Run 置 `canceled`（沿用 cancel 语义，不写 outcome），删除该 Loop 的全部残余 Lease（active 与 terminal-grace 一视同仁），再写入 completion 清除 + enabled=true + schedule revision+1 + 清 watermark + 有 cron 时以事务时间建立新 activation。提交后 reconcile Scheduler；完成期间的 occurrence 不补跑（activation 边界与 revision guard 共同保证）。
6. **管理路由的稳定 HTTP 映射（不新增 code）。** 决策 10 的两个 code 之外：goal/task-file 的值域违规 → 400；goal/schedule/reopen 的 revision 耗尽 → 普通 409（无 code）；Task File 重定向遇 running Run → 普通 409；管理路由读到损坏快照（`invalid_loop_state`）→ 普通 409。这些映射固定后即为契约，未来不得静默改码。
7. **Claim 事务的权威快照。** claim 事务在 `pending → running` 条件更新成功后于同一事务重读 Loop 行：Loop 缺失、Loop 已合法 Completed、或 goal/role 等授权输入与该快照矛盾时不 mint Lease（Run 回滚回 pending，候选扫描继续）。Lease 的 `terminalProtocolVersion=1`、`goalRevision=currentLoop.goalRevision`、`canFinish=role==='exec' && goal!=null` 全部由该快照计算；Delivery（含 `terminalProtocol:1` 与当前 goal）也由该快照构建——candidate 扫描时的 Loop 副本只是提示。Task File 为空的旧 Loop 不在 claim 处拦截：新 Daemon 领取后本地以前置失败收口（计划 §2.3）。
8. **Daemon Journal 的秘密边界。** 控制根目录（0700，每启动一次 mkdtemp）、静态 `loopzhb` wrapper（0500，内容不含任何 secret）与每 Run 控制目录（0700：`context/prev-state.json` 只读紧凑 JSON、`outbox/` 唯一可写）构成唯一本地命令通道。Agent env 只注入固定的 PATH 前缀（wrapper 目录后紧跟 Daemon 自身 canonical Node 目录）与 outbox 位置（`LOOPZHB_JOURNAL_OUTBOX`）；sandbox 对 Node 只开放该 canonical 可执行文件只读，不开放整个 bin 或 Daemon 安装目录。Machine Credential、Run Credential、Server URL 不进入 env/prompt/wrapper/Journal/控制文件。wrapper 从继承的 provider/proxy 环境变量（ANTHROPIC_*、CLAUDE_CODE_OAUTH_TOKEN、代理变量）派生脱敏 needle，在落盘前脱敏 message/reason；Daemon 读取 Journal 记录后用完整 `redactSecrets` 再脱敏一次（双层）。state 任何 key/value 命中已知 provider/proxy secret → 写无敏感 invalid marker 并令 Run 失败，不静默改写结构化 state。
9. **Daemon 本地 Journal/Task File 的稳定失败分类。** 均为 content-free 稳定字符串，经 `ok=false` Report 上报：Journal 侧 `journal_missing`（零记录）/`journal_multiple`（多记录或 symlink）/`journal_corrupt`（损坏 JSON）/`journal_invalid`（invalid marker 或 policy 非法）/`journal_io`（读取或清理失败）；Task File 前置（不启动 Claude）沿用 sync 分类 `missing`/`unreadable`/`outside_jail`/`changed` 加 `task_file_not_configured`（旧 Loop 未补齐）；Claude 非零退出/超时/signal/stream 失败永远优先，Journal 内容被忽略。这些分类是 daemon-local 的 error 文本，不进入 wire schema。
10. **v1 prompt 由 Daemon 构建。** Server 的 `buildExecTask`（Phase 3 原文）对 v0 Delivery 保持不变；v1 Delivery 的 `task` 字段仍是既有文本（向后兼容旧 reader），但新 Daemon 对 `terminalProtocol:1` 的 Run 忽略它，本地用权威输入组装 prompt：Goal line（最高优先级）、Task File 规范绝对路径（只给路径不注入全文，`## Spec` 权威/`## Current understanding` 基线/`## Timeline` 与 `prev-state.json` 不可信）、恰好一次 `loopzhb report|finish` 的收口指令；Open Loop 不展示 finish 示例，Closed Loop 提醒只有真实证据满足 Goal 才可 Finish。

### 2026-09-01（二）：首轮 Code Review 修复裁决固化

Batch 2 首轮 code review（FAIL）后，固化修复期确认的四处裁决——它们全部不改变已裁决语义，只改变实现纪律：

1. **`loops.revision` 统一乐观并发令牌（OCC）。** `updatedAt` 不能担任并发 guard：毫秒时钟下先提交者与陈旧事务可共享同一值，陈旧写会静默命中（review SPEC-3）。新增 additive 列 `loops.revision`（int、默认 0，ADR-003 只增不删纪律）：**每一次** loops 行写必须 `revision = revision + 1`；每一个基于 loop 快照做决策的写事务必须 `WHERE id = ? AND revision = <observed>` guard；guard 丢零行 → 回滚 → 有界 re-resolve 一次 → 再丢为稳定 500（RaceLost）。写方审计单：updateGoal/updateTaskFile/reopenLoop、最终 Report 的 Loop 写、claim（flip 即 bump——这是 retarget/claim 竞态 SPEC-1 的闭环机制：claim 先于 retarget 提交时 retarget 的 guard 必丢，re-resolve 见到 running Run → 409；反之 claim 读到新 taskFile，Delivery 恒属新路径）、调度水位写、updateSchedule（本次补齐此前缺失的 guard）。`updatedAt` 降级为纯展示字段；`goalRevision`/`scheduleRevision` 保留各自业务语义（lease 的 stale_goal 判定仍用 goalRevision）。单连接 PGlite 无法观测锁，故弃行锁方案；OCC 的确定性交错证明由 resolve/write 之间的 TEST-ONLY hook（`LifecycleOpsHooks.afterResolve`）承载。
2. **Daemon 的 no-follow 有界 fd 读取纪律。** 凡读取 agent 可影响的文件（Journal record、Task File 同步、wrapper 的 `--message-file`/`--state-file`），一律经 `bounded-read.ts` 的 `readRegularFileNoFollow`：`O_NOFOLLOW` 打开一次（终组件换链得 ELOOP）、同一 fd 上 fstat 验 regular+尺寸上限（先验尺寸再分配，超限含稀疏文件立即失败，review ADV-4 的 OOM 面关闭）、固定 `maxBytes+1` 缓冲有界读、返回 dev/ino 供调用方做 check/use 一致性复验。残余（明示）：中间目录组件在 realpath 与 open 之间被换链超出 Node 跨平台能力，Task File 以读后 realpath 复验收窄该窗口；Windows 无 `O_NOFOLLOW` 时退化为 dev/ino 比对（本仓 CI 为 POSIX）。Journal record 上限定为 2×64 KiB=128 KiB（合法 record 上界 ≈90 KB：64 KiB state + message/reason 最坏转义），超限为新的 daemon-local 稳定分类 `journal_too_large`；outbox 目录项数量帽 16（归入 `journal_multiple`）。
3. **Journal 第二层秘密边界扩展至 state。** wrapper 落盘前的 state 扫描（任何 key/value 命中已知 secret → 无用户值 invalid marker）不是可信边界：agent 对 outbox 有直接写权限，可绕过 wrapper 直写 record（review ADV-1）。collector 因此对 canonical state 复跑同一共享扫描（`secret-scan.ts`，needle 集 = agent env 全量 secret + runToken），命中即 `journal_invalid` fail-closed——绝不脱敏后静默入库（静默改写等于发明 agent 未报告的 state）。同时 secret key 分类收敛为 `agent-env.ts` 单一导出（`isSecretKey`/`collectSecretValues`），wrapper 不再字面复制（review STD-3）。
4. **per-start control root 的全生命周期。** `createControlRoot` 增补 `releaseControlRoot`（fail-closed：父目录/前缀身份校验先行，symlink/非目录置换 throw 不删，ENOENT 幂等）；composition root 在 startup failure（probe 失败等）与 runtime 关闭（SIGTERM/异常）两条路径都释放（review STD-4）——不再遗留 `loopzhb-control-*` 与 wrapper 元数据。

### 2026-09-02：第二轮 Code Review 修复裁决固化

1. **决策快照与写入必须由同一 Loop revision 证明。** claim、manual enqueue 与 scheduled watermark 在写事务外解析 Loop 快照，写事务内以 `id + revision` CAS 获得该快照对应的写权限；CAS 丢失时整笔 Run/Lease/watermark 事务回滚并完整重解析一次。manual enqueue 即使不修改 Loop 业务字段，也以 revision bump 封住 Finish 后插入 pending 的窗口；scheduled enqueue 的 watermark 与 Run 写共享同一事务。
2. **秘密边界复用同一个 protected-form matcher。** message/reason 的 redaction 与 state/Task File 的 fail-closed 扫描共享 raw、JSON escape、Base64/Base64URL、hex、二次编码、percent 与分隔符拆分形态定义。state/Task File 命中后拒绝，不对待持久化数据做静默改写。
3. **Journal 条目上限约束枚举本身。** collector 通过流式目录 handle 逐项读取，第 17 项立即返回 `journal_multiple` 并关闭 handle；不得先全量分配文件名再检查上限。
4. **所有 per-start 临时根都有 owner-level 生命周期。** control root 在 `mkdtemp` 后任一步构造失败即自清理；observer 也位于 startup 保护区。Workdir jail 暴露身份校验、幂等的 owner-level `dispose()`，composition root 在 startup failure 和 runtime shutdown 同时回收 control/scratch 两类根。

### 2026-09-02（二）：Issue #49 wrapper capability 修复裁决

1. **wrapper 必须是自包含能力胶囊。** control root 中的可执行文件不得在运行时 import Daemon 的 `dist`/源码或任何第三方业务模块；构建期以固定的直接 `esbuild` 开发依赖从唯一 `runLoopzhbWrapper` 实现生成 `dist/loopzhb-wrapper.mjs`，外部 import 只允许 `node:` built-in。bundle 是构建产物，不入 Git。
2. **产物身份编译进 Daemon。** 同一次 bundle 构建生成文件名与 SHA-256 manifest，manifest 随 TypeScript 编译进入 Daemon `dist`。构建检查从源图重新生成并逐字节比较 bundle/manifest；启动时 `createControlRoot` 在 mint 目录前以编译内 digest 校验安装 bundle。缺失、损坏或与本 Daemon build 不匹配均 fail startup，不能信任 bundle 邻接、可同时替换的摘要文件。
3. **Node runtime 是最小只读 capability。** `createControlRoot` canonicalize `process.execPath`；v1 child PATH 固定以 `wrapperDir → dirname(process.execPath)` 开头，使 `#!/usr/bin/env node` 不再接受运营方 PATH 中的其他架构/runtime。sandbox `allowRead` 只增加 exact canonical Node 文件，不开放整个 Node bin、Daemon 安装目录或 bundle 源目录。
4. **验收分层。** 确定性 capsule 必须以 agent 同形的 `loopzhb` shebang/PATH 入口启动，并在只允许 control root、exact Node 与 outbox 的文件权限下写出唯一合法记录；之后仍须依次通过单命令真实 Claude smoke 与 Issue #38 的两 Run 全链路门。真实门的认证/费用/监听环境问题只能记录为阻塞，不能用 fake/capsule 结果替代。

### 2026-08-31：实现期裁决固化

在不改变任何已裁决语义的前提下，固化实现期确认的八处裁决：

1. **State wire 校验非递归化。** `jsonObjectSchema` 不使用递归 `z.lazy`：wire 层只做非递归顶层 object 形状判断，嵌套 JSON 合法性由 stack-safe、全函数的严格 JSON 检查承担；该检查先以 lazy cursor 构建 plain clone，共享 DAG 节点只访问一次，重复引用在最终深度探针中用 primitive 占位，不按引用点指数展开，也不跳过其他非共享深分支。顶层反射也处于异常边界内，包含已撤销 Proxy 在内的异常输入只能成为 schema failure。深层或循环 state 稳定降级为 schema 拒绝（HTTP 400、Lease 不消费），不存在 `RangeError` 或 `TypeError` 逃逸为 500 的路径。64 KiB 上限与可写域规则仍在 terminal-policy，不进入 wire。
2. **State wire 不得重建输入对象的键。** 解析合法 state 必须按引用透传：以普通对象赋值重建键会把顶层 `__proto__` own property 变成原型设置而静默丢键。合法内容只允许被接受（逐字节保真）或被拒绝，不允许"成功但删除"。
3. **Policy 合法域 = PostgreSQL 可写域。** NUL 与未配对 UTF-16 surrogate 在 jsonb/text 中不可逐字节存储（jsonb 拒绝两者；text 拒绝 NUL，驱动会把孤立 surrogate 静默改写为 U+FFFD）。因此：state 的字符串 key/value 拒绝这两类（归入 `not_json`）；task-file content 拒绝（失败分类 `content_not_representable`）；goal/message/reason 拒绝（失败分类 `malformed_unicode`）。**Task File NUL 裁决**：含 NUL 或孤立 surrogate 的 content 属于 policy 非法而非合法同步结果，server 防御层收口 `terminal_protocol_invalid`；daemon 本地如何把此类文件归类为同步失败（读取阶段分类）右移 Batch 2 接线裁决。
4. **state 校验是单次受控读取并直接产出 canonical clone。** 校验遍历对输入每个属性恰好读取一次，并在同一趟构建规范化克隆（object 保留普通 prototype 以兼容会检查 `constructor` 的 DB adapter，同时用自有不可枚举 `toJSON` 屏蔽污染原型；数组同样屏蔽继承 `toJSON`；所有数据键以 defineProperty 定义，`__proto__` 等特殊键保持真实 own property）、验证可写域、增量计算紧凑 JSON 的精确 UTF-8 字节；无原型游标事件栈只随深度增长，超过 64 KiB 立即停止。共享 DAG 节点只克隆一次，其序列化尺寸在每个引用点以饱和计数累加，不展开成指数级中间字符串。尺寸通过后再以同一 clone 执行有界 stringify 探针，保证 DB adapter 可序列化；数组元素也以 defineProperty 写入，稀疏数组按 own-property 判定，不从污染原型继承数据。调用方持久化的正是通过全部校验的值；getter/Proxy 或全局原型污染无法改写已校验数据，任何反射、遍历或序列化异常稳定视为非法 state。
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
