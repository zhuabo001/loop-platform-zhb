# Phase 4 Batch 3 开发计划：最小 Dashboard 与阶段收口

## 1. 目标与实施基线

基于 `feat/phase4-batch3-dev@e51894b`，按照 Phase 4 总路线图交付本机 Dashboard，并完成整个 Phase 4 的验收和遗留问题核销。

本批固定范围：

- Hono SSR 页面，提供 Loop 列表、运行观察和唯一的 Run Now 按钮。
- Dashboard 使用中文文案，保留 Open、Closed、Completed、Paused、Run Now 等领域术语。
- 纳入开放 Issues #33、#36、#51、#52、#53 的复核、必要修复及后续核销。
- 完善确定性测试、真实 Claude E2E、重启验收及长期文档。
- 不新增数据库迁移、公共 JSON DTO、前端框架或客户端 JavaScript；Goal、Task File、Schedule、Reopen 编辑继续使用现有管理 API。

按五个切片推进，每个切片完成相应验证后进入下一切片。原路线图的 2–3 天作为 Dashboard 和集成工作的估计，遗留问题整改、复审与真实门另计。

## 2. Dashboard 读取、页面与安全边界

### 切片一：只读数据与页面

新增独立 Dashboard 模块，由生产启动入口装配。HTTP 层只依赖读取和触发的窄接口，不直接查询数据库或承担生命周期逻辑。

读取行为固定如下：

- 沿用现有 Loop 列表的 `updatedAt DESC, id ASC` 排序及 100 条上限，页面说明显示范围。
- 复用现有安全字段投影、Run 映射及 `nextFireAt` 计算，禁止读取 state、Task File 内容、transcript、credential 等无关字段。
- 最新 Run 沿用当前最新 exec Run 的定义：`ts DESC, id DESC`。
- 单独批量读取 pending/running 活跃状态及 progress，覆盖所有 role；不能从 `lastRun` 推断是否存在活跃 Run。pending 与 running 同时存在时分别展示。
- 按本页 Loop 的 machineId 查询 capability，不能依赖有独立截断上限的 machine 列表，也不能按版本字符串判断兼容性。
- 查询按批执行，避免逐 Loop 查询历史 Run。

页面使用 `hono/html` 服务端模板及固定 CSS，采用单列 Loop 卡片，窄屏自动换行。每张卡片展示：

- 名称、Loop 标识、Open/Closed 类型及 Completed/Paused 状态。
- pending/running 状态，运行进度 step、label、时间。
- goal、cron、timezone、next fire。
- Task File 路径、最近成功同步时间、最近失败尝试时间与告警。
- 最新 exec Run 的 phase、status、message、error，以及 Loop 的 completion reason。
- 缺少 `terminal-journal-v1` 时的升级提示。

Open/Closed 由 goal 决定；Completed 优先于 Paused，完成后仍可能存在迟到的 running Run，因此生命周期与活动状态分开显示。时间使用明确标注的 UTC，缺失值显示“暂无”，空列表显示简短说明。长文本和路径换行，状态与禁用原因不能只靠颜色表达。

### 切片二：路由与安全装配

新增两个 HTML 路由：

| 路由 | 行为 |
|---|---|
| `GET /` | 返回 Dashboard，HTML 每 3 秒刷新 |
| `POST /dashboard/loops/:id/run` | 校验表单及 CSRF，执行原子手动触发 |

由启动配置调用现有 `isLoopbackHost()` 决定是否挂载。非 loopback 时两个路由均返回 404；请求中的 Host 或转发头不能开启 Dashboard。

安全实现固定为：

