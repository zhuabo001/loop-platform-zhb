# Phase 5 Batch 3 开发计划：GitHub 登录、个人团队与旧数据认领

- 状态：计划完成，待实施
- 调查基线：`feat/phase5-batch3-dev`，提交 `4ff517a`
- 上位计划：[codex-phase5-dev-roadmap.md](codex-phase5-dev-roadmap.md)
- Batch 2：PR [#84](https://github.com/zhuabo001/loop-platform-zhb/pull/84) 已合入；实现与验收记录见 [codex-phase5-batch2-plan.md](codex-phase5-batch2-plan.md) 和 `docs/tests/phase5-acceptance.md`
- 预计排期：7–10 个开发日，拆成 7 个可独立验收的 slice

## 1. 目标与固定规则

本批建立单用户登录与团队归属闭环：GitHub 用户登录后获得个人团队；管理 API 和 Dashboard 只显示该团队资源；未知或未认领机器不能通过 poll 注册；运维可在 Server 停止后，将旧机器及其 Artifact 历史显式认领给已登录的用户。

Batch 3 的管理面认证和机器自注册关闭必须作为一个**不可拆分的合入与部署单元**。任何部署形态都不能出现管理 API 要求登录但生产 poll 仍可自注册的中间状态。

### 身份、登录与 Session

- GitHub.com 数字用户 ID 是唯一外部身份键，内部以十进制字符串保存；用户名仅作可变展示信息。
- 首次登录在一个数据库事务内创建 User、个人 Team 和 owner Membership；唯一约束保证并发登录不会创建重复团队。
- 使用 GitHub 授权码流程、一次性 state、浏览器绑定和 PKCE S256。每次登录交换 token 后重新查询 GitHub 用户身份。流程依据 [GitHub 官方 OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。
- OAuth 待完成事务有效 10 分钟，保存在服务端内存并绑定短期 HttpOnly Cookie。回调原子消费事务；Server 重启后未完成的登录失效，用户重新登录。
- GitHub access token 仅用于本次身份查询，不持久化，也不写入日志。
- Session 使用随机凭据，仅保存凭据哈希；绝对有效期 7 天，不滑动续期。退出只撤销当前 Session。
- Session Cookie 设置 HttpOnly、SameSite=Lax、Path=/，不设置 Domain。HTTPS 设置 Secure；HTTP 仅接受显式 loopback origin。
- OAuth 配置缺失或非法时启动失败，不允许回退到匿名模式。
- 配置项：`LOOPZHB_ORIGIN`、`LOOPZHB_GITHUB_CLIENT_ID`、`LOOPZHB_GITHUB_CLIENT_SECRET`。回调 URL 由配置的 origin 固定拼接，不从请求 Host 或 forwarded header 推导；不接受任意返回地址。

新增接口：

| 接口 | 行为 |
|---|---|
| `GET /login` | 显示 GitHub 登录入口 |
| `GET /auth/github` | 创建登录事务并跳转 GitHub |
| `GET /auth/github/callback` | 验证并消费登录事务，建立 Session 后跳转 `/` |
| `POST /auth/logout` | 校验 Session 和表单 CSRF，撤销当前 Session |
| `GET /api/session` | 返回当前用户、个人团队和 Session 到期时间；未登录返回 401 |

### 凭据、团队范围与机器准入

- 管理 API 使用 Session；未登录返回 JSON 401。Dashboard 页面未登录时跳转 `/login`，未登录表单提交直接拒绝。
- Poll 和 Artifact 同步使用 Machine Credential；Report 继续使用 Run Credential。不得对 `/api/machine/*` 整体套用同一种认证。
- Machine 增加可空 `teamId` 和 `revokedAt`；本批新增 User、Team、Membership、Session。ConnectKey 与接入接口留 Batch 4。
- Session 解析得到可信 User/Team scope。客户端不能通过请求参数选择或覆盖团队。
- 列表在 SQL 查询时按团队过滤，并在过滤后排序和限量。详情与写操作按 Machine → Loop → Run 归属链检查。
- 未认领、其他团队和不存在的资源，对管理入口统一返回 404；拒绝操作不得产生业务写入。
- 本批不提供团队迁移、机器撤销管理接口或成员管理；正常业务流程中没有在线改变 Machine 团队归属的入口。
- 未认领机器的 Loop 不新增自动调度或手动入队；保留现有 pending、历史 Run、配置和 schedule 游标。已有 RunLease 继续按原终态及迟到 Report 规则处理。
- Machine 凭据必须匹配已存在机器的完整 token hash，且机器必须已归属有效团队并未撤销。未知、未认领或已撤销凭据统一返回 401。
- 拒绝 poll 必须发生在 heartbeat、identity、capability、progress、watch 和 Run claim 任何写入或分发之前。

### 旧数据与 Artifact 认领

离线命令只接受**已完成 GitHub 登录、已存在个人团队**的目标数字用户 ID；不通过命令预建账号。机器必须由操作者显式指定，不提供默认认领全部机器的行为。

```bash
pnpm --filter @loopzhb/server claim:legacy -- --data-dir <目录> --github-user-id <数字ID> --machine-id <机器ID> --dry-run
```

移除 `--dry-run` 执行认领；`--machine-id` 可重复指定。Server 和 CLI 共用 dataDir 独占锁，锁无法获取时在打开数据库前拒绝执行，不自动抢占锁。异常退出后的锁恢复方式须写入命令帮助与运维说明。

认领 Artifact 时遵守以下契约：

1. 读取所选机器的历史 manifest、sync session 和 Blob 元数据。
2. 将 Blob 从 Machine namespace 复制到 Team namespace，并验证大小和 SHA-256；若目标 Blob 已存在，也必须验证。
3. 所有 Blob 验证成功后，在单个数据库事务中切换 Machine 归属及 Artifact namespace 元数据。
4. 保留 snapshot ID、manifest entries、revision、Run 引用及已提交 session receipt。
5. 保留源 Blob，不执行 GC。

复制失败或数据库事务失败时，不得留下部分已认领机器或不可用的历史快照。复制产生的未引用目标 Blob 可以保留，并由重试复用。

dry-run 只报告目标账号、团队、机器、历史资源数量和需复制字节数，不复制 Blob，也不改变业务数据。同一目标重复认领为幂等 no-op；跨团队重复认领、目标用户不存在、机器不存在或资源链不一致均拒绝。选中机器存在 running Run 时拒绝认领，操作前要求 drain。

## 2. Slice 划分

依赖顺序：

```text
Slice 1 → Slice 2 ─┐
        → Slice 3 ─┴→ Slice 4 → Slice 5 → Slice 6 → Slice 7
```

### Slice 1 — 身份模型、数据库迁移与认证配置

**前置：** 当前 Batch 2 基线。

**交付与范围：** 数据库 schema/migration、认证配置解析、身份类型和测试 fixture。

**关键步骤：**

- 增加 User、Team、owner Membership、Session 和 Machine 团队归属/撤销字段。
- 用数据库唯一约束保证 GitHub ID 唯一、每用户仅一个个人团队、Membership 不重复。
- 旧 Machine 的 `teamId` 保持 null；数据库升级不自动认领资源。
- 增加 origin、OAuth 配置校验；配置解析与打开数据库等资源的步骤分离。
- 提供显式用户、团队、Session 和已认领机器 fixture，不增加生产注册入口。

**验收：** 新库、Batch 2 旧库和重复迁移均通过；历史业务行及 Artifact 引用保持不变；非法 origin、非 loopback HTTP 和缺失 OAuth 配置不能进入生产启动流程。覆盖 `LM1–LM2`，建立 `AU/SE/PG` 测试基础。

**停止边界：** 不开放登录路由，不实现 ConnectKey，不自动关联旧数据。

### Slice 2 — GitHub 登录与持久 Session

**前置：** Slice 1。

**交付与范围：** 认证模块、GitHub adapter、登录/回调/退出/session 路由及独立测试装配。

**关键步骤：**

- 实现有浏览器绑定的 state、PKCE、超时和一次性消费。
- 将 GitHub HTTP 请求隔离到 adapter，支持注入 fetch 和请求超时。
- 原子创建或读取身份、个人团队和 Membership，再建立 Session。
- 实现 Session 查询、过期、撤销和 Cookie 策略。
- 提供 Session 级表单 CSRF token，供退出及 Dashboard 表单使用。
- 固定 OAuth 错误分类，屏蔽 code、token、secret 和上游敏感错误正文。

**验收：**

- `AU1–AU12`：state 缺失/不匹配/过期、浏览器绑定、PKCE、回调重放、拒绝授权、上游失败、并发登录、账号改名及身份稳定性。
- `SE1–SE8`：未知凭据、到期边界、退出撤销、Cookie 属性、重启持久、多个 Session 独立及 CSRF 隔离。
- 登录失败不产生可用 Session；首次登录不能取得旧机器。

**停止边界：** 本 Slice 只验收认证模块和路由，不作为可部署的管理面认证版本。

### Slice 3 — 关闭自注册与未认领机器执行隔离

**前置：** Slice 1。

**交付与范围：** Machine 验证、Coordinator、Artifact 认证路径、Scheduler 和相关测试 fixture。

**关键步骤：**

- 删除生产 poll 自注册分支及其生产注册实现；测试改用显式预置 Machine。
- 统一 poll 和 Artifact 路径的已有机器验证规则。
- 在任何 poll 副作用前完成凭据、团队归属和撤销检查。
- Scheduler 启动扫描排除不具执行资格的机器；调度、catch-up、enqueue 和 claim 边界复验资格。
- 将生产 Artifact attribution 改为从可信 Machine 归属解析 Team namespace。
- 保留 Report 独立的 RunLease 验证及终态语义。

**验收：**

- `PG1–PG6`：缺失、未知、hash 不符、未认领、已撤销凭据均被拒绝；已认领机器可正常 poll/claim/report。
- 对比拒绝前后 Machine、Run、Lease 和 Artifact 状态，证明零业务写入。
- 未认领机器不启动调度、不 catch-up、不新增 Run，schedule 游标不推进。
- 既有 lease 的合法 Report 和迟到 reconcile 回归通过。

**停止边界：** 不开放新机器接入或撤销操作；不通过测试开关恢复自注册。

### Slice 4 — 离线认领与 Artifact namespace 迁移

**前置：** Slice 1–3。

**交付与范围：** 独立离线 CLI、dataDir 互斥保护、Blob 复制验证及归属事务。

**关键步骤：**

- Server 与 CLI 共用 dataDir 独占锁，CLI 在打开数据库前获取锁。
- 验证目标用户已登录且个人团队关系完整；检查选中机器和资源链。
- 实现只读 dry-run 报告。
- 按统一认领契约复制并验证 Blob，再用单事务提交整组所选机器的认领。
- 同目标重复认领为幂等 no-op；跨团队、缺失机器或资源链不一致时拒绝。
- 处理复制中断、磁盘不足、损坏 Blob、目标 Blob 冲突及提交失败，并支持安全重试。

**验收：**

- `LM3–LM10`：未知目标、错误机器、重复/跨团队认领、停服要求、活跃 Run 拒绝、复制失败、事务回滚、断点重试及历史完整性。
- 覆盖两个 Machine 归属同一 Team 时相同 hash 的复用。
- 认领后旧快照下载字节、diff、已提交 session 重试回执保持不变。
- Machine ID 和原凭据哈希不变；原 Daemon 可恢复同步和执行。

**停止边界：** 不在线认领、不迁移已归属机器、不删除源 Blob、不预建 GitHub 身份。

### Slice 5 — 管理 API Session 门禁与团队过滤

**前置：** Slice 2–4。

**交付与范围：** 管理路由组、统一访问检查、团队列表查询和接口验收矩阵。

**关键步骤：**

- 管理路由统一要求 Session，避免逐路由遗漏；生产装配不能省略认证依赖。
- 覆盖机器列表、Loop 列表与创建、Run 列表、触发、取消、schedule、goal、Task File、reopen、Artifact 配置及全部管理读取端点。
- 创建 Loop 时验证 Machine 属于当前团队；列表在 SQL 过滤后排序和限量。
- Artifact 下载与 diff 在打开 Blob 或读取快照正文前校验归属。
- 保持已有成功响应 DTO，不向 wire 自动暴露团队内部信息。

**验收：**

- `MG1–MG10`：匿名全路由拒绝、过期 Session、团队列表过滤、跨团队创建/修改/触发/取消、未认领隔离、Artifact 读取/下载/diff 和凭据类型不可混用。
- 使用 A/B 两个团队和未认领 Machine 构造访问矩阵；拒绝结果统一且零业务写入。
- 验证列表限量发生在团队过滤之后，不因其他团队数据漏掉当前团队资源。

**停止边界：** 本片完成管理入口团队过滤，不宣称完成 Batch 4 的深模块/事务权限隔离；不核销 #56。

### Slice 6 — Dashboard 登录态与团队视图

**前置：** Slice 5。

**交付与范围：** Hono SSR 登录页、账号状态、退出表单、团队页面查询与 Session CSRF 接线。

**关键步骤：**

- 接入登录页、当前账号信息和退出操作。
- Dashboard 列表和 Artifact 页面复用 Slice 5 的团队访问规则；不得先读取所有数据再在模板中过滤。
- 将进程启动级 CSRF token 改为 Session 级 token。
- Run Now、Artifact 配置和退出表单均校验当前 Session 的 CSRF token。
- 保留 HTML 转义、attachment 下载、安全响应头和现有表单解析规则。
- 新账号显示空团队状态，并说明需通过离线命令认领旧机器。

**验收：**

- `DG1–DG6`：匿名页面跳转、匿名 POST 拒绝、登录后团队视图、跨团队页面 404、跨 Session CSRF 拒绝和退出后访问拒绝。
- Artifact XSS、下载响应头及 Dashboard 不 supersede pending Run 的既有回归通过。
- 登录错误页和空状态不泄露旧资源或敏感配置。

**停止边界：** 保持 Dashboard 当前 loopback 挂载边界；不实现 Connect UI、成员管理或通知。

### Slice 7 — 生产装配、升级演练与批次收口

**前置：** Slice 1–6。

**交付与范围：** 生产启动接线、真实 HTTP 集成验收、升级说明、ADR 和长期测试记录。

**关键步骤：**

- 将认证、团队过滤、机器准入、Team attribution 和 dataDir 锁接入实际生产组合根。
- 清理旧测试中“首次 poll 注册机器”和“匿名管理 API”的假设，改为显式 fixture 或完整登录。
- 使用真实 HTTP、文件型 PGlite、本地 BlobStore、Fake Runner 和可控 GitHub adapter 演练：旧库升级 → 首次登录 → 旧数据仍不可见 → 停服认领 → 重启 → 原 Daemon 执行与同步 → 旧快照下载。
- 增加新库、旧库和连续重启验收，防止初始化路径恢复自注册。
- 对恢复 poll 注册、移除团队过滤、跳过 Blob 校验等关键防线做变异验证。
- 更新过时的启动提示、包描述，以及 roadmap 中 #56 的批次指向。

**验收：**

- `PG7–PG8`：新旧库生产启动及连续重启均不能自注册。
- `BI1–BI6`：完整升级链路、首访不取得旧数据、迁移故障恢复、原凭据兼容、历史 Artifact 保真及生产认证不可旁路。
- 全部质量门通过；配置真实 GitHub OAuth 后执行一次人工 smoke。自动测试不依赖 GitHub 网络或真实 Claude。
- 记录每项验证及未执行的人工项；不得把 mock OAuth 测试描述为真实 GitHub 验收。

**停止边界：** 不开放 Connect，不核销 #56/#61，不宣称完成公开部署或 Phase 5 全阶段验收。

## 3. 质量门与升级顺序

### 批次质量门

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

长期测试编号沿用 `AU1–AU12`、`SE1–SE8`、`LM1–LM10`、`PG1–PG8`；新增 `MG/DG/BI` 编组，不占用 Batch 4 的 `TZ/HR/MR` 编号。测试与验收记录写入 `docs/tests/phase5-acceptance.md`。

### 升级顺序

1. 备份旧 dataDir，停止新增任务，等待已有 Run 完成并停止 Daemon。
2. 停止旧 Server，部署整个 Batch 3，配置 GitHub OAuth 与固定 origin。
3. 启动新 Server，目标账号登录并创建个人团队；此时旧机器仍不可见、不可执行。
4. 停止 Server，执行认领 dry-run；核对数字 ID 和机器集合后执行认领。
5. 重启 Server 与既有 Daemon，验证执行、同步和历史快照下载。

认领改变 Artifact namespace 后，不能只回退应用二进制。回退旧版本必须恢复升级前的完整 dataDir 备份。

## 4. 文档与完成条件

- 本文件是 Batch 3 的 slice 和验收计划。
- 架构裁决写入 `docs/adr/011-phase5-identity-and-legacy-claim.md`；实施时更新 ADR-010 的 Team namespace 迁移落实记录。
- 逐 slice 证据写入 `docs/tests/phase5-acceptance.md`；长期有效的领域词汇及阶段状态按仓库约定同步更新。
- 临时进度与审查往返放在 handoff，不提交会话物流。

**Batch 3 完成条件：** 未登录用户不能管理资源；登录用户通过管理入口只能访问自己的团队；首次访问不能取得旧数据；未知机器无法自注册；显式认领保留历史快照和原机器凭据；Batch 3 独立部署时上述规则全部成立。
