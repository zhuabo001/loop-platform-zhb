# Day 3–4 Poll / Report 计划澄清：CONFLICT、GAP 与 ASSUMPTION

> 日期：2026-07-29
> 状态：4 个 CONFLICT、4 个 GAP 已解决；其余 ASSUMPTION 待后续收敛
> 对象：[`codex-handoff-pollReport-plan.md`](./codex-handoff-pollReport-plan.md)
> 目的：把当前开发计划中与既有决策冲突、未显式写出的既有约束，以及尚未被
> ADR/roadmap 锁定的设计假设分别列出。在本文件收敛前，不直接按原计划实施。

## 一、判断依据

对照时采用以下权威顺序：

1. 最新且状态为 Accepted 的
   [ADR-001](../adr/001-heart-tests.md)、
   [ADR-002](../adr/002-protocol-package.md)、
   [ADR-003](../adr/003-heart-schema.md)；
2. 已落地的 protocol/schema 代码；
3. [roadmap](../roadmap.md) 的阶段范围；
4. [Day 1–2 handoff](./001-phase1-day1-2.md) 和
   [HTTP framework handoff](./002-day3-4-http-framework.md)；
5. `loop-platform-github` 参考实现。参考实现只能提供实现证据，不能覆盖本项目 ADR
   已记录的有意偏离。

分类：

- `CONFLICT`：计划与已锁定约束不一致，或当前仓库中的权威来源互相矛盾，需要改变
  计划设计或由 owner 消解来源冲突。
- `GAP`：计划的实现方向正确，但没有把 ADR 已锁定的约束、分支或验收场景显式写全；
  不需要重新做设计决策，只需补充计划表述和测试。
- `ASSUMPTION`：为使计划可执行而新增，但尚未被 ADR、roadmap 或当前代码明确锁定的
  设计选择。

## 二、CONFLICT

### C-01：Report 读取侧不能强制要求 `rk_` 形状

> 决议：**已解决（2026-07-29）**。Report 读取侧保持 opaque；`rk_` 形状只在当前
> server 的 mint/write 侧验证。

**原计划（修订前）**

> Bearer token 必须是本服务签发且仍存在的 `rk_` lease。

**冲突**

- `isRunTokenShape` 被明确限定为 mint/write-side 过滤。
- Delivery 中的 `runToken` 是 opaque string，必须兼容旧 server 签发的 bare UUID。
- daemon 只会把 Delivery 中的 token 原样回传为 Report Bearer；因此 Report 是读取侧，
  不能在 resolve 前用 `rk_` 前缀拒绝 legacy token。

**依据**

- [`tokens.ts`](../../packages/protocol/src/tokens.ts)
- [`poll.ts` 的 deliverySchema](../../packages/protocol/src/poll.ts)
- [Day 1–2 handoff：runToken opaque、shape check 仅留 mint/write-side](./001-phase1-day1-2.md)

**Owner 决议**

- 当前 server 新 mint 的 Run Token 必须通过 `isRunTokenShape`，即使用 `rk_` 形状。
- Report 将 Bearer token 视为 opaque credential，直接计算 SHA-256 并 resolve lease。
- 未知、过期、已 retire 的 token 返回 401；不能以“不是 `rk_`”作为读取侧拒绝原因。
- “malformed run token”HTTP 测试改成 unknown/expired/retired token 测试；`rk_` 形状只在
  mint 测试中验证。

### C-02：`done + active lease → enrich` 与 Phase 1 行为收缩存在张力

> 决议：**已解决（2026-07-29）**。Phase 1 不实现 enrich；该组合按失效的 Run
> Capability fail closed。

**原计划（修订前）**

> done + active lease 仅允许补充 duration/session 等当前已支持的终态信息。

**来源冲突**

- Day 1–2 handoff 要求 report 按 `canceled / done enrich / terminal-grace /
  normal finalize` 分支。
- ADR-002 又规定 handler 不得因为预声明字段存在就提前实现后期行为。
- `done + active lease` 的正常来源是未来的 in-run `finish` 动词；Phase 1 当前只有
  report，没有合法路径产生该组合。

**依据**

- [Day 1–2 handoff：report 分支](./001-phase1-day1-2.md)
- [ADR-002 决策 6](../adr/002-protocol-package.md)
- [roadmap：goal/finish 属于 Phase 4](../roadmap.md)

