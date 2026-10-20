# ADR-011：Phase 5 Batch 3——身份模型、登录 Session 与旧数据认领

- 状态：Accepted
- 日期：2026-10-07
- 关联：ADR-010（Artifact 同步基础，决策 7 namespace 可信归属）、`docs/plan/codex-phase5-batch3-slices-plan.md`
- 实现：Batch 3 片 1（本文档的决策条目先于行为代码写入，作为片 2–7 的契约依据）

## 背景

Phase 5 Batch 3 建立单用户登录与团队归属闭环：GitHub 用户登录后获得个人团队；管理 API 和 Dashboard 只显示该团队资源；未知或未认领机器不能通过 poll 注册；运维可在 Server 停止后将旧机器及其 Artifact 历史显式认领给已登录用户。身份模型、Team namespace 格式、Session 持久化形态与认证配置策略横跨全部七个切片，任何一处含糊都会在后续切片放大为返工。片 1 在不开放登录路由、不改变生产行为的前提下冻结这些契约。

## 决策

### 1. 身份模型：GitHub 数字 ID 即主键

`users.id` 直接保存 GitHub.com 数字用户 ID 的十进制字符串，并作为主键——唯一外部身份键即 PK，「GitHub ID 唯一」由主键约束承载，离线认领 CLI 按数字 ID 查找即主键查找。`username` 只是可变展示信息，每次登录刷新（片 2 行为），不参与身份判定。DB CHECK（`users_id_github_numeric_ck`）钉住十进制形态。已知边界：users.id 与 GitHub 耦合，未来引入多身份提供商需要加列迁移；批次规则内不预留。

### 2. Team id 格式与 namespace 切换预留

Team id 格式冻结为 `t-<16 位小写十六进制>`，DB CHECK（`teams_id_namespace_ck`）保证它满足 BlobStore 的 `NAMESPACE_ID_RE`（`/^[a-z0-9][a-z0-9-]{0,63}$/`）。片 3 将生产 Attribution Resolver 的派生从 Machine namespace 切换为 Team namespace（`namespaceId = teamId`），片 4 离线认领在复制 Blob 后以单事务切换元数据；存储键 `(namespaceId, hash)` 规则与 wire 形状不变（ADR-010 决策 7 的不变量保持）。Team id 作为存储键，格式漂移代价高于 Machine id（后者仅运行时校验），故此处用 DB CHECK 增强不变量。

铸造规则采用**确定性派生**：`t-<sha256("team:" + githubUserId)[:16]>`。并发首次登录的两个事务算出同一 team id，唯一索引天然仲裁出唯一团队，与「唯一约束保证并发登录不会创建重复团队」配对。铸造在片 2 登录事务中落实；片 1 只冻结格式与 CHECK。

### 3. 个人团队唯一性与 Membership 不重复

「每用户仅一个个人团队」由 teams 表的部分唯一索引承载：`teams_personal_owner_idx ON (owner_user_id) WHERE kind = 'personal'`。`kind` 列（值集 `["personal"]`）为未来团队形态扩容预留，部分唯一索引不受扩容阻碍。Membership 不重复由 `(user_id, team_id)` 复合主键承载（artifact_blobs 先例）；`role` 值集 `["owner"]`。

### 4. Login Session：哈希即主键、绝对有效期、退出删行

表名 `auth_sessions`（与 agent sessionId、artifact_sync_sessions 消歧；领域词汇为 Login Session，见 CONTEXT.md）。随机凭据只保存 SHA-256 哈希，且哈希即主键（run_leases 先例，不另设 id + unique）。绝对有效期 7 天，`expires_at` 由 writer 用注入 Clock 在建立时计算盖章，不滑动续期。退出 = 删除当前行（lease retired 先例），不留撤销列。Cookie 属性矩阵（HttpOnly、SameSite=Lax、Path=/、不设 Domain、HTTPS 设 Secure、HTTP 仅接受显式 loopback origin）中，origin 的 loopback 判定在片 1 的配置校验落地，Set-Cookie 行为在片 2 落实。

### 5. 认证配置策略

配置项：`LOOPZHB_ORIGIN`、`LOOPZHB_GITHUB_CLIENT_ID`、`LOOPZHB_GITHUB_CLIENT_SECRET`，全部在 `loadServerConfig`（纯函数，任何资源打开之前）校验，缺失或非法即启动失败，**无匿名回退**。`ServerConfig.auth` 为必选字段，`bootstrapServer` 类型级不可绕过。

origin 校验规则：显式值经 `new URL()` 解析；拒绝解析失败、协议非 `https:`/`http:`、`http:` 且 hostname 非 loopback、含 username/password、含 path（`/` 以外）/query/hash；存储规范化后的 `url.origin`。origin 未设置时，仅当绑定 host 为 loopback 派生 `http://<host>:<port>` 默认（保留零配置本地开发）；非 loopback 绑定且未显式配置 origin 即启动失败。回调 URL 由配置的 origin 固定拼接 `/auth/github/callback`，解析期冻结，不从请求 Host 或 forwarded header 推导。clientId/secret 未设置或全空白即缺失，两项缺失合并为一条点名两个变量的错误。

