# Phase 5 Batch 1 开发计划：Artifact 领域、协议与存储基础

- 状态：内部验收完成，待收口三轨复审
- 基线：`7681058`
- 目标分支：`feat/phase5-batch1-dev`
- 上位计划：[`codex-phase5-dev-roadmap.md`](codex-phase5-dev-roadmap.md)
- 长期决策：新增 ADR-010；按需修订 ADR-002
- 预计排期：5–6.5 个开发日（六个切片逐项合计为 4–6.5 天；4 天是全取最低估时的乐观情形，排期下限预留约 1 天缓冲）

## 1. 目标与固定边界

交付可通过内部接口验收的 ArtifactHome：完整 manifest 协商、按需上传、内容校验、原子提交、不可变快照，以及旧数据库无损升级。

本批保持生产执行行为与 Phase 4 一致：新增协议字段允许解析，但不挂载 Artifact HTTP 路由、不启动 watcher、不修改 Run claim 条件、不接入最终 Report 或 Dashboard。旧 Loop 默认未配置 Artifact 目录，不能开始上传。

已确认的决策：

- **团队命名空间：**不提前建立 Team。ArtifactHome 强制使用可信归属解析器提供的存储命名空间；测试注入归属映射。缺少有效归属时拒绝操作，不提供默认全局命名空间。生产 Team 归属由后续认证批次接入。
- **配置切换：**修改或移除 `artifactDir` 后保留最后成功的 manifest，并依据配置代际将其标记为过期。新配置首次成功提交后才替换当前视图；历史 manifest 和快照保持不可变。
- **超限处理：**非法、不完整或超限 manifest 整单拒绝。不得裁剪文件后提交，因为缺席路径会删除旧视图中的文件。
- **存储治理：**本批限制当前清单和单文件大小，不声称历史快照、未引用 Blob 或过期会话的累计磁盘用量有界；历史 GC 属于 Phase 6。

## 2. 协议、校验与持久化模型

### Protocol 与共享 policy

在 `@loopzhb/protocol` 增加 Artifact DTO、纯校验 policy 和 `artifact-sync-v1` capability。协议主入口保持无 Node 内建依赖；SHA-256 等 Node 功能放入已有 `./node` 子入口。所有新增 object schema 遵守 ADR-002 的 tolerant-reader 规则，并纳入穷尽测试清单。

预声明后续接线所需形状，本批不开放生产路由：

| 接口 | 契约 |
|---|---|
| Create/配置更新 | 可选 `artifactDir`；更新请求 `{artifactDir: string \| null}` |
| Poll | 请求可选 `watchDigest`；响应可选 `watch` 和 `watchDigest` |
| Watch 项 | `loopId`、`artifactDir`、`workdir`、有效 Server roots、Artifact 配置 revision |
| prepare | `{requestId, loopId, configRevision, baseManifestRevision, entries}` |
| prepare 响应 | `{syncId, needHashes, expiresAt}` |
| PUT | sync ID、协商过的 hash 和原始字节流；未来 HTTP 通过 `X-Artifact-Sync-Id` 传会话 ID |
| commit 响应 | `{artifactSnapshotId, manifestRevision}` |
| Report | 可选 `artifactSnapshotId`、`artifactSyncError`；本批不消费 |

`watch` 是完整配置集合：缺省代表无需更新，`[]` 代表清空。`watchDigest` 只覆盖规范化 watch 配置，不随文件同步变化。

Manifest 条目固定为 `{path, hash, size}`，执行以下同一套双侧校验：

- `path` 是规范 POSIX 相对路径；拒绝绝对路径、盘符、反斜杠、空路径段、`.`、`..`、NUL 和非法 Unicode。
- 不做 URL 解码、大小写折叠或 Unicode 归一化；拒绝重复路径及 `a` 与 `a/b` 这种文件/目录冲突。
- `hash` 是 64 位小写十六进制 SHA-256；`size` 是非负安全整数。同一 hash 声明不同 size 时拒绝。
- 单文件上限 **10 MiB**、当前完整清单 **256 MiB / 5000 文件**、路径 **1024 UTF-8 字节**、prepare 请求 **8 MiB**，均含边界值。
- 清单容量按每个路径分别累加；即使内容相同，多个路径仍分别计入。上传内容按 hash 去重。
- 任一条目非法、超限或属于 never-sync 规则，整份 manifest 拒绝，不跳过条目、不生成截断清单。
- 8 MiB 限制覆盖完整请求编码，包括未知字段；提供有界解析工具供内部测试。Batch 2 的 HTTP adapter 必须在解析 JSON 前执行同一限制。

