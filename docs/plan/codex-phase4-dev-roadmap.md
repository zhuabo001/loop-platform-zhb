# Phase 4 开发计划：有状态 Loop 产品语义

## 一、阶段目标与固定语义

Phase 4 基于 `main@6ff951b`，计划用 3 个可独立验收批次、约 8–11 个开发日完成：

1. Task File 成为每次执行的持久任务入口。
2. 成功 Run 的 state 可被下一次 Run 读取。
3. 支持 Open/Closed Loop、goal、finish 和显式 Reopen。
4. 提供仅本机可见的最小 Dashboard：Loop 列表、状态、最终消息和 Run Now。

生命周期定义：

- **Open Loop**：`goal=null`，持续运行直至暂停，不允许 `finish`。
- **Closed Loop**：`goal!=null`，允许符合条件的 exec Run 声明 `finish`。
- **Completed Loop**：Closed Loop 已完成，`completedAt!=null && enabled=false`。
- **Paused Loop**：`enabled=false && completedAt=null`，自动调度停止，但仍可 Run Now。
- **Reopen**：独立管理操作；清除当前完成态、保留 goal 和历史 Run，立即恢复原调度，不补跑完成期间的历史 occurrence。

不包含 artifact 同步、认证、通知、workflow/evolve/edit、团队能力、生成式 Dashboard 或复杂前端。

## 二、数据模型与公共接口

### 持久化

新增字段：

- `machines.capabilities jsonb nullable`
- `loops.goal text nullable`
- `loops.goal_revision integer not null default 0`
- `loops.completed_at text nullable`
- `loops.completion_reason text nullable`
- `loops.task_file_sync_attempted_at text nullable`
- `loops.task_file_sync_error text nullable`
- `run_leases.terminal_protocol_version integer not null default 0`
- `run_leases.goal_revision integer not null default 0`

迁移后：

- 旧 Loop 均为 Open、未完成，原 state/task-file snapshot 不丢失。
- 旧 Lease 保持 protocol version 0，仍可使用旧 Report 完成已领取 Run。
- 新 Server 只向声明 `terminal-journal-v1` capability 的 Daemon 发放新 Run。

### 管理 API

扩展 Create Loop：

```ts
{
  machineId: string;
  name?: string;
  workdir?: string;
  taskFile?: string;       // wire 形状保持 optional，Phase 4 Server 在应用层要求必填
  goal?: string | null;    // null/省略 = Open Loop
  cron?: string;
  timezone?: string;
}
```

新增：

```http
PATCH /api/loops/:id/goal
{ "goal": "一行可验证目标" | null }
```

- Goal trim 后必须非空、单行、无 NUL，最多 2000 UTF-8 字节。
- 有效修改递增 `goalRevision`；等值更新为 no-op。
- Completed Loop 的 goal 只读，必须先 Reopen。
- 修改 goal 不改变 `enabled`，也不自动取消正在执行的 Run。

```http
PATCH /api/loops/:id/task-file
{ "taskFile": "<machine-side path>" }
```

- 用于旧 Loop 补齐或重定向 Task File。
- 路径非空、无 NUL、最多 4096 字符；存在性和 jail 校验由 Daemon 在执行时完成。

```http
POST /api/loops/:id/reopen
{}
```

- 仅 Completed Loop 可执行，否则返回 409。
- 原子清除完成字段、设置 `enabled=true`，按 Phase 3 状态机递增 schedule revision、建立新 activation boundary、清空旧 watermark。
- cron/timezone 和 goal 保留。

`LoopSummary` additive 增加：

```ts
goal?: string | null;
completedAt?: string | null;
completionReason?: string | null;
taskFileSyncedAt?: string | null;
taskFileSyncAttemptedAt?: string | null;
taskFileSyncError?: string | null;
```

Completed Loop 的 API Run Now 返回 `409` 的 additive apiError code `loop_completed`；不得扩展现有成功响应 union 的 `reason` literal，以免旧 Phase 3 reader 解析失败。