**Owner 决议**

- Day 3–4 不实现 enrich。
- `done + active lease` 当前没有合法来源；出现时在事务内删除残留 lease、记录内部
  `stale_phase` 原因，不修改 Run/Loop，并返回统一的 capability-invalid 401。
- future finish 动词落地时再显式增加合法的 `done + active → enrich once` 转换。
- C-02 与 A-09、A-14 统一采用以下外部语义：
  - Run Capability 永久失效：401 +
    `{error:"invalid or expired run capability",code:"run_capability_invalid"}`；
  - capability 有效但缺少权限：403；
  - capability 有效但生命周期不允许该操作：409。
- unknown、expired、consumed、revoked、race_lost、orphaned_run、stale_phase 对外不
  区分，具体 reason 只进入服务端日志。
- `terminal-grace + error + report` 是 ADR 明确允许的一次性 reconcile，不属于
  capability invalidation。

### C-03：Report 的正式路由前缀在仓库中不一致

> 决议：**已解决（2026-07-29）**。机器端点统一使用 `/api/machine/*`，不提供无
> `/api` 的兼容别名。

**修订前状态**

- 当前计划以及 owner 在本轮计划讨论中的选择：`POST /api/machine/report`。
- `poll.ts` 与 HTTP framework 示例使用 `/api/machine/poll`。
- `report.ts`、roadmap、Day 1–2 handoff、HTTP framework handoff 标题使用
  `/machine/report` 或统称 `/machine/*`。

**依据**

- [`poll.ts`](../../packages/protocol/src/poll.ts)
- [`report.ts`](../../packages/protocol/src/report.ts)
- [roadmap Day 3–4](../roadmap.md)
- [HTTP framework handoff](./002-day3-4-http-framework.md)

**Owner 决议**

- 正式端点为 `/api/machine/poll` 与 `/api/machine/report`。
- 同步 protocol 注释、roadmap、001/002 handoff 和原计划。
- 当前没有已发布 daemon 需要兼容，因此不开放第二套路由别名。

### C-04：report/cancel 真实交错测试的交付时间不一致

> 决议：**已解决（2026-07-29）**。Day 3–4 验证应用层交错编排与真实事务提交；
> Phase 6 验证真实 Postgres 的锁竞争与隔离级别。

**修订前来源**

- roadmap 把 T4–T7 故障注入放在 Day 8–10。
- ADR-001 把完整 T6 作为 Phase 1 验收项。
- Day 1–2 handoff 顶部又明确写出：Day 3–4 需把 report/cancel 交错实现为真实并发测试。
- 当前计划只要求事务 guard 测试，没有明确是否构造真实交错。

**依据**

- [roadmap Day 8–10](../roadmap.md)
- [ADR-001 T6](../adr/001-heart-tests.md)
- [Day 1–2 handoff 顶部语义锁定](./001-phase1-day1-2.md)

**Owner 决议**

- Day 3–4 使用应用层 gate/deferred promise 编排顺序：
  1. report 完成初始 resolve 后暂停；
  2. cancel 的 PGlite 事务真实 commit；
  3. report 恢复并执行事务内二次验证；
  4. report 返回统一 401；
  5. Run 保持 canceled、lease 不存在、Loop 零写入。
- 该测试只验证应用层编排、事务边界和写前 guard，不宣称覆盖锁竞争或隔离级别。
- Day 8–10 完成包含 sweep、server restart、late report 的完整 T6 故障注入。
- Phase 6 使用真实 PostgreSQL 多物理连接验证行锁竞争、隔离级别、死锁与重试。

## 三、GAP

本节中的计划方向已经符合 ADR，不需要 owner 重新选择设计；只需把隐含约束补成显式
表述和验收场景。

### G-01：显式限定 `terminalizeLease` 只能由 sweep 的 reclaim 写入

**状态：已解决（2026-07-29）**

**当前计划已经正确的部分**

计划把 terminalize 放在“store 内部原子操作”中，并正确规定：

- 只允许 `active → terminal-grace`；
- 必须写 `now + 24h` expiry；
- 重复调用不得延长窗口。

**尚未显式写出的约束**

