# Day 5 目标：Daemon 最小闭环

## 目标

建立 `@loopzhb/daemon`，让一个已进入 `pending` 的 Exec Run 能完成：

```text
daemon poll → server 原子 claim → Fake Runner → daemon report → Run done/exec
```

这是 Day 5–7「前台 poll 循环 + Fake Runner，端到端打通」批次的 Day 5 切片；不实现真实
Agent，也不改变既有 Run/RunLease 状态机。

## 交付范围

### 1. `packages/daemon` workspace 包

- 新建 `@loopzhb/daemon`，依赖 `@loopzhb/protocol`，不得复制或重定义 wire DTO。
- 提供 `build`、`typecheck`、`test` 与前台 `start` 脚本。
- 最小配置：server URL、Machine Credential、poll interval；缺少必填配置时 fail-fast。
- 前台进程响应 `SIGINT` / `SIGTERM`，可停止下一次 poll 与正在等待的 HTTP 请求。

### 2. Machine HTTP client

- `POST /api/machine/poll`：以 Machine Credential 作为 `Authorization: Bearer`，发送
  `host`、`platform`、`arch`、`version`。
- 用 `pollResponseSchema` 校验成功响应；响应形状非法不得被当作空 Delivery。
- `POST /api/machine/report`：以 Delivery 给出的 opaque Run Credential 作为 Bearer，
  上报 `ReportRequest`，并以 `reportResponseSchema` 校验成功响应。
- 每个请求有明确 timeout；transport 与 fetch 均可注入，避免测试依赖真实网络。

### 3. Runner seam 与 Fake Runner

定义供未来真实 AgentRunner 替换的最小接口：

```ts
type RunnerReport = Omit<ReportRequest, "runId">;

interface AgentRunner {
  run(delivery: Delivery, signal: AbortSignal): Promise<RunnerReport>;
}
```

- Fake Runner 不 spawn 子进程、不读取 `taskFile`、不执行 workflow、不访问 workdir。
- 它对每条 Delivery 产生确定性的成功报告：`ok: true`、`outcome: "exec"`、
  非空 message 与非负整数 `durationMs`。
- Delivery 的 `runToken` 只透传到 report HTTP client；Runner 不解释或校验其格式。
- daemon 编排层无条件写入 `delivery.runId`。Runner 意外抛错时合成不带 `outcome` 的
  `{ ok: false, error: sanitizedSummary }`；错误去除 NUL、截断至 2000 字符且不得包含
  credential。

### 4. 单轮 poll 编排与前台循环

- 抽出可单测的 `pollOnce()`：poll、逐条交给 Runner、将结果 report。
- 前台循环重复调用 `pollOnce()`，直到 AbortSignal 被取消。
- 维护进程内 `inFlight` Run ID 集合，作为防御性去重；不得因此修改 server 的 claim 或
  重新派发语义。
- Day 5 可以先顺序执行 Fake Runner；为 Phase 2 保留 `AgentRunner` seam，不能把真实
  Agent 的子进程、进程组 kill、cwd jail 或 progress heartbeat 混入本批。

### 5. 测试与验收

至少覆盖：

1. poll 的 URL、Bearer、扁平请求体与协议响应解析。
2. report 使用 Delivery 的 Run Credential，并提交 Fake Runner 的报告。
3. malformed poll 成功响应显式 fail-fast；malformed report 成功响应、timeout、网络失败
   保留同一 credential/body 的可重试路径。
4. `401` / `run_capability_invalid` 的 report 视为该 Run Capability 已终结，不再用同一
   credential 无限重试。
5. 集成测试：预置一个 `pending` Exec Run，经 daemon 单轮处理后成为 `done/exec`，且
   RunLease 已消费。

## 配套缺口（纳入 Day 5–7，但不阻塞 Day 5 单轮验收）

当前 server HTTP 仅公开 machine poll/report。Phase 1 roadmap 指定用户从
`POST /loops/:id/run` 手动触发，因此在 Day 6–7 补最薄的 manual-trigger adapter，
并确定 Loop 的最小初始化方式（测试 fixture/seed 或受信网络内的创建入口）。否则只能
证明预置数据的 E2E，无法供用户手动发起一次 Run。

## 明确不做

- 真实 Claude/Codex 子进程、进程组 kill、timeout、env 白名单、工作目录 jail、
  progress heartbeat（Phase 2）。
- sweep/reclaim、取消的迟到 report、server 重启与 daemon 休眠的完整故障注入
  （Day 8–10 的 T4–T6）。
- cron、artifact 同步、workflow、Task File 语义、Dashboard、认证和通知。
- Delivery 响应丢失后的自动重新派发。
- `wait` 长轮询字段；Day 5 固定短轮询且不发送 `wait`。

## 可靠性约束

- 不重新实现或放宽 ADR-001 的 at-most-once execution：poll 已完成 claim 但 Delivery
  响应丢失时，daemon 不得要求 server 再派发该 Run。
