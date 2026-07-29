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
  RunCoordinator、HTTP 或通用 store 公开面。只有 sweep 编排可以调用
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

**决议（已确认）**

复刻参考实现：`POST /api/machine/poll` 是 Phase 1 唯一允许 Machine 自注册的入口。
在未启用 auth 的模式下，首次 Poll 携带形状合法的 `dk_` 时自动创建 Machine，并继续
处理同一次 Poll，不要求 daemon 额外执行 register/connect 请求或再 Poll 一次。

精确语义如下：

- `dk_` 形状检查只是廉价的畸形输入过滤，不是身份边界；不符合形状时返回统一的
  Machine Credential 401，且不产生数据库写入。
- machine ID 固定由完整 credential 派生：
  `m-${sha256(machineCredential).slice(0, 16)}`；数据库只保存完整 credential 的
  SHA-256，不保存明文。
- Machine 不存在时，创建行并写入 `createdAt`、`lastSeen` 及首次 Poll 携带的机器
  身份字段；`name` 优先使用 `host`，缺失时使用基于 machine ID 的稳定 fallback。
  具体身份字段的后续更新频率仍由 A-13 单独决定。
- Machine 已存在时，除派生 ID 命中外还必须校验完整 credential hash；hash 不匹配
  返回 401，防止截断 machine ID 碰撞造成冒用。
- 首次 Poll 的重试或并发请求必须幂等收敛到同一 Machine：同 hash 继续处理，不同
  hash 拒绝，不得因主键竞争暴露 500。
- Phase 5 不改变 daemon 的 Poll 自注册协议，只在“Machine 不存在”的创建分支前增加
  有效 connect key/owner 校验；既有 Machine 继续走完整 hash 校验。
- Phase 5 auth 完成前，server 仍仅允许 localhost/受信网络部署，不得公开暴露。

**参考依据与取舍**

`loop-platform-github` 的 `MachineGateway.poll` 正是唯一自注册入口：开放模式允许合法
形状的未知 `dk_` 注册，认证模式在同一分支增加 connect-key gate。继续复用 Poll
可以保持参考 daemon 的连接行为；独立 register/connect 端点会提前引入额外协议状态，
预注册则会破坏首次启动即连接的行为，因此本阶段均不采用。并发首次注册幂等是对
可重试 Poll 的当前正确性补强，不改变参考协议。

### A-02：深模块名称与接口

**决议（已确认）**

采用方案 B：Day 3–4 的心脏深模块统一命名为 `RunCoordinator`，包内接口仅包含
`enqueueExecRun`、`poll`、`report`。暂不建立额外的 `MachineGateway` 包装层。

三个方法按 Run 生命周期聚合，而不是按调用者身份聚合：

- owner/manual-trigger adapter 只能调用 `enqueueExecRun`；
- Machine Poll adapter 只能调用 `poll`；
- Machine Report adapter 只能调用 `report`；
- 模块接口不等于 HTTP 权限表面，`enqueueExecRun` 不得通过 Machine Credential
  暴露；
- store 的 claim、finalize、supersede、lease 消费等细粒度事务函数保持内部实现，
  HTTP adapter 不得直接调用；
- Phase 3 Scheduler 到来后复用 `enqueueExecRun`，不得绕过 `RunCoordinator` 自行
  编排 supersede + insert。

**参考依据与取舍**

`loop-platform-github/docs/retro-roadmap.md` 原始设计使用 `RunCoordinator`，接口聚合
trigger/poll/report/cancel；实际演化后的代码改用范围更广的 `MachineGateway`，并让
`Scheduler` 直接编排 pending Run 的创建。ZHB 当前只交付心脏链路、尚无 cron
Scheduler，直接复刻最终文件布局会提前引入一个浅 Scheduler，并使关键入队事务泄漏
到调用方。因此选择参考项目的原始深模块设计，同时保持其外部行为；这也与 ZHB
roadmap 已确定的 `RunCoordinator` 名称一致。当前不拆成 `MachineGateway + RunQueue`
两个浅模块，等出现真实独立行为簇和第二个 adapter 后再评估拆分。

### A-03：依赖注入粒度

