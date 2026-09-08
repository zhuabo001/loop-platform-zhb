# Codex Handoff：Day 6–7 手动触发与 JSON 观察面开发计划

> 日期：2026-08-07
> 分支：`feat/day6-7-manual-trigger`
> 基线：`365cd22`（Day 5 daemon + Fake Runner 已合入）
> 关联：`docs/roadmap.md` Phase 1 Day 5–7、`docs/goal/day5-daemon-fake-runner.md`、ADR-001 / ADR-002 / ADR-003。

## Summary

Day 6–7 完成可操作的 Phase 1 闭环：

1. daemon 首次 poll 注册 Machine。
2. 用户查询 Machine ID。
3. 创建 Loop。
4. 手动触发 Run。
5. daemon + Fake Runner 执行并回报。
6. 用户通过 JSON API 查看 `done/exec` 和最终消息。

采用无认证的本地管理接口，仅允许 localhost/受信网络；创建与触发分离，不实现 cron、真实 Agent、取消、sweep 或 Dashboard。

## Public APIs

新增以下本地管理路由：

本批新增的管理请求、响应 DTO 与 Zod schema 统一放入 `@loopzhb/protocol`，由类型和
运行时校验共同定义 wire 契约；server 只负责安全 view mapping。所有 object schema
继续遵守 ADR-002 tolerant-reader 纪律：校验已声明字段的类型和值域，但剥离未知键，
不得使用 strict object。时间戳均为 ISO string；响应字段及 nullability 不从数据库行
直接推断，而由以下 wire DTO 固定。

精确响应外形如下：

- `GET /api/machines`：`{machines: MachineSummary[]}`。`MachineSummary` 的
  `id/name/createdAt` 为 string；`hostname/platform/arch/daemonVersion/lastSeen` 为
  `string | null`。
- `LoopSummary` 固定包含
  `id/machineId/agent/createdAt/updatedAt: string`、`allowControl/enabled: boolean`、
  `name/workdir/taskFile: string | null`、`lastRun: RunSummary | null`。
- `RunSummary` 固定包含
  `id/loopId/machineId/phase/role/ts`；`outcome/status/message/error` 为对应值或 `null`，
  `durationMs` 为非负整数或 `null`，`progress` 为
  `{step: nonnegative integer, label: string, at: string | null} | null`。响应不得省略这些
  固定字段。
- 创建成功返回 `201 {loop: LoopSummary}`，其中 `lastRun` 固定为 `null`。
- 入队成功返回 `202 {enqueued:true,runId,supersededRunIds}`；running no-op 返回
  `200 {enqueued:false,reason:"running_exists"}`。
- Loop 与 Run 列表分别返回 `{loops: LoopSummary[]}` 与 `{runs: RunSummary[]}`。
- 错误统一复用 `apiErrorSchema`。本批精确产生：400 `{error:"invalid request"}`、
  404 `{error:"not found"}`、413 `{error:"request body too large"}`、500
  `{error:"internal server error"}`，均不新增 `code`。

上述摘要不返回 `tokenHash`、roots、credential、workflow、model、state、task-file content、
session、usage、artifact 或 transcript 等敏感、大体积或尚未开放的字段。

### `GET /api/machines`

- 返回安全的 Machine 摘要，不暴露 `tokenHash`、credential 或 roots。
- 按 `name ASC, id ASC` 排序后固定最多返回 100 条；Phase 1 暂不开放分页参数。

### `POST /api/loops`

- JSON object body：`machineId` 必填；`name`、`workdir`、`taskFile` 可选；malformed JSON
  或非 object JSON 返回 400。
- `machineId` 必须匹配 `m-<16位小写十六进制>` 且已由 poll 注册。
- `name` 最大 255 字符；路径最大 4096 字符；已声明字段拒绝 NUL 和空字符串。
- 未知字段按 tolerant-reader 规则剥离且不得写入；`workflow/model/agent/state/enabled`
  等字段即使由调用方提交也不产生业务效果，不代表本批开放其语义。
- 固定使用现有默认值：`agent=claude-code`、`allowControl=true`、`enabled=true`。
- 成功返回 `201 { loop: LoopSummary }`；Machine 不存在返回 `404 {error:"not found"}`。
- 只创建，不自动触发；Day 6–7 不承诺 create 请求幂等，但重试不会执行 Run。

### `POST /api/loops/:id/run`

- 当前无业务参数，调用现有 `coordinator.enqueueExecRun()`。
- 空 body 与 `{}` 均合法；空 body 在解析边界归一化为 `{}`。合法 JSON object 的未知字段
  按 tolerant-reader 规则剥离；malformed JSON 或非 object JSON 返回 400。
- 入队成功返回 `202 {enqueued:true,runId,supersededRunIds}`。
- 已有 running Run 返回 `200 {enqueued:false,reason:"running_exists"}`。
- Loop 不存在返回 `404 {error:"not found"}`。
- 重复触发未领取的 pending Run 继续继承 T7：旧 Run 转 `canceled/skipped`，只保留一个新 pending Run。

