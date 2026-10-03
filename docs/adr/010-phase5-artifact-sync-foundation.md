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

### 2026-09-29（片 3 BlobStore adapter）

- **原子发布的机制对齐**：本地 adapter 用 `link(2)` 实现决策 14 的「原子发布」——EEXIST 即原子 test-and-set，`published` 标志在并发下同 key 恰一个 `true`（rename-always 只能靠发布前 lstat，TOCTOU 竞态下不诚实）。权威计划片 3 行的「fsync 后原子 rename」是机制措辞，§3 规范段的「原子发布」语义不变。异类挂载上的 `EPERM`/`EXDEV` 归 `storage_error` 诚实失败，不做静默 rename fallback（那会破坏 no-clobber 语义）。
- **源中断的分类**：`writeVerified` 的字节流中途 throw（Batch 2 即 HTTP 请求体断流）归 `storage_error` 而非 `content_mismatch`——后者的 wire 重试类是 terminal，会把瞬时传输故障永久化；前者是 `idempotent_retry`（决策 13 的码表）。干净 EOF 但字节不足仍归 `content_mismatch`（同一字节流重试必然同样短，terminal 正确）。
- **`expectedSize` 值域纵深**：非 safe integer、负数或超 `ARTIFACT_FILE_MAX_BYTES` 的声明在 adapter 层即归 `content_mismatch` 且零拉取源流——决策 2 的值域纪律延伸到内部接口的 size 参数；决策 14 的契约文本未含此上限，此处登记为实现层防御（`isLegalExpectedSize` 与 `verifyByteStream` 共用同一判定）。
- **EEXIST 与 symlink 的 lstat 纪律**：发布的 EEXIST 分支与 `has`/`read` 全程 `lstat`（非 `stat`）——悬空 symlink 在 `stat` 下被错分为 ENOENT。EEXIST 命中普通文件即 `published:false`，不复验、不修复既有字节（与 read 不复验同一哲学：写路径已验证过内容寻址）。
- **nsDir symlink 守卫**：写路径拒绝 symlink 形态的 namespace 目录（`storage_error`——经它落盘会逃逸存储根）；存储根本身永不查 symlink（macOS tmpdir 经 `/var→/private/var` 合法穿越）。
- **fsync 粒度与停止边界**：决策 14 的 fsync 指 blob 文件本身；不做目录 fsync（目录项崩溃丢失恰好是 AB8「元数据在、文件无」这一架构已容忍的场景，prepare 要求重传、commit 拒绝不完整快照）；崩溃遗留临时文件的全局清理维持权威计划的停止边界（本批不做，残留惰性无害由测试钉住）。
- **共享契约套件的落点与故障注入缝**：套件居 `src/testkit/blob-store-contract.ts`（`tsconfig.build.json` 只排除 `*.test.ts` 与 `src/testkit/**`——放 `src/artifact/` 会进 dist 且引用 devDependency vitest）；memory adapter 的 fault 集合与 local adapter 的 `io.streamChunksImpl` 均为 TEST-ONLY 缝（config.ts `hooks.afterResolve` 与 daemon bounded-read `openImpl` 先例），生产装配不构造任何 adapter（决策 16，AD4 钉住）。

### 2026-09-29（片 3 三轨复审 Round 1 修复：#73/#74/#75/#76）