### 6. server 内部枚举不进 protocol 包的例外

`TEAM_KINDS`（`["personal"]`）与 `MEMBERSHIP_ROLES`（`["owner"]`）在 `packages/server/src/db/schema.ts` 本地声明，不放入 `@loopzhb/protocol`。这是对「枚举值列表单一来源在 protocol」惯例（ADR-002）的显式例外，理由：这两组值是 server 内部持久化概念，永不上 wire；放入 protocol 会污染 wire 单一来源。schema 测试以 enum pin 钉住两组值防漂移。

### 7. 迁移 dormancy：不自动认领、不预制身份

迁移 0006 只做加法：`machines` 增 `team_id`/`revoked_at`（旧行一律 null，即全部旧机器落为 Unclaimed Machine），新建 users/teams/memberships/auth_sessions 四张空表。数据库升级不自动认领任何资源、不预制任何身份；片 1 不增加生产注册入口（机器注册面在片 3 关闭 poll 自注册后只剩离线认领，用户/团队创建面在片 2 登录事务）。历史业务行及 Artifact 引用（snapshotId、manifest entries、session receipt）逐字节保持。

## 后果

- 片 2 的登录事务可直接依赖：users PK 仲裁并发身份、teams 部分唯一索引仲裁并发个人团队、确定性 team id 派生使并发登录收敛。
- 片 3/4 的 namespace 切换不需要变更 BlobStore 或 wire；team id 的 CHECK 保证切换产物永远是合法存储键。
- 全部现存 `bootstrapServer` 测试调用点必须携带 `auth` 配置（testkit 提供 `makeTestAuthConfig`）；遗漏由 typecheck 结构性列出。
- 旧部署升级到 Batch 3 后，全部旧机器对管理面不可见、不可执行，直到离线认领（片 4）；这是批次完成定义的一部分，不是缺陷。

## 修订 2026-10-07（片 2 落实增补）

片 2（GitHub 登录与持久 Session）实施时增补并冻结以下条目；编号接续原决策。

### 8. Cookie 名称与属性矩阵落实

Session Cookie 名 `loopzhb_session`，属性 `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`，https origin 时附 `Secure`，永不设 Domain。`Max-Age=604800` 显式镜像 7 天绝对有效期（用户确认 2026-10-07）：浏览器重启后登录态保留到服务端上限，语义单一来源仍是 `auth_sessions` 行。OAuth 待完成事务 Cookie 名 `loopzhb_oauth_tx`，`Path=/auth/github`（前缀覆盖回调路径）、`Max-Age=600`（镜像 10 分钟事务 TTL），其余属性相同。`Secure` 判定在模块构造时由配置的 origin 推导一次，永不读请求。

### 9. OAuth 待完成事务：内存存储、浏览器绑定、原子一次性消费

待完成事务保存在服务端内存 `Map`（重启即失效，符合批次规则），cookie 只携带随机事务 id，state 与 PKCE verifier 不出服务端。回调原子消费（get+delete 一次完成），每条分支（含全部失败）都消费——重放只得到 `state_unknown`。TTL 10 分钟，在消费时以注入 Clock 惰性判定；另设有界增长护栏（超过 1024 条先驱逐过期项再逐最旧），防 `/auth/github` 刷量内存膨胀。

### 10. OAuth 失败固定八值分类

`access_denied` / `state_missing` / `state_unknown` / `state_mismatch` / `code_missing` / `exchange_failed` / `network_error` / `response_invalid`。回调失败一律 303 `/login?error=<分类>`；登录页把分类映射为固定文案，未知值落通用文案，原始参数永不回显。上游响应正文、授权码、access token、client secret 永不进入响应、URL 或日志；日志只含固定串与 HTTP 状态码数字。GitHub access token 密闭在 adapter 的 `resolveIdentity` 单一操作内（类型层面不可获得），只用于本次身份查询。

### 11. Session 级 CSRF token：凭据派生，不落库

Session 级表单 CSRF token 从 Session 凭据派生：`sha256(credential + ":csrf")`（用户确认 2026-10-07）。这修正了片 1 验收记录中「0007 加列存哈希」的预留——随机铸造 + 哈希落库与「/api/session 交付明文」不可兼得，且凭据哈希纪律不允许存明文。派生式下：服务端在 resolve 时从浏览器 cookie 呈送的明文凭据重算 token;DB 泄漏（只有凭据哈希）无法推出 token;CSRF 攻击者骑浏览器自动带 cookie 但读不到 HttpOnly 值，也算不出 token。token 强度恰好等于它所保护的凭据，重启天然持久，auth_sessions 无需加列（0007 撤销，journal 保持 7 条）。退出及片 6 Dashboard 表单沿用 `csrf` 字段名，校验复用 dashboard/csrf.ts 提取出的 `extractSoleCsrfToken`（冻结的良构/重复判定不漂移），比较走 `timingSafeEqual`。

