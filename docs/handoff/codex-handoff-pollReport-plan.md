# Day 3–4：Poll / Report 心脏链路开发计划

## 总结

在现有 protocol DTO、PGlite 四表 schema 和 79 个绿色测试之上，引入 Hono，交付可测试、可启动的机器调度服务：

- 正式端点为 `POST /api/machine/poll`、`POST /api/machine/report`。
- 先完成 T1–T3，再实现 store、gateway 和 HTTP adapter。
- 同批交付 T7 的 coordinator 骨架，以及 cancel、terminal-grace 所需的事务原语；暂不提供 cancel/sweep HTTP 端点。
- 不修改数据库 schema，不生成新 migration。

## 核心实现

### 1. 深模块与事务

建立 `RunCoordinator` 深模块，包内接口仅包含 `enqueueExecRun`、`poll`、`report`；
owner/manual-trigger、Machine Poll、Machine Report adapter 分别只调用对应方法，模块
接口不等于 HTTP 权限表面。Phase 3 Scheduler 到来后复用 `enqueueExecRun`，不得绕过
`RunCoordinator` 自行编排 store；本阶段不额外建立 `MachineGateway` 包装层。

构造时注入单一 `RunCoordinatorDependencies` 对象：

- `db` 为具体 Drizzle `Db`，不含由 boot 管理的 open/migrate/close/dataDir 生命周期；
- `clock.now(): Date` 在 production/Fake Clock 间形成真实 seam，Coordinator 与内部
  store 的生命周期写入不得绕过它读取系统时间；
- `newRunId` 与 `mintRunCredential` 分开，分别表达标识生成和 capability secret
  mint，不合并为 `Ids`；production 使用 UUID 与 `rk_` 加密码学随机字节；
- 确定性 hash/ID 派生函数不注入，store 不建立公开 repository port。

测试使用真实独立内存 PGlite、Fake Clock 和确定性/故障 factories；必须验证 DB
隔离、时间戳、Delivery credential 与 DB hash 对应，以及 factory 失败时事务回滚。

store 内部统一承担以下原子操作：

- `enqueueExecRun`：若该 Loop 已有 running Run，则跳过本次触发且零写入；否则在
  同一事务内把全部旧 pending exec Run 转为 `canceled/skipped`、更新各自的 Run
  Transition Time，再插入恰好一个新的 pending exec Run，作为 T7 coordinator
  骨架。若任一 phase guard 输给并发 Poll claim，或 supersede/insert 任一步失败，
  整体回滚，不得在 running Run 后排入 pending，也不得提交“旧 Run 已跳过但替代
  Run 未入队”的中间结果。`RunCoordinator` 按 Loop 做进程内串行化；多实例数据库
  竞争留在 Phase 6 的真实 Postgres 验证。
- claim：条件更新 `pending → running`，并插入 SHA-256 RunLease；两步同一事务，lease 插入失败必须回滚 Run。
- report：事务内重新解析 lease、锁定同一 Run 行，再检查 phase；Run finalize 与 lease 删除同一事务。
- cancel 原语：锁定 Run，更新为 `canceled` 并删除 lease；不暴露 HTTP 路由。
- `reclaimStaleRun` 原语：在同一事务中把被 sweep 判定失联的 running Run 转为
  `phase=error/outcome=error`，写入稳定通用原因
  `machine timed out / disconnected`，把 `runs` 表的 `ts` 列更新为本次转换时间，
  并把对应 active lease 转为 `terminal-grace`、写入首次 `now + 24h` 的过期时间。
  重复 reclaim 不得延长窗口。
- `terminalizeLease` 仅为 `reclaimStaleRun` 的 store 私有步骤；不得进入
  `RunCoordinator`、HTTP 或其他通用公开接口。只有 sweep 编排可以调用
  `reclaimStaleRun`，report、cancel、正常失败 finalize 与管理员操作均不得借此制造
  reconcile 资格。
- 过期 terminal-grace lease 在 resolve 时惰性删除；retire 为单发删除。

### 2. Poll 与 Delivery

- Bearer token 必须符合 `dk_` 形状；`POST /api/machine/poll` 是 Phase 1 唯一的
  Machine 自注册入口。首次合法 Poll 在未启用 auth 的模式下按 credential 派生
  machine ID、保存完整 credential hash 并创建 Machine，然后继续处理同一次 Poll；
  `name` 优先使用清理后的非空 `host`，缺失时使用基于 machine ID 的稳定 fallback。
  INSERT 同时写入注入 Clock 的 `lastSeen` 和合法身份快照。首次 Poll
  重试或并发时，同 hash 必须幂等收敛到同一行，不同 hash 必须 401，不得因主键竞争
  暴露 500；后续 Poll 同时校验派生 machine ID 和完整 hash。Phase 5 保留此 Poll
  自注册协议，只在创建分支前增加有效 connect key/owner 校验。