Never-sync 规则集中在共享 policy，首版无例外及关闭开关，ASCII 大小写不敏感匹配。目录至少包含：`.git`、`.hg`、`.svn`、`node_modules`、`.worktrees`、`.venv`、`venv`、`.yarn`、`.pnpm-store`、`.cache`、`.next`、`.nuxt`、`.svelte-kit`、`.turbo`、`.parcel-cache`、`.gradle`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.tox`、`.loopzhb`、`.loopany`、`.claude`、`.codex`、`.ssh`、`.aws`、`.azure`、`.kube`、`.gnupg`、`.config/gcloud`，以及 `loopzhb-control-*`、`loopzhb-runs-*`、`lzc-*`。文件至少包含：`.DS_Store`、`.env`、`.env.*`、`.npmrc`、`.netrc`、`.pypirc`、`credentials`、`credentials.json`、`*.pem`、`*.key`、`id_rsa*`、`id_ed25519*`。

Server 不解析机器上的 `artifactDir` 文件系统路径。相对路径基于显式 workdir 解析；没有 workdir 时必须是绝对路径。Daemon jail、symlink、特殊文件与目录完整性校验属于 Batch 2。

### 数据模型与迁移

继续使用 PGlite、Drizzle、ISO text 时间戳和无外键约定，新增一个前滚 migration。迁移测试以现有 Phase 4 `0000–0004` 为冻结旧库 fixture，不修改历史迁移。

| 模型 | 字段与作用 |
|---|---|
| Loop | `artifactDir=null`、`artifactConfigRevision=0`、`artifactManifestRevision=0`、`artifactManifestId=null`，加同步尝试时间、成功时间及稳定错误分类 |
| SyncSession | namespace、Machine、Loop、requestId、配置/base revision、规范 manifest、载荷指纹、已协商 hash 集合、创建/过期时间、提交回执 |
| ArtifactManifest | 不可变 ID、namespace、Machine、Loop、配置 revision、manifest revision、完整 entries、文件数、总字节数、提交时间 |
| ArtifactBlob | `(namespaceId, hash)` 唯一键、实际大小、验证时间 |
| Run | 可空 `artifactSnapshotId` 和 `artifactSyncError` |

不可变 manifest ID 同时作为 Run 的 `artifactSnapshotId`，不另建重复快照表。manifest 以受限 JSONB 数组保存；当前文件视图通过 Loop 指针读取。

数据库约束与写路径共同保证：

- Session 的 `(namespaceId, machineId, requestId)` 唯一；manifest 的 `(loopId, manifestRevision)` 唯一。
- Revision 非负、单调递增，到 int32 上界时稳定拒绝。
- ArtifactHome 在事务内验证资源归属链；wire 输入不得指定存储 namespace。
- 旧库新增列使用安全默认，不自动配置目录、不生成 manifest、不绑定历史 Run。

## 3. ArtifactHome 与 BlobStore 行为

### 深模块接口与配置更新

ArtifactHome 注入 Db、Clock、ID factory、BlobStore 和可信归属解析器。归属解析器根据可信 Machine 身份生成 `{namespaceId, machineId}`；所有 prepare、PUT、commit、读取和快照绑定操作都重新验证 Loop、Machine、namespace 及资源关联。客户端只传 Loop/session/hash，不能自行选择 namespace。

模块提供配置更新、prepare、PUT、commit、当前视图/快照读取、同步失败记录和快照绑定计划。错误通过稳定结果联合返回，不暴露文件内容、凭据或存储内部路径。

配置更新规则：

- 等值更新零写入；有效 set/change/clear 递增 `artifactConfigRevision`。
- 保留旧 manifest 指针与 manifest revision；读取时按配置代际计算过期状态。
- 配置变化清除上一代的同步尝试状态；旧代请求不能更新新代状态。
- Loop 写入遵循既有 `loops.revision` CAS，递增统一 revision 并更新时间戳，不修改 schedule/goal revision。
- 复用一次有界 OCC 重试；配置或 manifest revision 冲突返回冲突，不能拿旧请求自动改用新 base 重放。

### prepare → PUT → commit

**prepare** 在写 session 前校验请求、清单和资源归属，再检查 Artifact 配置 revision 及 base manifest revision。prepare 不改变当前视图。客户端 `requestId` 用于恢复响应丢失：同键同规范化载荷复用会话，同键不同载荷返回冲突。重复 prepare 可重新计算缺失 Blob，并更新会话协商的 hash 集合。已提交请求返回原 session/revision，由 commit 重试恢复原回执。

Pending session 默认有效 **1 小时**，用注入的 Clock 判定；过期后须重新协商。已提交回执不因 pending 有效期失效。

**PUT** 只接受当前归属会话已协商的 hash。以流方式统计真实字节数并计算 SHA-256，不信任声明 size 或 Content-Length。写入期间和完成前都验证会话及配置代际。失败只清理本次临时文件，不改变当前 manifest。重复 PUT 仍检查上传字节，错误内容不能因目标 Blob 已存在而被接受。

**commit** 先确认所有 Blob 已验证且实际存在，再在一个数据库事务里重新检查会话归属、配置 revision、base manifest revision 和 Loop CAS，然后插入完整不可变 manifest、递增 manifest revision、更新 Loop 当前指针/成功状态，并将 session 标记为 committed、保存固定回执。任一步失败，数据库写入整体回滚。

只有完整成功提交的 manifest 才以路径缺席删除旧路径。相同 session 重复 commit 返回原回执，不生成新快照、不递增 revision、不让当前指针回退；配置变化后仍允许读取该历史回执，但须通过归属验证。每个新 session 成功提交会生成新快照，即使内容相同；同一 session 的重试始终返回相同快照。

错误至少稳定区分：校验失败、配置冲突、manifest 冲突、会话过期、hash 未协商、hash/size 不符、Blob 缺失和存储错误。

### BlobStore adapter

提供本地文件和测试内存两个 adapter，并运行同一契约测试。接口支持已验证写入、存在性检查和读取；本批不提供 Blob 删除或历史 GC。

本地 adapter 使用安全 namespace/hash 存储键，不把 manifest 路径映射为磁盘路径。写入时在目标文件系统内创建独占临时文件，流式写入、验证大小和 hash、刷新文件后原子发布；拒绝 symlink 与非普通文件。并发和重复上传不能暴露半文件。只有确认文件发布成功后才记录 Blob 元数据。

文件发布成功而数据库事务失败时允许留下未引用 Blob，不能通过删除共享 Blob 模拟文件系统回滚。元数据存在但文件丢失时，prepare 要求重传，commit 拒绝不完整快照。进程崩溃遗留临时文件的全局清理不属于本批。

### Run 快照边界

本批交付快照绑定的纯校验/write-plan 和持久化测试，不改生产 Report 事务。绑定前验证快照已提交，且 namespace、Machine、Loop、当前 Artifact 配置代际一致。非法引用记录 Artifact 同步错误，不改变合法 Run 执行结果。取消、superseded 或尚未收到合法最终报告的 reclaimed Run 不自动绑定快照。

Batch 2 将 binding plan 接入既有 Report 事务，并实现最终同步、30 秒等待和固定 Report 重试请求。

## 4. 开发切片与测试编组

| 切片 | 内容 | 完成条件 | 估时 |
|---|---|---|---|
| 1. 契约冻结 | Protocol DTO、`artifact-sync-v1`、tolerant-reader、共享 policy、canonical 指纹、错误/重试约定、8 MiB 有界解析工具；冻结 BlobStore 与可信归属解析器的服务端内部接口及行为契约；写入 ADR-010 决策条目并加路由未挂载守卫 | AP1–AP12；两个内部接口可编译，输入/输出、职责和失败语义在 ADR-010 中明确；AD1 守卫 | 0.5–1 天 |
| 2. 模型与迁移 | Schema、`0005` 前滚 migration、Phase 4 `0000–0004` 冻结 fixture、唯一键与 revision 规则、配置事务及快照 binding plan；加 Create/Poll 守卫 | AM1–AM6、`db:check` 无 drift、旧库升级后老 Loop/Run/Lease 行为不变；AD2 守卫 | 0.5–1 天 |
| 3. BlobStore | 内存/本地 adapter，共享契约测试；独占临时文件、流式写入、size/hash 校验、fsync 后原子 rename；拒绝 symlink 与特殊文件；加生产启动不构造 BlobStore 守卫 | AB3、AB9、AB10；AD4 守卫 | 1 天 |
| 4. ArtifactHome 状态机与事务实现 | 配置、prepare/PUT/commit；配置/base revision 校验、Loop CAS、唯一键冲突处理、原子提交及有界重试；requestId 幂等、1 小时 pending 过期、固定提交回执；加 Report 休眠守卫 | AC1–AC3、AC7、AC8、AC10；AB1、AB2、AB4、AB6、AB8 顺序场景；AD3 守卫 | 1–1.5 天 |
| 5. 并发、交错与故障注入验收 | 通过 PGlite 真实事务、可控交错 hook 和故障注入验证片 4 已实现的事务保护，修复交错问题并完成回滚矩阵 | AC4–AC6、AC9；AB5、AB7；并发重试子场景 | 0.5–1 天 |
| 6. 休眠回归、内部验收与收口 | 汇总 AD1–AD4；文件型 PGlite + 本地 BlobStore + 真实临时目录内部集成验收；ADR-010、ADR-002、领域词汇、验收记录、roadmap、Issue 和三轨复审 | 全部编组、五道质量门与内部 E2E 通过 | 0.5–1 天 |

片 4 的顺序执行场景不缩减实现契约：该片结束时事务、CAS、唯一键仲裁和有界重试必须已经实现。片 5 是并发与故障验收，不是首次补上并发保护；不得交付仅在单线程下正确的数据库写路径。

片 2 与片 3 没有直接实现依赖，可以互换或并行；并行前提是片 1 已完成表中的两个服务端内部接口契约。错误分类与重试约定也在片 1 冻结，片 2/3 使用同一稳定分类。

按原 roadmap 测试 ID 展开；每个编号至少包含下列独立场景，允许使用参数化用例：

| 编组 | 验收场景 |
|---|---|
| **AM1–AM3** | AM1：Phase 4 文件旧库无损升级；AM2：旧 Loop 默认关闭，旧 Run/Lease 行为正常；AM3：新模型往返及安全默认 |
| **AM4–AM6** | AM4：唯一性、revision 和关联约束；AM5：关闭/重开、重复 migration 和 session 恢复；AM6：配置 set/change/clear/no-op、旧视图过期和旧代请求失效 |
| **AP1–AP4** | AP1：路径合法及穿越矩阵；AP2：重复路径及文件/目录冲突；AP3：NUL、非法 Unicode、UTF-8 路径长度边界；AP4：hash 形状与同 hash 不同 size |
| **AP5–AP8** | AP5：单文件字节上限；AP6：累计大小和相同内容多路径计数；AP7：5000/5001 文件；AP8：原始请求 8 MiB 边界与未知字段绕过 |
| **AP9–AP12** | AP9：VCS、依赖、worktree、cache 排除；AP10：控制目录及凭据文件排除；AP11：整单拒绝、规范化及顺序无关指纹；AP12：tolerant-reader 清单与冻结 Phase 4 reader 双向兼容 |
| **AB1–AB5** | AB1：hash 不符；AB2：声明/实际大小不符及流超限；AB3：中断和临时文件清理；AB4：重复 PUT 正确内容与错误内容；AB5：同 namespace 并发上传同 hash |
| **AB6–AB10** | AB6：未协商 hash 和跨 Machine/namespace/session 拒绝；AB7：文件发布及数据库故障；AB8：元数据存在但文件缺失；AB9：空文件、二进制和重启读取；AB10：安全存储键、symlink/特殊文件拒绝及双 adapter 契约一致 |
| **AC1–AC5** | AC1：完整替换；AC2：缺席删除和合法空 manifest；AC3：失败/不完整同步保留旧视图；AC4：提交事务任一步失败均回滚；AC5：配置切换与 commit 交错 |
| **AC6–AC10** | AC6：base 冲突和会话竞争；AC7：重复 commit、丢失响应、重启取回回执及禁止指针回退；AC8：prepare 幂等键、载荷冲突和过期；AC9：统一 Loop OCC 与调度/Report 写入交错；AC10：快照不变、绑定成功及跨资源引用拒绝 |

增加 **AD1–AD4 生产休眠回归**：

- AD1：Artifact 管理、sync、PUT、commit、文件路由未挂载。
- AD2：生产 Create 不持久化 Artifact 配置；Poll 不返回 watch、不增加 claim 门槛。
- AD3：生产 Report 忽略新增 Artifact 字段，终态行为与 Phase 4 一致。
- AD4：生产启动不创建 BlobStore、不启动 watcher；Daemon 不声明新 capability、不发送同步请求。

并发验收使用 PGlite 真实事务、可控交错 hook 和故障注入；此证据不替代 #11 的 report/reclaim 与 #72 的 Artifact 绑定/配置切换所要求的多物理连接 Postgres 并发验证。

片 5 保留 AC6 中不同 session 争抢同一 base revision 的场景，并补齐以下同幂等键/会话并发子场景，不新增或减少原 AM/AP/AB/AC/AD 测试编组编号：

| 场景 | 编组 | 验收结果 |
|---|---|---|
| 同 namespace/Machine、同 `requestId`、同规范载荷同时 prepare | AC8 | 复用同一 session；不产生重复会话；同键不同载荷返回稳定冲突，不泄漏唯一键异常 |
| 同一 session 同时 commit | AC7、AC9 | 最多生成一个 manifest、一次 revision 递增；两次请求收敛到同一 snapshot ID，不回退当前指针 |
| PUT 尚未完成时切换或移除 Artifact 配置 | AB7、AC5 | 配置代际复验拒绝旧上传，旧 session 不能 commit 或更新新代状态；允许留下未引用 Blob，不删除共享 Blob 模拟回滚 |

PGlite 交错点放在事务外 resolve/write 之间或 Blob 流等待点，用竞争事务提交新状态；事务内 hook 用于抛错并验证回滚，不在同一连接的未结束事务中等待另一笔竞争事务。

另增加一条 Batch 1 内部集成验收（不改变原测试编组 ID）：通过 ArtifactHome 执行 prepare → PUT → commit → 读取当前视图和快照，并在测试事务中应用 binding plan、核对 Run 引用与文件内容。关闭数据库后，以同一文件型 PGlite 数据目录和本地 Blob 根目录重开，确认快照及 Run 引用仍在；重试同一 commit 返回相同 snapshot ID/manifest revision，且不创建第二份记录。再提交文件变化，确认旧快照不变，重试旧 commit 不会回退当前指针。该路径只调用内部模块，不挂载 Artifact HTTP 路由、不接入生产 Report handler，不实现 Batch 2 watcher/最终 Report 协调。

参数化可减少重复测试代码，但不能删减编组的断言、失败分支或交错场景来缩短工期；工期不足时调整排期，不降低完成条件。

## 5. 质量门、文档与完成定义

按仓库约定运行：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

额外检查生产 import/composition，证明 ArtifactHome 只由测试接线；本批不跑真实 Claude 或 OAuth。

文档交付：

- 新增 ADR-010，记录完整 manifest、namespace、原子提交、重试、配置切换和快照语义；按需修订 ADR-002，写清共享 Artifact policy 及兼容协议差异。
- 更新领域词汇，并在 Phase 5 验收记录固定提交、命令、结果及生产休眠证据。
- 所有质量门和复审通过后更新 roadmap 的 Batch 1 状态。新增问题按 Issue Tracker 约定记录；#56、#61 仍由后续批次处理。

完成定义：AM/AP/AB/AC 与 AD 编组全部通过；失败协商、上传或提交不改变当前文件视图；快照不可变；旧库无损升级；生产仍运行 Phase 4 行为。

已知限制：本批只验证 namespace 隔离，未实现用户认证或生产 Team 归属。当前集合限制不等于历史快照、过期 session 和孤立 Blob 的累计磁盘占用有界；这些继续留给 Phase 6。
