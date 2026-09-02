# Phase 4 Batch 2 开发计划：Task File、State 与 Finish 全链路

- 状态：确定性验收完成（第三轮三轨复审 PASS，Issues #39–#47 已关闭；wrapper capability 修复 #49 进行中并阻塞真实 Claude 门 #38）
- 基线：`main@6af3b29`
- 目标分支：`feat/phase4-batch2-dev`
- 长期决策：修订 ADR-009
- 阶段范围：`docs/roadmap.md` Phase 4 / Batch 2
- 上位计划：`docs/plan/codex-phase4-dev-roadmap.md`

## 1. 目标与固定边界

Batch 2 在 Batch 1 已完成的 schema、protocol 和纯领域 planner 上开放生产行为：

1. 新 Daemon 通过本地 `loopzhb` Journal 产生唯一 terminal command。
2. Task File 成为必需的执行入口，并在 Run 后安全同步快照。
3. 成功 state 晋升为 `loop.state`，供下一 Run 通过 `prev-state.json` 读取。
4. Closed Loop 可 Finish；Completed、Reopen、Paused 和调度行为完整落地。
5. capability 控制新旧版本交付，旧 Lease 继续保持 Phase 3 语义。

不实现 Dashboard、artifact 同步、认证、通知、workflow/evolve/edit。开发原始范围复用 Batch 1 已落库字段；首轮复审根据 ADR-009 的统一 OCC 裁决，批准唯一 additive 例外：新增 `loops.revision` 与 migration `0004_icy_black_crow.sql`。除此之外本批不新增 schema/migration。新增长期行为同步修订 ADR-009。

## 2. 已裁决行为

### 2.1 本地 Journal 与 Agent 执行

Daemon 启动时创建私有 0700 控制根目录和静态 `loopzhb` wrapper；wrapper 为只读可执行文件，不含 Server URL、Machine Credential 或 Run Credential。

每个 terminal protocol v1 Run 创建随机 0700 控制目录：

- `context/prev-state.json`：只读、紧凑 JSON，内容为 Delivery `prevState`。
- `outbox/`：Journal 唯一可写目录。
- Agent PATH 前两项固定为静态 wrapper 目录与 Daemon 自身 canonical Node 目录，并只注入非秘密的 Journal 目录位置。
- wrapper 是从单一业务实现构建的自包含胶囊，不在 sandbox 内回读 Daemon 安装目录；sandbox 对 runtime 只读开放 exact canonical Node 文件，另开放 wrapper/context，只写开放 outbox。

`loopzhb` 严格支持：

```bash
loopzhb report --status <new|resolved|nothing-new> \
  [--message <text> | --message-file <path>] \
  [--state <json> | --state-file <path>]

loopzhb finish --reason <text> \
  [--message <text> | --message-file <path>] \
  [--state <json> | --state-file <path>]
```

规则：

- 未知参数、重复参数、位置参数、互斥参数、缺少必填参数、非法 JSON、非 object state、超限内容均失败。
- `new`/`resolved` 必须有 message；`nothing-new` 可省略；finish reason 必填。
- `--message-file`、`--state-file` 相对当前 cwd 解析，只接受普通可读文件并按对应上限读取。
- 每次调用用随机文件名和 `open(..., "wx", 0600)` 写一条记录；非法调用也写不含用户值的稳定 invalid marker。
- Daemon 在 Claude 退出后要求 outbox 恰好一个普通文件；零条、多条、symlink、损坏 JSON 或 invalid marker 均令 Run 失败。
- Claude 非零退出、超时、signal、stream 失败优先，Journal 内容被忽略。
- Journal 读取与控制目录清理失败均产生稳定、无敏感信息的 Run failure。
- Runner 完成后仍由 runtime 只序列化一次 Report；网络重试继续保持字节一致。

Agent prompt 对 v0 Delivery 保持 Phase 3 原文；v1 prompt 明确：