- `lastSeen` 是持久化 Machine 心跳水位而非逐 Poll 审计时间：null、非法、未来或距
  当前时间已满 10 秒时刷新；窗口内身份不变的 Poll 对 Machine 表只读。身份变化时
  在同一次 UPDATE 中写入快照并顺带刷新水位，每个已有 Machine 的 Poll 至多一次
  UPDATE。并发写必须在数据库 guard 中保证
  `lastSeen(new) = max(lastSeen(stored), pollTime)`，不得倒退。
- `host/platform/arch/version` 映射为
  `hostname/platform/arch/daemonVersion`，去除 NUL、trim 后空值视为未报告并保留
  旧值，只有非空变化才写；上限分别为 255/64/64/64 字符。它们只是可变身份快照，
  不改变 Machine ID、tokenHash、Loop 绑定或已有非空 friendly name；只有空 name
  可由合法 hostname 补齐。
- Machine 心跳/身份更新发生在合法 Poll 的 credential 验证之后、Run claim 之前，
  不属于某个 claim 事务；claim 竞争失败不回滚已确认的联系。非法 credential/body
  零 Machine 写入。`progress` 和 `wait` 当前只解析、不产生 Phase 2 行为。
- 不新增 `online` 列或内存在线真相；未来 presence/sweep 都由 lastSeen、注入当前
  时间和各自阈值推导，阈值必须大于持久化间隔与正常 Poll 间隔之和。
- 只 claim `exec` Run；每个成功 claim 同时获得新的 `rk_` token，数据库只保存 hash。
- Delivery 固定包含协议要求的完整字段：machine roots、Loop 快照、`prevState`、
  `systemPrompt=""`，以及纯函数 `buildExecTask(loop)` 产生的最小 one-pass 指令。
  task 使用 JSON 字符串编码携带 Loop id/显示名称；有 `taskFile` 时要求先读取并执行
  其中任务，没有时明确标记“无真实 Agent 任务来源”，然后均以 `Run once, then
  stop.` 收尾。当前由 Fake/真实 Runner 调用 Report endpoint，task 不得宣传尚未实现
  的 in-run `loopany report/finish`，也不提前加入 evolve/edit、workflow、prevState、
  state、控制动作、artifact 或完整 Task File 生命周期语义。Phase 2 真实 Agent E2E
  必须使用配置了本地 `taskFile` 的 Loop；后续 prompt 演进只替换 builder。
- Phase 1 mint RunLease 时显式写入 `allowControl=false`、全部 `canSet*=false`、
  `canFinish=false`，不得依赖数据库默认值；预声明字段不等于能力已开放。Delivery
  的 `loop.allowControl` 仍携带真实 Loop 配置，但配置意图不构成本次 lease 的有效
  授权。Report 权限来自 coherent active RunLease，不依赖控制 caps。未来任一能力
  必须与对应 route、mint policy 和 401/403/409 测试同批开放，且只作用于新 lease，
  不得追溯激活既有 active lease。
- 同一 Machine 的一次 Poll 在无竞争时尝试领取全部 eligible pending exec Runs：
  `run.machineId` 必须匹配、`phase=pending`、`role=exec`，且对应 Loop 能构造合法
  Delivery。候选按 `runs` 表 `ts` 列升序、再按 `run.id` 升序。每个 Run 独立执行
  条件 claim + lease insert 事务，整个批次不承诺全有或全无；并发 Poll 可以瓜分
  候选，但每个 Run 至多产生一个 Delivery 和一条 active lease。Phase 1 不设置领取
  数量或 daemon 并发上限；未来背压需要 daemon 队列或 additive capacity 信号，
  不以单次 Poll `LIMIT` 冒充并发控制。
- claim 事务一旦提交，Run 就永久失去派发资格。即使首次 Delivery HTTP 响应丢失，
  后续 Poll 也只能看到该 Run 已是 running，必须返回空而不能重建 Delivery、重新
  mint credential 或把 Run 放回 pending；同一或其他 daemon、server 重启后均适用。
  系统无法判断响应是否到达，因此宁可让未完成 Run 后续被 sweep 回收为可观察 error，
  也不冒险重复执行。

### 3. Report 状态机

- Report 将 Bearer token 视为 opaque Run Credential，直接计算 SHA-256 并 resolve
  RunLease；读取侧不得用 `isRunTokenShape` 预先拒绝 legacy bare UUID。当前 server
  新 mint 的 credential 仍必须符合 `rk_` 形状。请求体 `runId` 仅作回声，lease 中的
  Run 为唯一权威。
