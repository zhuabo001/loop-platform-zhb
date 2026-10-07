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
