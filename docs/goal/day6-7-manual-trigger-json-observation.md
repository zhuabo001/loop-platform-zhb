# Day 6–7 目标：手动触发与 JSON 观察面

## 目标

补齐 Day 5 最小 daemon 闭环的用户入口与观察面，让一个 Loop 不依赖测试 fixture 即可完成：

```text
daemon poll 注册 Machine
  → 用户查询 Machine ID
  → 创建 Loop
  → 手动触发 Exec Run
  → daemon + Fake Runner 执行并回报
  → JSON API 查看 done/exec 与最终消息
```

这是 Phase 1 Day 5–7「前台 poll 循环 + Fake Runner，端到端打通」批次的收尾切片；
创建与触发分离，不改变既有 Run/RunLease 状态机，不提前实现 Day 8–10 的 sweep 或
Phase 2 以后的产品能力。

## 交付范围

### 1. 管理 API wire 契约

- 在 `@loopzhb/protocol` 新增管理请求、响应 DTO 与 Zod schema；类型和运行时校验同源，
  server 不得复制或重定义 wire DTO。
- 所有 object schema 继续遵守 ADR-002 tolerant-reader：校验已声明字段的类型和值域，
  剥离未知键，永不使用 strict object；新增 schema 必须纳入 tolerant-reader 穷尽测试。
- 时间戳统一为 ISO string。响应字段与 nullability 由 wire DTO 固定，不直接泄漏数据库
  行的 optional/nullable 差异：
  - `MachineSummary`：`id/name/createdAt: string`；
    `hostname/platform/arch/daemonVersion/lastSeen: string | null`。
  - `LoopSummary`：`id/machineId/agent/createdAt/updatedAt: string`；
    `allowControl/enabled: boolean`；`name/workdir/taskFile: string | null`；
    `lastRun: RunSummary | null`。
  - `RunSummary`：固定包含 `id/loopId/machineId/phase/role/ts`；
    `outcome/status/message/error` 为对应值或 `null`；`durationMs` 为非负整数或 `null`；
    `progress` 为 `{step: nonnegative integer, label: string, at: string | null} | null`。
- 摘要不得返回 `tokenHash`、roots、credential、workflow、model、state、task-file content、
  session、usage、artifact 或 transcript。
- 错误统一复用 `apiErrorSchema`，本批只产生：
  - 400 `{error:"invalid request"}`；
  - 404 `{error:"not found"}`；
  - 413 `{error:"request body too large"}`；
  - 500 `{error:"internal server error"}`。
  本批不新增 error `code`。

### 2. Machine 查询与 Loop 创建

- `GET /api/machines` 返回 `{machines: MachineSummary[]}`，按 `name ASC, id ASC` 排序后
  最多返回 100 条；Phase 1 不开放分页参数。
- `POST /api/loops` 接收 JSON object：`machineId` 必填，`name/workdir/taskFile` 可选。
- `machineId` 必须匹配 `m-<16位小写hex>` 且已由 poll 注册；未知 Machine 返回 404，
  不产生任何写入。
- `name` 最大 255 字符，`workdir/taskFile` 最大 4096 字符；已声明字符串字段拒绝空值
  与 NUL。malformed JSON、非 object JSON 或超过 2 MiB 的 body 分别返回 400/413。
- 未知键剥离且不得写入。`workflow/model/agent/state/enabled` 等未开放字段即使由调用方
  提交也不产生业务效果；能解析或忽略 wire 字段不等于开放其语义。
- 创建固定得到 `agent=claude-code`、`allowControl=true`、`enabled=true`；使用注入的
  Clock 写 `createdAt/updatedAt`，生产 Loop ID 为 `loop-${randomUUID()}`，测试使用
  确定性 factory。
- 成功返回 `201 {loop: LoopSummary}`，其中 `lastRun=null`。创建不自动触发，也不承诺
  create 请求幂等，但重试创建请求不得执行 Run。

### 3. 手动触发

- 本目标将 `POST /api/loops/:id/run` 定为本批 canonical route，也是 Phase 1 唯一触发
  入口；实现 route 前必须把 roadmap 中遗留的 `/loops/:id/run` 统一为该 `/api` 前缀。