- 每次 Server bootstrap 生成一个 32 字节随机 CSRF token，仅保存在该实例内存中，通过隐藏表单字段提交；不写入 URL 或日志。重启后旧 token 失效。
- POST 只接受 URL 编码表单，限制为 4 KiB，要求恰好一个有效 token，并在调用 Coordinator 前完成校验。
- 缺失、重复或错误 token 返回 403；格式错误返回 400，不支持的媒体类型返回 415，超限返回 413，均不得触发运行。
- 通过校验的业务结果，无论创建成功、已有活跃 Run、Loop 已完成或已不存在，统一 `303 Location: /`。未知服务端异常返回固定 500，不伪装为成功。
- Dashboard 响应设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
- CSP 使用 `default-src 'none'`、`script-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`、`form-action 'self'`；固定内联 CSS 通过内容 SHA-256 授权，不使用 `unsafe-inline`。
- 所有动态文本和属性使用模板转义；Loop ID 作为路径段编码，用户值不得进入 raw HTML、CSS 或脚本。

## 3. Run Now 原子行为与遗留问题

### 切片三：禁止 Dashboard 替换已有 pending

扩展 Coordinator 内部 manual trigger 参数，增加 `pendingPolicy: "skip" | "supersede"`，默认保持 `"supersede"`；Dashboard 显式使用 `"skip"`。该参数不进入公共 HTTP 请求 DTO。

事务行为：

- Completed Loop 拒绝触发。
- 任意 role 存在 running 时跳过；Dashboard 模式下任意 role 存在 pending 也跳过。
- 跳过时不创建、取消或更新 Run，不推进 watermark，不修改 Loop revision。
- 无活跃 Run 时，沿用现有 Loop revision CAS 与有界重试，在同一写事务中取得写权限并插入一个 pending exec Run。
- CAS 冲突后重新解析 Loop 并重新检查活跃状态，不复用旧页面或旧查询结果。
- 新增仅内部使用的 `pending_exists` 结果；Dashboard 成功创建时 `supersededRunIds` 必须为空。
- 保留现有同 Loop enqueue 串行化，以及管理 API、cron、catch-up 的默认 T7 行为。

按钮规则与后端规则一致：pending、running、completed 时禁用；Paused 且未完成、没有活跃 Run 时可用。capability 缺失只显示升级提示，不额外改变触发规则。

### 切片四：核销五个开放 Issue

- **#33、#36：** 按 Issue 关闭条件复核已有修复和测试，重点验证深层 state、数据库可写域、finish message 的 NUL/UTF-8 字节边界。缺口才补测试，不重复实现已有修复。
- **#51：** provider bootstrap 错误改为稳定、无路径值的消息。覆盖非法 JSON、schema、允许字段类型错误、不可读文件；配置路径含伪 token 时，异常和 daemon 日志均不得回显。保持缺失文件兼容、启动失败关闭和资源回收行为。
- **#53：** 增加临时 settings fixture 驱动的生产 daemon CLI 确定性 E2E。清除继承的 provider 凭据，证明 planted secret 确实进入 agent 环境，并验证正常输出脱敏，以及至少一种派生编码在 state/Task File 路径上的拒绝行为。秘密不能进入被接受的 Journal 结果、晋升 state、同步快照、Report/DB、HTTP 响应或 daemon 日志；保留显式环境覆盖 settings 的独立用例。
- **#52：** 修正仍写“待实施”的 provider 计划，以及 ADR-006 正文和 CLI composition 注释中的启动顺序。按当前事实记录 #50/#49/#38 已通过的历史链路，不恢复过时阻塞状态；roadmap 指向实际仍开放的问题。

每项关闭必须具备修复提交或已有修复定位、验证证据及后续复审核销记录，不能仅凭本轮实现自行关闭。

## 4. 测试编组与阶段验收

### 确定性测试