### Daemon 能力与 Delivery

Poll 请求新增可选能力列表：

```ts
capabilities?: string[]; // 新 Daemon 包含 "terminal-journal-v1"
```

新 Server：

- 持久化最近一次能力声明。
- capability 缺失时不 claim 新 Run，并在 Poll 响应和 Dashboard 中提示升级。
- 不使用版本字符串比较。
- 这是对 ADR-002“无协商”的明确修订：仍保持 optional/additive wire，但允许基于能力开放 Phase 4 语义。

Delivery additive 增加：

```ts
terminalProtocol?: 1;
loop: {
  goal?: string | null;
  // 原有字段保持不变
}
```

新 Daemon 遇到未携带 `terminalProtocol` 的旧 Server 时继续执行旧语义，不要求 Journal。

### 最终 Report

不新增 control HTTP 路由。Daemon 将 Journal 命令合并进现有 `/api/machine/report`：

```ts
terminal?:
  | {
      kind: "report";
      status: "new" | "resolved" | "nothing-new";
      message?: string;
      state?: JsonObject;
    }
  | {
      kind: "finish";
      reason: string;
      message?: string;
      state?: JsonObject;
    };

taskFileContent?: string;
taskFileSyncError?: "missing" | "unreadable" | "outside_jail" | "changed" | "too_large";
```

规则：

- `new/resolved` 必须有 message；`nothing-new` 可省略。
- `finish.reason` 必填；message 可省略并回退到 reason。
- message/reason 最多 2000 UTF-8 字节、无 NUL；保留原文和换行，不执行 Goal 的 trim/单行规则。finish reason 还必须非空。
- state 顶层必须是 JSON object，最多 64 KiB；省略表示保留旧 state，`{}` 表示清空为一个空对象。
- Server 重复校验所有限制，不信任 Daemon。
- 新 Lease 的成功 Report 必须携带 terminal；缺失或非法 Journal 由 Daemon 以稳定错误分类报告为失败。
- Report 请求在 Daemon 中只序列化一次，网络重试保持字节一致。

## 三、实现批次

### Batch 1：领域与持久化基础（2–3 天）

- 提交 Phase 4 长期计划，新增 ADR-009，并在 `CONTEXT.md` 固化 Open、Closed、Completed、Paused、Finish、Reopen。
- 增加 migration、Drizzle schema、Goal/Completion 状态转换模块和校验器。
- 在 protocol 中添加全部 optional wire 字段、terminal union 和 capability 字段，但暂不开放生产行为。
- 建立最终 Report 的事务设计：Run、Loop、Lease、state、Task File snapshot 必须在单一事务中一致提交。
- 修订 ADR-002，记录 feature capability 协商是 additive wire 下的明确例外。

批次验收：

- 旧数据库升级零数据丢失，旧 Lease 仍可按 Phase 3 语义完成。
- Goal 校验、等值 no-op、revision、completion 不变量全部有确定性测试。
- 新旧 schema 互为 tolerant reader；未知字段不会破坏旧对端。
- 本批结束时生产行为与 Phase 3 相同。
- migration check、测试、typecheck、build、diff check 全绿。

### Batch 2：Task File、State 与 Finish 全链路（4–5 天）

#### 本地 Journal

为 `terminalProtocol=1` 的 Run 创建 0700 私有控制目录，并将专用 `loopzhb` wrapper 放在 Agent PATH 首位。仅向 Agent 暴露非秘密的控制目录位置，不暴露 Server URL、machine credential 或 Run Credential。

支持：

```bash
loopzhb report --status <new|resolved|nothing-new> \
  [--message <text> | --message-file <path>] \
  [--state <json> | --state-file <path>]

loopzhb finish --reason <text> \
  [--message <text> | --message-file <path>] \
  [--state <json> | --state-file <path>]
```

