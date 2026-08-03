# Day 5 开发计划：Daemon + Fake Runner 最小闭环

> 关联：`docs/goal/day5-daemon-fake-runner.md`、`docs/roadmap.md` Phase 1 Day 5–7、
> ADR-001 / ADR-002 / ADR-003。
>
> 目标：新增 `@loopzhb/daemon`，通过短轮询领取 pending Exec Run，交给 Fake Runner
> 产生确定性结果，再使用 Delivery 中的 Run Credential 完成 report。正常路径必须实现
> `pending → running → done/exec` 与 lease 消费；report 的瞬态失败进入进程内重试，
> 不阻塞后续 poll。

本批不实现 manual-trigger HTTP、真实 Agent、长轮询、持久化 report outbox、sweep 或新 ADR。

## 1. Daemon 包与启动配置

- 新建 `packages/daemon`，提供 `build`、`typecheck`、`test`、`start`；生产依赖仅包含
  `@loopzhb/protocol`，HTTP 使用 Node 22 原生 `fetch`。
- 配置环境变量：
  - `LOOPZHB_SERVER_URL`：必填，只接受无账号、query、fragment 的绝对 `http/https`
    URL，统一移除末尾 `/`。
  - `LOOPZHB_MACHINE_CREDENTIAL`：必填，启动时用 `isDeviceTokenShape` 做廉价检查。
  - `LOOPZHB_POLL_MS`：可选，默认 `3000`，严格整数范围 `250–60000`。
- 启动时生成固定 Machine identity：`os.hostname()`、`process.platform`、`process.arch`
  和 `src/version.ts` 中与 daemon package version 镜像的版本常量；测试读取 package.json
  并断言二者相等，避免 runtime package.json import 与 build-time 生成。
- composition root 注册 `SIGINT/SIGTERM`，用一个 AbortController 关闭 poll sleep、在途
  HTTP 和 report 重试；core 不直接调用 `process.exit`，启动失败或 poll 401 由 `main`
  以非零状态结束。
- 日志只记录 URL、状态码、runId 和错误分类，禁止输出 Machine/Run Credential。

## 2. HTTP transport 与错误分类

- 建立可注入 `fetch` 的 Machine client：
  - `poll()` 请求 `/api/machine/poll`，Bearer 使用 Machine Credential；body 只发送
    identity，不发送 `wait`。
  - `report()` 请求 `/api/machine/report`，Bearer 原样使用 Delivery 的 opaque Run
    Credential。
  - 两类请求统一使用 10 秒 timeout，并与 daemon AbortSignal 组合。
- 所有 2xx 响应分别用 `pollResponseSchema`、`reportResponseSchema` 校验；poll 的 malformed
  2xx 是协议错误，daemon fail-fast，不能降级为空 Delivery。report 的 malformed 2xx 保留
  原 credential 与不可变 body 进入重试：服务端可能已消费 lease，重报可得到 coded 401
  终态确认。
- poll 分类：
  - 401：Machine Credential 配置错误，fail-fast。
  - 408、429、5xx、timeout、网络异常：记录后等待下一轮 poll。
  - 其他 4xx 或 malformed 响应：协议/配置错误，fail-fast。
- report 分类：
  - 合法 2xx：终态确认；`reconciled` 只解析，不产生 Day 5 行为。
  - malformed 2xx：进入重试，不能当作成功或直接丢弃该报告。
  - `401` 且响应符合 `apiErrorSchema`、`code === "run_capability_invalid"`：终态确认。
  - 408、429、5xx、timeout、网络异常：保留相同 credential 和完全相同 body，进入重试。
  - 其他 4xx 或无法解析的 401：协议错误，停止 daemon，避免继续领取更多无法回报的 Run。

## 3. Runner seam 与运行状态

对外类型固定为：

```ts
type RunnerReport = Omit<ReportRequest, "runId">;

interface AgentRunner {
  run(delivery: Delivery, signal: AbortSignal): Promise<RunnerReport>;
}
```

- Fake Runner 不访问文件系统、不 spawn、不解释 task/workflow/workdir/runToken，返回：
  `ok: true`、`outcome: "exec"`、`message: "fake runner completed"`、`durationMs: 0`。
- daemon 编排层无条件以 `delivery.runId` 构造最终 `ReportRequest`；Runner 无权提供或
  覆盖 runId。
- Runner 意外抛错时，编排层生成 `{ ok: false, error: sanitizedSummary }` 的失败报告并正常
  走 report，而不是让 Run 静默停留在 running；`sanitizedSummary` 去除 NUL、截断至 2000
  字符且不含 credential，报告不带 `outcome`。Fake Runner 的 `outcome: "exec"` 仅为 wire
  兼容，最终 `done/exec` 由 server 的 Phase 1 写入规则决定。
