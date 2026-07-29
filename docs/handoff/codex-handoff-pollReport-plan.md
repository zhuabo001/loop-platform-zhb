# Day 3–4：Poll / Report 心脏链路开发计划

## 总结

在现有 protocol DTO、PGlite 四表 schema 和 79 个绿色测试之上，引入 Hono，交付可测试、可启动的机器调度服务：

- 正式端点为 `POST /api/machine/poll`、`POST /api/machine/report`。
- 先完成 T1–T3，再实现 store、gateway 和 HTTP adapter。
- 同批交付 T7 的 coordinator 骨架，以及 cancel、terminal-grace 所需的事务原语；暂不提供 cancel/sweep HTTP 端点。
- 不修改数据库 schema，不生成新 migration。

## 核心实现

### 1. 深模块与事务

建立 `MachineGateway` 深模块，外部接口仅包含 `poll`、`report` 和供后续手动触发复用的 `enqueueExecRun`；注入 DB、Clock 和 token/id factory，测试使用真实内存 PGlite。

store 内部统一承担以下原子操作：

- `enqueueExecRun`：同一事务内把该 Loop 的旧 pending Run 转为 `canceled/skipped`，再插入唯一的新 pending `exec` Run，作为 T7 coordinator 骨架。
- claim：条件更新 `pending → running`，并插入 SHA-256 RunLease；两步同一事务，lease 插入失败必须回滚 Run。
- report：事务内重新解析 lease、锁定同一 Run 行，再检查 phase；Run finalize 与 lease 删除同一事务。
- cancel 原语：锁定 Run，更新为 `canceled` 并删除 lease；不暴露 HTTP 路由。
- terminalize 原语：仅允许 `active → terminal-grace`，必须写入 `now + 24h` 的过期时间；重复调用不得延长首次窗口。
- 过期 terminal-grace lease 在 resolve 时惰性删除；retire 为单发删除。

### 2. Poll 与 Delivery

- Bearer token 必须符合 `dk_` 形状；首次合法 poll 在未启用 auth 的 Phase 1 模式下自注册 Machine，后续同时校验派生 machine ID 和完整 token hash。
- 更新 `lastSeen`、host/platform/arch/version；`progress` 和 `wait` 当前只解析、不产生 Phase 2 行为。
- 只 claim `exec` Run；每个成功 claim 同时获得新的 `rk_` token，数据库只保存 hash。
- Delivery 固定包含协议要求的完整字段：machine roots、Loop 快照、`prevState`、空 `systemPrompt` 和仅面向 exec 的最小任务说明。
- RunLease 的 `allowControl`、`canSet*`、`canFinish` 全部保持关闭；预声明字段不等于能力已开放。
- 同一 Machine 的一次 poll 可以领取多个 pending Run；并发 poll 对每个 Run 只能产生一个 Delivery。

### 3. Report 状态机

- Report 将 Bearer token 视为 opaque Run Credential，直接计算 SHA-256 并 resolve
  RunLease；读取侧不得用 `isRunTokenShape` 预先拒绝 legacy bare UUID。当前 server
  新 mint 的 credential 仍必须符合 `rk_` 形状。请求体 `runId` 仅作回声，lease 中的
  Run 为唯一权威。
- 正常 running Run：
  - `ok=true` 写为 `done/exec`；
  - `ok=false` 写为 `error/error`，缺失错误时使用稳定的通用原因；
  - 保存 message/finalText fallback、durationMs、sessionId，清除 progress，重打 `runs.ts`；
  - finalize 与 lease retire 同事务。
- terminal-grace + error Run：允许恰好一次 reconcile，返回 `{ok:true,reconciled:true}`，然后删除 lease。
- canceled Run 或 report/cancel 竞态中失去 phase guard：按 Run Capability 已失效处理，
  返回 401，禁止任何 Loop 级写入。
- Phase 1 不实现 `done + active lease` enrich。该组合当前没有合法来源；若出现则按
  stale capability fail closed，在同一事务中删除残留 lease、记录内部
  `stale_phase` 原因，不修改 Run/Loop，并返回 401。等 Phase 4 的 finish 动词落地时
  再增加合法的一次性 enrich 转换。
- lease 存在但 Run 不存在时按 orphaned capability fail closed：删除孤儿 lease、
  记录 invariant violation、不产生 Loop 写入，并返回 401。