**决议（已确认）**

采用方案 B：`RunCoordinator` 接收单一 `RunCoordinatorDependencies` 对象，依赖项
为必填的 `db`、`clock`、`newRunId` 和 `mintRunCredential`。

依赖语义如下：

- `db` 注入具体 Drizzle `Db`，而不是整个 `DbHandle`；Coordinator 只使用查询与事务，
  open/migrate/close 和 `dataDir` 生命周期属于 boot。
- `clock` 提供 `now(): Date`；production 使用 System Clock，测试使用 Fake Clock。
  `RunCoordinator` 及其内部 store 写路径不得绕过它直接调用 `Date.now()` 或
  `new Date()` 生成生命周期时间。
- `newRunId` 与 `mintRunCredential` 保持两个明确依赖，不合并为含混的 `Ids`：
  Run ID 是标识，Run Credential 是 capability bearer secret。production 分别使用
  `randomUUID()` 与 `rk_` 加密码学随机字节；测试可提供确定值或故障工厂。
- `sha256`、`machineIdFromToken` 等确定性纯函数直接复用 protocol/node，不注入。
- store 是 `RunCoordinator` 的内部实现，绑定注入的 DB/transaction handle；不为当前
  唯一持久化实现创建公开 repository port，HTTP adapter 也不得看到 DB 或 store。
- logger、Delivery builder、hash function 等当前只有一个真实实现的依赖不提前注入。

**参考依据与取舍**

`loop-platform-github` 的实际实现直接 import 全局 DB/store，并在 gateway/store/token
路径中调用系统时间与随机源；生产 wiring 较少，但测试需要通过环境变量、动态 import
和手工改时间戳控制状态。ZHB 已经选择独立内存 PGlite、Fake Clock 与事务故障注入，
若继续使用全局依赖，Day 8–10 再抽 Clock 会穿过 claim/report/reclaim/lease expiry/
Machine lastSeen 等多个写路径。显式依赖对象保持参考行为，同时把修改集中在 boot
wiring；不采用完整 Repository/Store 接口，避免为单一实现建立浅 seam。

测试必须证明：两个 Coordinator 的内存 DB 完全隔离；Fake Clock 精确控制生命周期
时间；固定 Run ID/Run Credential 能钉住持久化行和 credential hash；ID 或 credential
factory 失败时所在事务整体回滚；production credential factory 始终生成合法 `rk_`
形状。

### A-04：supersede 与新 Run 入队是否同事务

**决议（已确认）**

采用方案 B：保持参考实现的外部行为，但将“旧 pending 被 supersede + 新 pending
入队”收敛为 `RunCoordinator.enqueueExecRun` 内的一次原子替换。

精确语义如下：

- 若该 Loop 已有 running Run，本次触发直接跳过且零写入；不得 supersede running
  Run，也不得在其后额外排入 pending Run。
- 若不存在 running Run，则在同一事务中把该 Loop 的全部旧 pending exec Run 转为
  `phase=canceled/outcome=skipped`，更新各自的 Run Transition Time，再插入恰好一个
  `phase=pending/role=exec` 的新 Run。
- supersede 的 phase guard 若输给并发 Poll claim，说明旧 Run 已进入 running；整个
  enqueue 回滚并跳过本次触发，不创建第二个 pending Run。
- 任一 supersede 或新 Run insert 失败时整体回滚，旧 pending 保持原状，禁止出现
  “旧 Run 已跳过但替代 Run 未入队”的部分提交。
- Phase 1 像参考实现一样在 `RunCoordinator` 内按 Loop 做进程内串行化，覆盖单进程
  并发 trigger；多实例下的数据库行锁、隔离级别与重试在 Phase 6 使用真实 Postgres
  验证，不由 PGlite 测试冒充证明。

**参考依据与取舍**