### 12. 路由失败面与 /api/session DTO

`POST /auth/logout` 失败面为 JSON 错误信封（401 未认证 / 400 表单畸形 / 403 token 判定；用户确认 2026-10-07），CSRF 失败不撤销任何 Session。`GET /api/session` 200 响应 DTO（`sessionInfoResponseSchema`，含 `csrfToken` 字段）单源在 `@loopzhb/protocol`（wire 惯例；决策 6 的例外不适用于 wire 面），响应恒 `Cache-Control: no-store`，401 为 `{error:"not authenticated"}`。过期边界钉死：`now >= expiresAt` 即过期（恰在到期时刻失效，前一毫秒有效）。Session 凭据形态 `sk_` + 32 字节随机 base64url。AU 编组编号：AU10 = 账号改名、AU11 = 身份稳定性、AU12 = 回调地址固定（用户确认 2026-10-07）。

## 修订 2026-10-08（片 3 落实增补）

### 13. 机器执行资格：五步门与统一 401（删除生产自注册）

Poll 与全部 Artifact machine 端点的凭据校验合并为**一个实现** `verifyEligibleMachineCredential`（`store/machines.ts`），固定五步顺序：token 形状 → 派生 id 行查找 → 全量 tokenHash 比对（H-01 截断碰撞防御）→ `teamId` 非空（已认领）→ `revokedAt` 为空（未撤销）。**五种拒绝原因全部折叠为同一 undefined → 统一 401**，不区分、不泄漏信号；调用方只记固定分类日志。

生产自注册（`registerMachineOnPoll`）与 poll 的「首接触建档」分支**连实现一并删除**：这里没有测试开关可以恢复，新机器接入属于 Batch 4 的 ConnectKey 流程。未认领与已撤销机器在任何心跳、identity、capability 快照与 claim 写入**之前**被拒绝，故拒绝路径零业务写入。

### 14. 生产 Artifact Attribution 切换落实（决策 2 的落地）

`createProductionArtifactHome` 与 report 事务的 artifact 绑定改用 `createTeamAttributionResolver`：存储 namespace 取自被可信解析的 `machines.teamId`（`namespaceId = teamId`），不再取机器自身 id。存储键 `(namespaceId, hash)` 规则与 wire 形状不变（ADR-010 决策 7 不变量保持）。

`createMachineAttributionResolver`（Machine namespace）**保留但退出生产路径**：片 4 离线认领 CLI 需要它以**源侧**身份读取认领前位于机器 namespace 下的 Blob，并在复制进 Team namespace 前完成校验。

### 15. Scheduler 的执行资格边界

启动扫描以 `loops LEFT JOIN machines` 并按 `teamId IS NOT NULL AND revokedAt IS NULL` 过滤：未认领、已撤销机器（以及机器行缺失的孤儿 loop）**不注册 job、不 catch-up、不新增 Run、不推进 schedule 游标**。cron tick 回调在 enqueue 之前**再次**复验资格（`isMachineExecutionEligible`，只读谓词），因此即便 job 因运行期配置变更被注册，tick 也被固定分类 `scheduler: machine_ineligible` 拒绝，游标不推进。

**资格复验范围**：机器执行资格还在唯一入队写入口复验（决策 16），使手动触发、Dashboard、cron tick 与 catch-up 均受同一规则约束，符合 Batch 计划第 133 行的 enqueue 边界要求。管理面 Session 门禁与创建 Loop 时的机器归属校验仍属片 5；本片不提供在线撤销入口，撤销仅经片 4 的停服 CLI 发生，故不存在并发撤销窗口。

## 修订 2026-10-08（二）（机器执行资格与零写入验证）

### 16. 执行资格下沉到 enqueue 边界（#122）

`enqueueExecRunTx`（创建 Run 的唯一写入口；手动触发、Dashboard、cron tick、重启 catch-up 全部经它）在打开事务**之前**以 `isMachineExecutionEligible` 复验 loop 的机器：机器行缺失（孤儿）、`teamId` 为空（未认领）或 `revokedAt` 非空（已撤销）一律返回新结果 `{ enqueued: false, reason: "machine_ineligible" }`，**零写入**——不新增 Run、不 supersede 既有 pending、不 bump `loops.revision`、不推进 schedule 游标。读在事务外：本批没有在线认领与在线撤销（片 4 的 CLI 要求停服），快照即权威，fail-closed 拒绝不需要重试。