- trigger adapter 调用既有 `coordinator.enqueueExecRun()`。
- 当前无业务参数：空 body 与 `{}` 均合法，空 body 在 HTTP 边界归一化为 `{}`；合法
  JSON object 的未知键被剥离；malformed 或非 object JSON 返回 400 且零写入。
- 新 Run 入队返回 `202 {enqueued:true,runId,supersededRunIds}`。
- Loop 已有 running Run 时返回
  `200 {enqueued:false,reason:"running_exists"}`，并保持零写入。
- Loop 不存在返回 404。
- 重复触发继承 ADR-001 T7：无 running Run 时，在同一事务中把全部旧 pending exec
  Run 转为 `canceled/skipped`，并插入恰好一个新 pending exec Run；guard 失败或写入
  失败必须整体回滚。

### 4. Loop 与 Run JSON 观察面

- `GET /api/loops` 返回 `{loops: LoopSummary[]}`，按 `updatedAt DESC, id ASC` 排序后
  最多返回 100 条；Phase 1 不开放分页参数。
- 每个 Loop 的 `lastRun` 只考虑 exec role，按 `ts DESC, id DESC` 取最新一条；无 Run
  时固定为 `null`。
- `GET /api/loops/:id/runs` 返回 `{runs: RunSummary[]}`，固定最多 50 条，按
  `ts DESC, id DESC`；Loop 不存在返回 404。
- `runs.ts` 是最近一次状态转换时间，不是创建时间。Run 会在
  claim/finalize/reclaim/supersede 后随新 `ts` 重排；同 `ts` 由 `id DESC` 决胜。
- Machine、Loop、Run 列表均先完成确定性排序，再应用条数上限。

### 5. 模块边界与 HTTP 组装

- 新建本地 Loop 管理深模块，注入 DB、Clock 和 `newLoopId`，负责 Machine 查询、
  Loop 创建、存在性校验、安全 view mapping 与确定性列表查询。
- HTTP app 同时注入本地管理模块与既有三方法 RunCoordinator；不得扩展 Coordinator 的
  `enqueueExecRun/poll/report` 接口，也不得绕过 Coordinator 直接写 Run 生命周期。
- 所有新增 POST route 复用 2 MiB body cap；所有 route 复用统一 JSON error、404 与
  全局 500 脱敏。
- 更新非 loopback 启动警告，明确 `/api/loops*` 和其他管理端点同样无认证。
- 不修改数据库 schema、migration、machine claim/report wire 或 RunLease mint policy。

### 6. 测试与验收

至少覆盖：

1. Protocol：每个新增 object schema 都被 tolerant-reader 穷尽测试覆盖；未知字段剥离，
   所有成功响应均通过对应 schema。
2. 创建失败：未知/畸形 Machine、空值、NUL、超长字段、malformed/非 object JSON、
   超大 body 均返回精确错误且零写入；未知字段不得改变默认值或写入未开放配置。
3. 创建成功：ID 与 Clock 可注入，默认字段正确，响应 nullability 固定，且不产生 Run。
4. Trigger：202 入队、pending 原子 supersede、running 200 no-op、未知 Loop 404；空 body、
   `{}`、未知字段、malformed/非 object JSON 的行为全部钉住。
5. 观察面：不泄漏敏感/大字段；排序、nullability、exec-only `lastRun`、同时间戳决胜、
   Machine/Loop 100 条与 Run 50 条上限均有边界测试，并证明先排序后截断。
6. 完整 E2E：daemon poll 注册 Machine → `GET /api/machines` 获取本次注册的 Machine ID
   → HTTP 创建 Loop → HTTP 手动触发 → daemon `pollOnce()` → Fake Runner report →
   JSON 查询看到 `done/exec` 与
   `"fake runner completed"`；RunLease 已删除，第二次 daemon poll 不重执行。
7. 保留 Coordinator 三方法结构钉与现有 T1–T7 回归测试。

### 7. 完成态交接

- 新增 Day 6–7 完成态 handoff，记录最终 API 契约、实际测试基线、尚未完成的 Day 8–10
  T4–T6/Phase 1 收尾工作，以及无认证管理面的 localhost/受信网络安全限制。
- handoff 必须如实记录实现相对本目标的偏差与右移项；不得用“测试通过”替代剩余风险说明。

最终验收运行：