`loop-platform-github` 的 Scheduler 已锁定相同外部行为：running 阻止本次触发，
pending exec 被 supersede 后只留下一个新 pending，并使用进程内 per-loop guard
合并并发 trigger。但参考实现逐条调用 `supersedePendingRun` 后再单独 `addRun`，没有
包在同一事务中，存在 supersede 已提交而 insert 失败的窗口。ZHB 复刻其可观察行为，
不复刻该部分提交窗口；事务封装在 A-02 已确认的 `RunCoordinator` seam 后，不把编排
泄漏给 manual-trigger 或未来 Scheduler adapter。本决议不新增数据库约束或 migration。

### A-05：一次 Poll 可以领取多少 Run

**决议（已确认）**

采用方案 B：Phase 1 的一次 Poll 在没有并发竞争时，尝试领取该 Machine 的全部
eligible pending exec Runs，并使用稳定的 oldest-first 顺序。

精确语义如下：

- eligible 指 `run.machineId` 等于 Machine Credential 派生出的 machine ID、
  `phase=pending`、`role=exec`，且对应 Loop 存在并能构造合法 Delivery。
- 候选按 `runs` 表 `ts` 列（Run Transition Time）升序，再按 `run.id` 升序；较早
  入队的 Run 优先，ID 为相同时间戳提供确定性 tie-break。
- 每个 Run 独立执行“条件 `pending → running` + active RunLease insert”事务；整个
  Delivery 批次不承诺全有或全无。单个 Run 竞争失败不阻止本次 Poll 继续尝试其他
  候选。
- 并发 Poll 可以瓜分候选，且不保证哪个响应获得哪个 Run；但所有并发响应的并集对
  每个 Run 至多包含一个 Delivery，最终至多存在一条对应 active lease。
- 本阶段不设置每次领取上限或 daemon 并发上限。以后若真实资源压力要求背压，应增加
  daemon 本地执行队列或 additive capacity 信号；单纯给每次 Poll 加 `LIMIT` 无法阻止
  busy daemon 在后续 Poll 中继续累积 in-flight Runs。

**参考依据与取舍**

`loop-platform-github` 会查询该 Machine 的全部 pending Runs、逐个条件 claim，且没有
数量上限；daemon 收到多个 Delivery 后逐个启动后台执行，也没有 capacity 协议。参考
查询未使用 `ORDER BY`，因此顺序不是稳定契约。ZHB 保留“全部尝试领取 + 每个 Run
独立竞争”的外部行为，只补充 `ts ASC, id ASC` 的确定顺序以稳定测试、日志与故障复现。
领取策略容易在现有数组协议上调整，本决议不新增 ADR。

### A-06：RunLease caps 全部关闭

**决议（已确认）**

Phase 1 mint RunLease 时显式写入：

```text
allowControl = false
canSetUi = false
canSetSchema = false
canSetWorkflow = false
canFinish = false
```

这些字段表示本次 Run 当前真正获得的有效控制能力，不是未来配置快照。Phase 1 唯一
开放的 Run Credential 写入口是 Report；Report 的权限来自 coherent active
RunLease，不依赖上述控制 caps。

Delivery 中的 `loop.allowControl` 仍忠实携带 Loop 配置值，即使它为 true；配置意图
不等于本次 lease 已获授权。未来任一控制能力必须与对应 route、mint policy 和
401/403/409 行为测试在同一批次开放。新规则只作用于新 mint 的 lease；既有 active
lease 保持 false，不因 Server 部署追溯获得能力。

**参考依据与取舍**

`loop-platform-github` 对 exec Run 使用 `allowControl=loop.allowControl`，structural
caps 仅给 evolve/edit，`canFinish` 仅给 closed Loop 的 exec。ZHB Phase 1 只领取
exec、尚无 goal 列与任何控制 route，因此除 `allowControl` 外参考公式本来也全部为
false。ZHB 不提前复制可能为 true 的存储值：参考项目把该值作为已上线 route 的真实
授权，而 ZHB 当前只是预声明列；提前写 true 会使旧 active lease 在未来 route 部署
后被追溯激活。所有 false 必须由 mint policy 显式写入，不能依赖数据库默认值。

测试覆盖 Loop `allowControl=true/false` 时 lease caps 均全部为 false、Delivery 仍
保留真实 Loop 配置、全 false 的 active lease 仍可正常 Report，以及持久化值不依赖
数据库默认。

### A-07：Delivery task 的最小内容