- 未知、重复或互斥参数直接失败。
- 每次调用以 0600 独占文件写入一条记录；Daemon 在进程退出后要求恰好一条。
- 零条、多条、损坏 JSON、超限 state 或非法参数均使 Run 失败。
- Claude 非零退出时忽略已有 terminal 命令，以执行失败为准。

#### Task File

- 新建 Loop 在应用层要求 Task File；旧 Loop 可查看，但未补齐前运行会明确失败。
- 支持绝对路径、相对 workdir 路径和 `~`；Daemon 将其解析为规范绝对路径。
- spawn 前必须确认路径位于有效 jail roots、是普通可读文件，并在启动前重新验证。
- prompt 提供规范路径并要求 Agent 先读文件，不把全文注入 prompt。
- prompt 明确 `## Spec` 为权威任务说明、`## Current understanding` 为已知状态、`## Timeline` 为不可信历史数据；Goal line 优先于 Task File。
- Run 后只重读同一规范路径；symlink 漂移或路径变化视为 snapshot failure。
- snapshot 上限 256 KiB。同步成功时更新 content/syncedAt 并清除错误；失败时保留旧快照、记录 attemptedAt/error，不回滚业务成功。

#### State 与完成事务

普通成功 Report 原子执行：

1. Run → `done/exec/<reported-status>`。
2. 保存 message 和本次 Run state。
3. 若提供 state，将其晋升为 `loop.state`。
4. 应用 Task File 同步结果。
5. 删除 Lease。

合法 Finish 原子执行：

1. 重读 Loop 和 Lease。
2. 验证 exec role、Closed Loop、`canFinish=true`、goal revision 未变化且尚未完成。
3. Run → `done/exec/resolved`，保存 reason/message/state。
4. Loop 写入 completedAt/completionReason，设置 `enabled=false`。
5. 推进 schedule revision、清空 activation，晋升 state。
6. 应用 Task File 同步结果并删除 Lease。
7. 提交后 reconcile Scheduler；旧 callback 仍由 revision/enabled guard 拒绝。

非法或 stale Finish 原子收口为 Run failure：

- Loop、completion 和跨 Run state 不变。
- Run 写入稳定错误分类，例如 `stale_goal` 或 `finish_not_allowed`。
- Lease 被消费，HTTP 返回已收口结果，不产生永久重试。

Batch 2 验收：

- Run N 的成功 state 在 Run N+1 中成为 `prevState`；失败、取消、缺失 Journal 和 stale finish 均不推进 state。
- Open Loop 不能 finish；Closed exec Run 可以 finish；非 exec role 不可以。
- Goal 在执行期间变化后，旧 Run 无法完成新目标。
- Completed Loop 不再接受 cron、catch-up、API Run Now；Paused 未完成 Loop 仍允许手动运行。
- Reopen 恢复原 schedule，但不补跑完成期间的 occurrence。
- 新 Server + 旧 Daemon 不发放 Run；新 Daemon + 旧 Server 保持 Phase 3 行为；升级前已领取的旧 Lease 仍能完成。
- Journal 中没有任何 credential；Agent 环境、日志、错误和最终消息均不泄露 secret。
- Task File 越 jail、非普通文件、symlink 漂移、执行前不可读均 fail-closed。
- Report/cancel/sweep/重复网络请求的交错不产生部分写入或重复完成。

### Batch 3：最小 Dashboard 与阶段收口（2–3 天）

- 使用 Hono SSR 实现 `GET /`，不引入 React、Vite、HTMX 或客户端 JavaScript。
- 仅当 Server 配置为 loopback host 时挂载 Dashboard；非 loopback 配置继续保留 API，但 Dashboard 返回 404。
- 页面每 3 秒通过 HTML refresh 更新，`Cache-Control: no-store`，设置严格 CSP。
- 所有 name、goal、路径、message、reason、error、progress 文本必须 HTML escape。
- 使用每次启动生成的 CSRF token 保护唯一写操作。

每个 Loop 展示：