ADR-003 规定 `terminal-grace` 只能由 sweep 的 reclaim 写入。计划没有说
`terminalizeLease` 会成为通用 gateway/HTTP 能力，但应明确禁止这种暴露，避免后续
调用者把正常失败伪装成可 reconcile 的 sweep 误判。

**依据**

- [ADR-003 RunLease 状态机](../adr/003-heart-schema.md)
- [Day 1–2 handoff 的 lease 工程规则](./001-phase1-day1-2.md)

**Owner 决策**

- `sweep` 是识别失联 Run 的扫描编排，`reclaim` 是回收单个失联 Run 的原子事务；
  两者不是同义词。
- 对外原语命名为 `reclaimStaleRun`：在同一事务中完成
  `running Run → phase=error/outcome=error`、写入稳定通用原因
  `machine timed out / disconnected`、更新 `runs.ts` 数据库列（Run 最近转换时间）和
  `active lease → terminal-grace(expiresAt=首次 now+24h)`。
- `terminalizeLease` 仅为 `reclaimStaleRun` 的 store 私有步骤；不得进入
  MachineGateway、HTTP 或通用 store 公开面。只有 sweep 编排可以调用
  `reclaimStaleRun`。
- report、cancel、正常失败 finalize 和管理员操作不得调用 terminalize，从而不得把
  正常失败伪装成具有一次 reconcile 资格的 sweep 误判。
- Day 3–4 实现并测试事务原语，不实现 sweep 定时调度和超时扫描；后者留在
  Day 8–10。
- 验收覆盖原子提交、通用 reclaim reason、首次 24h 窗口、重复 reclaim 不续期、
  非 `running Run + active lease` 零转换，以及公开面不存在通用 terminalize
  能力。

### G-02：补齐 reconcile 失败分支的锁定语义

**状态：已解决（2026-07-29）**

**当前计划**

只写了 terminal-grace report 可以 reconcile 一次，没有规定迟到结果本身为失败时如何
落库。

**ADR 要求**

- 迟到成功：把 sweep 误判的 error 翻正为 done。
- 迟到失败：保持 error，但用 daemon 报告的真实错误替换通用 reclaim 原因。
- 两者都只能消费一次 lease；第二次 report 返回 401。

**依据**

- [ADR-001 持久化 RunLease 与 T5](../adr/001-heart-tests.md)
- [ADR-003 reconcile 状态机](../adr/003-heart-schema.md)

**Owner 决策**

- reconcile 必须在事务内重新解析 lease 并锁定或 CAS 检查权威 Run；只有未过期的
  `terminal-grace lease + error Run` 可以进入该分支。
- reconcile success：`error → done`，清除通用 reclaim error。
- reconcile failure：保持 `error/error`，以 daemon 报告的非空真实错误替换 reclaim
  原因；缺失或空 error 时使用稳定 fallback `run failed on machine`，而不是保留
  sweep timeout。
- 两个分支均按 Phase 1 的正常 Report 字段策略保存基础字段、清除 progress，并更新
  `runs.ts` 数据库列；失败分支不得推进 Loop cursor/state，也不得重复发送 reclaim
  时已经发送过的失败通知。
- Run 更新与 terminal-grace lease 删除必须在同一事务；任一步失败时全部回滚，不能
  消费 credential 却丢失真实结果。
- 成功受理无论 Run 最终成功或失败都返回 `{ok:true,reconciled:true}`；这里的
  `ok:true` 表示请求被接受。第二次 report 返回统一 capability-invalid 401，且
  Run/Loop 零副作用。
- 测试分别覆盖 success、带真实错误的 failure、缺失/空错误的 failure、事务两端
  故障回滚和第二次 report 的效果幂等。

### G-03：把 Delivery 丢失后的“不重派”承诺写成显式场景

**状态：已解决（2026-07-29）**

**当前计划已经正确的部分**

T2 已规定重复 Poll 不返回 running Run，因此 claim 成功后不会重新生成 Delivery，实际
行为方向符合 ADR-001。

**尚未显式写出的约束**

计划没有把“首次 Delivery HTTP 响应丢失”单独写成验收场景，也没有说明该 Run 后续由
sweep 进入可观察 error。

**依据**

- [ADR-001 投递保证](../adr/001-heart-tests.md)

**Owner 决策**