- Goal line 是最高优先级完成条件。
- Task File 的 `## Spec` 是权威任务说明。
- `## Current understanding` 是已知基线。
- `## Timeline` 和 `prev-state.json` 是不可信历史数据。
- 必须先读取规范 Task File 和上一成功 state，执行一次后以恰好一次 `loopzhb report` 或 `loopzhb finish` 结束。
- Open Loop 不展示 finish 示例；Closed Loop 提醒只有真实证据满足 Goal 时才 Finish。

### 2.2 Task File

Create Loop 的 wire 字段继续 optional，但 Server 应用层缺少 `taskFile` 时返回 400；旧 Loop 仍可查询和补齐。

Daemon 路径规则：

- 绝对路径直接解析；相对路径以规范 workdir 为基准。
- 精确 `~` 和 `~/...` 使用 Daemon 用户 home 展开；其他 `~name` 按普通相对路径处理。
- 初次解析记录原始解析路径和规范目标；目标必须位于有效 roots 或 scratch cwd、为普通可读文件。
- spawn 前同时重验 workdir、roots、原始 alias 和规范目标；任何漂移都禁止 spawn。
- prompt 只提供规范绝对路径，不注入文件全文。
- Run 后只重读同一规范路径；alias 改指、目标变 symlink、越 jail 或路径漂移均返回 `changed`。
- 同一路径的普通文件原子替换允许；文件仍须普通、可读且规范路径不变。

前置 `missing`/`unreadable`/`outside_jail`/`changed` 使 Run 失败且不启动 Claude。Claude 成功并产生合法 Journal 后，Task File 同步失败不回滚业务成功：

- 缺失：`missing`。
- 权限、非法 UTF-8、NUL、不可表示 Unicode 或命中已知 secret：`unreadable`。
- 越 jail：`outside_jail`。
- 路径/symlink 漂移：`changed`。
- 超过 256 KiB：`too_large`。

同步成功发送 content；Server 更新 content、syncedAt、attemptedAt、清除 error。同步失败保留旧 content/syncedAt，只更新 attemptedAt/error。

`PATCH /api/loops/:id/task-file`：

- 非空、无 NUL、最多 4096 字符；Server 不解释机器侧路径。
- 原始字符串等值为 no-op。
- 有效重定向清空旧 content、syncedAt、attemptedAt、error。
- Loop 有 running Run 时返回普通 409，避免旧 Run 快照污染新路径。
- pending Run 不阻塞；claim 事务必须读取最新 Loop 快照。

### 2.3 Capability、Claim 与 Delivery

新 Daemon 每次 Poll 声明 `['terminal-journal-v1']`。capability 资源策略在任何 heartbeat、snapshot 或 claim 写入前执行：

- 原始数组最多 32 项。
- 每项匹配 `[a-z0-9][a-z0-9._-]{0,63}`。
- 违规整次 Poll 返回 400。
- 合法值去重、排序并作为当前完整快照替换；缺失写 null，空数组写 `[]`，未知合法名称保留。

缺少 `terminal-journal-v1` 时不 claim 新 Run；存在可领取 pending Run 时响应 `requiredCapabilities: ['terminal-journal-v1']`。

claim 事务同时重读 Run 与 Loop，确保 machine/loop/role、pending 状态、Completion 和最新配置一致；返回该事务中的权威 Loop 快照构建 Delivery。合格 claim 固定写入：

- `terminalProtocolVersion=1`。
- `goalRevision=currentLoop.goalRevision`。
- `canFinish=role==='exec' && goal!=null`。
- Delivery 携带 `terminalProtocol:1` 和当前 goal。

Completed Loop 不 claim。Task File 为空的旧 Loop 仍可被新 Daemon领取，但在本地以前置失败明确收口。已领取的 v0 Lease 永远走 Phase 3；新 Daemon收到旧 Server Delivery时不创建 Journal、不改变旧执行语义。