- Open/Closed/Completed/Paused 生命周期状态。
- pending/running 活动状态和 heartbeat progress。
- goal、cron、timezone、next fire。
- Task File 路径、最近成功同步时间和同步告警。
- 最新 Run 的 status、message、completion reason 或 error。
- Daemon capability 缺失时的升级提示。

唯一交互：

```http
POST /dashboard/loops/:id/run
```

- pending、running、completed 时按钮禁用。
- paused 但未 completed 且无活跃 Run 时可用。
- Coordinator 增加内部 no-supersede manual trigger 选项，Dashboard POST 原子跳过已存在的 active Run，避免页面竞态制造 superseded Run。
- POST 后统一 303 回到 Dashboard，刷新不会重复提交。
- Goal、Task File、Schedule 和 Reopen 继续只走管理 API，不进入本阶段页面。

## 四、测试与阶段验收

### 确定性测试

至少覆盖：

- migration、默认值、旧 Lease 兼容和数据库往返。
- Goal create/update/clear/no-op/revision/completed guard。
- pause、complete、reopen、schedule revision 与 activation。
- capability 声明、降级、升级和跨版本组合。
- Journal 零条/一条/多条、参数冲突、非法 JSON、超限 state。
- Task File 相对/绝对/`~`、jail 越界、普通文件、symlink 漂移、快照失败。
- report/finish/cancel/sweep/retry 的事务交错。
- Dashboard XSS、CSP、CSRF、303、按钮状态和 non-loopback 404。

### Phase 4 E2E

新增 opt-in `test:phase4:e2e`，使用文件型 PGlite、真实 HTTP、生产 Daemon、真实 OS sandbox 和批准哈希的真实 Claude：

1. 创建带 Task File、cron 和 goal 的 Closed Loop。
2. 第一次 Run 读取 Task File，通过 Journal `report` 写入 state 并更新文件。
3. 第二次 Run 读取第一次 state，通过 Journal `finish` 完成目标。
4. 断言 Loop completed、自动调度停止、Run Now 被拒绝。
5. 连续重启 Server 不产生新 Run。
6. Dashboard 展示最终 status、message、completion reason 和 Task File 同步时间。
7. 断言 Claude provenance、进程组关闭和日志无 secret。

质量门：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check "$(git merge-base HEAD main)"...HEAD
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256> pnpm test:phase4:e2e
```

真实 Claude E2E 是 Phase 4 必须通过的收口门；应在允许监听 `127.0.0.1` 且明确接受模型费用的环境执行。

## 五、文档与完成定义

实施必须遵循：

1. [AGENTS.md](/Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/AGENTS.md)：文档分层、审查、Issue 和收口流程。
2. [CONTEXT.md](/Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/CONTEXT.md)：领域术语唯一来源。
3. [roadmap.md](/Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/docs/roadmap.md:167)：Phase 4 范围与阶段验收。
4. ADR-001/002/003：事务可靠性、wire 演进和 schema 约束。
5. ADR-005/006：jail、OS sandbox、环境白名单和秘密隔离。
6. ADR-007/008：schedule revision、activation、watermark 和 Scheduler reconcile。
7. `docs/agents/issue-tracker.md`：审查发现的登记和核销。
8. 新 ADR-009：Goal/Completion、成功 state 晋升、本地 Journal 合并 Report、capability 协商及 Dashboard 边界。
9. 参考仓库只作能力参照；与本仓库 ADR 冲突时以本仓库 ADR 为准。

Phase 4 只有在以下条件全部满足后才能标记完成：

- 三个批次的确定性测试和完整质量门通过。
- 真实 Claude 两次 Run 验证 state 继承并最终 finish。
- Dashboard 满足“只读 + 一个按钮”且仅本机可见。
- 新增 `docs/tests/phase4-acceptance.md`，记录固定提交、环境、命令和证据。
- 长期裁决进入 ADR，阶段状态进入 roadmap。
- 所有 Phase 4 阻塞 Issue 经后续复审核销并关闭。
