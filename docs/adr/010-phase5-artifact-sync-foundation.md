# ADR-010：Phase 5 Batch 1——Artifact 同步基础（单向上传、完整 manifest、原子提交与快照语义）

- 状态：Accepted
- 日期：2026-09-28
- 关联：ADR-002（协议包纪律）、ADR-009（Phase 4 语义）、`docs/plan/codex-phase5-batch1-plan.md`
- 实现：Batch 1 片 1（本文档的决策条目先于行为代码写入，作为片 2/3/4 的契约依据；片 6 收口时复核）；Batch 2 片 1 修订契约（2026-10-04）

## 背景

Phase 5 要为 Loop 增加 Artifact 目录同步：Daemon 持续单向上传文件，Server 存储不可变 manifest 与 Blob，Run 可绑定快照。这一功能横跨 Daemon 扫描、wire 协议、Server 状态机、本地存储与数据库事务，任何一处契约含糊都会在后续切片或 Batch 2 放大为返工。Batch 1 片 1 在不挂载任何生产路由、不改变生产行为的前提下，冻结全部跨切片契约：wire DTO、共享校验 policy、canonical 指纹、错误分类与重试约定、两个服务端内部接口（BlobStore、可信归属解析器）的行为契约。本批保持生产执行行为与 Phase 4 一致（休眠边界，决策 16）。

## 决策

### 1. 单向上传与完整 manifest 语义

同步只从 Daemon 到 Server 单向流动；Server 不回写本机。每次 prepare 携带**当前完整 manifest**（不是增量）；提交成功即整份替换当前文件视图，manifest 中缺席的路径即删除。扫描失败、目录消失、文件不稳定或超限时保留服务端旧版本并展示同步错误，不提交截断清单。确认存在的空目录可以提交空 manifest；缺失目录不能等价为空目录。

### 2. 路径与条目校验域

Manifest 条目固定为 `{path, hash, size}`。`path` 必须是规范 POSIX 相对路径：拒绝绝对路径、盘符、反斜杠、空路径段、精确 `.`/`..` 段、NUL 与未配对代理项（非法 Unicode）；不做 URL 解码、大小写折叠或 Unicode 归一化，值逐字保留。拒绝重复路径及 `a` 与 `a/b` 这类文件/目录冲突，两种 wire 序都拒绝。`hash` 是 64 位小写十六进制 SHA-256；`size` 是非负安全整数；同一 hash 声明不同 size 整单拒绝。

schema 层只检查 typeof 形状：`path`/`hash` 为 `z.string()`，`size` 使用 typeof-number 检查。Zod 4 的 `z.number()` 会提前拒绝非有限数，使 wire 上的 `1e400`（JSON 解析为 Infinity）无法进入共享 policy。值域规则统一由共享 policy 执行，使 Daemon 与 Server 对同一份 manifest 产出相同的失败分类。

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

Batch 2 的生产解析器使用 **Machine namespace**：`namespaceId` 取已验证 Machine 行的 `machineId`（`m-<sha256(token)[:16]>`，满足 BlobStore 的 `NAMESPACE_ID_RE`）。解析器在每次操作时重新查询 machines 行；行缺失或 id 不满足键规则时返回 `attribution_missing`（403），不抛异常、不写任何状态，也不把非法键交给 BlobStore。凭证校验属于 HTTP 认证读路径（Batch 2 片 2 落地为 `verifyMachineCredential`：形状检查 → 派生 id → 行查找 → 全量 tokenHash 比对，**永不注册**——注册只属 poll），解析器在其后运行并信任 store 解析出的身份。Batch 3 的 Team 归属替换解析器内部实现，并离线复制 Blob 后切换元数据；wire 与存储键规则不变。

### 8. 配置代际与过期

`artifactConfigRevision` 单调递增：等值更新零写入，有效 set/change/clear 递增代际。修改或移除 `artifactDir` 后保留最后成功的 manifest 指针与 manifest revision，读取时按配置代际计算过期状态；新配置的首次成功提交才替换当前视图。配置变化清除上一代的同步尝试状态，旧代请求不能更新新代状态。

`artifactDir` 的 workdir-相对/绝对路径规则是 Server 单侧 policy：相对路径基于显式 workdir 解析，无 workdir 时必须是绝对路径。该规则不进入共享 policy，Server 不解析机器上的文件系统路径。配置更新允许用于 completed Loop，沿用 `updateTaskFile` 的运维重定向语义。

配置 planner 的求值序固定为 validate → noop → exhaustion。等值合法命令在 int32 上界仍为 noop；非法值即使与存储值相等也拒绝。有效变更遇上界返回 `config_revision_exhausted`，零写入。

Loop 创建时携带的可选 `artifactDir` 经**同一** planner 求值（快照为 `{artifactDir: null, artifactConfigRevision: 0, workdir}`）并与 Loop 创建在**同一 INSERT** 落库：合法值即初始代际为 **1**（代际 0 专表「从未配置」），非法值以与 PATCH 相同的 coded 400（`artifact_validation_failed`）拒绝整个创建（零行写入）。创建不是一次「变更事件」，但「已配置 ⇒ 代际 ≥ 1」由该裁决统一成立。

### 9. prepare 幂等与 requestId

SyncSession 以 `(namespaceId, machineId, requestId)` 为唯一键。同键同规范化载荷（决策 6 指纹相同）复用会话并重新计算缺失 Blob；协商 hash 集合由规范化 manifest 决定。同键不同载荷返回 `artifact_manifest_conflict`。重复 prepare 不改变当前 manifest 指针、manifest revision 或 Loop 统一 revision。

prepare 的求值序固定为：manifest policy → 可信归属 → Loop 作用域 → 已提交重放 → 已配置 → 配置代际 → base revision → pending/新建幂等裁决。同键、同指纹且已有回执时，返回原 session，`needHashes` 为空；调用 commit 可恢复原回执。该重放先于已配置/代际/base 检查，因此配置变更或移除、base 推进、pending TTL 到期均不阻断重放。同键异载荷不进入重放分支。pending/新建会话仍须通过当前配置代际与 base 检查；配置或 base 变化后携带新载荷重新协商，必须使用新 requestId。