- **内存 adapter 到达即拷贝（#75）**：原实现留存 chunk 引用、hash 验证通过后才复制——合法复用同一缓冲的源流可在验证覆盖后改写已哈希字节（验证所见 `[A B]`、落库变 `[B B]`），违反已验证写入且双 adapter 不等价（本地 adapter 逐块即时落盘天然免疫）。改为 `onChunk` 内到达即拷贝（显式 `new Uint8Array` + `set`，不用 `chunk.slice()`——Buffer 型 chunk 的 `slice()` 返回视图）。共享套件新增用例钉死：单缓冲跨 yield 复用源必须存下「哈希覆盖的那版字节」，双 adapter 一致（AB10）。
- **has/read 的 namespace 目录守卫（#73）**：原实现只对最终 blob 路径 `lstat`，停在 `<root>/<ns>` 的 symlink 会被路径系统调用跟随——跨命名空间读取无需竞态。三方法统一走 `nsDirGuard`（symlink 或非目录归 `storage_error`——`not_regular_file` 类型上专属 blob 目标；namespace 不存在仍是 ENOENT 干净缺席）。rootDir 永不查 symlink 的既有裁决不变。
- **读流绑定打开期已验证的 fd（#74）**：原实现 `read()` 完成 lstat/open/fstat 后关闭句柄，返回的惰性流再按路径重开——`read()` 返回与开始迭代之间换目标即可改流（symlink 换入则越根读取，普通文件换入则 size 与内容分叉）。改为打开一次（`O_NOFOLLOW` 关掉 lstat→open 的最后一个组件换入窗口，ELOOP 归 `not_regular_file`；非 POSIX 平台缺该常量时退化为 0，lstat 前置检查仍确定性分类）、fstat 同一句柄、流从该 fd 读取；`streamBlob` 持有句柄并在流完成/失败/消费者中断时关闭。`ok:true` 结果若迭代器从未被消费则 fd 由调用方负责（契约消费者总是排空流），已在模块头注释登记。TEST-ONLY 缝 `streamChunksImpl` 保持按路径签名不变——注入故障流仍走 adapter 真实的终止元素归约代码（#66(a) 证据强度不降）。
- **AD4 daemon 出站守卫补半（#76）**：原守卫只钉静态 identity/capabilities，未来若在出站路径独立加请求仍会通过。新增钉：runtime 实际构造的 poll body 键集精确等于五静态键 + `availableSlots`（`watchDigest` 不发送——协议字段存在但 Batch 1 无消费者）；wire client 一个完整 poll+report 周期的请求目标恰为 `/api/machine/poll` 与 `/api/machine/report` 两个 Phase 1 端点。Batch 2 watcher 接线须显式更新此钉。

### 2026-09-29（片 3 二轮复审修复：#73/#74/#76）

- **namespace 目录并发替换的信任边界（#73）**：`nsDirGuard` 防御已停放的目录 symlink（包括指向其他 namespace 与存储根外），不是原子 `openat` 路径遍历。本实现使用的 Node [`fsPromises.open(path, flags)`](https://nodejs.org/download/release/latest-jod/docs/api/fs.html#fspromisesopenpath-flags-mode) 只接受路径、不接受目录 fd；若不可信进程拥有存储根目录写权限，可在检查与子路径操作间替换 namespace，路径式 `has/read/write` 无法保证隔离。生产接线的前提是存储根仅由 Server 的可信运行身份/运维写入，不授予其他本地进程该目录的写权限；同 UID 恶意进程可改动该根的部署形态不在本 adapter 的对抗保证内。rootDir 自身可经可信 symlink（例如 macOS `/var`），这一边界不变。新增根外静态 symlink 用例钉住适配器承诺的拒绝行为；如未来需要抵御可并发修改存储根的本地对手，须引入支持目录 fd 相对打开的存储实现，并在生产接线前另作 ADR。
- **成功读取结果的资源所有权（#74）**：为保持打开期错误走 `BlobReadResult` 联合、流从同一经 `fstat` 验证的 fd 读取，`read()` 仍在返回前打开文件。成功结果新增幂等 `close()`；正常 EOF、流故障、消费者提前停止会自动调用同一关闭路径，若未开始迭代则调用方必须显式 `close()`。内存 adapter 提供无资源的同形态方法。此接口责任代替上版“必须排空，否则无释放入口”的不完整约定。
- **AD4 同路出站钉（#76）**：将拆开的 runtime stub 与手调 wire client 断言合为同一 `createDaemonRuntime`→`createMachineClient`→注入 `fetchImpl` 的 poll/dispatch/report 周期；记录并断言运行时真实发出的目标与 poll 请求体，同时钉住 `globalThis.fetch` 零调用，防止 runtime 绕开注入客户端独立出站。不靠两个互不相连的测试片段推断零 Artifact 请求。

### 2026-10-03（片 4 ArtifactHome 状态机）