**决议（已确认）**

采用方案 C：复刻参考 prompt 的结构方向，但只交付当前阶段能够兑现的最小 exec
指令。`systemPrompt` 精确等于空字符串；`task` 由独立、确定性的纯函数
`buildExecTask(loop)` 构造，Delivery DTO 组装不内联 prompt 文案。

配置了本地 `taskFile` 时，模板为：

```text
[loop run]
Loop id: "<loop-id>"
Loop name: "<loop-name>"
Read the task file first: "<task-file-path>"
Do the work it describes.
Run once, then stop.
```

没有配置 `taskFile` 时，模板为：

```text
[loop run]
Loop id: "<loop-id>"
Loop name: "<loop-name>"
No task file is configured; this delivery has no real-agent task source.
Run once, then stop.
```

`loop.id`、显示名称（`loop.name ?? loop.id`）和路径必须通过 JSON 字符串编码后插入，
避免换行、引号或反引号破坏模板结构。Day 3–4/Phase 1 的 Fake Runner 允许接收无
task-file Delivery；Phase 2 的真实 Agent E2E 必须使用配置了本地 `taskFile` 的 Loop，
该文件此时只是一轮执行的输入来源，不提前开放 Phase 4 的 Spec/Current
understanding/Timeline、同步或跨 Run 演进语义。

Fake/真实 Runner 负责把执行结果提交给 Report endpoint；当前 task 不得宣传尚未实现
的 in-run `loopany report/finish`。同样不得注入 evolve/edit、workflow、prevState、
state schema、控制动作或 artifact 指令。以后相应能力落地时整体替换
`buildExecTask`，不得改动 claim、lease 或 HTTP route。

**参考依据与取舍**

`loop-platform-github` 当前同样使用空 `systemPrompt`，并由独立 `buildExecTask`
把完整首轮指令放入 `task`；但其文案依赖成熟的 Task File 生命周期、in-run CLI、
report/finish、goal/state 与 skill。直接照抄会形成虚假契约。protocol golden 中原有
“end with exactly ONE loopany report”也只是参考形状示例，与当前能力不符，本决议
同步替换该示例。最小模板保留参考实现的 Run 身份、task-file 输入和 one-pass 约束，
其余能力按阶段后补。

测试覆盖空 `systemPrompt`、有/无 task-file 两个确定模板、元数据 JSON 编码、无残留
模板变量、不得出现未开放能力文案，以及完整 Delivery 通过 `deliverySchema`。

### A-08：正常 Report 当前保存哪些字段

**决议（已确认）**

采用严格定义的 Phase 1 字段子集，复刻参考项目已经可用的基础执行结果，但不因协议和
数据库中的预声明形状提前开放后续阶段语义。

- `ok=true` 必须写为 `phase=done, outcome=exec`；`ok=false` 必须写为
  `phase=error, outcome=error`。请求中的 `outcome=direct/silent/evolve` 当前只解析，
  不改变 Phase 1 只有 exec Run 的终态分类。
- 每次成功受理都把 `runs.ts` 更新为注入 Clock 的本次转换时间，并把 `progress`
  清为 `null`。Run finalize 与 lease retire 必须处于同一事务。
- message 采用与参考实现一致、兼容未来 in-run message 的优先级：
  1. 请求显式携带 `body.message` 时使用它；
  2. 未携带时保留 Run 已有的非空 message；
  3. Run 没有 message 时才使用 `body.finalText`；
  4. 三者均无值时保持 `null`。
- success 显式清除旧 `error`；failure 使用清理后非空、非纯空白的 `body.error`，
  否则统一写入 `run failed on machine`。正常 Report 与 G-02 reconcile 共用这套错误
  归一化规则。
- `durationMs` 有值时保存，无值时写 `null`；`sessionId` 有值时保存，无值时写
  `null`。
- 所有进入文本列的 daemon 输入先去除 NUL：message/finalText fallback/error 最多
  保存 2000 字符，sessionId 最多保存 200 字符。
