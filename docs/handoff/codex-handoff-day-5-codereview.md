# Codex 评审：Day 5 daemon + Fake Runner 实现

> 评审对象：`0624250 feat(daemon): Day 5 daemon + Fake Runner 最小闭环`
>
> 固定基线：`b0c8ea7`（`feat/day3-4-poll-report` 尖端）
>
> 评审范围：`git diff b0c8ea7...0624250`
>
> 规格来源：`docs/goal/day5-daemon-fake-runner.md`、
> `docs/handoff/codex-handoff-day5-plan.md`、
> `docs/handoff/kimi-handoff-review-day-5-plan.md`

## 总体结论

Day 5 的正常主链路已经打通：daemon 能 poll 并 claim pending Exec Run，交给 Fake Runner，
再使用 Delivery 的 Run Credential report，E2E 验证最终进入 `done/exec` 且 lease 被消费。
此前计划评审的 6 项裁决也全部落地。

本轮评审发现的 2 个可靠性问题已经完成修复：

1. `pollOnce()` 使用批级 `seenRunIds`，同一响应中的重复 `runId` 只执行一次；没有引入跨 poll
   tombstone 或新的容量策略。
2. runtime 在报告入队时生成一次 `SerializedReportRequest` wire 快照，所有重试复用同一 JSON
   字符串，Runner 后续修改嵌套引用不会改变 HTTP body。

CR-03 的关停验收覆盖与 CR-04～CR-07 的代码质量项也已全部收口。因此本轮最终结论为：
**Day 5 完整验收通过。**

## 前次裁决项完成状态

### 必须澄清/补写项

| 补充内容 | 同意/不同意 | 不同意的理由 | 完成状态 |
|---|---|---|---|
| E2E 构建顺序：server 增加 daemon devDependency；server 的 `typecheck`/`test` 先 build daemon；daemon exports 使用指向 `dist` 的 `types` + `import`。 | 同意 | 干净工作区必须能解析构建后的 daemon 公共入口。 | 已完成 |
| malformed 2xx 分流：poll 的 malformed 2xx fail-fast；report 的 malformed 2xx 保留原 credential/body 重试。 | 部分同意 | poll 可能已 claim 且无法恢复 Delivery；report 可能已消费 lease，重报可通过 coded 401 自愈。 | 已完成 |
| Runner 抛错合成 `{ ok: false, error: sanitizedSummary }`，不带 `outcome`；清除 NUL、截断 2000 字符且不泄漏 credential。 | 同意 | Phase 1 的终态 outcome 由 server 根据 `ok` 推导。 | 已完成 |
| 版本使用提交的 `src/version.ts` 常量，并由测试读取 package.json 防漂移。 | 同意 | 避免生产时 import package.json 或 build-time 生成文件。 | 已完成 |

### 可选说明项

| 补充内容 | 同意/不同意 | 不同意的理由 | 完成状态 |
|---|---|---|---|
| `pendingReports` 无容量上限；server 长期不可用时允许增长，不通过丢弃已 claim 报告限流。 | 同意 | Day 5 接受进程内风险，容量和背压留待真实 Agent 阶段。 | 已完成 |
| `pollOnce` 顺序路径的首次 report 最多等待 10 秒；后续 retry 后台化且不阻塞 poll。 | 同意 | 与 Day 5 的 Fake Runner 顺序执行范围一致。 | 已完成 |

## Spec（目标/行为一致性）