- claim 与 Lease 的事务一旦提交，Run 就永久失去派发资格；HTTP Delivery 响应是否
  到达不改变这一点。
- Poll 只 claim pending Run，不得因 daemon 重试重新返回 running Run、重建
  Delivery、重新 mint credential 或把 Run 放回 pending。
- 规则对同一 daemon、其他 daemon 和 server 重启后的 Poll 一致。数据库只保存
  credential hash，本来也无法安全恢复原 credential。
- server 无法区分“响应丢失”和“daemon 已收到并开始产生外部副作用”，因此 MVP
  选择 at-most-once execution：Run 可能执行零次或一次，绝不因自动重派执行两次。
- Day 3–4 测试第一次 Poll claim/lease commit 后丢弃响应，再次 Poll 返回空且
  Run/Lease 数量和身份不变。Day 8–10 再以 Fake Clock+sweep 验证 Run 最终进入
  可观察 error，全程不重派。
- Delivery ACK、claim request ID、可重放 Delivery 和可恢复 credential 不进入当前
  MVP，需要时另行设计。

### G-04：显式规定错误响应使用已有 protocol 形状

**状态：已解决（2026-07-29）**

**当前计划已经正确的部分**

计划已列出 400/401/413/404/500 的状态映射，方向正确。

**尚未显式写出的约束**

Protocol 已提供 `apiErrorSchema`：`{error, code?}`。如果 route 各自返回字符串或不同
JSON 形状，会重新引入 server/daemon wire 漂移。

**依据**

- [`errors.ts`](../../packages/protocol/src/errors.ts)
- [ADR-002：protocol 是唯一 wire 耦合点](../adr/002-protocol-package.md)

**Owner 决策**

- 所有机器端点以及 body-limit、not-found、全局 exception 分支都通过集中 JSON
  error helper 返回 `ApiError`，body 必须满足 `apiErrorSchema` 并使用 JSON
  Content-Type；禁止纯字符串、Zod issue 数组、框架默认 404 和自创错误形状。
- 稳定映射为：
  - 400 `{error:"invalid request"}`；
  - 无效 Machine Credential 401 `{error:"invalid machine credential"}`；
  - 无效 Run Capability 401
    `{error:"invalid or expired run capability",code:"run_capability_invalid"}`；
  - 413 `{error:"request body too large"}`；
  - 404 `{error:"not found"}`；
  - 500 `{error:"internal server error"}`。
- `code` 保持 additive optional；当前仅已锁定的 `run_capability_invalid` 必须携带，
  其他分类等 daemon 真正需要编程分支时再增量增加。
- Zod 细节、异常消息、stack、SQL/数据库信息只进入服务端日志，不进入 wire。
- 测试让所有错误分支通过 `apiErrorSchema`，精确断言 status、稳定 error、必要 code
  和 JSON Content-Type，并单测 404/500 不泄漏框架或内部细节。

## 四、ASSUMPTION

### A-01：首次 Poll 自动注册 Machine

**计划假设**

任意形状合法的 `dk_` 在未启用 auth 的 Phase 1 模式下首次 Poll 时自动注册 Machine。

**尚未锁定的原因**

当前 schema 支持 Machine，roadmap 也承认 auth 前机器注册没有身份边界，但没有明确
注册由 Poll 完成还是由独立 connect/register 流程完成。

**推荐**

Phase 1 允许 Poll 自动注册，条件为：

- 仅允许 localhost/受信网络部署；
- `dk_` 形状检查只用于过滤畸形输入；
- machine ID 由 token 派生，DB 只保存完整 token hash；
- 后续 Poll 同时校验派生 ID 和完整 hash；
- Phase 5 auth 上线时重新收紧 enrollment。

### A-02：深模块名称与接口

**计划假设**

建立 `MachineGateway`，同时暴露 `poll`、`report`、`enqueueExecRun`。

**风险**

`enqueueExecRun` 属于 owner/coordinator 表面，而 poll/report 属于 daemon 表面；以
`MachineGateway` 命名会让同一接口承担两个角色。roadmap 已使用 `RunCoordinator`
作为心脏深模块的名称。

**推荐**

- 外部深模块命名为 `RunCoordinator`，接口包含心脏行为：
  `poll`、`report`、`enqueueExecRun`。