- 状态分为：
  - `inFlight`：Runner 尚未完成的 runId。
  - `pendingReports`：Runner 已完成、报告尚未获得终态确认，保存 runId、opaque
    credential、不可变 body、attempt 和下一次重试时间。
  - 去重判断使用两个集合的并集；重复 Delivery 不重复执行 Runner。
- `pendingReports` 在 server 长期不可用时可能无上限增长。Day 5 明确接受该进程内风险，
  不得通过丢弃已 claim 的报告限流；容量与背压留待真实 Agent 阶段设计。
- `pollOnce()` 顺序处理本次 Deliveries：登记 `inFlight`、调用 Runner、转入
  `pendingReports`、立即尝试一次 report。正常确认后删除；瞬态失败保留并启动后台重试。
- 后台 report 重试与 poll 循环并行：退避为 `1s → 2s → 4s → … → 30s`，之后保持 30 秒，
  直到确认、协议致命错误或 daemon 停止；不设置总尝试次数，不持久化。
- 前台 poll 固定短轮询，每轮结束后等待 `LOOPZHB_POLL_MS`；不发送 `wait`，不实现长轮询。
- shutdown 不承诺持久化或 drain 未确认报告；进程退出后遗失的执行结果由 ADR-001 规定的
  后续 sweep 收敛。

## 4. 包接口与集成方式

- `@loopzhb/daemon` 主入口导出 `AgentRunner`、`RunnerReport`、Fake Runner、配置解析器和
  可注入依赖的 daemon runtime factory；CLI 启动文件保持独立 composition root。
- server 生产 exports 继续只保留 `./db`、`./db/schema`，不为测试开放 coordinator 或 HTTP
  内部模块。
- daemon package exports 采用 server 同型的 `types` + `import` 条件，均指向 `dist`。
- 跨包 E2E 放在 server 测试侧：server 增加 daemon devDependency，server 的 `typecheck` 与
  `test` 脚本均先执行 `pnpm --filter @loopzhb/daemon build`，再运行自身检查；通过现有
  `bootstrapServer()` 获取 Hono app，并把 `app.request` 适配成注入 fetch，不监听真实 TCP
  端口。
- E2E 通过 coordinator `enqueueExecRun` 或现有 seed fixture 创建 pending Run，不经过尚未
  实现的 `POST /loops/:id/run`。

## 5. 测试计划

- 配置：缺失/空白 URL 或 credential、畸形 credential、非法 URL、非法 poll interval 均
  fail-fast；合法值规范化正确。
- Transport：
  - poll/report URL、Bearer 和 JSON body 精确匹配。
  - poll 不包含 `wait`。
  - poll 的 malformed 2xx fail-fast；report 的 malformed 2xx 重试；401、其他 4xx、5xx、
    timeout、AbortSignal 分类正确。
  - credential 从不出现在日志或异常消息。
- Runner/runtime：
  - Fake Runner 输出确定且无文件/进程副作用。
  - daemon 无条件写入 Delivery runId。
  - 同一 runId 在 `inFlight` 或 `pendingReports` 时不会再次执行。
  - report 瞬态失败后 poll 仍继续，重试使用相同 token/body，并按 1–30 秒退避。
  - 首次 report 已提交但响应丢失，下一次得到 coded 401 后清除 `pendingReports`。
  - Runner 抛错会产生无 `outcome` 的 `ok:false` report，其 error 已清理、截断且不泄漏
    credential。
  - AbortSignal 确实传入 Runner；SIGINT/SIGTERM 停止 sleep 和在途 HTTP，不要求 Fake
    Runner 实现真实取消。
- 集成验收：内存 PGlite 中预置 Loop 并 enqueue pending Exec Run，运行 daemon 单轮后断言
  Run 为 `done/exec`、message 为 Fake Runner 文案、progress 清空、RunLease 不存在；第二次
  poll 不再次执行该 Run。
- 最终验证：`pnpm -r typecheck`、`pnpm -r test`、`pnpm -r build`、
  `pnpm --filter @loopzhb/server db:check` 全绿，且无 schema/migration diff。

## 6. 范围与默认决策

- Day 5 不新增 ADR；进程内 `pendingReports` 不是持久化 outbox。
- server URL 与 Machine Credential 不落盘，不实现 CLI flag 优先级或凭证轮换。
- 不限制本次 poll 返回的 Delivery 数量；`pendingReports` 也不设容量上限。Fake Runner 顺序
  执行，不提前决定 Phase 2 的真实 Agent 并发/背压模型。
- manual trigger、Loop 创建和只读观察面继续属于 Day 6–10 后续工作，不阻塞本次预置数据
  E2E。