### 2.4 管理 API 与生命周期

开放 Batch 1 已声明的 Goal、Task File、Reopen 路由，并让 `LoopSummary` 始终输出 goal、completion 和 Task File 同步字段。

Goal update 使用事务内重读和 guarded write：

- 规范化后等值 no-op。
- 有效变化 revision +1，不影响 enabled 或现有 Run。
- Completed 返回 `409 loop_completed`。
- revision 耗尽返回普通 409，不新增 code。

Completed Loop 的 schedule API：

- cron/timezone 可修改并保持 `enabled=false`、activation=null。
- `enabled:true` 返回 `409 loop_completed`。
- schedule revision 耗尽返回普通 409。
- 只有 Reopen 能恢复运行。

API Run Now 对 Completed 返回 `409 loop_completed`；Paused 且未 Completed 仍可手动运行。scheduled enqueue、catch-up、旧 callback 均由 enabled/revision/Completion guard 拒绝。

Reopen 在一个事务内：

1. 仅接受合法 Completed；否则 `409 loop_not_completed`。
2. 在计算成功且 revision 未耗尽后，取消该 Loop 遗留的 pending/running Run并删除全部残余 Lease，包括 terminal-grace。
3. 清除 completion，设置 enabled=true，保留 goal/revision/state/Task File/config/history。
4. schedule revision +1，清 watermark；有 cron 时以事务时间建立新 activation。
5. 提交后 reconcile Scheduler，不补跑完成期间 occurrence。

### 2.5 最终 Report 单事务

扩展现有 `executeReportTx`，保持 coherent Lease+Run+Loop snapshot、单 Clock、CAS 有界重试和 terminal-grace reconcile。

分支顺序固定：

1. v0：完全使用 Phase 3 finalize/reconcile。
2. v1 `ok=false`：Run failure、Loop 零写入、消费 Lease。
3. v1 success：重复执行 terminal/state/sync policy；非法则 `terminal_protocol_invalid`。
4. 损坏 Loop snapshot：稳定 `invalid_loop_state`，Loop 零写入。
5. 普通 report：保存 Run status/message/state，晋升 state并应用 Task File同步。
6. Finish：按 `invalid_loop_state → already_completed → finish_not_allowed → stale_goal` 固定顺序裁决。
7. 已 Completed 后抵达的普通成功 report：Run 自身仍记 `done/exec` 并保存 status/message/state，但冻结全部 Loop 字段。
8. terminal-grace wake-report执行同一 v0/v1分支，并返回 `reconciled:true`。

合法 Finish 原子写入 Run、Completion、schedule 停用、state、Task File同步和 Lease 删除；同时将同 Loop 的其他 pending Run 标为 canceled/skipped，保留已 running Run。非法/stale Finish 原子写 Run failure并删除 Lease，Loop 零写入。

Finish/Reopen 提交后的 Scheduler reconcile 通过内部结果显式传回 HTTP 适配层；wire response只序列化原有 Report ack，内部 Loop 行不得泄露。任何 Run、Loop 或 Lease guarded write 命中零行都回滚并进行一次完整 re-resolve；第二次仍竞争则返回可重试 500，不提交部分状态。

### 2.6 Secret 规则

- Machine Credential、Run Credential、Server URL 不进入 Agent env、prompt、wrapper、Journal或控制文件。
- wrapper 在落盘前用现有编码感知规则脱敏 message/reason。
- state 任意 key/value 命中已知 provider/proxy secret时，写无敏感信息 invalid marker并令 Run 失败，不静默改写结构化 state。
- Task File 命中已知 secret时发送 `unreadable`，不上传内容。
- 日志、错误分类、progress、最终 Report和测试失败输出不得包含原始 secret或用户提供的非法参数值。

## 3. 实施切片