- 正常 running Run：
  - `ok=true` 写为 `done/exec`；
  - `ok=false` 写为 `error/error`，使用清理后非空、非纯空白的 `body.error`；
    缺失、空或纯空白时统一写入 `run failed on machine`。success 显式清除旧 error；
  - message 的优先级为：显式 `body.message`、Run 已有非空 message、
    `body.finalText` fallback；均无值时保持 null；
  - `durationMs`、`sessionId` 有值时保存，无值时写 null；进入文本列前统一去除 NUL，
    message/finalText fallback/error 最多保存 2000 字符，sessionId 最多保存 200
    字符；
  - 每次成功受理都清除 progress，并把 `runs` 表的 `ts` 列更新为注入 Clock 的本次
    转换时间；
  - finalize 与 lease retire 同事务。
- terminal-grace + error Run 允许恰好一次 reconcile：
  - `ok=true` 把 Run 从 `error` 翻正为 `done`、清除旧 reclaim error；
  - `ok=false` 保持 `error/error`，以非空 `body.error` 替换 reclaim 原因；缺失或
    空 error 时使用稳定 fallback `run failed on machine`，不得继续保留 sweep
    timeout 原因；
  - 两个分支都按正常 Report 的 Phase 1 字段策略保存基础字段、清除 progress，并把
    `runs` 表的 `ts` 列更新为本次 reconcile 时间；失败分支不推进任何 Loop
    cursor/state；
  - Run 更新与 terminal-grace lease 删除必须在同一事务中，任一步失败整体回滚；
    成功受理均返回 `{ok:true,reconciled:true}`，第二次 report 返回统一 401 且零
    副作用。
- canceled Run 或 report/cancel 竞态中失去 phase guard：按 Run Capability 已失效处理，
  返回 401，禁止任何 Loop 级写入。
- Phase 1 不实现 `done + active lease` enrich。该组合当前没有合法来源；若出现则按
  stale capability fail closed，在同一事务中删除残留 lease、记录内部
  `stale_phase` 原因，不修改 Run/Loop，并返回 401。等 Phase 4 的 finish 动词落地时
  再增加合法的一次性 enrich 转换。
- lease 存在但 Run 不存在时按 orphaned capability fail closed：删除孤儿 lease、
  记录 invariant violation、不产生 Loop 写入，并返回 401。
- cursor、taskFileContent、artifacts、transcript、cost、attempts 和非 exec outcome
  当前只通过 schema 解析，不写入 Run/Loop，不触发通知、快照或后续阶段语义；具体
  不修改 `Loop.state`、Task File 内容/同步时间，以及 Run 的 state、artifacts、
  transcript、costUsd、usage。成功 Report 的 outcome 固定为 exec。
- Run Capability 因 unknown、expiry、正常 report 消费、cancel 撤销、竞态失败、
  orphaned Run 或 stale phase 而失效时，外部统一返回
  `{error:"invalid or expired run capability",code:"run_capability_invalid"}` 及 401；
  具体原因只进入服务端日志。成功 report 后，同 credential 的任何重复 report
  因此返回 401，Run、Loop 与全部副作用保持不变。
- 有效 capability 但缺少权限的未来动词使用 403；有效 capability 与当前生命周期
  冲突的操作使用 409。`terminal-grace + error + report` 是 ADR 明确允许的一次性
  reconcile，不属于 capability invalidation。

## HTTP 与启动接口

- 新增 `hono`、`@hono/node-server` 并更新 lockfile。`src/http/app.ts` 具名导出包内
  `createServerApp(coordinator)` 测试 seam；它只装配 route 并返回独立 Hono app，
  不读取环境变量、不管理 DB、不监听端口、不注册信号或使用全局 singleton。HTTP
  route 只负责认证头、JSON/schema 解析、调用 Coordinator 和返回响应。
- 两个端点统一使用 2 MiB wire body cap；所有 route、body-limit、not-found 和全局
  exception 分支均通过集中的 JSON error helper 返回 `ApiError`，响应必须通过
  protocol 的 `apiErrorSchema`，并设置 JSON Content-Type：
  - 非法 JSON 或 DTO：400 + `{error:"invalid request"}`；
  - 无效 Machine Credential：401 + `{error:"invalid machine credential"}`；
  - 无效、过期、已消费或已撤销的 Run Capability：401 +
    `{error:"invalid or expired run capability",code:"run_capability_invalid"}`；
  - 超限：413 + `{error:"request body too large"}`；
  - 未知路由：404 + `{error:"not found"}`；
  - 未捕获异常：500 + `{error:"internal server error"}`。
