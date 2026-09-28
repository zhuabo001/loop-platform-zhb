# ADR-010：Phase 5 Batch 1——Artifact 同步基础（单向上传、完整 manifest、原子提交与快照语义）

- 状态：Accepted
- 日期：2026-09-28
- 关联：ADR-002（协议包纪律）、ADR-009（Phase 4 语义）、`docs/plan/codex-phase5-batch1-plan.md`
- 实现：Batch 1 片 1（本文档的决策条目先于行为代码写入，作为片 2/3/4 的契约依据；片 6 收口时复核）

## 背景

Phase 5 要为 Loop 增加 Artifact 目录同步：Daemon 持续单向上传文件，Server 存储不可变 manifest 与 Blob，Run 可绑定快照。这一功能横跨 Daemon 扫描、wire 协议、Server 状态机、本地存储与数据库事务，任何一处契约含糊都会在后续切片或 Batch 2 放大为返工。Batch 1 片 1 在不挂载任何生产路由、不改变生产行为的前提下，冻结全部跨切片契约：wire DTO、共享校验 policy、canonical 指纹、错误分类与重试约定、两个服务端内部接口（BlobStore、可信归属解析器）的行为契约。本批保持生产执行行为与 Phase 4 一致（休眠边界，决策 16）。

## 决策

### 1. 单向上传与完整 manifest 语义

同步只从 Daemon 到 Server 单向流动；Server 不回写本机。每次 prepare 携带**当前完整 manifest**（不是增量）；提交成功即整份替换当前文件视图，manifest 中缺席的路径即删除。扫描失败、目录消失、文件不稳定或超限时保留服务端旧版本并展示同步错误，不提交截断清单。确认存在的空目录可以提交空 manifest；缺失目录不能等价为空目录。

### 2. 路径与条目校验域

Manifest 条目固定为 `{path, hash, size}`。`path` 必须是规范 POSIX 相对路径：拒绝绝对路径、盘符、反斜杠、空路径段、精确 `.`/`..` 段、NUL 与未配对代理项（非法 Unicode）；不做 URL 解码、大小写折叠或 Unicode 归一化，值逐字保留。拒绝重复路径及 `a` 与 `a/b` 这类文件/目录冲突（两种 wire 序都拒绝）。`hash` 是 64 位小写十六进制 SHA-256；`size` 是非负安全整数；同一 hash 声明不同 size 整单拒绝。schema 层只钉 typeof 形状：`path`/`hash` 为 `z.string()`，`size` 为 typeof-number 检查而**不是** `z.number()`——Zod 4 在 schema 层拒绝非有限数，wire 上的 `1e400`（JSON 解析为 Infinity）会在 schema 处死亡，而 Daemon 直接调 policy 得到 `size_invalid`，同一缺陷两条分类路径（片 1 复审 A1 发现，已修）。值域规则单一来源在共享 policy——Daemon 与 Server 必须对同一份 manifest 产出同一套失败分类，不允许 zod issue 与 policy failure 两条分类路径并存。

### 3. 上限常量（含边界值）

单文件 10 MiB；当前完整清单 256 MiB / 5000 条目；单路径 1024 UTF-8 字节；prepare 请求 8 MiB。全部边界值含等号。清单容量按每个路径分别累加（同一内容在 N 个路径计 N×size）；上传内容按 hash 去重。常量单一来源在 `artifact-policy.ts`，双侧共用。

### 4. never-sync 规则表

规则集中在共享 policy，首版无例外、无关闭开关，ASCII 大小写不敏感匹配。目录规则匹配路径的任意连续段窗口（含 `.config/gcloud` 段对与 `loopzhb-control-*`/`loopzhb-runs-*`/`lzc-*` 前缀）；文件规则匹配 basename（含 `.env`/`.env.*`/`*.pem`/`id_rsa*` 等通配）。规则表逐字冻结（`NEVER_SYNC_DIRECTORY_RULES`/`NEVER_SYNC_FILE_RULES`，见 Batch 1 计划 §2），测试逐字钉住防漂移。命中任一规则的条目导致整份 manifest 拒绝。

### 5. 8 MiB 有界解析插入点