pending 默认有效 1 小时，`now < expiresAt` 时可用，由注入的 Clock 判定。过期后须重新 prepare；同指纹且仍满足当前配置/base 的会话可原位续约，保留 syncId。续约写入以 `id AND receipt IS NULL AND expiresAt = 观测值` 为守卫，使并发续约收敛。已提交回执不因 pending 有效期失效。

新会话插入事务先以 `SELECT … FOR UPDATE` 锁定 Loop 行，在锁下复验解析时观测的统一 OCC revision，再插入 session。行锁覆盖检查到插入的窗口，与并发配置写入互斥，遵守 ADR-009 基于 Loop 决策快照写入时的 revision 守卫要求；该事务不改变当前文件视图。

prepare 的缺失 Blob 判断同时检查元数据中的已验证 size 与文件存在性。声明 size 与已验证 size 不一致时，重新要求上传，防止跨 session 去重绕过字节验证。

### 10. PUT 验证语义

PUT 只接受当前归属会话已协商的 hash，经 `X-Artifact-Sync-Id` 头携带会话。以流方式统计真实字节数并计算 SHA-256，不信任声明 size 或 Content-Length。重复 PUT 仍检查上传字节；实际 hash/size 与协商不符返回 `artifact_content_mismatch`。

上传前验证可信归属、session 与 Loop 的关联、pending 状态、TTL 和配置代际。Blob 发布完成后、登记元数据前，重新解析可信归属并重读 session 与 Loop，使用新鲜时钟复验 TTL。归属缺失返回 `attribution_missing`；归属或 machine 关联失配返回 `session_not_found`；会话已提交返回 `session_committed`；TTL 到期返回 `session_expired`；Loop 缺失返回 `loop_not_found`；配置漂移返回 `config_conflict`。

失败只清理本次临时文件，不改变当前 manifest。完成前复验失败时不登记 Blob 元数据；已经发布的 Blob 可以成为未引用内容，按决策 12 保留。hash 与 namespace 已由 policy 和可信归属校验，BlobStore 若返回 `invalid_key`，视为不变量违例并抛 `ArtifactSyncInvariantError`，避免将永久契约缺陷归入可重试的存储错误。元数据行登记在发布成功之后；登记本身失败（驱动/连接故障）归 `storage_error` 结果联合，不抛原始异常——已发布 Blob 同样按决策 12 容忍为未引用遗留，同一 PUT 原样重试经 `published:false` 幂等收敛。

### 11. 原子提交边界

ArtifactHome（`packages/server/src/artifact/sync.ts`）统一负责 prepare/PUT/commit 同步写入，本批仅测试接线（决策 16）。相同 session 重复 commit 返回固定回执，不生成新快照、不递增 revision、不让当前指针回退。历史回执经归属验证可跨配置代际和重启读取；Loop 被带外删除后也可读取已有回执。每个新 session 成功提交生成新快照，即使内容相同。

#### 观测顺序与裁决顺序

事务外先读 session 作作用域探针，取得 loopId 与归属，再读 Loop，最后重读一次 session 作裁决。事务内同样先读 LIVE Loop，再读 LIVE session。现行裁决读序统一为 Loop→session。

回执判断在作用域门控之后优先于 pending 的 TTL、配置代际、base 和耗尽检查。事务内 pending TTL 使用新鲜 Clock；重新核对 namespace/machine 与 Loop↔session 关联，随后检查会话锚定的配置代际、base manifest revision 和 int32 上界。manifest revision 耗尽返回 `manifest_revision_exhausted`，零写入。

该读序依赖三个不变量：会话归属及载荷不变，Loop 代际/base 单调递增，base 推进与一次性回执写入在同一事务提交。READ COMMITTED 下，若 Loop 读已看到同 session 成功提交，随后的 session 读就能看到回执；若竞争者在末次 session 读后提交，后续 Loop CAS 会丢失守卫并触发整体回滚及有界重读。这样不会把同 session 的成功误判为 base 冲突，无须额外 SELECT 行锁。

#### 完备性与原子写入

Blob 完备性在事务外检查：所有协商 hash 都须有元数据行，已验证 size 与 manifest 声明一致，文件实际存在。行缺失、size 不符或文件缺失归 `blob_missing`；`has` 的异常归 `storage_error`，不得当作缺失。同 hash 多路径按路径数累加真实 size，manifest 的 `totalBytes` 等于已验证内容的实际总量。

单事务内完成复验后，按以下顺序写入：

1. guarded Loop UPDATE：以事务内观测的统一 revision 为守卫，更新当前指针、manifest revision、成功状态及统一 revision。
2. 插入完整不可变 manifest，由 ID factory 生成新 ID。
3. 以 `receipt IS NULL` 为守卫写入固定 session 回执。

任一步失败，数据库写入整体回滚。Loop UPDATE 取得的行锁串行化并发提交；session 回执守卫保证写入一次。CAS 或回执守卫丢失时有界重跑，读取胜方回执；manifest 唯一冲突 `23505` 也转换到同一守卫重试路径。只影响统一 OCC revision 的无关域写入可通过重读继续提交，业务守卫始终以 session 的配置代际和 base 为依据。