- **ArtifactHome 模块与内部字面量集**：`src/artifact/sync.ts` 是 prepare/PUT/commit 的唯一写方（仅测试接线，决策 16）。内部失败字面量细于 9 个 wire 码（决策 13 双层设计）；wire 映射暂缓到 Batch 2 路由接线的字面量：`artifact_dir_unconfigured`（prepare，未配置 loop 不开始上传）、404 级 `loop_not_found`/`session_not_found`（从未存在或跨归属同一拒绝，存在性不跨 scope 泄漏）、`session_committed`（对已提交会话的 PUT 属客户端缺陷，9 码无诚实归属）。
- **prepare 固定求值序**：manifest policy → 归属 → loop 作用域 → 已提交重放 → 已配置 → 配置代际 → base revision → pending/新建幂等裁决。已提交重放（同键+同指纹+回执）先于已配置/代际/base 检查：真实 commit 会把 loop base 推进过会话值，原载荷重放若先过这些检查会被误判为冲突、stored 回执无法经 prepare 恢复（决策 9 恢复路径，见 Round 1 修复 S4-2）。只有 pending/新建键由当前代际/base 裁决——旧代请求即使键可复用陈旧 pending 会话也先判 config/manifest 冲突（该会话本就过不了 PUT/commit 的代际复检）。配置冲突后的重新协商必须铸造新 requestId——同键异载荷恒为冲突（决策 6/9 的刻意设计，防止携带过期 base 的重发复用旧会话）。
- **过期语义**：pending 有效期是排他上界（`now < expiresAt` 可用）；过期 pending 同指纹原位续约（同 syncId；续约写 `WHERE id AND receipt IS NULL AND expiresAt = 观测值` 使并发续约收敛到同一响应）；已提交回执永不过期。
- **commit 事务结构与仲裁**：回执重放在作用域检查之后最优先（跨代际、跨重启、甚至 loop 被带外删除后仍经归属门控可读）。blob 完备性（元数据行 + 文件双查）在事务外：行缺或文件缺归 `blob_missing`（AB8，`has` 失败归 `storage_error`，永不静默当缺失）。单事务内：对 LIVE loop 行做会话锚定的代际/base/耗尽量复检（决策 11 的事务内重新检查）→ guarded loop UPDATE 先行（行锁串行化并发 commit，使 `(loopId, manifestRevision)` 唯一冲突在正确竞态下不可达；仍保留 23505 因链到 guard loss 的防御转换）→ 插入不可变 manifest（ID factory 新 id，同内容两会话两快照）→ `insideCommitTx` 只抛错缝 → receipt 写入带 `receipt IS NULL` 守卫（同 session 并发 commit 败方整体回滚、有界重跑重放胜方回执，AC7 收敛单快照）。guarded UPDATE 以事务内读到的 revision 为守卫基线：只动 OCC revision 的无关域写入不阻塞 commit，语义守卫由会话锚定复检承担。
- **同步尝试打账规则**：成功账随事务内 guarded UPDATE 落（`attemptedAt=succeededAt=提交时刻`、`error=null`）；失败账仅 `manifest_conflict`/`blob_missing`/`storage_error` 三类，值为 WIRE 码（`loops.artifactSyncError` 枚举即 `ARTIFACT_ERROR_CODES`），best-effort `UPDATE … WHERE id AND revision = 观测值 AND artifactConfigRevision = 会话代际`——代际谓词即 AM6「旧代请求不能更新新代状态」守卫，零行静默跳过、不重试（打账是簿记，不是操作结果）。`config_conflict`/`session_expired`/`attribution_missing`/`session_not_found` 与 `manifest_revision_exhausted` 不打账（无当前代尝试，或 Batch 2 前尚无 wire 码）；prepare/PUT 失败不打账（尝试未终结）。
- **PUT 的 invalid_key 是不变量违例**：hash 来自 policy 校验过的 manifest、namespace 来自可信归属解析——走到 `invalid_key` 即契约破坏，抛 `ArtifactSyncInvariantError`，不归 `storage_error`（避免把永久缺陷挂上 `idempotent_retry` 无限重试）。
- **片 5 接缝预留**：`hooks.afterResolve(op, id)` 在 resolve 与写之间（事务外，PGlite 单连接的真实交错点）；PUT 的交错点在字节流 await 处（测试流中途让出即真实交错）；`hooks.insideCommitTx` 只允许抛错验证回滚（事务内不等待另一笔竞争事务）。

### 2026-10-03（片 4 三轨复审 Round 1 修复：S4-1/S4-2/A4-1/A4-2/A4-3）