- cursor、taskFileContent、artifacts、transcript、cost、attempts 以及非 exec
  outcome 继续通过 protocol 校验，但当前不得写 Run/Loop，也不得触发通知、快照或
  其他后续阶段副作用。具体包括不修改 `Loop.state`、Task File 内容/同步时间，以及
  Run 的 state、artifacts、transcript、costUsd、usage。

**参考依据与取舍**

`loop-platform-github` 的正常 Report 除上述基础字段外，还会持久化 cursor/Run
state、Task File、artifacts、transcript、cost/attempts，并接受 daemon 声明的
outcome；这些写入依赖成熟的 workflow、Task File、运行详情和后续调度语义。ZHB 的
相关 wire 字段和数据库列是兼容形状预声明，不代表 Phase 1 已开放这些行为。延后消费
它们无需改 wire shape 或数据库迁移，因此不会形成后续大改；反而现在照搬会把尚未定义
的 Loop 级副作用带入可靠性心脏。

测试覆盖 success/failure 的精确 phase/outcome/error、注入时间、progress 清空、
message 优先级和 fallback、文本 NUL/长度处理、duration/session 的有值与缺失分支，
以及携带全部暂不消费字段时 Run/Loop 快照保持零额外写入。

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

**决议（已确认）**

采用方案 C：保留可注入的 Hono app factory，但只把它作为 server 包内模块导出和测试
seam，不新增 `@loopzhb/server/http` package 子路径；对运行者提供构建后启动脚本。

- `src/http/app.ts` 具名导出 `createServerApp(coordinator)`，供同包 HTTP/心脏测试
  直接 import。它只装配 route 并返回新的 Hono app，不读取环境变量、不打开/关闭
  数据库、不监听端口、不注册进程信号，也不持有全局 singleton。
- app factory 接收包内 `RunCoordinator`，HTTP adapter 只调用其 `poll`/`report`；
  `RunCoordinator`、`RunCoordinatorDependencies` 和 app factory 均不进入
  `package.json#exports`。现有 `./db`、`./db/schema` exports 保持不变。
- `src/start.ts` 是唯一 production composition root：读取并校验配置、调用
  `openMigratedDb`、以生产依赖构造 Coordinator 和 app、通过
  `@hono/node-server` 监听，并统一管理 shutdown。host/port/dataDir 的具体规则由
  A-12 决定。
- `SIGINT`/`SIGTERM` 触发同一个幂等关闭流程：先停止接收新请求并等待 HTTP server
  关闭，再关闭 `DbHandle`；启动中途失败也必须释放已经打开的资源。boot 只做 wiring
  和生命周期管理，不承载 Poll/Report 业务逻辑。
- server package 增加
  `"start": "node --enable-source-maps dist/start.js"`；根 package 增加
  `"start": "pnpm --filter @loopzhb/server start"`。`start` 运行已构建产物，不使用
  隐式 `prestart` 自动 build。
- HTTP/心脏测试通过 `createServerApp(...).request()` 或 `app.fetch()` 驱动真实
  Coordinator 和内存 PGlite，不监听真实端口；fixture 拥有并关闭自己的
  `DbHandle`，app factory 不接管资源所有权。

**参考依据与取舍**

`loop-platform-github` 的 `@loopany/server` 同样是 private package，没有通过
`package.json#exports` 暴露 app/gateway/boot；根 `start` 委托 server package
启动构建产物，内部入口自行完成 backend wiring。ZHB 保留该部署边界，但利用 Hono
factory 改善测试隔离，不复制参考项目的全局 boot singleton。

当前没有任何 workspace consumer 需要嵌入 server app；daemon 与 server 的唯一耦合点
仍是 ADR-002 定义的 HTTP wire protocol。将来出现真实嵌入方时再新增 `./http` 是
additive 且改动很小，而现在公开它会迫使包同时暴露 Coordinator 或 composition
dependencies，绕过 A-02/A-03 已锁定的包内边界。因此本决议不需要新增 ADR，记录在
Day 3–4 handoff 即可。

### A-12：启动环境变量与持久化策略

**决议（已确认）**

采用方案 B：启动配置允许环境变量覆盖，但零配置 production boot 也必须默认使用
用户级文件目录持久化，不能因缺少 `LOOPZHB_DATA_DIR` 静默进入内存模式。