8 MiB 上限量的是**解析前的原始请求文本**——未知字段是原始文本的一部分，天然计入；tolerant-reader 的 strip 发生在其后，被剥离的内容照样计入。组合顺序固定为：cap-on-raw → strip → validate → fingerprint-on-normalized。共享工具 `parseBoundedJsonText` 只做「语法 + 大小」并返回 `unknown`，形状校验是另一个可组合步骤。Batch 2 的 HTTP adapter 必须在 prepare 路由上同时使用 `bodyLimit(8 MiB)`（传输层 413）与该工具（解析前校验）双闸；内部非 HTTP 路径共用同一函数。

### 6. canonical 规范化与顺序无关指纹

会话指纹覆盖**除 `requestId` 外**的完整规范化 prepare 载荷 `{loopId, configRevision, baseManifestRevision, entries}`——`requestId` 是幂等键而非载荷；config/base revision 不同必须判为不同载荷（冲突），防止携带过期 base 的重发复用旧会话。规范化 = 校验 + 定序，值逐字保留：entries 通过全部校验后按 `path` 的 UTF-16 code unit 序（JavaScript 默认字符串比较，无 locale）升序排列。canonical 序列化为递归稳定 stringify：对象键按 UTF-16 序排序、数组保序、数字走 `JSON.stringify`（值域被 policy 限定为非负安全整数）、无空白。指纹在 strip 与校验**之后**计算，只覆盖已知规范化字段。纯规范化函数在主入口，SHA-256 组合（`preparePayloadFingerprint`/`watchConfigDigest`）在 `./node` 子入口。`watchDigest` 只覆盖规范化 watch 配置全集（项按 `loopId` 排序、roots 去重排序），不随文件内容变化。黄金向量逐字钉住。

### 7. namespace 可信归属

存储 namespace 的唯一来源是可信归属解析器：由已认证的可信 Machine 身份产出 `{namespaceId, machineId}`。wire 输入不得指定 namespace；每次 prepare/PUT/commit/读取/快照绑定都重新解析归属。缺少有效归属时拒绝操作（`artifact_attribution_missing` / 403），不提供默认全局命名空间。生产 Team 归属由后续认证批次接入；Batch 1 测试注入归属映射。

### 8. 配置代际与过期

`artifactConfigRevision` 单调递增：等值更新零写入，有效 set/change/clear 递增代际。修改或移除 `artifactDir` 后**保留**最后成功的 manifest 指针与 manifest revision，读取时按配置代际计算过期状态；新配置的首次成功提交才替换当前视图。配置变化清除上一代的同步尝试状态，旧代请求不能更新新代状态。`artifactDir` 的 workdir-相对/绝对路径规则是 Server 单侧 policy（相对路径基于显式 workdir 解析，无 workdir 时必须是绝对路径），不进入共享 policy；Server 不解析机器上的文件系统路径。

### 9. prepare 幂等与 requestId

SyncSession 以 `(namespaceId, machineId, requestId)` 为唯一键。同键同规范化载荷（决策 6 指纹相同）复用会话并可重新计算缺失 Blob、更新协商 hash 集合；同键不同载荷返回 `artifact_manifest_conflict`。重复 prepare 不改变当前视图。pending session 默认有效 1 小时，由注入的 Clock 判定，过期后须重新协商；已提交回执不因 pending 有效期失效。

### 10. PUT 验证语义

PUT 只接受当前归属会话已协商的 hash（经 `X-Artifact-Sync-Id` 头携带会话）。以流方式统计真实字节数并计算 SHA-256，不信任声明 size 或 Content-Length——真实字节流是唯一事实来源。写入期间和完成前都验证会话及配置代际。重复 PUT 仍检查上传字节：错误内容不能因目标 Blob 已存在而被接受。失败只清理本次临时文件，不改变当前 manifest。实际字节与协商不符是稳定分类 `artifact_content_mismatch`。

### 11. 原子提交边界