| 验收面 | 评审结果 | 完成状态 |
|---|---|---|
| daemon 包、配置解析、Machine identity、前台 CLI | 包结构、必填项校验、URL/interval 规范化、version pin 与信号处理代码均存在。 | 已完成 |
| poll transport | URL、Machine Bearer、扁平 identity、无 `wait`、10 秒 timeout、schema 校验及错误分类与计划一致。 | 已完成 |
| report transport | 使用 opaque Run Credential；合法 2xx 确认；malformed 2xx/瞬态失败重试；coded 401 终态确认。 | 已完成 |
| Runner seam 与 Fake Runner | `RunnerReport` 不含 `runId`；Fake Runner 确定性成功；编排层覆盖 `runId`；异常报告清洗符合裁决。 | 已完成 |
| 进程内去重 | `inFlight`/`pendingReports` 覆盖跨 poll 的未确认窗口；批级 `seenRunIds` 保证同一响应中的重复 Delivery 不重复执行。 | 已完成 |
| report 不变重试 | 入队时一次序列化为 wire 快照；所有重试复用同一 credential 与同一 JSON 字符串。 | 已完成 |
| 非阻塞无限重试 | 退避为 `1s → 2s → 4s → … → 30s`，无次数上限；终态前不删除 pending report；不阻塞后续 poll。 | 已完成 |
| shutdown | signal 会中止 poll sleep、传给 Runner 并组合到 HTTP；测试覆盖 SIGINT/SIGTERM 注册/释放及 runtime → client 的在途请求中断。 | 已完成 |
| 跨包 E2E | 通过 coordinator 预置 pending Run；单轮后断言 `done/exec`、message、progress 清空、lease 删除和第二次 poll 不重执行。 | 已完成 |
| 范围与 ADR | 未引入 manual trigger、真实 Agent、长轮询、持久化 outbox、sweep 或新 ADR，范围符合 Day 5。 | 已完成 |

### Spec 发现

| 编号 | 严重度 | 发现与证据 | 建议 | 完成状态 |
|---|---|---|---|---|
| CR-01 | P1 | 原实现只检查当下的 `inFlight` 与 `pendingReports`，同批重复 `runId` 会执行两次。 | `runtime.ts:189-194` 新增批级 `seenRunIds`；`runtime.test.ts:154` 固化同批重复 Delivery 只执行一次。按补充评估，不引入跨 poll tombstone。 | 已完成 |
| CR-02 | P1 | 原浅冻结无法阻止 `cost` 等嵌套引用变化，重试 JSON 会漂移。 | `client.ts:47-55` 引入一次序列化的 `SerializedReportRequest`；`runtime.ts:176` 入队时生成快照；`runtime.test.ts:182` 验证嵌套引用突变后两次 wire body 完全相同。 | 已完成 |
| CR-03 | P2 | 原测试没有覆盖 CLI 信号注册，也没有证明 runtime → client 的在途 HTTP 中断链路。 | `cli.ts:18-46` 抽出可注入的信号注册/释放函数，`cli.test.ts` 覆盖 SIGINT/SIGTERM；`runtime.test.ts:315` 用悬挂 fetch 验证在途 poll 被 abort。 | 已完成 |

## Standards（代码质量）

仓库没有本项目专属 `AGENTS.md`、`CODING_STANDARDS.md` 或 `CONTRIBUTING.md`；本轴依据
现有 TypeScript/package 惯例与通用代码异味基线评审。

| 编号 | 严重度 | 发现与证据 | 建议 | 完成状态 |
|---|---|---|---|---|
| CR-02 | P1 | 原浅冻结与“不可变 body”的所有权语义不符。 | runtime/client 边界现以 `SerializedReportRequest` 表达单一 wire 快照，重试不再读取 Runner 的对象图。 | 已完成 |
| CR-04 | P2 | `run_capability_invalid` 原由 daemon 与 server 分别维护裸字符串。 | `protocol/errors.ts:20` 导出 `RUN_CAPABILITY_INVALID_CODE`，server 和 daemon 共同引用。 | 已完成 |
| CR-05 | P3 | runtime 测试 helper 原有恒等死条件，并可能返回未实际使用的 Runner spy。 | helper 现在始终包装最终选中的 Runner，`runnerCalls` 与实际调用一致。 | 已完成 |
| CR-06 | P3 | `parse2xx` 实际也用于解析 401，名称误导。 | 已重命名为 `tryParseJsonResponse`。 | 已完成 |
| CR-07 | P2 | `RunnerReport.cursor` 是 `unknown`，可包含 BigInt/循环引用；wire 快照序列化失败原本会抛出并让已 claim Run 停在 running。 | runtime 捕获快照失败并合成固定、无 credential、无 `outcome` 的 `ok:false` 报告；BigInt 回归测试验证它继续进入既有 report/retry 链路。 | 已完成 |