- report 若服务端已成功消费 lease 而响应丢失，重试同一报告可得到
  `401 + run_capability_invalid`；该结果是终态确认，不再继续写入。
- 只能使用 `@loopzhb/protocol` 的 schema 与类型。协议中已有但当前阶段未开放的字段
  不得因 daemon 可以解析而提前实现业务语义。
- `pendingReports` 是无持久化、无容量上限的进程内集合；server 长期不可用时它可能增长，
  但不得通过丢弃已 claim 的报告限流。容量/背压留待真实 Agent 阶段设计。

## ADR 结论

Day 5 按本目标实施时不新建 ADR：投递/报告语义已由 ADR-001、wire 契约已由 ADR-002、
RunLease 生命周期已由 ADR-003 覆盖。

只有在本批次决定以下任一跨阶段、难以回滚的策略时，才新建 ADR：本地持久化 report
outbox、Delivery 重派、并发/背压模型、Machine Credential 落盘策略，或崩溃后恢复真实
Agent session。

## 目标review反馈

| 补充内容 | 同意/不同意 | 不同意的理由 |
|---|---|---|
| 补充 poll 侧 401 行为：Machine Credential 被拒时 daemon fail-fast 退出（Phase 1 自注册语义下 credential 无效是配置错误，不是瞬态故障）；启动时用 `isDeviceTokenShape` 做廉价自检，归入"缺少必填配置 fail-fast"。 | 同意 | 合法的新 `dk_` 会在首次 Poll 自注册；401 表示配置的 credential 已无效或不匹配。形状检查仅是启动期廉价输入检查，不能替代服务端认证。 |
| 明确可重试 report 失败的上限与后果：二选一写明——有界重试（N 次指数退避后放弃 + 日志标明"该 run 依赖 Day 8 sweep 回收"），或进程内无限退避直到 daemon 停止。Day 5–7 期间 sweep 未落地，放弃重试会让 run 永远卡在 `running`，这是本批唯一可能"丢 run"的地方，必须显式承认。 | 同意，但改写 | 必须定义重试；采用“每次请求有 timeout，失败后以有上限的退避间隔持续重试，直到成功、401 终态确认或 daemon 停止”。重试不得阻塞 poll 心跳。不要写“唯一可能丢 run”：Delivery 响应丢失或 daemon 在领取后崩溃同样会留下 running Run；ADR-001 已规定由 sweep 最终收敛。 |
| 写明 `inFlight` 去重集合的移除时机：条目在 report 拿到终态（成功或 401 终态确认）后才移除；不能用该集合吞掉"上一轮 report 网络失败、本轮用同一 credential 重报"的合法重试路径。 | 同意，但细化 | 只在 report 成功或 401 终态确认后移除。Runner 完成而 report 尚未确认的 Run 应进入独立的 `pendingReports` 重试集合；不能仅靠 `inFlight` 既表示执行中又表示待报告，否则容易阻塞 poll 或遗漏重报。 |
| 集成测试的"预置"方式写明：测试通过 store/coordinator 层（如 `enqueue`）或 seed fixture 预置 `pending` Run，不经 HTTP（server 尚无触发端点），与"配套缺口"一节呼应。 | 同意 | 这使 Day 5 的单轮集成验收不依赖尚未实现的 manual-trigger HTTP，也与 Day 6–7 的配套缺口一致。 |
| 将 `wait` 长轮询字段加入"明确不做"：Day 5 固定短轮询、不发送 `wait`，避免实施者犹豫。 | 同意 | 当前 server 对 `wait` 仅解析、不提供长轮询语义；Day 5 固定短轮询，后续启用长轮询时再单独设计与测试。 |
| Fake Runner 产出的 `ReportRequest` 带上 `runId` echo（对日志对账有用）；daemon 侧 report 时用 `delivery.runId` 兜底，不依赖 Runner 自觉。 | 同意，但改写 | 不应让 Runner 决定 `runId`。将 Runner 返回类型收窄为 `Omit<ReportRequest, "runId">`，由 daemon 编排层无条件写入 `delivery.runId`；这比“Runner 自觉、daemon 兜底”更能保证日志与对账正确。 |
| 注明 `reconciled` 字段的读者义务：daemon 对 report 响应只做 schema 校验、不解释 `reconciled`（Day 5 正常路径不会遇到，防止 Day 8–10 T5 时误读其语义）。 | 同意 | Day 5 对响应做 schema 校验即可；`reconciled` 的行为验证留给 Day 8–10 的 T5。 |
| 明确验收边界：SIGINT 测试只覆盖"停止下一次 poll + 中断在途 HTTP"，不为"abort 正在执行的 Fake Runner"写专门测试（`AgentRunner` 的 `signal` 参数在 Fake 阶段无真实消费者，seam 留给 Phase 2）。 | 同意，但补一项 | 无须测试 Fake Runner 的真实取消行为；但应测试 daemon 将 AbortSignal 传给 Runner，以验证 Phase 2 所需的关停 seam 已接通。 |