- `LOOPZHB_HOST`：trim 后的非空值覆盖默认值；未配置或纯空白时使用
  `127.0.0.1`。默认使用明确的 IPv4 loopback，避免 `localhost` 的 IPv4/IPv6
  解析差异。
- `LOOPZHB_PORT`：未配置或纯空白时使用 `3000`；显式值必须是 1–65535 的十进制
  整数。`0`、负数、小数、指数形式、非数字和越界值全部 fail fast，不静默回退默认
  端口。
- `LOOPZHB_DATA_DIR`：未配置或纯空白时使用
  `path.join(os.homedir(), ".loopzhb")`；显式值 trim 后相对启动 cwd 解析为绝对路径。
  boot 在打开数据库前递归创建目录，并记录最终绝对路径。
- 包内纯函数 `loadServerConfig(env, homeDir, cwd)` 一次性解析配置；`src/start.ts`
  必须先完成配置校验，再打开任何资源。错误不得留到 listen 或首次请求时才暴露。

production `src/start.ts` 始终把解析后的非空 `dataDir` 传给 `openMigratedDb`，实际
数据库位于 `<dataDir>/pgdata`；不得使用无参数调用，也不提供 `:memory:` 等启动环境
捷径。`openMigratedDb()` 无 dataDir 时创建内存库的能力继续保留，但只供测试和显式
包内 fixture 使用。由此，“DB factory 支持内存”与“production boot 永远持久化”成为
两个不同且不冲突的契约。

默认绑定 localhost。显式把 `LOOPZHB_HOST` 配置为非 loopback 地址代表操作者主动选择
受信网络或容器监听；Phase 5 auth 完成前允许启动，但必须记录醒目的无认证暴露警告，
不得把 credential、token 或其他 secret 写入日志。启动成功日志可以记录最终
host、port、dataDir。

**参考依据与取舍**

`loop-platform-github` 的 embedded PGlite 默认使用 `~/.loopany`，并允许
`LOOPANY_DATA_DIR` 覆盖；这说明参考行为是“零配置默认持久化”，而不是要求每次启动
显式声明目录。参考项目当前 Vite dev、base URL 和用户连接示例以 3000 为主；旧
standalone `src/main.ts` 的 8787 不属于当前 package `start` 入口。ZHB 因此采用
`~/.loopzhb` 和 3000，同时保留 roadmap 要求的 loopback 默认。

测试覆盖默认配置、三项 override、空白值、相对 DATA_DIR 绝对化、端口有效边界及全部
非法形式、目录创建失败、production boot 不得打开内存库、默认目录重启后
Machine/Run/RunLease 仍存在，以及非 loopback host 产生安全警告。app factory 和
内存 DB fixture 不读取启动配置。

### A-13：Machine 身份字段的更新策略

**决议（已确认）**

采用方案 B：`lastSeen` 是 Server 持久化的最近 Machine 心跳水位，不是每次 Poll 的
精确审计时间；使用 10 秒刷新窗口抑制 Poll 热路径写放大，身份快照发生变化时立即
更新。

- 只有通过 schema 校验和 Device Credential 验证的 Poll 可以更新 Machine。首次
  自注册 INSERT 使用注入 Clock 的当前时间写 `lastSeen`，同时保存合法身份字段。
- 已有 Machine 的 `lastSeen` 为 null、非法时间、未来时间，或距当前时间已满
  10 秒时刷新；未满 10 秒且身份字段没有变化时，本次 Poll 对 Machine 表只读。
- 任一身份字段发生变化时立即写入，并在同一次 UPDATE 中顺带刷新 `lastSeen`；每个
  已有 Machine 的 Poll 至多执行一次 Machine UPDATE。该心跳/身份更新先于 Run claim，
  不属于某个 claim 事务；单项 claim 竞争失败不得回滚已确认的 Machine 联系。
- 并发 Poll 必须保证 `lastSeen(new) = max(lastSeen(stored), pollTime)`，旧请求晚提交
  不得把水位倒写。节流判断和单调条件必须落实到数据库写入 guard，不能只靠应用层
  先读后写。