HTTP 映射：`POST /api/loops/:id/run` 对 `machine_ineligible` 返回**平 404 `not found`**（与未知 loop 同分类，同 Batch 计划第 44 行「未认领、其他团队和不存在的资源统一 404」），**不落入** `running_exists` 的 200 兜底——那会把拒绝误标为普通队列状态。claim 边界不需要新检查：poll 在任何 claim 之前已用同一凭据门验证机器，且 `claimRunWithLeaseTx` 的候选只能来自该已验机器的 `pendingExecRunsForMachine`（本批无并发归属变化窗口）。catch-up 边界由本决策与决策 15 的扫描过滤双重覆盖。

### 17. Poll 拒绝顺序：凭据 401 先于资源策略 400

Poll 流水线的固定顺序改为「凭据门 → capability 资源策略」：ADR-009 修订 2026-09-01 决策 1 要求 credential 失败（401）先于 capability 拒绝（400），而实现曾把资源策略置于完整机器门之前，使 well-shaped 的未知/未认领/已撤销凭据携带非法声明时得到 400。整改后：形状、派生 id、全量 hash、归属、撤销**五步整体**先于资源策略；只有通过门的请求才可能得到 400，且 400 仍先于任何心跳/快照/claim 写入。已撤销凭据携带合法声明同样只得到 401。

### 18. Scheduler tick 全生命周期进入排空集合（#121）

`reconcile` 注册的 cron 回调改为**同步**登记整条 tick（含资格查询 await）到 drain 集合：`stopAndDrain()` 不再可能在 tick 仍挂起于资格查询时提前返回（ADR-008 第 6 节：先排空 callbacks 再关库）。资格查询返回后**再次**检查 `stopped`，停机后的 tick 不再 enqueue（该 occurrence 由下次启动的 catch-up 覆盖，不丢）。固定分类与逐 loop 错误隔离不变；资格查询异常仍经 Croner 的 `catch` 收口为 `scheduler: croner_error` 并正常结束排空。

### 19. 零写入 oracle 覆盖全部业务表（#123）

拒绝路径的零写入证据从「machines 表快照」升级为 `snapshotBusinessState`（machines、loops、runs、run_leases 与三张 artifact 表，全字段、确定性排序）**前后整体相等**，且必须配合**非空世界**（预设 pending Run 及其 progress、lease、已提交 sync session/manifest/blob）——空表之间的相等不构成证据。PG4 由部分字段匹配改为整行比较。poll 与 Artifact 两条拒绝路径共用同一 oracle。

## 修订 2026-10-10（片 4 落实增补）

### 20. dataDir 独占锁（Server 与 CLI 共用）

锁文件 `<dataDir>/data-dir.lock`，以 `open(path, "wx", 0o600)` 原子获取；`EEXIST` 即拒绝。内容为一行 JSON 持有者记录 `{pid, hostname, role, startedAt, version}`；该记录**只供操作者阅读**，任何代码路径都不据它做判定（PID 存活探测在 PID 复用下不可靠，故不用）。释放幂等，且仅在 `fstat(handle)` 与 `lstat(path)` 的 `dev`+`ino` 相同才 `unlink`——恢复方式就是手工 `rm`，这个竞态是真实存在的。**绝不自动抢占**；SIGKILL 留下陈旧锁导致下次启动被拒，是已文档化的契约而非缺陷，恢复命令写进 `--help` 与 README 运维段。

**接线范围（相对计划第 227 行的偏差点，如实登记）**：片 7 的收口条目把「dataDir 锁接入实际生产组合根」列为批次收口项；本片**提前到片 4 同时接入 `bootstrapServer`**，因为 `@electric-sql/pglite@0.5.4` 只提供进程内 async mutex，**没有任何跨进程文件锁**（在 `dist/index.cjs` 中核实：仅 `mutex already locked` 一类的进程内错误，唯一的 `O_EXCL` 命中是 Emscripten 的 NODEFS 标志表）。只有 CLI 持锁而 Server 不持锁，等于没有锁：两个进程仍会同时写同一个 `<dataDir>/pgdata`，且认领会与在线写入竞争。片 7 保留的部分是：真实 HTTP 升级演练（BI1–BI6）、跨进程锁断言的进程级证据、README 运维说明之外的生产收口。

获取顺序固定：CLI 为「解析参数 → stat dataDir（绝不创建）→ 取锁 → stat pgdata → 开库」；Server 为「mkdir → 取锁 → 开库」。`closeDb` 先关客户端**再**释放锁，故下一个进程不会在本次仍在收尾时打开数据库。开库失败时锁由获取方显式释放（此时 handle 尚不存在，既有的失败清理覆盖不到）。

### 21. 离线认领契约（拷贝后单事务）

**先拷贝、后事务**：全部选中机器的全部 Blob 在**任何数据库写入之前**复制并验证完毕，之后才在单个事务中切换归属与元数据。事务只写四列——`machines.team_id`、`artifact_manifests.namespace_id`、`artifact_sync_sessions.namespace_id`，以及目标 namespace 下新增的 `artifact_blobs` 行；manifest id/entries/revision/committedAt、session receipt/normalizedManifest、`runs.artifact_snapshot_id`、`loops.*`、`machines.id`/`token_hash` 逐字节不动。