- Hono route 是 adapter，只解析/返回。
- store 保持内部 seam，不把细粒度事务函数暴露给 HTTP。

### A-03：依赖注入粒度

**计划假设**

向深模块注入 DB、Clock、token factory 和 id factory。

**推荐**

- DB、Clock 必须注入：分别支持 PGlite 测试和确定性时间。
- token/id factory 可注入为一个 `Ids` 依赖，避免扩大构造接口。
- 不为只有一个实现的依赖额外创建公开 port；PGlite 是本地可替代实现，直接通过 DB
  seam 测试。

### A-04：supersede 与新 Run 入队是否同事务

**计划假设**

`enqueueExecRun` 在同一事务内 supersede 所有旧 pending Run 并插入新 pending Run。

**推荐**

采纳该假设。否则 supersede 成功而 insert 失败会造成 Loop 暂时没有待执行 Run，与
“下一次触发替换旧 pending”的单一 coordinator 行为不一致。

需要明确：

- 旧 pending 编码为 `phase=canceled, outcome=skipped`；
- running Run 不受影响；
- 新 Run 固定为 `phase=pending, role=exec`；
- supersede 和 insert 任一步失败时整体回滚。

### A-05：一次 Poll 可以领取多少 Run

**计划假设**

一次 Poll 领取该 Machine 的全部 eligible pending Run。

**尚未锁定的内容**

虽然 `PollResponse.deliveries` 是数组，但 protocol 没有规定领取数量、排序或并发上限。

**推荐**

- Phase 1 领取全部 eligible pending Run；
- 使用稳定顺序，例如 `runs.ts`、再按 `run.id`；
- 不在本批次新增任意并发上限；
- 每个 Run 仍通过独立条件 UPDATE + lease INSERT 事务竞争。

### A-06：RunLease caps 全部关闭

**计划假设**

`allowControl`、`canSetUi`、`canSetSchema`、`canSetWorkflow`、`canFinish` 全部写 false。

**尚未锁定的原因**

ADR 只规定这些列是兼容形状预声明，未规定 Phase 1 claim 时的持久化值。

**推荐**

Phase 1 全部 false。当前唯一 run-token 写表面是 report，没有必要提前颁发任何控制
能力；对应控制动词上线时再逐项开放并补行为测试。

### A-07：Delivery task 的最小内容

**计划假设**

`systemPrompt=""`，`task` 使用一段仅面向 exec 的最小任务说明。

**已锁定与未锁定部分**

- `systemPrompt` 当前为空有 protocol 注释依据。
- `task` 必须是字符串，但具体文案没有 ADR。

**推荐**

使用独立、确定性的 `buildExecDelivery` 内部函数；任务只包含当前 Loop 名称和必要的
执行说明，不提前实现 evolve/edit/workflow/Task File prompt 语义。

### A-08：正常 Report 当前保存哪些字段

**计划假设**

保存 message/finalText、durationMs、sessionId，忽略 cursor、taskFileContent、
artifacts、transcript、cost、attempts。

**推荐**

采纳该最小集合：

- 必须写：phase、outcome、ts；
- 成功/失败观察面：message/finalText fallback、error；
- 可写基础执行元数据：durationMs、sessionId；
- 清除 progress 是否属于当前阶段需单独确认；
- cursor、Task File、artifact、transcript、cost/attempts 暂不产生业务写入。

### A-09：report/cancel 竞态输家返回什么状态（已由 C-02 解决）

**此前假设**

无论 token 在 resolve 前还是 resolve 后失效，Report 都返回 401。

**Owner 决议**

- cancel 已提交并删除 lease后，resolve 必然返回 401。
- report 在 resolve 后输掉竞态时，同样视为 Run Capability 已失效。
- 两条路径统一返回 `run_capability_invalid` 401；daemon 将其视为终态确认。
- 竞态输掉的 Report 不得产生任何 Run/Loop 写入。

### A-10：HTTP 状态映射（已由 G-04 解决）

**Owner 决议**

- JSON/DTO 错误：400；
- token 错误：401；
- body 超限：413；
- 未知路由：404；
- 未捕获异常：500。

以上映射已采纳；所有 body 使用 `apiErrorSchema`，稳定摘要与可选 code 规则以 G-04
为准。

### A-11：server 包公开接口

**计划假设**