- wire `host/platform/arch/version` 分别映射到
  `hostname/platform/arch/daemonVersion`。这些字段是 daemon 最近报告的可变描述
  快照，不是 Machine 主身份；变化不得修改 credential 派生的 Machine ID、
  tokenHash、Loop 绑定或已有 friendly name。
- 字段缺失、去除 NUL 并 trim 后为空时视为“未报告”，保留旧值；非空且变化才写。
  hostname 最多 255 字符，platform/arch/daemonVersion 各最多 64 字符。version
  记录当前报告值，不做只能升级的 semver 比较。
- 首次注册的 `name` 继续遵循 A-01：合法 host 优先，否则使用稳定 machine-ID
  fallback。后续 Poll 只有在已有 `name` 为空时才可用合法 hostname 补齐，人工名称
  或 fallback 不得被 hostname 变化覆盖。
- 不新增 `online` 列，也不维护第二套内存在线真相；未来 presence 和 sweep 都由
  `lastSeen + 注入的当前时间 + 各自阈值` 推导。消费方阈值必须大于心跳持久化间隔与
  正常 Poll 间隔之和。

**参考依据与取舍**

`loop-platform-github` 在约 3 秒 Poll 热路径上使用 10 秒
`LAST_SEEN_REFRESH_MS`，并让 identity 只在变化时写；其在线判断窗口为 30 秒。ZHB
复刻该已验证的写入策略，但不保留参考项目的冗余 `online` 布尔，并补上并发单调
guard、全部身份文本的 NUL/长度防护。节流会改变时间戳的可观察精度，因此在 ZHB
中是显式契约而非未测试的实现细节。

测试覆盖首次 INSERT、10 秒边界、窗口内相同 Poll 零 UPDATE、身份变化时单次合并
UPDATE、缺失/空白字段保留、friendly name 稳定、文本清理与上限、非法/未来水位
纠正、两个并发 Poll 不倒写、非法 credential/body 零写入，以及 schema/迁移仍无
`online` 列。

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

## 五、澄清完成状态

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

已由 owner 拍板并回写的 ASSUMPTION：

- [x] A-01：首次 Poll 是 Phase 1 唯一自注册入口；开放模式按 credential 派生并幂等创建 Machine。
- [x] A-02：心脏深模块统一为 `RunCoordinator`，包内接口仅含 enqueue/poll/report。
- [x] A-03：注入单一 dependencies 对象，显式区分 DB、Clock、Run ID 与 Run Credential mint。
- [x] A-04：保持参考 trigger 行为，并将 supersede + insert 收敛为原子 enqueue。
- [x] A-05：无竞争时尝试领取全部 eligible exec Runs，按 ts/id 升序且逐 Run 原子竞争。
- [x] A-06：全部控制 caps 显式 false，能力随 route 同批开放且不追溯既有 lease。
- [x] A-07：空 systemPrompt + 最小 one-pass exec task；真实 Agent E2E 要求本地 taskFile。
- [x] A-08：正常 Report 采用明确的 Phase 1 基础字段子集，其余预声明字段零业务写入。
- [x] A-09：竞态输家统一返回 `run_capability_invalid` 401。
- [x] A-10：HTTP 状态与 `apiErrorSchema` 映射已由 G-04 解决。
- [x] A-11：app factory 保持包内测试 seam，唯一 production boot 启动构建产物。
- [x] A-12：环境变量可覆盖，零配置 production boot 默认持久化到 `~/.loopzhb`。
- [x] A-13：lastSeen 使用单调的 10 秒持久化水位，身份快照只在变化时更新。
- [x] A-14：orphaned Run 统一使 capability 失效并清理孤儿 lease。

CONFLICT、GAP 与 ASSUMPTION 已全部收口。后续进入实现时：

1. 以 `codex-handoff-pollReport-plan.md` 作为执行计划，以本文件作为决策追踪依据。
2. 实现中若发现代码事实与已确认决议冲突，先重新打开对应条目，不得静默改写语义。
3. 只有新证据改变 Accepted ADR 的语义时，才修订 ADR 或新增 superseding ADR。