- `code` 保持 protocol 定义的可选 additive 字段；本批次只有已经锁定的
  `run_capability_invalid` 必须携带 code，其他错误不提前创造 code。Zod issues、
  异常消息、stack 和数据库细节只进入服务端日志，不得进入响应。
- 不新增 `@loopzhb/server/http` package export，也不公开 `RunCoordinator` 或其
  dependencies；现有 `./db`、`./db/schema` exports 保持不变。未来出现真实嵌入方时
  再 additive 地开放子路径。
- `src/start.ts` 是唯一 production composition root：open/migrate DB、构造生产
  Coordinator 和 app、通过 `@hono/node-server` 监听，并在启动失败或
  `SIGINT`/`SIGTERM` 时幂等地先关闭 HTTP server、再关闭 DB。配置规则由 A-12
  决定，boot 本身不得承载 Poll/Report 业务逻辑。
- server package 的 `start` 执行
  `node --enable-source-maps dist/start.js`，根 `start` 委托
  `pnpm --filter @loopzhb/server start`；启动脚本只运行已构建产物，不通过隐式
  lifecycle script 自动 build。
- 启动配置固定为：
  - `LOOPZHB_HOST` 未配置或纯空白时默认 `127.0.0.1`；显式非 loopback 值允许受信
    网络/容器监听，但 Phase 5 auth 前必须记录醒目的无认证暴露警告；
  - `LOOPZHB_PORT` 未配置或纯空白时默认 `3000`；显式值只能是 1–65535 的十进制
    整数，非法值启动失败；
  - `LOOPZHB_DATA_DIR` 未配置或纯空白时默认
    `path.join(os.homedir(), ".loopzhb")`，显式相对路径按启动 cwd 解析为绝对路径。
- 包内纯函数 `loadServerConfig(env, homeDir, cwd)` 在打开资源前一次性校验配置；
  boot 创建数据目录并始终把非空 dataDir 传给 `openMigratedDb`，数据库位于
  `<dataDir>/pgdata`。production 不允许隐式或显式内存启动；无 dataDir 的 DB factory
  只供测试 fixture 使用。启动日志可记录最终 host/port/dataDir，但不得记录 secret。
- 增加 server `start` 脚本；测试全部通过 Hono `app.fetch`/`app.request`，不启动真实端口。
- 更新 server package 描述和 handoff，记录 `/api` 前缀及实际完成范围。

## 测试与验收

- T1：同一 pending Run 的并发 poll 中，恰好一个响应含 Delivery；最终只有一个 running Run 和一条 active lease。
- T2：领取后的重复 poll 返回空 deliveries，不生成新 Run、lease 或 token。
- 多 Run Poll：同一 Machine 的多个 eligible pending exec 在无竞争时由一次 Poll
  全部领取，响应按 `ts ASC, id ASC`；其他 Machine、非 exec 和不可构造 Delivery 的
  候选不被领取。两个并发 Poll 的 Delivery 并集无重复，单项竞争失败不阻断其余候选。
- Lease caps：Loop `allowControl=true/false` 时，Phase 1 mint 的全部控制 caps 均为
  false，且由写入路径显式持久化；Delivery 保留真实 Loop 配置，全 false 的 active
  lease 仍能完成正常 Report。
- Delivery task：精确断言空 `systemPrompt`、有/无 task-file 两个最小模板、Loop
  元数据 JSON 编码、无未替换变量或未开放能力文案，并让完整结果通过
  `deliverySchema`。
- T3：首次 report 返回 200 并落库；第二次返回 401；前后 Run/Loop 快照证明无重复副作用。
- Report 字段策略：分别验证 success/failure 的精确 phase/outcome/error、注入
  Clock 的 ts 与 progress 清空；覆盖显式 message、已有 message、finalText fallback
  的优先级，文本 NUL 清理和 2000/200 字符上限，以及 durationMs/sessionId 有值与
  缺失分支。携带非 exec outcome、cursor、taskFileContent、artifacts、transcript、
  cost、attempts 时仍固定 done/exec，且 Run 高阶字段与 Loop 快照零额外写入。
- HTTP app 边界：每个 `createServerApp` 调用返回独立实例且 import/构造不打开 DB、
  监听端口或注册信号；测试通过 app.fetch/request + 自有内存 PGlite fixture 驱动，
  fixture 负责关闭 DbHandle。构建产物包含 `dist/start.js`，package exports 不新增
  `./http` 且不泄漏 Coordinator 类型。
