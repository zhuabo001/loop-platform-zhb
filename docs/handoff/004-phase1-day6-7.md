# Handoff：Phase 1（Day 6–7 完成态）——手动触发与 JSON 观察面

> 更新日期：2026-08-08 ｜ 分支 `feat/day6-7-manual-trigger`（基于含 PR #7 的 main，待合入）
> 用途：让任何新会话/新人在 5 分钟内接上当前进度。路线图全貌见 `docs/roadmap.md`；
> 上一阶段见 `docs/handoff/003-phase1-day3-4.md` 与 Day 5 相关 handoff。
>
> 本批次的验收契约是 `docs/goal/day6-7-manual-trigger-json-observation.md`，
> 开发计划是 `codex-handoff-day67-work-plan.md`（已经一轮评审修订，评审与裁决见
> `kimi-handoff-day67-plan-review.md`，裁决回填于目标文档「目标review反馈」表）。
> 实现按 step 逐提交交付；测试基线更新为 **305 全绿（85 protocol + 43 daemon + 177 server）**。

---

## 一句话现状

Phase 1 的用户可操作闭环已打通：daemon 首次 poll 自注册 Machine 后，用户可经
无认证本地管理面完成「查 Machine → 建 Loop → 手动触发 → daemon + Fake Runner
执行回报 → JSON 观察终态」全链路，全程无需测试 fixture。
**下一步是 Day 8–10：sweep/reclaim 与 T4–T6 完整故障注入。**

## 最终 API 契约（本批交付）

全部路由无认证（localhost/受信网络边界）；DTO 单源在
`packages/protocol/src/admin.ts`；错误统一 `apiErrorSchema`，本批只产生
400/404/413/500，无新增 `code`。

| 路由 | 成功 | 错误 |
|---|---|---|
| `GET /api/machines` | `200 {machines: MachineSummary[]}`（`name ASC, id ASC`，≤100） | — |
| `POST /api/loops` | `201 {loop: LoopSummary}`（`lastRun=null`） | 400 畸形/非 object/值域越界/超长；404 未注册 Machine；413 超 2 MiB |
| `POST /api/loops/:id/run` | `202 {enqueued:true,runId,supersededRunIds}`；running 时 `200 {enqueued:false,reason:"running_exists"}` | 400 malformed/非 object；404 未知 Loop |
| `GET /api/loops` | `200 {loops: LoopSummary[]}`（`updatedAt DESC, id ASC`，≤100；`lastRun` 为最新 exec Run） | — |
| `GET /api/loops/:id/runs` | `200 {runs: RunSummary[]}`（`ts DESC, id DESC`，≤50） | 404 未知 Loop |

要点：

- trigger 空 body 在 HTTP 边界归一化为 `{}`；所有 object body tolerant-reader
  剥离未知键；`workflow/model/agent/state/enabled` 等未开放字段提交后无任何效果。
- 创建与触发分离：create 永不产生 Run；HTTP 重试 create 不产生隐式 Run。
- 重复触发继承 T7：单事务 supersede 全部旧 pending exec + 插入恰好一个新 pending。
- `runs.ts` 是最近转换时间：Run 列表会随 claim/finalize/supersede 重排（有测试钉住）。

## 已完成清单（六步，每步一提交）

1. **文档基线**（`ffb50f1`/`fb84dd5`/`4e2d8a7`/`da12727`）：修订版开发计划、
   Day 6–7 目标（验收）文档、roadmap 触发路径统一 `/api` 前缀、计划评审（5 项裁决）。
2. **Step 1 — protocol 管理 DTO**（`09b98f7`）：`src/admin.ts` 十个 object schema
   （三份 Summary + 创建请求 + 五个响应 envelope），全部 tolerant-reader；穷尽测试
   扩至 21 行。
3. **Step 2 — 管理深模块**（`a4b8ff7`）：`src/admin/`（注入 db/clock/newLoopId），
   Loop 创建（caps→Machine 存在性→单 INSERT，任何失败零写入）、安全 view mapper
   （显式挑字段，禁止展开后删字段）。