- `pnpm -r typecheck`
- `pnpm -r test`
- `pnpm -r build`
- `pnpm --filter @loopzhb/server db:check`
- `git diff --check`

## 明确不做

- cron、定时调度、catch-up 或离线 pending 恢复（Phase 3）。
- 真实 Claude/Codex 子进程、工作目录 jail、进程组 kill、progress heartbeat（Phase 2）。
- sweep/reclaim、owner cancel 与 T4–T6 的完整故障注入（Day 8–10）。
- Dashboard、认证、Team/Membership、rate limit 或公开部署（Phase 4–6）。
- workflow、Task File 持久语义、跨 Run state、artifact 同步、通知或真实 Agent 配置入口。
- Loop 更新/删除、暂停/关闭、分页、筛选或搜索。

## 可靠性与安全约束

- 管理 API 无认证，不接收 Machine/Run Credential；认证上线前 server 仅允许
  localhost/受信网络使用，不得公开暴露。
- Server 只调度、存储和观察，绝不执行用户代码或调用 LLM；Fake Runner 仍只在 daemon。
- 手动触发必须复用 T7 的原子 enqueue，不能在 HTTP route、管理模块或新 store 中复制
  supersede/insert 逻辑。
- `enabled` 在本批不限制手动触发；Phase 1 没有关闭入口，暂停/关闭语义留到 Phase 4。
- 创建不自动执行，HTTP 重试不得把 create 转化为隐式 Run；Run 的 at-most-once
  execution、claim/report 与 lease 语义保持不变。
- 安全 view mapper 必须显式挑选字段，不得通过展开数据库行后删除少数字段来构造响应。

## ADR 结论

Day 6–7 按本目标实施时不新建 ADR：手动触发的 T7 语义由 ADR-001 覆盖；管理 DTO
进入 protocol 及 tolerant-reader 纪律由 ADR-002 覆盖；`runs.ts` 与数据库字段语义由
ADR-003 覆盖。管理模块是既有 HTTP/Coordinator 架构内的新 adapter，不改变跨阶段、
难以回滚的架构决策。

只有在实施中决定以下任一策略时才应暂停并新增 ADR：改变 create 幂等模型、把管理
DTO 留在 server 形成第二套 wire 契约、扩展 Coordinator 公共接口、改变 T7/RunLease
语义、引入认证授权模型，或在 Phase 1 提前作出公开部署承诺。

## 目标review反馈

| 补充内容 | 同意/不同意 | 不同意的理由 |
|---|---|---|
| 管理 API 的请求/响应 DTO、`MachineSummary`、`LoopSummary`、`RunSummary` 统一进入 `@loopzhb/protocol`，不在 server 本地定义第二份契约。 | 同意 | ADR-002 要求 wire 类型与运行时校验单源；这些 DTO 还会被 Phase 4 Dashboard client 消费。 |
| `POST /api/loops` 不采用 strict reader；所有管理 object schema 继续剥离未知键。 | 同意，但反向裁决 | 放弃原计划“拒绝未知字段”的偏离。管理面同样遵守 ADR-002；未知字段不产生业务效果，已声明形状也不等于开放后续语义。 |
| 明确 Run 列表的 `ts` 是最近状态转换时间，并测试转换后重排与同 `ts` 的 `id DESC` 决胜。 | 同意 | ADR-003 已固定 `runs.ts` 语义；观察面应展示最近活动而非伪造不存在的创建时间。 |
| 补齐 malformed JSON → 400，并明确 trigger body 对空 body、`{}`、未知键与非 object JSON 的行为。 | 同意 | 继承现有 HTTP 解析与错误边界，消除实现选择分歧；tolerant reader 仍保持向前兼容。 |
| 将评审裁决写入本目标文档。 | 同意 | 延续 Day 5 goal 的评审闭环惯例，让目标文档可独立指导实现。 |
| 精确钉住响应 envelope、逐字段 nullability 与统一错误 JSON。 | 同意 | 防止安全 mapper、server handler 与未来 client 对省略字段或错误形状产生不同解释。 |
| 为 Machine/Loop 列表增加 100 条固定上限，并测试先排序后截断。 | 同意 | roadmap 将数据上限列为每阶段 Definition of Done；Run 列表已有 50 条上限，管理列表应同样有界。 |