| 编组 | 必须覆盖的场景 |
|---|---|
| **D1–D5：读取与展示** | 空列表；列表排序与上限；生命周期组合；最新 Run 已结束但旧 Run 仍活跃；pending/running 同时存在；progress、同步告警、capability 提示；无敏感字段投影 |
| **H1–H6：HTTP 与安全** | loopback 开放、非 loopback 双路由 404；动态文本和属性 XSS；CSP/refresh/no-store；有效及非法 CSRF；实例隔离与重启失效；业务结果 303、异常 500 |
| **Q1–Q6：触发与竞态** | idle/paused 创建；pending/running/completed 零写跳过；重复提交；两个 Coordinator 的 resolve/write 交错；claim/finish/cron 竞争；既有 API supersede 和调度水位回归 |
| **S1–S3：遗留安全项** | #51 无值错误与启动日志；#53 settings secret 全链路及派生编码拒绝；#33/#36 原关闭条件复验 |
| **E1–E2：完整链路** | Dashboard 触发→state→finish→最终页面；Completed 后跨 occurrence 连续重启不新增 Run |

竞态测试必须使用真实事务和既有测试 hook 安排提交顺序，并比较 Run/Loop/Lease 快照，证明无意外取消、插入或部分写入。双 Dashboard 提交必须只产生一个 pending；与 cron 竞争时，Dashboard 不替换先到的 active Run，cron 仍遵循既有 T7 规则。

重启测试复用文件型 PGlite、真实 HTTP、生产 bootstrap 和 Scheduler。关闭时先 drain Scheduler，再关闭 listener 和数据库；同一数据目录连续重启至少两次，推进测试时钟跨过多个合法 occurrence。加入可正常 catch-up 的未完成 Loop 对照，证明测试确实执行了恢复逻辑。Completed Loop 的 Run 数量、完成字段和 state 保持不变。

### 切片五：真实 Claude 门

在现有 Batch 2 真实 E2E 上扩展，新增 `pnpm test:phase4:e2e` 入口；旧 Batch 2 命令保留可用，共享同一测试链路，默认测试不触发真实 Claude。

验收步骤：

1. 使用批准 SHA-256 的真实 Claude、生产 Daemon、真实 OS sandbox、真实 HTTP 和文件型 PGlite；listener 就绪后启动生产 Scheduler。
2. 创建带 goal、Task File 和 cron 的 Closed Loop，GET 页面取得 token，经 Dashboard POST 发起第一次 Run。
3. 第一次 Run 修改 Task File 的 Timeline 并 report state；校验磁盘内容变化、同步快照和 state 晋升。
4. 第二次 Run 读取前次 state 和文件标记，并将实际观测证据写入 finish reason；校验 Completed、调度停用、API Run Now 拒绝及页面按钮禁用。
5. 保留同一数据库连续重启 Server 两次。完成后的恢复阶段使用现有 Clock 注入跨越合法 occurrence，保留生产 Scheduler，验证没有新增 Run。
6. 校验 Dashboard 最终 status、message、completion reason、同步时间，以及 Claude provenance、日志无 secret、进程组关闭和临时资源回收。

真实门继续遵循已有认证、批准哈希和费用授权要求。确定性通过不能替代真实门；执行失败必须记录实际原因。

## 5. 完成条件与交付

完成全部切片后执行：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check "$(git merge-base HEAD main)"...HEAD
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256> pnpm test:phase4:e2e
```

交付标准：

- Dashboard 满足本机可见、只读观察加一个按钮、零客户端 JavaScript 的约束。
- 新增安全及竞态测试通过，既有公共 API、调度和 v0 兼容测试通过，无新增 migration。
- 对最终提交进行 Standards、Spec、Adversarial 三轨复审；核销五个遗留 Issue 及本批新增阻塞项。
- 将 Dashboard、CSRF、no-supersede 的长期裁决写入 ADR-009，provider 修订同步 ADR-006。
- 扩展 `docs/tests/phase4-acceptance.md` 为整个阶段的验收证据，保留 Batch 2 历史，追加最终提交、环境、命令、真实门结果及测试编号。
- README 补充本机 Dashboard 使用方法和按钮规则；所有门禁通过后，roadmap 才标记 Batch 3 与 Phase 4 完成。
- 审查过程继续留在不入库的 handoff，PR 描述引用 ADR 和 Issue。