公开 `@loopzhb/server/http` app factory，并新增 `start` script。

**推荐**

- 公开可注入的 app factory，供 HTTP 测试与未来集成复用；
- `RunCoordinator` 是否作为 package export 暂不开放，先保持包内接口；
- Node boot 保持独立入口，负责 open/migrate DB、serve 和 shutdown；
- 测试只使用 app factory，不监听真实端口。

### A-12：启动环境变量与持久化策略

**计划假设**

- `LOOPZHB_HOST` 默认 `127.0.0.1`；
- `LOOPZHB_PORT` 默认 `3000`；
- `LOOPZHB_DATA_DIR` 必填。

**尚未锁定的原因**

ADR-003 只规定 `createDb/openMigratedDb`：提供 dataDir 时使用文件库，不提供时使用
内存库；没有规定进程启动配置。

**推荐**

- 默认 host 保持 `127.0.0.1`，符合 auth 前不得公开暴露的 roadmap 约束；
- 默认 port 使用 3000；
- 正式 Node boot 要求提供 `LOOPZHB_DATA_DIR`，测试 app factory 可继续使用内存库；
- 若希望开发模式自动使用临时/仓库内目录，应另行明确，不能静默牺牲重启持久性。

### A-13：Machine 身份字段的更新策略

**计划假设**

每次 Poll 更新 lastSeen，并在 host/platform/arch/version 变化时更新 Machine。

**推荐**

采纳该行为，但把写入节流视为实现细节：

- lastSeen 必须反映 Poll 联系；
-身份字段只在值变化时写入；
- Day 3–4 不实现 `online` 列，因为 ADR-003 明确在线状态由 lastSeen 推导。

### A-14：Report 找到 Lease 但 Run 不存在（已由 C-02 解决）

**此前缺口**

无外键设计允许异常或级联顺序导致 lease 存在、Run 不存在；计划未规定处理方式。

**Owner 决议**

fail closed：

- 不执行任何 Loop 写入；
- 删除异常 lease，避免永久残留活 capability；
- 返回统一的 `run_capability_invalid` 401；
- 记录内部 `orphaned_run` invariant violation；
- 增加 store/gateway 测试。

## 五、建议的澄清顺序

已解决并同步到原计划/来源文档的 CONFLICT：

- [x] C-01：Report token 读取侧保持 opaque。
- [x] C-02：Phase 1 不做 done-enrich，统一 capability invalidation 语义。
- [x] C-03：正式路由统一采用 `/api/machine/*`。
- [x] C-04：Day 3–4 验证应用层交错与真实事务提交，真实 PG 并发留 Phase 6。

不需要 owner 再决策、可直接按 ADR 补齐的 GAP：

- [x] G-01：terminalize 仅为 sweep→reclaim 原子事务的私有步骤。
- [x] G-02：锁定 reconcile success/failure、fallback 与原子消费语义。
- [x] G-03：claim 提交后 Delivery 丢失也不重派，最终由 sweep 显式失败。
- [x] G-04：全部 HTTP 错误统一使用 `apiErrorSchema` 与稳定公开摘要。

仍需要 owner 拍板的 ASSUMPTION：

- [ ] A-01：首次 Poll 是否自动注册 Machine。
- [ ] A-02：深模块是否统一命名为 `RunCoordinator`。
- [ ] A-04：supersede + insert 是否同事务。
- [ ] A-05：一次 Poll 的领取数量与排序。
- [ ] A-06：Phase 1 lease caps 的值。
- [ ] A-08：正常 Report 当前保存的字段集合。
- [x] A-09：竞态输家统一返回 `run_capability_invalid` 401。
- [x] A-10：HTTP 状态与 `apiErrorSchema` 映射已由 G-04 解决。
- [ ] A-11/A-12：package export、启动入口和环境变量。
- [x] A-14：orphaned Run 统一使 capability 失效并清理孤儿 lease。

确认后再执行：

1. 将结论回写本文件，把相应 checkbox 勾选并记录 owner 决策。
2. 修订 `codex-handoff-pollReport-plan.md`，删除不再成立的假设。
3. 对于只是文档漂移的内容，同步 protocol 注释、roadmap 与 handoff。
4. 只有当最终选择改变 Accepted ADR 的语义时，才修订 ADR 或新增 superseding ADR。
