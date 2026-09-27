# Phase 5 开发计划：Artifact 同步、个人团队认证与站内告警

## 一、目标与固定语义

以计划制定时的仓库状态为调查基线，实施前复核当前提交与 Issue 状态。Phase 5 分 **6 个可独立验收的 batch**，预计约 **24–32 个开发日**。

本阶段完成：

- 为 Loop 配置显式 Artifact 目录，持续单向上传，并支持文件浏览、下载、Run 快照和差异。
- 实现 GitHub 登录、个人 Team/Membership、机器安全接入及跨团队隔离。
- 提供持久化站内失败告警，连续 3 次失败自动暂停。
- 核销 Phase 5 的 [#56](https://github.com/zhuabo001/loop-platform-zhb/issues/56)、[#61](https://github.com/zhuabo001/loop-platform-zhb/issues/61)。

固定边界：

- Artifact 目录默认未配置，不自动上传 workdir 或 Task File 所在目录；不支持服务端回写本机。
- 每个 GitHub 用户拥有一个个人团队和 owner Membership；不开放邀请、成员管理、机器跨团队迁移。
- Dashboard 与管理 API 统一要求登录；机器和 Run 分别使用自己的凭据。
- 继续使用单进程 PGlite、本地文件 BlobStore、Hono SSR，不引入 React 或复杂前端。
- 不包含邮件、Webhook、R2、托管 Postgres、历史 GC、复杂内容 diff。
- 认证层完成前仅限 localhost / 受信网络；公开部署里程碑仍须等待 Phase 6。

本文是 batch、测试编组和阶段收口的长期引用锚点。实施须遵循仓库 [AGENTS.md](../../AGENTS.md)、[CONTEXT.md](../../CONTEXT.md)、[roadmap.md](../roadmap.md)、ADR-001 至 ADR-009 及 [Issue Tracker 约定](../agents/issue-tracker.md)。新增长期决策按需写入 ADR；Issue 状态以 GitHub 为准，不在本文复制未关闭 Issue 的详情。

## 二、公共接口与关键行为

### Artifact 同步

新增可选 `artifactDir` 创建字段及配置更新 API：

```http
PATCH /api/loops/:id/artifact-dir
{ "artifactDir": "<machine-side path>" | null }
```

相对路径基于显式 workdir 解析；没有 workdir 时要求绝对路径。Daemon 必须验证目录在有效 jail 内，不跟随目录或文件 symlink，不读取特殊文件。目录修改递增独立配置 revision，旧 watcher 和未完成同步不能提交到新配置。

Protocol 增加 `artifact-sync-v1` capability、Poll 的 `watch/watchDigest` 字段及同步 DTO。仅配置 Artifact 的 Loop 额外要求该 capability；未配置的 Loop 保持原领取条件。

同步协议采用三个步骤：

1. `POST /api/machine/sync`：提交完整 manifest、配置 revision、当前 manifest revision，返回同步会话和 `needHashes`。
2. `PUT /api/machine/blob/:hash`：携带同步会话，上传协商要求的字节；Server 验证实际大小及 SHA-256。
3. `POST /api/machine/sync/:id/commit`：全部 Blob 已验证后，原子提交新 manifest。

固定规则：

- Manifest 条目包含相对路径、SHA-256、字节数；仅完整、成功提交的 manifest 按“缺席”删除旧路径。
- 扫描失败、目录消失、文件不稳定、超限均保留服务端旧版本并展示同步错误；不提交截断清单。
- 确认存在的空目录可以提交空 manifest；缺失目录不能等价为空目录。
- 配置 revision、基础 manifest revision 不匹配返回冲突；Daemon 重新协商，旧请求不得覆盖新版本。
- 相同内容不重复传输；协商、PUT、commit 均支持安全重试。
- Blob 按团队隔离命名空间，避免通过 hash 探测其他团队内容。
- 默认限制：每文件 10 MiB、每 Loop 当前 manifest 256 MiB / 5000 文件、相对路径 1024 UTF-8 字节、manifest 请求 8 MiB。Daemon 与 Server 使用同一规则。
- Never-sync 至少覆盖 VCS、依赖、worktree、缓存、Daemon 控制目录及常见凭据文件；规则放入共享 protocol policy，双侧验证。
- Phase 5 限制当前文件集合；历史 Blob 和快照累计容量治理留 Phase 6，不能宣称磁盘总占用已经有界。

新增受团队权限保护的文件列表、下载、Run 快照和 diff API。下载默认 attachment，禁止将上传 HTML/SVG 作为应用页面执行。Diff 首版只提供新增、修改、删除及前后 hash/大小。

### Run 快照与最终报告

Agent 退出后，Daemon 强制扫描并同步，最长等待 30 秒，然后冻结最终 Report 请求：

- 成功时携带不可变 `artifactSnapshotId`；Report 事务校验同 Machine、Loop、配置代际后绑定快照。
- 失败时携带稳定同步错误，Run 执行结果照常提交；同步失败不把成功 Run 改为失败。
- 非法快照引用拒绝绑定并记录同步错误，不允许跨资源引用，也不阻断合法业务终态。
- Report 重试使用同一序列化请求，不改绑后续目录内容。
- 未拿到最终快照的 Run 显示“快照缺失”；后续 idle 同步只能修复当前文件视图，不能伪造该 Run 的历史快照。
- Snapshot 为提交时观察到的文件集合，不承诺本地文件系统的原子快照。
- canceled、superseded、尚未收到最终报告的 reclaimed Run 不自动绑定当前 manifest。

### 认证、归属与通知

新增 User、Team、Membership、Session、ConnectKey，以及 Machine 的团队归属与撤销状态。Loop 归属由绑定 Machine 决定，所有 Run、Artifact、通知查询沿该归属链验证。

GitHub.com 登录采用授权码流程、一次性 state 和 PKCE S256；按 GitHub 数字用户 ID 建立身份，不以可变用户名或邮箱作为归属键。参照 [GitHub 官方 OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

Session 使用服务端持久化的随机凭据哈希，默认绝对有效期 7 天；Cookie 设置 HttpOnly、SameSite=Lax，HTTPS 使用 Secure，HTTP 仅允许显式 loopback origin。退出登录撤销 Session。

Connect key 固定 24 小时有效、单次消费，仅保存哈希，创建时显示一次。Daemon 本地生成 Machine Credential，通过 connect endpoint 换取归属；首次 poll 不再自注册。连接响应丢失时，以新凭据 poll 确认接入结果，不重复消费 key。

失败告警只在 Dashboard 展示。连续失败按首次终态事件顺序计算：成功清零，取消与 supersede 不计数。第三次失败原子暂停自动调度；恢复必须显式操作，迟到成功不能自动恢复。

## 三、实施批次与验收

### Batch 1 — Artifact 领域、协议与存储基础（3–4 天）

实施：

- 建立 ArtifactHome 深模块及本地文件 BlobStore adapter；测试使用内存 adapter。
- 新增 Artifact 配置、同步会话、不可变 manifest、Blob 元数据和 Run 快照绑定模型。
- 实现路径、容量、never-sync 校验及 prepare/PUT/commit 状态机。
- Blob 使用临时文件写入、验哈希后原子落盘；数据库只引用已确认的 Blob。
- 本批接口保持内部测试接线，不启动生产 watcher。
- 新增 ADR-010，固化单向上传、完整 manifest、提交边界和快照语义。

测试编组：

- `AM1–AM6`：迁移、旧数据、默认关闭、模型往返。
- `AP1–AP12`：路径穿越、重复路径、非法 hash、容量、never-sync。
- `AB1–AB10`：哈希不符、大小不符、中断写入、重复 PUT、Blob 缺失。
- `AC1–AC10`：全量替换、删除、提交回滚、revision 冲突和重复 commit。

批次验收：失败协商或上传不能改变当前文件视图；旧 Loop 不会开始上传，生产执行行为保持 Phase 4。

### Batch 2 — Watcher、持续同步、Run 快照与文件视图（5–7 天）

实施：

- 开放 `artifactDir` 管理接口及 Poll watch 配置。
- 实现 chokidar WatchManager：启动全扫描、事件合并、增量哈希、目录配置 reconcile、关闭 drain。
- 文件缓存使用 size/mtime/ctime，并对时间粒度内的可疑写入重新哈希；上传前重新验内容。
- 启动及每 60 秒执行完整目录核对，补偿遗漏事件；同步请求每 Loop 串行，Blob 上传并发最多 4。
- 配置移除、代际变化或 jail 验证失败时关闭旧 watcher；401/403 停止相应同步，瞬态失败指数退避，最长 60 秒。
- 接入 Run 最终快照与 Report 原子绑定。
- Dashboard 增加同步状态、文件列表、下载、快照及结构 diff。

测试编组：

- `AW1–AW14`：创建、修改、删除、重命名、idle 编辑、同大小快速改写、事件遗漏。
- `AJ1–AJ10`：jail、symlink、特殊文件、目录消失和不完整扫描。
- `AS1–AS12`：断网、响应丢失、重启重扫、配置变化、停止 drain。
- `AR1–AR12`：最终快照、Report 重试、取消、迟到 report、同步失败不丢报告。
- `AV1–AV8`：下载权限接线、XSS、attachment、二进制文件、diff。

批次验收：只传缺失内容，删除正确，重启恢复同步；Run 快照不随后续编辑变化，失败同步不会阻塞最终报告。

### Batch 3 — GitHub 登录、个人团队与旧数据归属（4–5 天）

实施：

- 新增认证及个人团队模型、GitHub adapter、Session、登录/回调/退出接口。
- 首次登录事务创建个人团队和 owner Membership；并发登录不能创建重复团队。
- 接入 Dashboard 和全部管理读写 API 的 Session 认证，不保留匿名 loopback 旁路。
- 提供停止 Server 后执行的离线认领命令，按明确 GitHub 数字 ID 将无归属 Machine 及其资源链绑定到个人团队。
- 未认领资源隔离且停止新增调度/领取；已有 Lease 保留原最终报告语义，升级前要求先 drain。
- 新增 ADR-011，记录身份、认证、个人团队及迁移边界。

测试编组：

- `AU1–AU12`：state/PKCE、回调重放、GitHub 错误、并发登录、身份稳定性。
- `SE1–SE8`：Session 过期、撤销、Cookie、重启保持。
- `LM1–LM10`：旧数据显式认领、错误目标、重复认领、零历史数据丢失。

批次验收：未登录不可读取或修改管理资源；任何首个访客都不能自动取得旧数据。本批仍不得公开暴露，机器接入隔离在 Batch 4 完成。

### Batch 4 — Connect、全资源权限隔离与 HTTP 加固（4–5 天）

实施：

- 开放 Connect key 创建/撤销、Machine connect、Machine 撤销及 Daemon connect CLI。
- 删除生产首次 poll 自注册路径；未知 Machine Credential 一律拒绝。
- 将 TeamScope/MachineScope 权限放入深模块和事务条件，覆盖列表、详情、触发、取消、schedule、goal、Task File、reopen、文件、快照和 diff。
- 撤销 Machine 原子禁止后续 poll/sync，并取消其活跃 Run、撤销 Lease；历史数据保留。
- 保留 Run Credential 的单 Run 权限边界；消费后的重试仍按既有 coded 401 确认。
- 核销 #56：JSON 写接口要求 application/json 和非空合法 JSON；拒绝不可信 Origin、cross-site fetch metadata，缺 Origin 时校验存在的 Referer；无浏览器来源头的合法客户端继续按凭据授权。
- Cookie 写操作额外要求 Session CSRF token；HTML 表单沿用独立表单解析，不套用 JSON 门禁。
- 使用显式 canonical origin 校验 Host/来源，不信任任意 forwarded header，不增加 CORS 允许头。
- Dashboard 挂载改为认证保护；Phase 5 验收仍使用 loopback。

测试编组：

- `CK1–CK10`：24h 边界、单次消费、并发连接、响应丢失、密钥脱敏。
- `TZ1–TZ16`：两个个人团队之间全部读写面不可越权，失败零写。
- `HR1–HR14`：#56 各状态变更路由、Content-Type、空体、来源、CSRF。
- `MR1–MR8`：未知凭据、Machine 撤销、Lease 撤销、旧 Daemon 兼容。

批次验收：跨团队资源统一按不存在处理；无法借任意 Loop/Run/hash 访问其他团队；#56 经后续独立复审核销。

### Batch 5 — 站内失败告警与连续失败熔断（4–5 天）

实施：

- 新增持久化结果事件与 Notification 模型；首次终态为每 Loop 分配稳定事件序号，reconcile 修订同一事件。
- Report 与 sweep 的终态事务同时写结果事件、去重告警、连续失败状态及必要的暂停，事务失败全部回滚。
- sweep reclaim 产生失败告警；迟到成功将原告警标为已纠正，并重新计算当前失败序列。
- 自动暂停复用现有 schedule revision、activation 和 OCC 规则，提交后通过共同 reconcile seam 更新 Scheduler。
- 自动暂停不抢占正在执行的 Run，不取消已有 pending；阻止后续自动触发。
- 增加站内通知列表、标记已读及显式“恢复自动调度”操作。恢复清除熔断基线，不补跑暂停期间 occurrence；Completed Loop 仍须走 Reopen。
- 手动 Run Now 维持 Paused Loop 的既有行为，成功也不自动解除熔断。
- 新增 ADR-012，记录结果事件、告警纠正及熔断语义。

测试编组：

- `NF1–NF10`：失败、重试去重、重启持久、已读、团队隔离。
- `CB1–CB12`：三次失败、成功清零、取消忽略、手动恢复、Completed 守卫。
- `NR1–NR10`：sweep/report/reconcile/恢复交错、回滚、旧 callback 拒绝。

批次验收：同一失败事件只生成一条告警；三次失败持久暂停；迟到成功纠正记录，但不会意外恢复调度。

### Batch 6 — 环境防回归、端到端验收与阶段收口（4–6 天）

实施：

- 核销 #61：明确测试 BUN_OPTIONS/NODE_OPTIONS 不进入 Agent/Probe 环境，并用零费用 fixture 验证实际 spawn 边界。
- 补充父运行时、Claude 身份、注入变量布尔值和 provider 来源的脱敏验收记录规范，修订 ADR-006。
- 新增 `test:phase5:e2e`：文件型 PGlite、真实 HTTP、生产 Daemon runtime、Fake Runner 和模拟 GitHub provider。
- 完成一次真实 GitHub 登录与 connect 的人工 smoke；默认不执行付费 Claude，Phase 4 真实 Runner 验收作为既有基线。
- 验收两个个人团队隔离、文件变化与删除、两次 Run 快照差异、断网恢复、Server/Daemon 重启、告警与熔断。
- 完成独立 Standards/Spec/Adversarial 复审及 Issue 核销。

测试编组：

- `ENV1–ENV8`：#61 环境与 spawn 防回归。
- `E5-1–E5-12`：认证、连接、同步、快照、隔离、告警、恢复全链路。
- `UP1–UP8`：旧库升级、显式认领、旧 Lease、旧 Daemon 和重启。

批次验收：全部质量门通过，真实 OAuth smoke 留证，#56/#61 及新增 Phase 5 阻塞 Issue 均经后续复审核销。

## 四、质量门、升级与完成定义

每个 batch 执行：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

最终增加 Phase 5 E2E，并记录固定提交、运行环境、命令与证据。#11 仍是 Phase 6 真实 Postgres 阻塞项，PGlite 测试不能替代多物理连接并发验证。

认证升级顺序固定为：备份数据 → 暂停并 drain Daemon/Server → migration → 离线认领旧数据 → 配置 GitHub OAuth/canonical origin → 启动认证 Server → 既有机器凭据验证 → 新机器 connect → 恢复调度。新旧 Server/Daemon 组合必须测试；新版 Daemon 对旧 Server 忽略缺失的 Artifact 配置。

阶段完成要求：

- Artifact 持续同步、删除、容量限制、快照和 diff 可用。
- 管理面统一认证，机器接入及全资源团队隔离闭环。
- 告警、纠正、三次失败暂停和显式恢复通过重启及交错测试。
- 验收证据进入 `docs/tests/phase5-acceptance.md`；长期裁决进入 ADR，状态进入 roadmap。
- README 提供登录、旧数据认领、connect、Artifact 配置与通知操作说明。
- 当前问题以 GitHub Issues 为权威来源；获准右移项仅在 roadmap 保留指针。
- handoff 不提交，PR 描述引用 ADR、验收记录及实际 Issue。
- Phase 5 标记“可靠单用户”完成；公开部署能力仍由 Phase 6 验收决定。