- **prepare INSERT 的 Loop 行锁（S4-1）**：会话插入事务先 `SELECT … FOR UPDATE` 锁定 Loop 行，并在锁下复验观测到的统一 OCC revision（binding-plan Round-2 同一先例）。原先的无锁 SELECT 在真实多连接的 SELECT→INSERT 窗口内会让并发配置写入不受 GuardLost 约束，违反 ADR-009 L138/L145「基于 Loop 决策快照的写事务须取得对应 revision 写权限」。行锁不改动当前视图，prepare 的零视图写入承诺不变；多物理连接重叠证明仍归 #11/#72 的验证边界。
- **已提交 prepare 重放先于代际/base（S4-2）**：见上方求值序条目的更正。同键+同指纹+回执 ⇒ 原样返回原 session（needHashes 为空，回执经 commit 重放恢复）；同键异指纹永不重放，仍由 planner 判稳定冲突。回归测试改用真实 prepare→PUT→commit 推进 base 后重放（原测试手工填 receipt、不推进 base，掩盖了正常路径），并钉住升代+过 TTL 后仍可重放。
- **commit 事务内先复验 session（A4-1）**：事务内先重读 LIVE session 行——胜方回执逐字重放（同 session 并发 commit 收敛为单回执单快照，修复前败方落 manifest_conflict）、pending TTL 以事务内新鲜时钟复检（session_expired）、namespace/machine 归属关联复验（404 级 session_not_found）；之后才重读 LIVE loop 行做 loop↔session 关联 + 代际/base/耗尽量检查。新增 abort 字面量（session_not_found/session_expired）均不打账，与 precheck 同名结局一致。
- **PUT 完成前全量复验（A4-2）**：发布完成后重新解析可信归属并重读 session + loop——归属映射中途切换或 loop 关联断开归 session_not_found，会话中途被提交归 session_committed，TTL 中途到期归 session_expired，代际中途漂移归 config_conflict。拒绝时遗留已发布但未引用的 Blob（决策 12 容忍），不删共享 Blob 模拟回滚，不登记元数据行。
- **已验证 size 参与复用校验（A4-3）**：prepare 的 needHashes 与 commit 的完备性检查都比较协商条目 size 与元数据行的已验证 size；不一致的行不支撑本会话——prepare 重新要求上传（PUT 以声明 size 复检字节，诚实报 content_mismatch），commit 以 blob_missing 拒绝（协商意义上的 blob 缺失）并打 wire 码。manifest 的 totalBytes 从此恒等于已验证内容真实总量。同 digest ⇒ 同内容 ⇒ 同 size，故跨 session 的 size 不一致恒为客户端虚报：该 requestId 下的会话无法经去重路径洗白，过期后由新 requestId 诚实重报。

### 2026-10-03（片 4 三轨复审 Round 2 修复：A4-1 剩余窗口 + S4-2/A4-3 验收补齐）

- **commit 裁决读序：loop 先、session 后（A4-1 Round 2，#79）**。Round 1 的事务内复验封住了 afterResolve 之后的窗口，但事务外裁决仍按 session→loop 顺序读：同 session 胜方 commit 落在两读之间时，败方用（旧 session：无回执，新 loop：base 已推进）的不一致快照裁决出伪 manifest_conflict，且失败打账用它刚观测到的提交后 revision 命中当前行，把胜者的成功三元组覆盖上 artifact_manifest_conflict。修复不改决策序（receipt 仍最先裁决），只把**观测序**统一为 loop→session：事务外为「作用域探针读 session（取 loopId/归属）→ 读 loop → 有界重读一次 session 裁决」；事务内同样先读 LIVE loop 再读 LIVE session。保护依据（替代加锁）：竞品 commit 的 base 推进与回执写入在**同一事务**原子落库、loop 代际/base 单调递增、回执写一次——故放在 loop 读之后的 session 读永远不可能看到「base 已越过本 session 却无回执」；该组合恒为**其他** session 的真实 base 冲突，而已完成的同 session 胜方回执必被观测并重放。这不是新增固定检查点平移窗口：线性化点落在末次 session 读，之后的竞品 commit 合法地排在本操作之后。READ COMMITTED 足够，未引入新行锁，prepare 的 FOR UPDATE 仍是模块唯一锁，不存在锁序问题。回归：真实 session读→loop读 间竞争 commit（Db 包装在首个 session 查询返回真实行后让胜方完整提交）收敛为双方同回执、单 manifest、单次 revision 递增、成功错误字段保持 null；并已反证该测试在修复前代码上失败。PGlite 证据不冒领 #11/#72 的真实多物理连接验证。
- **S4-2 验收补齐（#78）**：committed 重放回归补两类断言——移除 artifactDir（null）后 prepare 仍返回原已提交 session、commit 仍恢复原回执（重放先于 artifact_dir_unconfigured）；重放前后 loop 的 artifactManifestId/artifactManifestRevision/统一 OCC revision 逐项相等（重放是纯读，不碰当前视图）。
- **A4-3 验收补齐（#81）**：补声明 size **大于**已验证 size（5 对 3）的跨 session 复用回归（prepare 重新要求上传 → PUT 对协商 size 诚实报 content_mismatch → commit blob_missing 且旧视图不动）；补同 hash 多路径成功提交的 totalBytes = 已验证 size × 路径数（3×2=6）断言。