**ADR-010 决策 11/12「manifest 不可变」的精确豁免**：不可变指 id、entries、manifestRevision、committedAt、configRevision；`namespace_id` 是**恰好迁移一次**的列——只在认领事务中改写，此后再不改动。两条 UPDATE 都以原 namespace 为前置条件并断言影响行数，失配即整事务回滚（`claim_guard_lost`）。

**`published:false` 不是验证**：本地 BlobStore 只校验传入流，从不回读既存目标文件，故批次契约「若目标 Blob 已存在，也必须验证」必须由 CLI 自己回读并重算 SHA-256 兑现。目标既存但损坏一律**硬拒绝、绝不覆盖**——认领的全部意义就是历史不变。源流的中断以抛错方式进入共享验证管线，归类为 `storage_error` 而非 `content_mismatch`，避免把流中断误报成源数据损坏。

**拷贝集 = 源 namespace 的全部 `artifact_blobs` 行**（manifest entries 是其子集，由链检查保证）。这不只是保守：一个仍处于 pending 的 session 在认领后重放 commit 时，其完整性检查要在**新** namespace 看到 blob 行与文件，漏掉未上表但已协商的 hash 会让该 session 永久无法提交。

**源侧全部保留**：源 Blob 文件与源 `(machineId, hash)` 元数据行都不删。保留与 `createMachineAttributionResolver` 的存续语义一致，可复查、可逆，且与批次的无 GC 姿态一致；下一次目标是同一对的认领是幂等 no-op，不会把它们当作待迁移行。

**活跃 Run 判定（用户裁定）**：`phase = 'running'` **拒绝**，`phase = 'pending'` **只警告**。running Run 持活跃 lease，其 Report 由 Run 凭据授权（不经机器资格门），可在认领后落地并对着刚改写过的行重新派生归属——这正是「先 drain」的对象。pending Run 在认领前惰性（未认领机器无法 claim 工作），认领后随机器恢复而可执行；若连它一起拒绝会死锁：取消 Run 要开管理 API，开 Server 又被锁禁止。dry-run 与执行报告都列出其数量供操作者判断。

**幂等与重试**：同一目标重复认领为 no-op（已认领机器改按**目标** namespace 做完整链检查，半迁移的世界判 `chain_inconsistent` 而非二次迁移）；跨团队、机器缺失、链不一致拒绝**整组**，没有「能认领多少算多少」。崩溃或回滚后的重跑是普通重跑：数据库未变，已发布的目标 Blob 由 `has` + 回读验证发现并计为 reused。事务失败后未引用的目标 Blob 保留，由重试复用——契约明确允许。

**链检查**（不通过一律拒绝）：manifest/session 的 `namespaceId` 必须等于期望源 namespace；其 `loopId` 必须属于该机器；`fileCount === entries.length`、`totalBytes === Σsize`；每个 entry 的 hash 满足 `ARTIFACT_HASH_RE` 且 size 落在合法域；每个 entry hash 有同尺寸的 blob 行；`runs.artifactSnapshotId` 与 `loops.artifactManifestId` 必须落在该机器的 manifest 集合内；同 hash 跨机器尺寸冲突；每个 blob 行的文件必须存在（`source_blob_missing`）。

**dry-run 深度（用户裁定）**：只做元数据行 + 存在性（lstat），不读字节、不算哈希；损坏的源 Blob 在执行阶段才暴露。dry-run 严格只读且快。

### 22. `claim:legacy` 命令表面

`pnpm --filter @loopzhb/server claim:legacy -- --data-dir <目录> --github-user-id <数字ID> --machine-id <机器ID> [--machine-id …] [--dry-run]`。`--data-dir` 必填且无环境变量回退；`--github-user-id` 必须是十进制 GitHub 数字 ID（复用 `schema.ts` 的 `GITHUB_USER_ID_REGEX` 同源规则）；`--machine-id` 可重复，重复**值**判用法错误（复制粘贴失误，静默去重会掩盖它），至少一个——不提供「认领全部」。退出码：0 成功/幂等 no-op，1 拒绝或失败，2 用法错误，3 数据目录被锁。CLI **不读任何环境变量**，也不 import `loadServerConfig`（运维 shell 没有 OAuth 三件套）。`--data-dir` 不存在或缺少 `pgdata` 时在开库前拒绝——避免在笔误路径上静默建库再报「目标用户不存在」。CLI 与 Server 共用 `openMigratedDb` 开库路径，故 CLI 可能顺带应用迁移；升级顺序保证 Server 先启动过，这是已披露的行为。

## 修订 2026-10-20（片 5 落实增补）

### 23. 管理面默认拒绝门禁