4. **Step 3 — 创建与触发路由**（`2763cbe`）：`createServerApp(coordinator, admin)`
   双注入；trigger 空 body 归一化；`triggerRunRequestSchema` 补入 protocol（穷尽测试
   22 行）；启动警告覆盖 `/api/machines`、`/api/loops*`。
5. **Step 4 — JSON 观察面**（`36d6fce`）：三个 GET 路由 + 列表查询（确定性排序、
   先排序后截断、100/100/50 上限、exec-only lastRun、同 ts 按 id DESC 决胜、
   progress.at 归一化为显式 null）。
6. **Step 5 — 完整链路 E2E**（`0bb2dc7`）：预置数据 E2E 升级为真实 HTTP 用户链路
   （poll 注册 → GET machines → POST loops → POST run → pollOnce → GET 观察
   done/exec + "fake runner completed"），lease 已消费、二次 poll 不重执行、
   所有成功响应过 protocol schema。

## 实现相对计划的偏差（如实记录）

1. **校验分层**：machineId 格式/非空/无 NUL 在 protocol schema（ADR-002 决策 4 的
   基础值域例外）；长度上限（name 255、path 4096）在 server 管理模块
   （`LoopValidationError` → 路由映射 400）——决策 4「caps 是 server 侧策略」的
   应用。目标文档未逐字指定层级，两处都有注释记录此裁决。
2. **`triggerRunRequestSchema` 为新增**：目标文档只说「无业务参数」；为实现
   tolerant-reader 剥离与统一 400 边界，protocol 补了空 object schema。
3. **`createServerApp` 签名变更**：`(coordinator)` → `(coordinator, admin)`；
   `BootedServer` 形状不变（admin 在 `bootstrapServer` 内接线，不外露）。
4. **lastRun 聚合**：页面内 loops 的一次有序查询 + 内存取每 loop 首行（既非逐 loop
   N+1，也未引入 `DISTINCT ON` 原生 SQL）。
5. **旧 E2E 被替代而非并存**：预置数据 E2E 的全部断言（done/exec、lease 消费、
   不重执行）已由完整链路 E2E 覆盖。
6. **管理模块多了 `loopExists` 辅助**：仅供 `listRuns` 的 404 判定复用。

## 右移项（本批明确不做，见目标文档「明确不做」）

- create 不承诺幂等（重试安全、不产生 Run，但会建重复 Loop）。
- 分页/筛选/搜索未开放（固定上限 100/100/50）。
- Loop 更新/删除、暂停/关闭（`enabled` 不限制手动触发，Phase 4）。
- sweep/reclaim、owner cancel、T4–T6 故障注入（Day 8–10）。

## 安全限制（必须随交接传达）

- 管理面与 machine 面均无认证：**Phase 5 认证上线前 server 只允许
  localhost/受信网络，不得公开暴露**；非 loopback 启动警告已覆盖全部端点。
- 无认证管理面意味着任何可达客户端可建 Loop 并触发 Run（Fake Runner 阶段无真实
  副作用；真实 Agent 之前必须完成认证或保持网络隔离）。

## 完成验证（分支 HEAD）

- `pnpm -r typecheck` ✅（server 脚本自带 protocol/daemon 构建前置）
- `pnpm -r test` ✅ **305 全绿**（85 protocol + 43 daemon + 177 server）
- `pnpm -r build` ✅
- `pnpm --filter @loopzhb/server db:check` ✅（No schema changes——ADR-003 未动）
- `git diff --check` ✅

## 下一步：Day 8–10（故障注入与 Phase 1 收尾）

1. sweep/reclaim：server 不活跃清扫 adapter（消费 `reclaimStaleRunTx` store 原语），
   terminal-grace 24h 宽限；`machines.lastSeen` 消费侧必须经
   `classifyHeartbeatWatermark`/`heartbeatAgeMs`（ADR-003 的 2026-07-30 裁决）。
2. T4–T6 完整故障注入：server 重启不丢在途 run、daemon 休眠迟到 report 翻正误判、
   owner cancel 拦截迟到 report。
3. Phase 1 完成标准收口：ADR-001 心脏测试 T1–T6 全绿确认 + 观察面已交付（本批）。