回滚矩阵按事务步骤钉定：guarded UPDATE、manifest 插入、回执写入任一步失败，事务整体回滚、零部分写入（前序步骤随之回滚）。失败按识别分类：已识别的可恢复存储故障（SQLSTATE 08xxx 连接 / 53xxx 资源不足 / 57xxx 操作干预 / 58xxx 系统 I/O，沿驱动 cause 链识别）归稳定 `storage_error` 结果（决策 13 的 idempotent_retry），不走守卫重跑，故障消除后同一 session 原样重试收敛；无码或未识别类的错误保留原始抛出边界——不把未知异常兜底成可重试失败，约束违例与序列化/死锁码也不归此类。守卫零行丢失经恰一次有界重跑收敛，持续丢失以 `ArtifactSyncRaceLostError` 失败关闭。统一 OCC 与调度/Report 真实写方的双向交错已钉：无关域写（claim 的 bump-only、report 的终态写）落在 commit 缝前时，commit 以事务内 live 行重定基线零重跑落地；commit 落在 claim 的解析—写窗口时，claim 的事务前快照守卫丢失一次、有界重跑收敛；落在 report 的解析—写窗口时，report 写事务的快照取得于 commit 之后，守卫不丢失直接落地。两个方向双写集互不丢失。该证据来自 PGlite 单连接，不替代 [#11](https://github.com/zhuabo001/loop-platform-zhb/issues/11)/[#72](https://github.com/zhuabo001/loop-platform-zhb/issues/72) 的真实多物理连接验证。

#### 同步尝试状态

成功状态随 guarded Loop UPDATE 原子写入：`attemptedAt=succeededAt=提交时刻`，`error=null`。commit 失败仅对 `manifest_conflict`、`blob_missing`、`storage_error` 记录尝试，错误值使用对应 wire 码。失败记录采用 best-effort UPDATE，以 Loop id、观测 revision 和 session 配置代际为守卫；零行静默跳过、不重试，防止旧请求覆盖较新状态。真竞态下败方的失败记录携带事务外观测的陈旧 revision：已验证窗口是胜方提交晚于败方的 Loop 观测，此时守卫零行——胜方的成功三元组不被败方的失败打账覆盖；若胜方在败方观测之前已提交，败方基于新鲜观测裁决出的冲突是真实结论，其打账合法落库（打账只更新 attemptedAt/error/revision，不改写胜方的 succeededAt 与指针）。事务内已识别存储故障归 `storage_error` 时同样按此规则 best-effort 打账；同一存储故障可能使打账本身失败，账目从不改变操作结果。

`config_conflict`、`session_expired`、`attribution_missing`、`session_not_found`、`manifest_revision_exhausted` 不记录失败尝试。prepare/PUT 失败尚未终结同步尝试，也不记录该状态。

### 12. 快照语义与未引用 Blob 边界

不可变 manifest ID 即 Run 的 `artifactSnapshotId`，由 ArtifactHome 注入的 ID factory 铸造。内容相同的不同 session 提交生成不同快照，不另建快照表。

文件发布成功而数据库事务失败时允许留下未引用 Blob，不能通过删除共享 Blob 模拟文件系统回滚；元数据存在但文件丢失时，prepare 要求重传，commit 拒绝不完整快照。历史 Blob、过期 session 与孤立 Blob 的累计磁盘治理属于 Phase 6，本批不宣称其占用有界。崩溃遗留临时文件的全局清理也不属于本批。

### 13. 错误分类、HTTP 映射与重试约定

wire 错误形状复用 `apiErrorSchema` `{error, code?}`；错误文本不是机器契约，code 才是。稳定区分 11 码（内部细粒度 policy 失败字面量映射到这层，双层设计同 RunCapabilityInvalidError 先例）：

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
| `artifact_revision_exhausted` | 409 | prepare/PUT/commit/配置更新（config 或 manifest revision 耗尽） | terminal |
| `artifact_session_committed` | 409 | PUT（会话已提交） | recover_receipt |

从未存在或跨归属的会话/Blob 一律无码平 404——存在性不跨 scope 泄漏（同既有 404 约定）。请求级传输错误沿用既有约定：原始体超限 → 413（bodyLimit）、JSON 畸形 → 400 无码、机器凭证无效 → 401。重试类定义：`idempotent_retry` 可原样有界重试；`resume` 补传缺失 Blob 后原样重试；`renegotiate` 从 prepare 重新协商；`recover_receipt` 对同一 session 重发 commit 取回固定回执（不重传、不重新协商）；`terminal` 同请求必败，须先修复成因。码→重试类映射以 `ARTIFACT_ERROR_RETRY_CLASS` 常量表机器可核对地固定在 protocol。HTTP 映射固定后即为契约（同 ADR-009 修订 2026-09-01 决策 6），Batch 2 以 taxonomy pin 测试钉死。

内部失败字面量细于 wire 码；Batch 2 片 1 冻结完整映射：`config_revision_exhausted` 与 `manifest_revision_exhausted` → `artifact_revision_exhausted`（409，terminal；稳定结果联合、零写入）；`artifact_dir_unconfigured` → `artifact_config_conflict`（409，renegotiate）；`session_committed` → `artifact_session_committed`（409，recover_receipt）；`artifact_dir_invalid` 与 `artifact_dir_relative_without_workdir` → `artifact_validation_failed`（400，terminal）。`loop_not_found`、`session_not_found`、`run_not_found`、`snapshot_not_found`、`path_not_found` 一律无码 404，沿用不存在与跨归属统一按不存在处理的规则。服务端映射表以 `ARTIFACT_FAILURE_HTTP` 机器可核对地固定在 `packages/server/src/artifact/error-mapping.ts`（Batch 2 片 1 冻结，片 2 接线）。

客户端失败分类法固定为 9 值：`directory_missing`、`unreadable`、`outside_jail`、`symlink`、`special_file`、`unstable`、`too_large`、`watcher_error`、`timeout`。该集合与 wire 错误码不相交，二者的有序并集（`ARTIFACT_SYNC_STATE_ERRORS`）是 Loop 同步尝试状态列的取值域。错误上报 `POST /api/machine/loops/:id/artifact-sync-error` 携带 `failure`、`configRevision` 与 `baseManifestRevision`；仅当二者仍与 Loop 当前值匹配时才更新同步尝试状态（响应 `recorded:false` 表示未写入），迟到的错误不得覆盖较新的成功状态。

片 2 冻结两处补充：PUT 的成功响应为 `{ok, size, published}`（`size` = 已验证字节数，绝不信声明 size/Content-Length；`published:false` = 同 key 已存在的去重命中，字节同样经过完整校验）；服务端映射表新增 `machineRead` 失败域（归属缺失、Loop 缺失/跨 Machine、目录未配置、存储故障），读取路径的存储故障同样归 `artifact_storage_error`。

错误上报的写入裁决（`recordArtifactSyncError`）：求值序为可信归属 → Loop 作用域（非上报 Machine 的 Loop 按不存在处理）→ **未配置门槛**（`artifactDir` 为空 ⇒ `recorded:false` 零写入，防 0/0 假匹配污染从未配置的 Loop）→ 双匹配门槛。仅在门槛全过后执行守卫 UPDATE（`attemptedAt=now`、`error=失败类`、统一 revision +1，**`succeededAt` 不动**），守卫为 `id + revision + 观测 artifactConfigRevision + 观测 artifactManifestRevision`；任一门槛不符或守卫零行都返回 `recorded:false`、零写入、**不重试**（记账从不重跑，同 `stampCommitFailure` 先例）。`message` 只做接受：无列可存，不落库也不记日志。

### 14. BlobStore 内部接口契约

服务端内部接口位于 `packages/server/src/artifact/blob-store.ts`，由片 1 冻结、片 3 实现。方法为 `writeVerified`、`has`、`read`；无删除、无历史 GC。预期失败使用结果联合：`invalid_key`/`content_mismatch`/`blob_missing`/`not_regular_file`/`storage_error`。内存与本地 adapter 遵守同一契约。

#### 已验证写入与发布

`writeVerified` 流式统计真实字节并计算 SHA-256，与协商值比对。`expectedSize` 必须是 0 到 `ARTIFACT_FILE_MAX_BYTES` 之间的安全整数；非法声明返回 `content_mismatch`，不拉取源流。超限、hash/size 不符或干净 EOF 字节不足归 `content_mismatch`；源流中途抛错归 `storage_error`，使瞬时传输故障可按决策 13 重试。adapter 留存的字节必须与哈希覆盖的字节一致；内存 adapter 在 chunk 到达时复制，允许源流复用缓冲区，Buffer 也不得通过返回视图的 `slice()` 留存。

本地 adapter 使用独占临时文件 → 文件 fsync → 关闭句柄 → 原子发布。并发或重复上传仍验证字节，不暴露半文件。发布使用 `link(2)`，保留既有目标；同 key 并发发布仅一方返回 `published:true`。EEXIST 分支对最终目标 `lstat`：普通文件返回 `published:false`，不复验或修复既有字节；symlink/特殊文件拒绝。`EPERM`/`EXDEV` 等失败归 `storage_error`，不退回会覆盖目标的 rename。只有发布与决策 10 的完成前复验均成功后，才登记元数据。

fsync 只覆盖 Blob 文件，不做目录 fsync。目录项崩溃丢失由决策 12 的缺失文件恢复语义处理。

#### 路径检查与部署信任边界

存储键为安全的 `(namespaceId, hash)`，manifest 路径不映射为磁盘路径。三方法均拒绝 symlink 或非目录形式的 namespace 目录，归 `storage_error`；namespace 不存在按干净缺失处理。最终 Blob 目标使用 `lstat`，symlink（包括悬空 symlink）或特殊文件归 `not_regular_file`。`has` 不得将上述异常或存储错误报告为 `present:false`。

存储根自身允许可信 symlink，例如 macOS `/var`。生产接线前提是存储根仅由 Server 的可信运行身份/运维写入，不授予不可信本地进程写权限。路径式 namespace 检查只防御已停放的 symlink，无法保证检查与子路径操作之间的 namespace 并发替换隔离；同 UID 恶意进程可改动该根的部署形态不在本 adapter 的对抗保证内。如需抵御该对手，应改用支持目录 fd 相对打开的存储实现，并在生产接线前另作 ADR。

#### 读取与资源所有权

`read` 的打开期失败走 `BlobReadResult` 联合。成功结果包含真实 size、字节流和幂等 `close()`。本地 adapter 打开一次，以 `fstat` 验证该 fd，流始终从同一 fd 读取，防止打开后按路径重开造成内容替换。打开使用 `O_NOFOLLOW`，ELOOP 归 `not_regular_file`；平台缺少该常量时 flags 退化为 0，保留前置 `lstat` 检查，该退化不提供相同的最终路径组件竞态防护。

打开后 I/O 失败通过流内终止元素 `{ok:false, failure:"storage_error"}` 返回，迭代器不为 I/O 失败抛异常。正常 EOF、流故障、消费者提前停止均自动关闭句柄；若成功结果未开始迭代，调用方必须显式 `close()`，关闭后不再迭代。内存 adapter 提供同形态的无资源 `close()`。

生产存储根固定为 `<dataDir>/blobs`（`dataDir` 来自 `ServerConfig`，默认 `~/.loopzhb`）。根目录仅由 Server 的可信运行身份独占写入。

### 15. 可信归属解析器接口契约

服务端内部接口（`packages/server/src/artifact/attribution.ts`），片 1 冻结契约，生产 Team 接线仍留后续认证批次。`resolve(machine: TrustedMachineIdentity): Promise<ArtifactAttribution>`：输入是 store 已从 Bearer 凭证解析出的可信 Machine 身份（永非 wire 输入）；异步（生产 Team 归属需要查库）；缺失归属是预期域结果（联合返回 `{ok:false, failure:"attribution_missing"}`），不抛异常。每次操作重新解析，不从请求缓存。接口的输入/输出、职责与失败语义即决策 7 与本文；TSDoc 与本文不得矛盾，漂移时以本文为准并同步修订。

### 16. Batch 1 休眠边界

本批不挂载任何 Artifact HTTP 路由、不启动 watcher、Daemon 不声明 `artifact-sync-v1`、Report 不消费 `artifactSnapshotId`/`artifactSyncError`、Run claim 条件不变、旧 Loop 默认未配置 Artifact 目录且不开始上传、生产装配不构造 BlobStore。

Daemon 的 poll 出站体仅包含既有五个静态字段与 `availableSlots`，不发送 `watchDigest`；poll/report 请求仅使用 `/api/machine/poll` 与 `/api/machine/report`。Batch 2 watcher 接线时须显式更新该边界。AD1–AD4 休眠守卫覆盖路由、Create/Poll/Report、出站请求及启动装配，长期验收要求以 Batch 1 计划为准。Batch 2 按批次计划逐切片解除该边界：片 1 只冻结契约与生产门面（AD1–AD4 仍全绿），片 2 挂 6 条路由与生产装配并解除 Create/Poll/claim/Delivery 的相关休眠，片 5 声明 capability 并启动 watcher，片 6 消费 Report 字段。片 2 之后休眠仍覆盖：Report Artifact 字段（片 6）、Daemon watcher 与 `artifact-sync-v1` 声明（片 5）、读路由与 Dashboard（片 7）；对应守卫按各片的实际解除范围重写（AD1 拆为已挂/未挂两半、AD2(a)/(b) 反转为启用语义、AD4 保留「启动零 fs 副作用、无 watcher」并新增装配断言）。片 3 只新增 Daemon 本地库模块（决策 23），不改任何装配与 wire 面：休眠边界与片 2 之后逐字相同，AD4 的 daemon 半（`identity.test.ts`）零修改全绿即其可执行证据。

### 17. 共享 policy 的 ADR-002 窄例外记录

`artifact-policy.ts` 是 ADR-002 决策 4「裁剪策略不进 protocol」的第二个记录在案窄例外（第一个是 terminal-policy.ts）：manifest 条目校验、容量上限、never-sync 规则、canonical 规范化与有界解析必须由 Daemon（扫描本地预分类）与 Server（防御层收口）逐字一致地执行，两份拷贝必然漂移，故单一来源放 protocol 包。模块保持纯函数、无 I/O、无 Node 内建依赖，主入口浏览器可 bundle 性不变。ADR-002 修订记录同步登记。

### 18. 持久化形状与仲裁键

模型使用 `artifact_sync_sessions`、`artifact_manifests`、`artifact_blobs` 三张表，Loop 保存配置、当前 manifest 指针与同步尝试状态，Run 保存快照绑定与同步错误。migration `0005` 前滚，沿用无外键、无新 CHECK、ISO text 时间戳和 jsonb 规范化 manifest/回执的仓库纪律；revision 非负、单调和上界由写路径保证。

唯一键作为仲裁依据：session `(namespaceId, machineId, requestId)`、manifest `(loopId, manifestRevision)`、Blob 复合主键 `(namespaceId, hash)`。

### 19. Run 快照绑定与配置互斥

绑定资格以 Report 事务显式确认的 finalize/reconcile 结果为准（Batch 1 的 planner 当前仅接受 `run.phase === "running"`；Batch 2 片 6 落地资格参数，规则见本节末段）。canceled/superseded 不绑定，reclaimed（terminal-grace 唤醒报告）路径在 Batch 1 保守排除，Batch 2 按本节末段裁决。

绑定必须确认已提交 manifest 的 `id === snapshotId`，namespace 匹配可信归属，manifest / Run / Loop / 可信归属四方 machineId 相等，manifest / Run / Loop 的 Loop ID 一致，manifest 配置代际等于当前 Loop 代际。写入已验证的 `manifest.id`。内部拒绝分类为 `snapshot_not_committed` / `cross_namespace` / `cross_machine` / `cross_loop` / `stale_config_generation`；Batch 2 拥有最终接线分类法。

bind 计划携带解析时的 `guardConfigRevision`。落库的 Run UPDATE 守卫 Run `(id, phase)`，并在同一语句的代际子查询中以 `FOR UPDATE` 锁定 Loop 行、复验当前代际。锁持续到该语句或外层 Report 事务提交，与配置 UPDATE 互斥：配置先提交时绑定看到新代际并守卫失败；绑定先取得锁时配置等待绑定提交。普通无锁子查询的语句快照不足以保证此互斥。

守卫零行抛 `ArtifactBindingGuardLostError`，调用方须重解析、重计划；代际前进后转为 `stale_config_generation`。`record_error` 仍守卫 Run `(id, phase)`，但不锁 Loop、不加代际守卫：`cross_*` 与 `snapshot_not_committed` 不受配置代际影响，`stale_config_generation` 在代际单调递增下仍成立。

Batch 2 裁决 reconcile 绑定资格：合法 finalize 与合法 terminal-grace reconcile 都可以绑定 Report 明确携带且通过校验的 snapshot（资格由 Report 事务显式确认，而不是放宽 phase 检查）；取消、superseded 以及没有合法最终 Report 的 reclaimed Run 不绑定。绑定 planner 的资格参数在 Batch 2 片 6 落地。

### 20. Delivery Artifact 配置与最终同步代际

Delivery 的 Loop 投影携带可选 `artifact: {dir, configRevision}`，值来自成功 claim 的权威 Loop 行，不是请求参数。Daemon 的最终同步固定使用该代际；Run 期间新设置的目录不改绑该 Run 的最终同步。配置被清除（`artifactDir=null`）时该字段缺席。片 2 接线：值取自 claim 事务 CAS 返回的权威行（`buildDelivery` 在 `artifactDir` 非空时才带该键）。

### 21. 生产门面边界

Batch 2 的生产门面是 `packages/server/src/artifact/production.ts` 的 `createProductionArtifactHome({db, dataDir, clock?}) → ArtifactHomeDeps`：构造以 `<dataDir>/blobs` 为根的本地 BlobStore、Machine 归属解析器、生产 ID 工厂（`sync-`/`amf-` 加 UUID）与注入时钟。构造零文件系统副作用、不读环境变量、不依赖启动模块。片 1 只由测试调用该门面；片 2 由 `bootstrapServer` 装配为 `BootedServer.artifacts = createArtifactApi(home)`，HTTP 适配器只经该窄接口消费——构造仍零副作用（`<dataDir>/blobs` 首次写入才出现）。

### 22. Poll watch 下发与 claim capability 门控

Poll 的 watch 集合是该 Machine 名下**全部已配置 Loop**（`artifactDir` 非空，含 Paused 与 Completed，不按 enabled/completedAt 过滤）；每项为 `{loopId, artifactDir, workdir: loop.workdir ?? null, roots: machine.roots ?? [], configRevision}`。**服务端只在 Machine 已声明 `artifact-sync-v1` 时下发 watch**——未声明的 daemon 不运行 watcher，配置是死重；未声明者（含全部 Batch 1 daemon）的 poll 响应因此与 Batch 1 逐字一致。判定规则：请求缺 `watchDigest` **等价于空集合的摘要**（无 watch 状态的 daemon 与空集合语义等价，旧 daemon 因此不产生噪声）；有效摘要 ≠ 计算摘要才返回 `{watch, watchDigest}`，相等则两者都缺席；`watch: []` 表示清空全部 watch。busy Poll（`availableSlots: 0`）同样处理 watchDigest——watch 是配置分发，不依赖 run 领取。

claim 的 capability 门控是**逐候选**的，不是整轮 Poll 门控：已配置 Loop 要求 Machine 声明 `artifact-sync-v1`，缺 capability 的候选被跳过、不阻塞同 Machine 的其他候选（未配置 Loop 的领取条件不变）。判定发生在 claim 的权威 Loop 解析处（与 Completed 检查同点），其快照由事务内 `id + revision` CAS 证明——扫描与 claim 之间落地的配置写入使 CAS 丢失、有界重跑以新状态重裁。服务端不下发 artifact 的 `requiredCapabilities` 提示（该提示保持 terminal-journal 语义；daemon 在片 5 才声明该 capability）。

### 23. Artifact 扫描器（Daemon 本地库模块）

片 3 只交付 Daemon 本地的库模块（`artifact-jail.ts` / `artifact-scan.ts` / `artifact-hash-cache.ts` / `artifact-verify.ts`，既有 `jail.ts` 仅新增两处 `export`），不接线 `runtime.ts`/`cli.ts`/`index.ts`、不声明 `artifact-sync-v1`、不启动 watcher、不访问网络。给定 `{artifactDir, workdir, serverRoots}` 时，它要么产出**完整可提交**的 manifest（经共享 policy 收口与排序），要么返回一个封闭分类的失败——**结构上不存在部分清单**（决策 1 的本地执行体）。

**根解析复用 workdir jail 的 roots 纪律，但不复用 Task File 的 symlink 跟随。** `daemonRoots` 为空、或 `artifactDir` 为相对路径而无显式 `workdir`（`path.resolve(workdir, dir)` 解析失败）⇒ `outside_jail`；server roots 每次重新 canonicalize（非信任输入，`..`/不存在/非目录一律拒绝；**realpath 成功后 stat 才失败的文件系统故障同样转成 `JailError` 并归 `outside_jail`**，原 errno 不逃逸，见 #89）后求交集，空交集 ⇒ `outside_jail`。解析序为 `realpath` **先于**容器检查，因此**根自身是 symlink 时被跟随**，落点在有效 roots 内即通过、越界 ⇒ `outside_jail`（与 `jail.ts` 的 workdir 解析同规）；**树内**任何 symlink（指向内/外/悬空）一律使整次扫描失败，绝不读取目标。`ENOENT`/`ENOTDIR` 或 realpath 后非目录 ⇒ `directory_missing`；`ELOOP` ⇒ `symlink`；`EACCES`/`EPERM` ⇒ `unreadable`。解析零 scratch：不 import `mkdtemp`、不触碰 `createWorkdirJail`。

**遍历前剪枝先于一切 I/O。** never-sync 规则（决策 4）在 `lstat` 之前判定：命中的目录不下降（不枚举其子项）、命中的文件不 `lstat` 不 `open`——秘密文件连「被打开过」都不发生。合法空目录产出空 manifest；目录缺失绝不降级为空 manifest。

**失败分类映射（wire 9 值的子集）。** 扫描器类型层只产出 `Exclude<ArtifactSyncFailure, "watcher_error" | "timeout">` 七个值（后两者是片 5/片 4–6 的职责）。wire 不可表示的路径拒绝细分映射：`path_too_long ⇒ too_large`（决策 3 把路径上限归入容量组）；`path_backslash`/`path_drive_letter` 及其余防御性路径拒绝 ⇒ `unreadable`（detail 写明原因）。绝不跳过、绝不截断。

**读纪律与不稳定重扫。** 每个文件 `lstat`（分类 + 尺寸早检）→ `readRegularFileNoFollow`（决策：O_NOFOLLOW + O_NONBLOCK 单次打开、fstat 证明常规文件、分配前尺寸闸、有界读取）→ 读后 `lstat` 复验 `dev/ino/size/mtimeMs/ctimeMs` 五元组全等且字节长度等于 size。`O_NONBLOCK` 使终端组件在检查后被换成 FIFO 时 open 不再等待 writer，仍由同 fd 的 `fstat` 拒绝非普通文件（#87）；该标志对普通文件读取无影响。每访问过的目录在子树处理完后复检一次（覆盖「列完 A 后 A 被增删」）。复检错误分两类：**路径移动**（`ENOENT`/`ENOTDIR`/`ELOOP`）标脏并进入有界重扫；**内核拒绝**（`EACCES`/`EPERM` 及其余）是确定性失败，立即返回 `unreadable`，绝不重扫三次后误报 `unstable`（#88）。**确定性失败**（symlink/special/unreadable/too_large/路径拒绝）立即返回；仅当标脏且无确定性失败时整轮丢弃重扫，最多 3 次，仍脏 ⇒ `unstable`。收口由 `normalizeManifestEntries` 完成，它是唯一校验/排序源；`path_never_sync`/`duplicate_path`/`file_dir_conflict`/`hash_size_mismatch`/`hash_malformed`/`size_invalid` 在本地不可达，出现即抛不变量错误（说明扫描器自身不变量被破坏），不伪装成可提交失败。

**容量与 DoS 上界。** 单文件超 10 MiB 在 `lstat` 早检拒绝（不 open）；条目数与聚合字节（按路径累加）早停 ⇒ `too_large`；Daemon 另设 `maxVisitedDirents = 4 × ARTIFACT_MANIFEST_MAX_ENTRIES` 的已访问目录项上限——这是**本地防 DoS 上限，不是 wire 策略上限**，服务端不执行、不感知。

**hash 缓存与复用边界。** 缓存键为绝对路径，条目为文件身份五元组 + hash；`sameArtifactFileIdentity` 要求五元组**全等**才允许复用（绝不 size-only），Map 插入序 FIFO 驱逐，上界 `4 × ARTIFACT_MANIFEST_MAX_ENTRIES`，由调用方持有、无单例。默认（启动/每 60 秒/Run 最终同步）**全量重哈希**；只有片 5 的事件路径增量扫描显式选择复用缓存（本片只交付机制与测试，不预设调用方）。**上传前验证一律重新读取并重算 hash**（对应决策 13「上传前重新读取并验证 hash/size」），验证结果写回缓存；上传前验证先做包含守卫，越界 ⇒ `changed` 且不读取。

**残余边界与 follow-up。** 扫描的 TOCTOU 口径与 `bounded-read.ts` 逐字一致：O_NOFOLLOW 只护终端组件，不宣称同 UID 进程替换**中间目录**时的原子性；扫描一致性截止到读取时刻，读取后至上传间的漂移由上传前验证兜底（片 4 消费）。`artifactDir` 根**自身**落在 never-sync 区域（如 `~/.ssh`）不做检查：共享 policy 只约束 manifest 相对路径（决策 4/17），服务端同样只按条目判断，单侧拒绝会造成两侧口径不一——记为配置面 follow-up，片 3 不拓宽冻结的失败域。

## 后果

- 片 2/3 可以并行：表结构与 BlobStore adapter 都只对本文档与已编译接口负责。
- Daemon 本地扫描预分类与 Server 防御层共用同一 policy，失败分类跨端一致；Batch 2 的 HTTP adapter 按决策 5/13 接线即可。
- 9 码错误分类与重试约定冻结后，Daemon 的重试/重新协商行为可以脱离实现先行测试。
- 休眠边界（决策 16）使本批可以安全合入主干：生产行为与 Phase 4 逐字节一致由 AD1–AD4 可执行证据支撑。
- 已知限制延续 Batch 1 计划：只验证 namespace 隔离，未实现用户认证与生产 Team 归属；历史快照、过期 session 与孤立 Blob 的累计磁盘治理留 Phase 6。
- 内存与本地 BlobStore adapter 共用契约套件，测试工具置于 `src/testkit/`，不进入生产构建。测试注入的故障与交错接口不参与生产装配：`hooks.afterResolve` 在事务外允许竞争写入，PUT 在字节流 await 处交错，`hooks.insideCommitTx` 仅用于抛错验证回滚，事务内不等待竞争事务。
- PGlite 单连接证据不替代真实 PostgreSQL 多物理连接重叠验证；验证范围仍由 [#11](https://github.com/zhuabo001/loop-platform-zhb/issues/11) 与 [#72](https://github.com/zhuabo001/loop-platform-zhb/issues/72) 跟踪。

## 修订记录

以下仅记录决策变化及理由；正文表达现行契约。修复过程、测试结果和核销状态由 GitHub Issues 与 handoff 审查记录保存。

### 2026-09-28

- 决策 2/14 明确 schema 只检查 typeof 形状、读取的两阶段失败通道及异常文件分类，保证跨端分类与 adapter 契约一致。
- 决策 8/18 补充配置求值序、revision 上界、completed Loop 配置语义及持久化仲裁键；决策 19 补充绑定身份链与配置行锁，保证绑定对象可验证且与配置更新互斥。关联：[#69](https://github.com/zhuabo001/loop-platform-zhb/issues/69)、[#70](https://github.com/zhuabo001/loop-platform-zhb/issues/70)、[#71](https://github.com/zhuabo001/loop-platform-zhb/issues/71)。

### 2026-09-29

- 决策 12/14 明确不覆盖目标的原子发布、源中断分类、size 防御、fsync 范围与字节所有权，保证发布结果和已验证内容一致。关联：[#75](https://github.com/zhuabo001/loop-platform-zhb/issues/75)。
- 决策 14 明确 namespace 目录检查的部署信任边界，以及同 fd 读取与显式关闭责任，限定隔离保证并使未消费的读取结果可释放资源。关联：[#73](https://github.com/zhuabo001/loop-platform-zhb/issues/73)、[#74](https://github.com/zhuabo001/loop-platform-zhb/issues/74)。

### 2026-10-03

- 决策 9 明确已提交重放优先于当前配置/base 检查、pending 原位续约及 prepare 插入行锁，保证历史请求可恢复且新会话写入遵守 OCC。关联：[#77](https://github.com/zhuabo001/loop-platform-zhb/issues/77)、[#78](https://github.com/zhuabo001/loop-platform-zhb/issues/78)。
- 决策 10/11 明确 PUT 完成前全量复验、commit 事务内复验、回执守卫及同步尝试记录规则；commit 裁决观测序统一为 Loop→session，避免同 session 成功被误判为 base 冲突。关联：[#79](https://github.com/zhuabo001/loop-platform-zhb/issues/79)、[#80](https://github.com/zhuabo001/loop-platform-zhb/issues/80)。
- 决策 9/11 明确去重与完备性检查使用已验证 size，保证容量统计与实际内容一致。关联：[#81](https://github.com/zhuabo001/loop-platform-zhb/issues/81)。
- 决策 10 明确元数据登记失败归 `storage_error` 结果联合；决策 11 钉定 commit 回滚矩阵（任一步失败整体回滚、守卫丢失恰一次重跑、持续丢失失败关闭）、真竞态下败方失败打账因陈旧 revision 守卫零行跳过，以及统一 OCC 与 claim/report 真实写方的双向交错收敛。片 5 并发/交错/故障注入验收的 PGlite 证据不替代 #11/#72。
- 决策 11 修正 commit 回滚矩阵的驱动失败分类：已识别的可恢复存储故障（SQLSTATE 08/53/57/58 类）在事务整体回滚后归稳定 `storage_error` 结果并 best-effort 打账，无码或未识别类错误保留原始抛出边界；同步限定真竞态零行打账的已验证窗口（胜方提交晚于败方观测），并区分 AC9 反向交错的收敛路径——claim 守卫丢失一次后有界重跑，report 写事务快照后至、守卫不丢失直接落地。来源：片 5 Round 1 三轨审查记录（A5-1）。

### 2026-10-04

- 决策 7 确定 Batch 2 生产归属为 Machine namespace：`namespaceId` 取已验证 Machine 行的 `machineId`；行缺失或键不合规统一 `artifact_attribution_missing`（403），wire 与读视图不含 namespace 字段。
- 决策 13 将 wire 码扩为 11（新增 `artifact_revision_exhausted`、`artifact_session_committed`），冻结完整 HTTP 映射、第 5 个重试类 `recover_receipt`、客户端失败 9 值分类法及错误上报的双匹配写入门槛（迟到错误不覆盖新成功）。
- 决策 14 固定生产 Blob 根为 `<dataDir>/blobs`；新增决策 20 记录 Delivery Artifact 配置与最终同步代际固定；新增决策 21 记录生产门面边界。
- 决策 19 裁决 reconcile 绑定资格：合法 finalize 与合法 terminal-grace reconcile 可绑定经校验的 snapshot，取消、superseded 与无合法最终 Report 的 reclaimed 不绑定（代码改动在 Batch 2 片 6）。

### 2026-10-05

- 决策 13 冻结 PUT 成功响应 `{ok, size, published}`（`size` = 已验证字节数、`published:false` = 去重命中）与 `machineRead` 失败域（归属、Loop、未配置、存储故障）；记录错误上报的写入裁决：未配置门槛、双匹配门槛、守卫 UPDATE 形状，门槛不符或守卫零行均 `recorded:false`、零写入、不重试。
- 决策 8 裁决 Create 携带的 `artifactDir` 经同一 planner 求值、与创建同 INSERT 落库、初始代际为 1（代际 0 专表从未配置）；非法值与 PATCH 同码（400 `artifact_validation_failed`）且整个创建零写入。
- 决策 7 记录凭证校验落地为 `verifyMachineCredential`（形状检查 → 派生 id → 行查找 → 全量 tokenHash 比对，永不注册）。
- 新增决策 22：Poll watch 集合与下发门控（仅 Machine 声明 `artifact-sync-v1` 才下发；缺 `watchDigest` 等价于空集合摘要；busy Poll 同样处理）与 claim 的逐候选 capability 门控（权威解析 + 事务内 CAS 证明，非阻塞跳过，`requiredCapabilities` 保持 terminal-journal 语义）。
- 决策 16 更新：片 2 挂 6 条路由与生产装配，明确片 2 后仍休眠的范围（Report 字段、Daemon watcher、读路由）与各守卫的重写方式。
- 新增决策 23（片 3）：Daemon 本地扫描器的根解析（复用 roots 交集、根 symlink 跟随并做容器检查、树内 symlink 整扫失败）、失败映射（`path_too_long ⇒ too_large`；其余防御性路径拒绝 ⇒ `unreadable`）、never-sync 剪枝先于一切 I/O、读纪律（无跟随打开 + 读后身份五元组复验）、目录终检与有界丢弃重扫（3 次 ⇒ `unstable`）、容量与本地 dirent 防 DoS 上界、hash 缓存的五元组复用边界（默认全量重哈希、仅事件路径增量、上传前验证一律重读重算）、与 `bounded-read.ts` 同口径的残余 TOCTOU 声明，以及「`artifactDir` 根自身命 never-sync 不检查」的配置面 follow-up。
- 决策 16 更新：片 3 只新增 Daemon 本地库模块（零接线、零依赖、零 wire 面），休眠边界与片 2 之后逐字相同；AD4 daemon 半（`identity.test.ts`）零修改全绿为证。
- 决策 23 修订（片 3 首轮三轨审查修复）：共享有界读取原语 `bounded-read.ts` 增加 `O_NONBLOCK`——终端组件在检查后被换成 FIFO 时 open 不再等待 writer（原实现可无限挂起，且无 fd 可被 fstat 拒绝），仍由同 fd 的 `fstat` 拒绝非普通文件（[#87](https://github.com/zhuabo001/loop-platform-zhb/issues/87)）；读后与目录终检区分「路径移动」（`ENOENT`/`ENOTDIR`/`ELOOP` ⇒ 有界重扫）与「内核拒绝」（`EACCES`/`EPERM` 及其余 ⇒ 立即 `unreadable`，不再重扫三次后误报 `unstable`，上传前验证也不误报 `changed`）（[#88](https://github.com/zhuabo001/loop-platform-zhb/issues/88)）；server roots canonicalize 的 realpath 后 stat 故障一律转 `JailError`，根解析始终返回封闭失败结果（`outside_jail`），原 errno 不逃逸（[#89](https://github.com/zhuabo001/loop-platform-zhb/issues/89)）。
- 决策 23 记录：`artifactDir` 根自身命 never-sync 的配置面防护由 [#91](https://github.com/zhuabo001/loop-platform-zhb/issues/91) 跟踪（roadmap 加指针，启用生产持续同步前明确责任与规则）；Batch 2 计划与上位 Phase 5 计划已同步根 symlink 例外、树内拒绝、事件 hash 缓存复用条件与全量/上传前必重读边界（[#90](https://github.com/zhuabo001/loop-platform-zhb/issues/90)）。