Session 门禁挂在 `/api/*` 上，**默认拒绝**，只精确豁免三个路径形态：`/api/session`（登录态探针，自身返回 401）、`/api/machine` 与 `/api/machine/*`（Bearer 机器凭据）。豁免谓词必须带斜杠——`startsWith("/api/machine")` 会把 `/api/machines`（机器列表）一并豁免，这是静默的跨团队数据泄漏；该边界由单测与变异 M3 同时钉住。未登录一律 `401 {"error":"not authenticated"}`，不新增 `code`，与 `/api/session`、`/auth/logout` 的既有约定一致。

注册顺序固定：`hostGate`（若有 Dashboard）→ sessionGate → loopGate/runGate → 机器路由 → 管理路由 → auth/Dashboard。因此认证先于 `bodyLimit` 与 DTO 解析：匿名超大或畸形请求得到 401 而非 413/400。默认拒绝的已知后果是**未知 `/api/*` 路径的匿名响应由 404 变为 401**；非 `/api` 路径仍是扁平 404。

`createServerApp` 由 9 个位置参数改为 options object，`management: ManagementAccess` 为**必填**字段：生产与测试装配都无法在类型层面省略门禁。

### 24. Team Scope 只来自 Session；过滤先于排序与限量

管理查询的 teamId 唯一来源是 `ResolvedSession.team.id`；请求参数、header 与 body 都不能覆盖。`listMachines`、`listLoops`、`getLoopSummary`、`listRuns` 与 `createLoop` 全部改为团队范围查询：loops/runs 经 `loops.machine_id → machines.team_id` 内连接推导（`runs.machine_id` 是冗余副本，不作归属依据），`machines_team_idx` 就此投入使用。谓词在 SQL 内、`ORDER BY` 与 `LIMIT` 之前执行——过滤后置会让其他团队的新行吃掉 100 行上限（MG4 的回归目标）。

Dashboard 在片 6 之前仍未认证，其无 scope 读取被收敛为**具名出口** `listLoopsUnscoped()` 与 `ArtifactApi` 的四个 `*Unscoped` 方法；生产 HTTP 路由只能调用带 teamId 的 `listLoops(teamId)` 与 `*ForTeam`。`read.ts` 内部用判别联合 `ReadScope = { kind: "team"; teamId } | { kind: "unscoped" }`，不用可选 teamId，避免生产路由误传 `undefined` 退化为无 scope。片 6 删除这些出口时类型检查会列出唯一调用点。

`revokedAt` 不参与管理过滤：本批没有在线撤销入口，撤销只影响执行资格（决策 15/16 不变）。

### 25. 归属执法在路径中间件

`/api/loops/:id`、`/api/loops/:id/*`、`/api/runs/:id`、`/api/runs/:id/*` 在处理器之前解析 `id`，按 **Run → Loop → Machine → Team** 链检查（`store/scope.ts` 的窄投影查询）。未找到、孤儿、未认领、跨团队一律 `404 {"error":"not found"}`，与 `app.notFound` 逐字节一致；中间件拿不到 Session team 时返回 401，绝不 `next()`。`POST /api/loops` 是唯一资源 id 来自 body 的管理写入口，其机器查找改为 `(id, teamId)` 双条件，失配沿用既有 `machine_not_found` → 扁平 404，零写入。

该执法依赖本批不变量：**Server 运行期间归属不可变**（认领只能由片 4 的 CLI 在停服并持 dataDir 锁时发生，本批无在线撤销）。Batch 4 若引入在线归属变更，必须重新审视中间件读取与处理器写入之间的 TOCTOU 窗口。

### 26. Artifact 管理读的归属前置

`resolveLoopScope` 在读到 loop 行之后、`attribution.resolve` 之前比较团队；`readRunArtifactsView` 在 run → 父路径 → loop 之后、attribution 与 snapshot 之前比较。未认领与跨团队折叠为既有的 `loop_not_found` / `run_not_found`（无 code 404），**不落到 `attribution_missing`（403）**，也不得触及 snapshot 解析或 blob 打开。`ARTIFACT_FAILURE_HTTP` 与机器路径的 403 语义一行未改。

`PATCH /api/loops/:id/artifact-dir` 不向 `updateArtifactConfig` 下沉 teamId：loopGate 已在处理器之前完成只读归属检查，零写入由门禁本身保证。写归属执法统一在 HTTP 边界，域层不重复。

### 27. 凭据类型隔离

管理门禁只读 `loopzhb_session` Cookie；机器路由只读 `Authorization: Bearer`。两条解析链没有共享入口，因此同一请求同时携带两种凭据也只会在各自表面使用各自凭据（MG10）。管理路由没有 Bearer 分支，机器路由没有 Session 分支——这是结构性的，不是逐路由的纪律。

### 28. 片 5 提前接线生产组合根