- cursor、taskFileContent、artifacts、transcript、cost、attempts 和非 exec outcome 当前只通过 schema 解析，不写入 DB、不触发后续阶段语义。
- Run Capability 因 unknown、expiry、正常 report 消费、cancel 撤销、竞态失败、
  orphaned Run 或 stale phase 而失效时，外部统一返回
  `{error:"invalid or expired run capability",code:"run_capability_invalid"}` 及 401；
  具体原因只进入服务端日志。成功 report 后，同 credential 的任何重复 report
  因此返回 401，Run、Loop 与全部副作用保持不变。
- 有效 capability 但缺少权限的未来动词使用 403；有效 capability 与当前生命周期
  冲突的操作使用 409。`terminal-grace + error + report` 是 ADR 明确允许的一次性
  reconcile，不属于 capability invalidation。

## HTTP 与启动接口

- 新增 `hono`、`@hono/node-server` 并更新 lockfile；提供可注入的 `createServerApp`，HTTP route 只负责认证头、JSON/schema 解析、调用 gateway 和返回响应。
- 两个端点统一使用 2 MiB wire body cap：
  - 非法 JSON 或 DTO：400；
  - 无效、过期、已消费或已撤销的 Run Capability：401，并使用稳定的
    `run_capability_invalid` code；
  - 超限：413；
  - 未知路由：404；
  - 未捕获异常：500，响应不泄露堆栈。
- server 包公开 `@loopzhb/server/http` 的 app factory；Node 启动入口通过 `@hono/node-server` 监听。
- 启动配置固定为：
  - `LOOPZHB_HOST` 默认 `127.0.0.1`；
  - `LOOPZHB_PORT` 默认 `3000`；
  - `LOOPZHB_DATA_DIR` 为启动进程必填，避免误用内存库导致重启丢状态。
- 增加 server `start` 脚本；测试全部通过 Hono `app.fetch`/`app.request`，不启动真实端口。
- 更新 server package 描述和 handoff，记录 `/api` 前缀及实际完成范围。

## 测试与验收

- T1：同一 pending Run 的并发 poll 中，恰好一个响应含 Delivery；最终只有一个 running Run 和一条 active lease。
- T2：领取后的重复 poll 返回空 deliveries，不生成新 Run、lease 或 token。
- T3：首次 report 返回 200 并落库；第二次返回 401；前后 Run/Loop 快照证明无重复副作用。
- T7：连续 enqueue 时旧 pending 变为 `canceled/skipped`，新 pending 为 `exec`；running Run 不被 supersede。
- report/cancel 交错：使用应用层 gate/deferred promise 让 report 完成初始 resolve
  后暂停，随后让 cancel 的 PGlite 事务真实 commit，再恢复 report 执行事务内二次
  验证；断言 report 返回统一 401、Run 保持 canceled、lease 不存在且 Loop 零写入。
  该测试只验证应用层编排、真实事务提交和写前 guard，不宣称覆盖数据库锁竞争或
  隔离级别。
- 事务守卫：
  - lease INSERT 故意失败时 claim 整体回滚；
  - terminalize 必带 expiry 且不能延长；
  - cancel 后不存在 active lease；
  - report 在事务内发现 canceled/phase 已变化时不写任何终态或 Loop 数据。
- 协议与安全：
  - malformed/mismatched device token、unknown/expired/retired Run Credential、
    JSON、schema 和超大 body；
  - mint 测试单独验证新 Run Credential 符合 `rk_`；Report 读取侧测试 legacy bare
    UUID 只要对应 lease 存在仍可完成；
  - body.runId 伪造不能越过 lease；
  - 未启用字段不会修改 Loop/Run；
  - Delivery 与 report 响应分别通过 protocol schema 校验。
- 完成验证：
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `pnpm -r build`
  - `pnpm --filter @loopzhb/server db:check`
  - `git status --short`

## 假设

- 当前 62 个 protocol 测试和 17 个 server 测试继续作为回归基线。
- PGlite 用于本阶段验证应用层交错编排和真实事务提交；真实 PostgreSQL 的多物理连接、
  行锁竞争、隔离级别、死锁与重试验证仍属于 Phase 6。
- Day 3–4 不包含手动 trigger HTTP、sweep、cancel HTTP、daemon、真实 Agent、cron、通知或 Dashboard。
- 未完成认证前，启动入口默认仅绑定 localhost，不作为公网部署形态。