轴向汇总：Spec 共 3 项，最严重为 CR-01/CR-02（P1）；Standards 共 5 项，最严重为
CR-02（P1）。两个轴分别计数，不用一侧结果抵消另一侧。

## 动态验证

| 命令/验证 | 结果 | 完成状态 |
|---|---|---|
| `pnpm -r typecheck` | 3 个 workspace 包通过。 | 已完成 |
| daemon tests | 6 个文件、43 项测试通过。 | 已完成 |
| server tests | 13 个文件、147 项测试全部通过。 | 已完成 |
| protocol tests | 7 个文件、62 项测试通过。 | 已完成 |
| `pnpm -r build` | protocol、daemon、server 全部通过。 | 已完成 |
| `pnpm --filter @loopzhb/server db:check` | 无 schema/migration diff。 | 已完成 |
| `git diff --check` | 通过。 | 已完成 |

## 建议收口顺序

1. ~~先修 CR-01、CR-02，并把两个最小复现固化成回归测试。~~ 已完成。
2. ~~补 CR-03 的关停验收，确认 signal 从 CLI 一直传播到在途 HTTP。~~ 已完成。
3. ~~完成全套 typecheck/test/build/db:check 后，将 Day 5 标记为完整通过。~~ 已完成。
4. ~~CR-04～CR-06 可与上述修复一并清理。~~ 已完成。

## 补充评估

> 以下来自对评审发现的逐项自检（静态核对 + 用构建产物做最小动态复现），供修复决策参考。
> CR-01、CR-02 均已动态复现确认：单批 `[delivery, delivery]` 使 `runnerCalls === 2`；
> Runner 保留 `cost` 引用并在重试前改 `usd: 1→9`，两次 HTTP body 字节不同。

1. **CR-01 的最小修复**：批级 `seenRunIds` 集合即可覆盖复现场景（同批重复 runId）。
   评审建议中"跨 poll terminal tombstone"**Day 5 不必做**——server 不会对 done run 重派
   Delivery，跨 poll 的未确认窗口已由 `pendingReports` 覆盖；引入 tombstone 反而要回答
   生命周期/容量问题，与"pendingReports 无上限"的既定裁决叠床架屋。
2. **CR-02 的修复取向**：优先评审的第一建议——入队时一次 `JSON.stringify` 形成 wire
   快照，所有重试复用同一字节串（client `post` 接受已序列化 body）。这比深拷贝/深冻结
   更贴近"字节级相同"的真实约束，且快照之后 Runner 持有什么引用都不再影响重试。
3. **CR-03 的范围澄清**：SIGINT/SIGTERM 注册测试需要动 CLI 结构（抽出可测试的信号
   注册/释放函数）；在途 HTTP 中断测试不需要动结构——用一个尊重 AbortSignal 的悬挂
   fetch 即可证明 runtime → client 的 abort 链路。另外注意：signal 传入 Runner 的测试
   已存在（满足目标文档评审第 8 条裁决），CR-03 缺的是"中断在途 HTTP"与信号注册两环。

### 补充评估采纳结果

| 补充说明 | 采纳结论 | 落地结果 | 完成状态 |
|---|---|---|---|
| CR-01 仅做批级 `seenRunIds`，不引入跨 poll tombstone。 | 纳入 | `pollOnce()` 对当前响应维护 `seenRunIds`；跨 poll 继续只依赖 server claim 语义及两个未确认集合。 | 已完成 |
| CR-02 入队时一次序列化，MachineClient 接受并复用已序列化 body。 | 纳入 | 新增 `SerializedReportRequest`；runtime 生成一次快照，report 直接发送 `json` 字符串。 | 已完成 |
| CR-03 分别验证 CLI 信号注册和 runtime → client 在途 HTTP abort。 | 纳入 | 新增 SIGINT/SIGTERM 注册/释放测试及悬挂 fetch 中断测试。 | 已完成 |