commit 先确认所有协商 Blob 已验证且实际存在，再在一个数据库事务里重新检查会话归属、配置 revision、base manifest revision 和 Loop CAS，然后插入完整不可变 manifest、递增 manifest revision、更新 Loop 当前指针/成功状态，并将 session 标记为 committed、保存固定回执。任一步失败，数据库写入整体回滚。相同 session 重复 commit 返回原回执：不生成新快照、不递增 revision、不让当前指针回退；配置变化后仍允许经归属验证读取该历史回执。每个新 session 成功提交生成新快照，即使内容相同。

### 12. 快照语义与未引用 Blob 边界

不可变 manifest ID 即 Run 的 `artifactSnapshotId`，由 ArtifactHome 注入的 ID factory 铸造，**不是内容哈希**——内容相同的不同 session 提交生成不同快照；不另建快照表。文件发布成功而数据库事务失败时允许留下未引用 Blob，不能通过删除共享 Blob 模拟文件系统回滚；元数据存在但文件丢失时，prepare 要求重传，commit 拒绝不完整快照。历史 Blob、过期 session 与孤立 Blob 的累计磁盘治理属于 Phase 6，本批不宣称其占用有界。

### 13. 错误分类、HTTP 映射与重试约定

wire 错误形状复用 `apiErrorSchema` `{error, code?}`；错误文本不是机器契约，code 才是。稳定区分 9 码（内部细粒度 policy 失败字面量映射到这层，双层设计同 RunCapabilityInvalidError 先例）：

| code | HTTP | 归属步骤 | 重试类 |
|---|---|---|---|
| `artifact_validation_failed` | 400 | prepare（schema/path/never-sync/上限/hash/size 域） | terminal |
| `artifact_config_conflict` | 409 | prepare/PUT/commit（配置代际不符） | renegotiate |
| `artifact_manifest_conflict` | 409 | prepare（base 不符、同键不同载荷）、commit（base 竞争） | renegotiate |
| `artifact_session_expired` | 409 | PUT/commit（已知但过期） | renegotiate |
| `artifact_hash_not_negotiated` | 409 | PUT（hash 未协商） | renegotiate |
| `artifact_content_mismatch` | 400 | PUT（真实字节 hash/size 不符） | terminal |
| `artifact_blob_missing` | 409 | commit（协商过的 Blob 实际缺失） | resume（重传后原样重试） |
| `artifact_storage_error` | 500 | prepare/PUT/commit/读取 | idempotent_retry（有界退避） |
| `artifact_attribution_missing` | 403 | 全部（缺少有效可信归属） | terminal |

从未存在或跨归属的会话/Blob 一律无码平 404——存在性不跨 scope 泄漏（同既有 404 约定）。请求级传输错误沿用既有约定：原始体超限 → 413（bodyLimit）、JSON 畸形 → 400 无码、机器凭证无效 → 401。重试类定义：`idempotent_retry` 可原样有界重试；`resume` 补传缺失 Blob 后原样重试；`renegotiate` 从 prepare 重新协商；`terminal` 同请求必败，须先修复成因。码→重试类映射以 `ARTIFACT_ERROR_RETRY_CLASS` 常量表机器可核对地固定在 protocol。HTTP 映射固定后即为契约（同 ADR-009 修订 2026-09-01 决策 6），Batch 2 以 taxonomy pin 测试钉死。

### 14. BlobStore 内部接口契约

服务端内部接口（`packages/server/src/artifact/blob-store.ts`），本批只冻结不实现。方法：`writeVerified`（已验证写入）、`has`（存在性检查）、`read`（读取）；无删除、无历史 GC。失败走结果联合（`invalid_key`/`content_mismatch`/`blob_missing`/`not_regular_file`/`storage_error`）而非异常——Blob 缺失与内容不符是正常流程分支。写入语义：流式统计真实字节并计算 SHA-256 与协商值比对、超限短路 `content_mismatch`；独占临时文件 → fsync → 原子发布；并发/重复上传不暴露半文件且仍验证字节；只有发布成功后才记录 Blob 元数据。存储键是安全的 `(namespaceId, hash)` 形状，manifest 路径不映射为磁盘路径；拒绝 symlink 与非普通文件。`has` 不把存储错误吞成 missing（否则污染 commit 的重传分类）；blob 路径上的 symlink/特殊文件是**异常**而非缺失，分类 `not_regular_file`（归入 `BlobPresenceFailure`），不得报告为干净的 `present:false` 走上重传路径。`read` 的失败通道分两阶段：打开期失败（`invalid_key`/`blob_missing`/`not_regular_file`/`storage_error`）走 `BlobReadResult` 结果联合；打开后流式读取中途的 I/O 失败以流内**终止元素** `{ok:false, failure:"storage_error"}` 表达——迭代器不得为 I/O 失败抛异常，消费端不做 try/catch 即可分类。片 3 的共享契约测试必须覆盖读取中途 I/O 故障与 `has`/`read` 遇 symlink/特殊文件两类场景。内存与本地 adapter 共享同一契约测试（片 3）。