- 启动配置：覆盖三项默认值、override、空白输入、相对 DATA_DIR 绝对化和目录创建
  失败；port 接受 1/65535，拒绝 0、负数、小数、指数形式、非数字和越界值。证明
  production boot 永远传入文件 dataDir，默认目录重启后 Machine/Run/RunLease
  仍存在；非 loopback host 产生无认证暴露警告，app factory/内存 fixture 不读取
  启动配置。
- Machine 心跳与身份：首次 Poll INSERT 身份快照和 lastSeen；10 秒内相同 Poll
  对 Machine 零 UPDATE，边界到达后刷新，身份变化在窗口内也只做一次合并 UPDATE。
  覆盖缺失/空白字段保留、friendly name 不被覆盖、NUL/长度处理、非法/未来水位
  纠正、并发 Poll 不倒写，以及非法 credential/body 零写入；schema/迁移继续无
  `online` 列。
- T7：连续 enqueue 时全部旧 pending exec 变为 `canceled/skipped`，且只留下一个新
  pending exec；存在 running 时本次触发零写入。注入 insert 失败必须证明旧 pending
  回滚，Poll 抢先 claim 必须证明 enqueue 回滚且不追加 pending；同进程两个并发
  enqueue 最终只产生一个新 pending。
- Delivery 丢失：让第一次 Poll 完成 claim/lease commit 后丢弃响应，再次 Poll 必须
  返回空 deliveries；Run 仍为原 running 行、Lease 仍为原 hash，不生成新 Run、
  Lease 或 credential。Day 8–10 再推进 Fake Clock 并执行 sweep，验证它最终进入
  error 且全程未重派。
- report/cancel 交错：使用应用层 gate/deferred promise 让 report 完成初始 resolve
  后暂停，随后让 cancel 的 PGlite 事务真实 commit，再恢复 report 执行事务内二次
  验证；断言 report 返回统一 401、Run 保持 canceled、lease 不存在且 Loop 零写入。
  该测试只验证应用层编排、真实事务提交和写前 guard，不宣称覆盖数据库锁竞争或
  隔离级别。
- 事务守卫：
  - lease INSERT 故意失败时 claim 整体回滚；
  - `reclaimStaleRun` 原子提交 Run error 与 lease terminal-grace，terminalize 必带
    expiry，并断言 Run 的通用 reclaim reason 为
    `machine timed out / disconnected`；重复 reclaim 不延长首次窗口；
  - 非 `running Run + active lease` 不得被 reclaim，正常失败不得获得
    terminal-grace；store/gateway 公开面不存在通用 `terminalizeLease`；
  - reconcile success 将 error 翻正为 done 并清除 reclaim 原因；reconcile failure
    保持 error，以 daemon 的非空真实错误或 `run failed on machine` 替换 reclaim
    timeout，不推进 Loop state；
  - reconcile 的 Run 更新与 lease 删除做故障注入：任一步失败均整体回滚；首次成功
    返回 `{ok:true,reconciled:true}`，第二次返回 401 且 Run/Loop 快照不变；
  - cancel 后不存在 active lease；
  - report 在事务内发现 canceled/phase 已变化时不写任何终态或 Loop 数据。
- 协议与安全：
  - malformed/mismatched device token、unknown/expired/retired Run Credential、
    JSON、schema 和超大 body；
  - mint 测试单独验证新 Run Credential 符合 `rk_`；Report 读取侧测试 legacy bare
    UUID 只要对应 lease 存在仍可完成；
  - body.runId 伪造不能越过 lease；
  - 未启用字段不会修改 Loop/Run；
  - Delivery 与 report 响应分别通过 protocol schema 校验；
  - 400/401/413/404/500 的 body 均通过 `apiErrorSchema`，精确断言稳定
    status/error/必要 code 和 JSON Content-Type；404 不使用 Hono 默认文本，注入的
    gateway 异常不得把异常消息、stack 或数据库信息泄漏到 500 body。
- 完成验证：
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `pnpm -r build`
  - `pnpm --filter @loopzhb/server db:check`
  - `git status --short`

## 阶段边界与回归基线

- 当前 62 个 protocol 测试和 17 个 server 测试继续作为回归基线。
- PGlite 用于本阶段验证应用层交错编排和真实事务提交；真实 PostgreSQL 的多物理连接、
  行锁竞争、隔离级别、死锁与重试验证仍属于 Phase 6。
- Day 3–4 不包含手动 trigger HTTP、sweep、cancel HTTP、daemon、真实 Agent、cron、通知或 Dashboard。
- 未完成认证前，启动入口默认仅绑定 localhost，不作为公网部署形态。