相对批次计划第 223 行把「认证接入实际生产组合根」列在片 7 的偏差点，本片**如实登记**：`createAuthModule` 改为返回 `{ routes, sessions }`，`bootstrapServer` 无条件构造 `ManagementAccess` 并注入 `createServerApp` 的必填字段。理由：片 3 已关闭生产 poll 自注册，若管理面继续匿名，分支上的生产形态将长期停在「机器侧已关、管理侧全开」的中间态；片 4 提前接锁已开此先例。片 7 保留的部分不变：真实 HTTP 升级演练（BI1–BI6）、生产认证不可旁路的完整验收、旧测试假设清理的最终核对。

## 修订 2026-10-20（片 6 落实增补）

### 29. Dashboard 门禁：页面 303、表单 401、归属扁平 404

HTML 表面新增两道中间件，注册在全局 `hostGate` 之后、全部 Dashboard 路由之前：

- `pageGate` 挂在 `/` 与 `/dashboard/*`（两条都要注册：Hono 的 `use("/")` 只匹配根路径，`use("/dashboard/*")` 覆盖 `/dashboard`、`/dashboard/` 与全部子路径）。只读 `loopzhb_session` Cookie 并经 `SessionService.resolve` 解析。无会话、过期、身份链断裂：`GET`/`HEAD` → **303 `Location: /login`**，带全套安全响应头、**不 Set-Cookie**；其余方法 → **401 `{"error":"not authenticated"}`**。认证先于 `formContentType` 与 `bodyCap`，因此匿名超大或错误 Content-Type 的表单是 401，不是 413/415。
- `loopGate` 挂在 `/dashboard/loops/:id` 与 `.../:id/*`，复用 `store/scope.ts` 的 `getLoopTeam` + `teamMatches`。缺失、孤儿、未认领、跨团队一律 `404 {"error":"not found"}`，**与管理门禁、`app.notFound` 逐字节一致**，且**不带 Dashboard 安全头**——「未挂载 / 未知路径 / 拒绝」不可区分的约定与 hostGate 相同。中间件拿不到会话时 fail-closed 401。
- Session 每请求只解析一次，结果写入 context；处理器通过 `sessionOf` 读取用户、团队与 CSRF token，绝不从请求参数取团队。

### 30. Dashboard 读全部团队化；删除无 scope 出口

`DashboardRead.snapshot(teamId)` 改为 `admin.listLoops(teamId)`；四个 Artifact 页面读改为 `readLoopForTeam` / `readRunForTeam` / `diffSnapshotsForTeam`；`boundSnapshots(teamId, loopId)` 在 SQL 内 join runs→loops→machines 并过滤 `machines.teamId`。零调用的 `loopSnapshots` 删除。

片 5 的具名出口全部删除：`admin.listLoopsUnscoped`、`ArtifactApi` 的 `readLoopUnscoped` / `readRunUnscoped` / `diffSnapshotsUnscoped` / `openDownloadUnscoped`，以及 `ReadScope` 的 `{ kind: "unscoped" }` 分支。`queryLoops` / `queryMachines` 只接受 `teamId: string`，无 scope 的 SQL 形状不可达；类型检查是删除完整性的编译期证明。

**已披露的行为变化**：团队过滤的 INNER JOIN 使孤儿 Loop（machine 行缺失）与未认领机器的 Loop 从 Dashboard 消失，与 JSON API 一致。`updateArtifactConfig` 仍不接收 teamId——写归属由 `loopGate` 在 HTTP 边界执法（决策 26 不变）。

### 31. Dashboard 表单使用 Session 级 CSRF

Run Now 改用 `checkSessionCsrfForm(body, session.csrfToken)`；Artifact 配置继续用 `checkCsrfFormFields(body, session.csrfToken, [artifactDir])`——白名单、`field_duplicate` 与「stray field 先于 token 判定」的冻结顺序不变，只把期望值换成 `sha256(credential + ":csrf")`。

进程启动级 token 整条删除：`mintCsrfToken()`、`DashboardRouteDeps.csrfToken`、`BootstrapOverrides.csrfToken` 与 `start.ts` 的铸造点。后果：重启不再使 token 失效（Session 行持久、token 派生），**跨 Session 的 token 才是新的拒绝边界**；同用户的两个 Session 各有独立 token。`extractSoleCsrfToken` 及其良构/重复规则保持冻结，logout 与 Dashboard 共用同一判定。

### 32. 账号状态、退出表单与空团队指引

索引页页头显示「当前账号 / 团队」并提供退出表单（`POST /auth/logout`，隐藏 `csrf`，按钮不具名——表单仍只有一个具名控件）。已登录用户访问 `GET /login` → 303 `/`；未知或过期 Cookie 仍渲染登录页。

空团队提示改为可执行指引：先说明「当前团队暂无 Loop」，再给出停服后 `claim:legacy` 的命令形状与占位符。占位符作为文本插值（转义为 `&lt;目录&gt;` 等），不暗示每个空团队都有旧数据。HTML 转义、零 JavaScript 与 CSP 单一样式哈希不变。

四个 Artifact 页面本轮不显示账号/退出控件，但仍受同两道门禁保护；这是显式边界，不是遗漏。