### `GET /api/loops`

- 返回 `{loops: LoopSummary[]}`，按 `updatedAt DESC, id ASC` 排序后固定最多返回 100 条；
  Phase 1 暂不开放分页参数。
- 每个 Loop 带最新一条 exec Run 的 `lastRun`，无 Run 时为 `null`。

### `GET /api/loops/:id/runs`

- 返回 `{runs: RunSummary[]}`。
- 固定最多 50 条，按 `ts DESC, id DESC`；`ts` 明确定义为“最近状态转换时间”而非创建
  时间，因此 Run 会在 claim/finalize/reclaim/supersede 后随新时间戳重排；暂不开放分页参数。
- Loop 不存在返回 404。

## Implementation

### Day 6：创建与触发

- 先新增目标文档，记录本计划、无认证部署边界、精确 HTTP 契约，以及本轮评审对 DTO
  归属、tolerant reader、`ts` 排序和请求体语义的裁决；同步把 roadmap 路径统一为
  `/api/loops/:id/run`。
- 在 protocol 新增管理 API 的请求、响应、摘要 schema 和推导类型，并纳入现有
  tolerant-reader 穷尽测试；不得复制到 server 本地重新定义。
- 新建本地 Loop 管理深模块，注入 DB、Clock 和 `newLoopId`；生产 ID 使用 `loop-${randomUUID()}`，测试使用确定性 factory。
- 管理模块负责 Machine 查询、Loop 创建和存在性校验；所有时间戳使用注入 Clock。
- HTTP app 改为同时注入现有三方法 RunCoordinator 与本地管理模块；不得扩展 Coordinator 的 `enqueueExecRun/poll/report` 接口。
- 所有新 route 继续复用 2 MiB body cap、统一 JSON error 和全局 500 脱敏。
- 更新非 loopback 启动警告，明确 `/api/loops*` 同样无认证。
- 不修改数据库 schema、migration、machine claim/report wire 或 Coordinator 三方法接口。

### Day 7：观察面与完整 E2E

- 增加 Machine、Loop、Run 的安全 view mapper 和确定性查询排序。
- 实现三个 GET 观察接口及最新 exec Run 聚合。
- 将现有预置数据 E2E 升级为真实 HTTP 用户链路：
  - daemon poll 注册 Machine；
  - `GET /api/machines` 获取 machineId；
  - `POST /api/loops` 创建 Loop；
  - `POST /api/loops/:id/run` 入队；
  - daemon `pollOnce()` 完成 Fake Runner/report；
  - GET Loop/Run API 看到 `done/exec` 与 `"fake runner completed"`。
- 补完成态 handoff，记录接口、测试基线、剩余 Day 8–10 工作和安全限制。

## Test Plan

- Protocol：新增的每个管理 object schema 均被 tolerant-reader 穷尽测试覆盖，未知字段
  被剥离；请求与所有成功响应均通过对应 schema 验证。
- 创建校验：未知 Machine、畸形 machineId、空值、NUL、超长字段、malformed JSON、
  非 object JSON、超大 body 均零写入并返回正确状态；未知字段被剥离，且不改变默认值或
  写入尚未开放的配置。
- 创建成功：ID/Clock 可注入，默认字段正确，创建不产生 Run。
- Trigger：
  - 正常返回 202 和 pending Run。
  - 空 body 与 `{}` 均可触发；带未知字段的 object 行为不变；malformed/非 object JSON
    返回 400 且零写入。
  - pending 重复触发执行原子 supersede。
  - running 时返回 200 no-op 且零写入。
  - 不存在的 Loop 返回 404。
- 观察面：
  - 不泄漏 token hash、credential 和大字段。
  - Machine/Loop/Run 排序稳定；逐字段断言响应 nullability，不允许 mapper 以 `undefined`
    省略固定字段。
  - Machine/Loop 列表最多 100 条、Run 列表最多 50 条，均测试上限边界和“先排序、后截断”。
  - Run 发生状态转换后按新 `ts` 重排；同一 `ts` 按 `id DESC` 决胜。
  - `lastRun` 只取最新 exec Run。
- E2E：完整 HTTP 创建—触发—daemon 执行—JSON 查询闭环；断言 Run 为 `done/exec`、lease 已删除、第二次 daemon poll 不重执行。
- 保留 Coordinator 三方法结构钉和现有 T1–T7 回归测试。
- 最终运行：
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `pnpm -r build`
  - `pnpm --filter @loopzhb/server db:check`
  - `git diff --check`

## Assumptions

- 管理 API 无认证，不接收 Machine/Run Credential；安全边界依赖 localhost/受信网络。
- 创建 Loop 不自动执行，必须显式调用 Run Now。
- `enabled` 暂不限制手动触发；暂停/关闭语义留到 Phase 4。
- Day 8–10 继续负责 sweep、T4–T6 完整故障注入和 Phase 1 最终收尾。