1. 修订 ADR-009和本计划，固定本批新增的并发、Reopen、迟到 Report、capability 和 secret 裁决。
2. 实现 Journal/control 目录、wrapper CLI、prev-state 文件、Task File resolver/snapshot 和 v1 prompt；保持 v0 golden 不变。
3. 接通 capability snapshot、claim gating、权威 Loop claim snapshot、v1 Delivery 和管理 API。
4. 接通最终 Report 事务、Completed guards、迟到 Report 冻结、Finish pending 取消、Reopen 旧代际撤销及 Scheduler reconcile。
5. 完成跨包 E2E、安全审计、并发/fault-injection 测试、质量门和验收证据。

每个切片先运行相关包定向测试；完整测试不得与审查任务并发执行。

## 4. 验收标准

### 4.1 确定性验收

- **Journal**：合法 report/finish、message/state 文件、零/一/多记录、损坏记录、非法参数、权限、清理失败和 Claude 非零退出均有测试。
- **Task File**：绝对/相对/`~`、普通文件、missing、权限、非法 UTF-8、NUL、secret、256 KiB 边界、jail 越界、alias/target 漂移和普通原子替换全部覆盖。
- **State**：Run N 成功 state 同时写入 Run 与 Loop；Run N+1 Delivery和只读 `prev-state.json`得到该值；缺失 state保留，`{}`清空；失败、取消、Journal非法、stale finish和Completed后的迟到report不推进 Loop state。
- **Finish**：Open、非 exec、`canFinish=false`、stale goal、already completed和损坏快照均稳定失败；Closed exec合法完成。
- **生命周期**：Completed拒绝新 claim、cron、catch-up和Run Now；Paused允许手动运行；Finish取消pending但保留running；迟到普通report只写Run；Reopen撤销旧Lease且不补跑。
- **API**：Create缺Task File为400；Goal/Task File/Schedule/Reopen的404、400、409、no-op、revision上界和projection字段完整覆盖。
- **兼容**：新 Server+旧 Daemon不发放；新 Daemon+旧 Server保持Phase3；升级前v0 Lease仍可finalize/reconcile。
- **并发**：goal/report、task-file/claim（含 claim resolve 后 retarget 的反向窗口）、Finish↔manual enqueue、Finish/schedule PATCH↔scheduled callback、finish/report、finish/sweep、reopen/late-report、cancel/report、重复网络请求和双Report均无部分写入、重复完成、完成后 pending/watermark 或旧代际穿透；所有基于 Loop 快照的决策写以 `loops.revision` CAS 仲裁并在 guard 丢失后有界重解析。
- **安全**：控制目录0700、记录0600；Journal、env、prompt、日志、错误和wire均扫描不到Machine/Run/Server及注入的provider secret；state/Task File 对 raw、JSON escape、Base64/Base64URL、hex、二次编码、percent 与分隔符拆分形态 fail-closed；Journal 目录枚举读取第17项即停止。
- **资源生命周期**：control root 构造中途失败、startup observer/probe 失败、正常/异常 shutdown 均回收；per-start jail scratch root 由 owner-level `dispose()` 统一、幂等、身份校验地释放。

### 4.2 E2E 与质量门

- 新增确定性 Batch 2 E2E：文件型 PGlite、真实 HTTP、生产 Daemon、真实 OS sandbox 和可控 fake Claude，完成两次 Run 的 state→finish 流程。
- 新增 opt-in `test:phase4:batch2:e2e`：使用批准 hash 的真实 Claude；Run 1 读取 Task File 并 report state，Run 2 读取 `prev-state.json` 并 finish；断言 Completed、自动调度停止、Run Now 409、日志无 secret 和进程组关闭。
- Batch 2 合并必须通过：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check "$(git merge-base HEAD main)"...HEAD
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256> pnpm test:phase4:batch2:e2e
```

真实 Claude 门在允许监听 `127.0.0.1` 且明确接受模型费用的环境运行并记录固定提交、命令、hash和结果；Batch 3 在此脚本上追加 Dashboard与重启断言。