### 15. 可信归属解析器接口契约

服务端内部接口（`packages/server/src/artifact/attribution.ts`），本批只冻结不实现。`resolve(machine: TrustedMachineIdentity): Promise<ArtifactAttribution>`：输入是 store 已从 Bearer 凭证解析出的可信 Machine 身份（永非 wire 输入）；异步（生产 Team 归属需要查库）；缺失归属是预期域结果（联合返回 `{ok:false, failure:"attribution_missing"}`），不抛异常。每次操作重新解析，不从请求缓存。接口的输入/输出、职责与失败语义即决策 7 与本文；TSDoc 与本文不得矛盾，漂移时以本文为准并同步修订。

### 16. Batch 1 休眠边界

本批不挂载任何 Artifact HTTP 路由、不启动 watcher、Daemon 不声明 `artifact-sync-v1`、Report 不消费 `artifactSnapshotId`/`artifactSyncError`、Run claim 条件不变、旧 Loop 默认未配置 Artifact 目录且不开始上传、生产装配不构造 BlobStore。可执行证据为 AD1–AD4 休眠守卫（路由 404 探测、Create/Poll/Report 行为不变、启动装配无 BlobStore/watcher），分别随片 1/2/3/4 挂载，片 6 汇总核对。

### 17. 共享 policy 的 ADR-002 窄例外记录

`artifact-policy.ts` 是 ADR-002 决策 4「裁剪策略不进 protocol」的第二个记录在案窄例外（第一个是 terminal-policy.ts）：manifest 条目校验、容量上限、never-sync 规则、canonical 规范化与有界解析必须由 Daemon（扫描本地预分类）与 Server（防御层收口）逐字一致地执行，两份拷贝必然漂移，故单一来源放 protocol 包。模块保持纯函数、无 I/O、无 Node 内建依赖，主入口浏览器可 bundle 性不变。ADR-002 修订记录同步登记。

## 后果

- 片 2/3 可以并行：表结构与 BlobStore adapter 都只对本文档与已编译接口负责。
- Daemon 本地扫描预分类与 Server 防御层共用同一 policy，失败分类跨端一致；Batch 2 的 HTTP adapter 按决策 5/13 接线即可。
- 9 码错误分类与重试约定冻结后，Daemon 的重试/重新协商行为可以脱离实现先行测试。
- 休眠边界（决策 16）使本批可以安全合入主干：生产行为与 Phase 4 逐字节一致由 AD1–AD4 可执行证据支撑。
- 已知限制延续 Batch 1 计划：只验证 namespace 隔离，未实现用户认证与生产 Team 归属；历史快照、过期 session 与孤立 Blob 的累计磁盘治理留 Phase 6。

## 修订记录

### 2026-09-28（片 1 三轨复审 Round 1 修复）

- **决策 2 措辞修正（A1）**：原文「schema 层只钉形状（`z.string()`/`z.number()`）」改为 typeof 形状——`size` 不得用 `z.number()`（Zod 4 在 schema 层拒绝非有限数，会让 wire `1e400` 在 Server 死于 zod issue、在 Daemon 死于 policy `size_invalid`，违反本决策自身的单一分类要求）。决策语义（值域单一来源在共享 policy）不变，实现措辞对齐。
- **决策 14 细化（S1）**：明确 `read` 的两阶段失败通道与 `has` 对 symlink/特殊文件的分类（见决策 14 正文）。接口冻结时尚无 adapter 依赖旧措辞，属实现前修正而非行为变更。