### 33. 片 6 的装配顺序与停止边界

`start.ts` 先构造 `createAuthModule`，再构造 Dashboard，把 `auth.sessions` 同时交给 `createDashboardAccess` 与管理门禁——登录路由、HTML 门禁、JSON 门禁共用**同一个** Session 解析器。Dashboard 仍只在回环绑定挂载；非回环时 `/login`、`/auth/*` 照旧存在而 Dashboard 完全缺席。

本片不新增迁移（journal 保持 7 条）、不改 wire DTO、不实现 Connect UI/成员管理/通知/在线认领或撤销。BI1–BI6 与真实 HTTP 升级演练仍属片 7；#56（同源意图检查、Content-Type 门禁、空体加固）与 #61 不核销。

## 修订 2026-10-20（片 7 落实增补）

### 34. 验收证据分级：脚本化 adapter、构建产物与真实 OAuth 不得混称

自动化 BI/PG 套件使用**脚本化 GitHub `fetch`**（`BootstrapOverrides.githubFetch`），永不访问真实 GitHub；验收记录必须标注「脚本化 adapter，非真实 GitHub」。真实 GitHub OAuth 只以**人工 smoke** 验收：单独记录日期、检查点与通过/失败，不记录账号、授权码、access token 或 client secret。脚本 adapter 的通过不构成真实 OAuth 验收。

同理，自动测试不执行真实 Claude；三个 opt-in real-Claude 套件只做机械的 Session 迁移，本片不运行，不描述为真实 Claude 验收。

### 35. 升级与回滚顺序

Batch 2 → Batch 3 的固定顺序：完整备份 dataDir → 停止 Server/Daemon 并 drain → 部署整个 Batch 3 → 启动一次 Server 应用 0006 → 目标账号登录并创建个人团队 → 停服执行 `claim:legacy --dry-run` → 核对后认领 → 重启 Server 与 Daemon。

认领改写 `artifact_manifests` / `artifact_sync_sessions` 的 namespace 并新增团队 Blob 行后，**只回退应用二进制不够**；回退旧版本必须恢复升级前的完整 dataDir 备份。dataDir 锁不自动抢占；陈旧锁按 `--help` 与 README 的说明手工删除。

### 36. 新库、旧库与连续重启的生产启动门禁

三条路径必须在任何业务或身份写入之前拒绝未知、未认领与已撤销凭据，并统一 401：

- 新库首次生产启动；
- Batch 2 旧库经 0006 升级后的生产启动；
- 同一 dataDir 的连续重启。

默认门禁同时包含 **OS 级跨进程锁探针**：父进程持锁时子进程 `open(path, "wx")` 得 EEXIST；子进程持锁时真实 claim 路径退出 3、`bootstrapServer` 在 `<dataDir>/pgdata` 出现前抛 `DataDirLockError`。变异 M12–M15 证明 oracle 能抓住自注册恢复、团队过滤移除、管理门禁旁路与目标 Blob 校验跳过。

### 37. 跨进程证据分层与构建产物 drill

默认 `pnpm test` 不依赖 server `dist/`：BI 链使用真实 HTTP、文件型 PGlite、本地 BlobStore、生产 daemon 模块与进程内 claim。真实构建产物的进程级证据由 `LOOPZHB_SUBPROCESS_DRILL=1` 的 opt-in drill 提供：`dist/start.js` 持锁 → `dist/claim/main.js` 退出 3 → SIGTERM 后退出 0 → 重启验证历史 → 内置 daemon CLI 执行旧 pending Run 并同步新 snapshot。drill 单独记录，不计入默认门禁通过数；启用但缺产物时必须报错并提示 `pnpm build`，不得静默跳过。

### 38. 停止必须有界：数据库关闭与锁释放不依赖客户端断开

片 7 的真实 OAuth 人工 smoke 暴露了一个停止缺陷：浏览器打开 Dashboard 后保持 keep-alive 连接，`server.close()` 的回调一直等待该连接，`closeDb`（同时释放 dataDir 锁）只在回调内执行，于是 Ctrl+C 后进程长期存活、锁文件保留，下一次启动被拒绝。

裁决：生产停止顺序仍为 scheduler drain → sweep drain → HTTP → DB，但 HTTP 关闭必须**有界**：

1. 关闭监听；
2. 立即关闭空闲 keep-alive 连接（`closeIdleConnections`）；
3. 5 秒宽限期后强制关闭剩余连接（`closeAllConnections`）并继续关闭数据库与释放锁。

`closeDb` 与锁释放不得以「所有客户端自行断开」为前提。实现集中在 `http/server-shutdown.ts`，生产 `main()` 与测试台架共用；SD1（空闲 keep-alive）与 SD2（永不完成的请求在宽限期被强制关闭）钉住行为。ADR-011 决策 20 的「SIGKILL 可留下陈旧锁」仍然成立，但干净 SIGINT/SIGTERM 不应留下锁。