### 2026-09-28（片 2 模型与迁移）

- **schema 落定（决策 8/9/11/12 的持久化形状）**：`loops` 增 7 列、`runs` 增 2 列、新表 3 张（`artifact_sync_sessions` / `artifact_manifests` / `artifact_blobs`），migration `0005` 前滚；沿用既有纪律：无外键、无新 CHECK（revision 非负/单调/上界是写路径纪律，同 `goalRevision`/`scheduleRevision`）、ISO text 时间戳、jsonb 存规范化 manifest 与回执。唯一键即声明的仲裁面：session `(namespaceId, machineId, requestId)`、manifest `(loopId, manifestRevision)`、blob 复合主键 `(namespaceId, hash)`。
- **revision 上界耗尽的稳定分类**：内部字面量 `config_revision_exhausted`（本片配置事务；镜像 schedule 域 `schedule_revision_exhausted` 先例）与 `manifest_revision_exhausted`（片 4 commit 路径预声明）。二者在 Batch 1 无路由可达，**wire 映射推迟到 Batch 2 路由接线时裁决**；稳定拒绝（结果联合、不抛异常、零写入）即本批契约。配置 planner 求值序钉死为 validate → noop → exhaustion：等值命令在 int32 上界仍是 noop（零写入优先），非法值即使与存储值相等也拒绝。
- **配置更新无 completed-loop 限制**：镜像 `updateTaskFile`（运维重定向）而非 `updateGoal`（完成冻结语义）——决策 8 未列完成态限制，此处记录为有意的默认。
- **快照绑定的内部分类字面量**（`runs.artifact_sync_error` 自由文本列的值集种子，Batch 2 拥有最终分类法）：`snapshot_not_committed` / `cross_namespace` / `cross_machine` / `cross_loop` / `stale_config_generation`。绑定资格为 `run.phase === "running"`：canceled/superseded 不绑定；**reclaimed（terminal-grace 唤醒报告）路径在本层保守排除**，Batch 2 把 binding plan 接入 report 事务的 reconcile 分支时须显式裁决是否放行。

### 2026-09-28（片 2 三轨复审 Round 1 修复：#69/#70/#71）

- **绑定身份核对（#69）**：`planArtifactSnapshotBinding` 新增 `manifest.id === snapshotId` 核对，失配归入既有字面量 `snapshot_not_committed`——引用 ID 没有已提交 manifest 的证据（查不到与查到的不是同一行，对绑定者等价），值集不扩。bind 计划写入已验证的 `manifest.id`，不再直采独立的 `snapshotId` 输入。
- **machine 归属链补全（#70）**：`cross_machine` 检查纳入 `loop.machineId`——无外键模型下，manifest / run / loop / 可信归属四方 machineId 必须传递相等，Loop 行不作为可信输入豁免。
- **绑定落库的配置代际守卫（#71）**：bind 计划携带解析时观测的 `guardConfigRevision`；`applyArtifactBindingPlan` 在同一 UPDATE 语句内以子查询复验 `loops.artifact_config_revision`（单语句 CAS，与 `updateArtifactConfig` 的 revision 守卫同级原子性）。代际在 plan→apply 之间前进则守卫零行、抛 `ArtifactBindingGuardLostError`，调用方重解析后重计划（自然转为 `stale_config_generation` 记录）。`record_error` 不加代际守卫：五类拒绝字面量均代际稳定（`cross_*` 与 `snapshot_not_committed` 与代际无关，`stale_config_generation` 单调），配置前进不会证伪已记录的拒绝。

### 2026-09-28（片 2 三轨复审 Round 2 修复：#71）

- **绑定与配置更新的行级互斥**：上述普通子查询仅看见语句开始时的 Loop 快照，不能阻止另一事务在绑定语句执行期间提交新配置。bind 的代际子查询改用 `FOR UPDATE` 锁定 Loop 行，锁持续到独立调用的语句提交或调用方 Report 事务提交；配置写入 `UPDATE loops` 与其互斥。若配置先提交，绑定读取更新后的代际并守卫失败；若绑定先取得锁，配置等待绑定提交。`record_error` 仍不锁 Loop，因其不绑定快照。
