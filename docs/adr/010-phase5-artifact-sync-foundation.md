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

Daemon 的 poll 出站体仅包含既有五个静态字段与 `availableSlots`，不发送 `watchDigest`；poll/report 请求仅使用 `/api/machine/poll` 与 `/api/machine/report`。Batch 2 watcher 接线时须显式更新该边界。AD1–AD4 休眠守卫覆盖路由、Create/Poll/Report、出站请求及启动装配，长期验收要求以 Batch 1 计划为准。Batch 2 按批次计划逐切片解除该边界：片 1 只冻结契约与生产门面（AD1–AD4 仍全绿），片 2 挂 6 条路由与生产装配并解除 Create/Poll/claim/Delivery 的相关休眠，片 5 声明 capability 并启动 watcher，片 6 消费 Report 字段（决策 26：AD3 重写为激活语义，coordinator 报告测试默认注入绑定归属解析）。片 6 之后休眠仍覆盖：读路由与 Dashboard（片 7）；对应守卫按各片的实际解除范围重写（AD1 拆为已挂/未挂两半、AD2(a)/(b) 反转为启用语义、AD3 反转为绑定/落错语义、AD4 保留「启动零 fs 副作用、无 watcher」并新增装配断言）。片 3 只新增 Daemon 本地库模块（决策 23），不改任何装配与 wire 面：休眠边界与片 2 之后逐字相同，AD4 的 daemon 半（`identity.test.ts`）零修改全绿即其可执行证据。

### 17. 共享 policy 的 ADR-002 窄例外记录

`artifact-policy.ts` 是 ADR-002 决策 4「裁剪策略不进 protocol」的第二个记录在案窄例外（第一个是 terminal-policy.ts）：manifest 条目校验、容量上限、never-sync 规则、canonical 规范化与有界解析必须由 Daemon（扫描本地预分类）与 Server（防御层收口）逐字一致地执行，两份拷贝必然漂移，故单一来源放 protocol 包。模块保持纯函数、无 I/O、无 Node 内建依赖，主入口浏览器可 bundle 性不变。ADR-002 修订记录同步登记。

### 18. 持久化形状与仲裁键

模型使用 `artifact_sync_sessions`、`artifact_manifests`、`artifact_blobs` 三张表，Loop 保存配置、当前 manifest 指针与同步尝试状态，Run 保存快照绑定与同步错误。migration `0005` 前滚，沿用无外键、无新 CHECK、ISO text 时间戳和 jsonb 规范化 manifest/回执的仓库纪律；revision 非负、单调和上界由写路径保证。

唯一键作为仲裁依据：session `(namespaceId, machineId, requestId)`、manifest `(loopId, manifestRevision)`、Blob 复合主键 `(namespaceId, hash)`。

### 19. Run 快照绑定与配置互斥

绑定资格以 Report 事务显式确认的 finalize/reconcile 结果为准（资格参数 `eligibility: "finalize" | "reconcile"` 已由片 6 落地，规则见本节末段）。canceled/superseded 不绑定，reclaimed（terminal-grace 唤醒报告）路径按本节末段裁决。

绑定必须确认已提交 manifest 的 `id === snapshotId`，namespace 匹配可信归属，manifest / Run / Loop / 可信归属四方 machineId 相等，manifest / Run / Loop 的 Loop ID 一致，manifest 配置代际等于当前 Loop 代际。写入已验证的 `manifest.id`。内部拒绝分类为 `snapshot_not_committed` / `cross_namespace` / `cross_machine` / `cross_loop` / `stale_config_generation`；Batch 2 拥有最终接线分类法。

bind 计划携带解析时的 `guardConfigRevision`。落库的 Run UPDATE 守卫 Run `(id, phase)`，并在同一语句的代际子查询中以 `FOR UPDATE` 锁定 Loop 行、复验当前代际。锁持续到该语句或外层 Report 事务提交，与配置 UPDATE 互斥：配置先提交时绑定看到新代际并守卫失败；绑定先取得锁时配置等待绑定提交。普通无锁子查询的语句快照不足以保证此互斥。

守卫零行抛 `ArtifactBindingGuardLostError`，调用方须重解析、重计划；代际前进后转为 `stale_config_generation`。`record_error` 仍守卫 Run `(id, phase)`，但不锁 Loop、不加代际守卫：`cross_*` 与 `snapshot_not_committed` 不受配置代际影响，`stale_config_generation` 在代际单调递增下仍成立。

Batch 2 裁决 reconcile 绑定资格：合法 finalize 与合法 terminal-grace reconcile 都可以绑定 Report 明确携带且通过校验的 snapshot（资格由 Report 事务显式确认，而不是放宽 phase 检查）；取消、superseded 以及没有合法最终 Report 的 reclaimed Run 不绑定。绑定 planner 的资格参数已在片 6 落地（决策 26）。

### 20. Delivery Artifact 配置与最终同步代际

Delivery 的 Loop 投影携带可选 `artifact: {dir, configRevision}`，值来自成功 claim 的权威 Loop 行，不是请求参数。Daemon 的最终同步固定使用该代际；Run 期间新设置的目录不改绑该 Run 的最终同步。配置被清除（`artifactDir=null`）时该字段缺席。片 2 接线：值取自 claim 事务 CAS 返回的权威行（`buildDelivery` 在 `artifactDir` 非空时才带该键）。

### 21. 生产门面边界

Batch 2 的生产门面是 `packages/server/src/artifact/production.ts` 的 `createProductionArtifactHome({db, dataDir, clock?}) → ArtifactHomeDeps`：构造以 `<dataDir>/blobs` 为根的本地 BlobStore、Machine 归属解析器、生产 ID 工厂（`sync-`/`amf-` 加 UUID）与注入时钟。构造零文件系统副作用、不读环境变量、不依赖启动模块。片 1 只由测试调用该门面；片 2 由 `bootstrapServer` 装配为 `BootedServer.artifacts = createArtifactApi(home)`，HTTP 适配器只经该窄接口消费——构造仍零副作用（`<dataDir>/blobs` 首次写入才出现）。

### 22. Poll watch 下发与 claim capability 门控

Poll 的 watch 集合是该 Machine 名下**全部已配置 Loop**（`artifactDir` 非空，含 Paused 与 Completed，不按 enabled/completedAt 过滤）；每项为 `{loopId, artifactDir, workdir: loop.workdir ?? null, roots: machine.roots ?? [], configRevision}`。**服务端只在 Machine 已声明 `artifact-sync-v1` 时下发 watch**——未声明的 daemon 不运行 watcher，配置是死重；未声明者（含全部 Batch 1 daemon）的 poll 响应因此与 Batch 1 逐字一致。判定规则：请求缺 `watchDigest` **等价于空集合的摘要**（无 watch 状态的 daemon 与空集合语义等价，旧 daemon 因此不产生噪声）；有效摘要 ≠ 计算摘要才返回 `{watch, watchDigest}`，相等则两者都缺席；`watch: []` 表示清空全部 watch。busy Poll（`availableSlots: 0`）同样处理 watchDigest——watch 是配置分发，不依赖 run 领取。

claim 的 capability 门控是**逐候选**的，不是整轮 Poll 门控：已配置 Loop 要求 Machine 声明 `artifact-sync-v1`，缺 capability 的候选被跳过、不阻塞同 Machine 的其他候选（未配置 Loop 的领取条件不变）。判定发生在 claim 的权威 Loop 解析处（与 Completed 检查同点），其快照由事务内 `id + revision` CAS 证明——扫描与 claim 之间落地的配置写入使 CAS 丢失、有界重跑以新状态重裁。服务端不下发 artifact 的 `requiredCapabilities` 提示（该提示保持 terminal-journal 语义；daemon 在片 5 才声明该 capability）。

### 23. Artifact 扫描器（Daemon 本地库模块）

片 3 只交付 Daemon 本地的库模块（`artifact-jail.ts` / `artifact-scan.ts` / `artifact-hash-cache.ts` / `artifact-verify.ts`，既有 `jail.ts` 初始交付新增两处 `export`，后续审查修复补充 roots 的 I/O 异常分类），不接线 `runtime.ts`/`cli.ts`/`index.ts`、不声明 `artifact-sync-v1`、不启动 watcher、不访问网络。给定 `{artifactDir, workdir, serverRoots}` 时，它要么产出**完整可提交**的 manifest（经共享 policy 收口与排序），要么返回一个封闭分类的失败——**结构上不存在部分清单**（决策 1 的本地执行体）。

**根解析复用 workdir jail 的 roots 纪律，但不复用 Task File 的 symlink 跟随。** `daemonRoots` 为空、或 `artifactDir` 为相对路径而无显式 `workdir`（`path.resolve(workdir, dir)` 解析失败）⇒ `outside_jail`；server roots 每次重新 canonicalize（非信任输入，`..`/NUL/不存在/非目录一律拒绝；**realpath/stat 抛出的已识别 OS errno 转成 `JailError` 并归 `outside_jail`**；仅识别当前平台 `node:os.constants.errno` 中的码，无码、未知码与 `ERR_*` 程序异常保持原样抛出，见 #89）后求交集，空交集 ⇒ `outside_jail`。解析序为 `realpath` **先于**容器检查，因此**根自身是 symlink 时被跟随**，落点在有效 roots 内即通过、越界 ⇒ `outside_jail`（与 `jail.ts` 的 workdir 解析同规）；**树内**任何 symlink（指向内/外/悬空）一律使整次扫描失败，绝不读取目标。`ENOENT`/`ENOTDIR` 或 realpath 后非目录 ⇒ `directory_missing`；`ELOOP` ⇒ `symlink`；`EACCES`/`EPERM` ⇒ `unreadable`。解析零 scratch：不 import `mkdtemp`、不触碰 `createWorkdirJail`。

**遍历前剪枝先于一切 I/O。** never-sync 规则（决策 4）在 `lstat` 之前判定：命中的目录不下降（不枚举其子项）、命中的文件不 `lstat` 不 `open`——秘密文件连「被打开过」都不发生。合法空目录产出空 manifest；目录缺失绝不降级为空 manifest。

**失败分类映射（wire 9 值的子集）。** 扫描器类型层只产出 `Exclude<ArtifactSyncFailure, "watcher_error" | "timeout">` 七个值（后两者是片 5/片 4–6 的职责）。wire 不可表示的路径拒绝细分映射：`path_too_long ⇒ too_large`（决策 3 把路径上限归入容量组）；`path_backslash`/`path_drive_letter` 及其余防御性路径拒绝 ⇒ `unreadable`（detail 写明原因）。绝不跳过、绝不截断。

**读纪律与不稳定重扫。** 每个文件 `lstat`（分类 + 尺寸早检）→ `readRegularFileNoFollow`（决策：O_NOFOLLOW + O_NONBLOCK 单次打开、fstat 证明常规文件、分配前尺寸闸、有界读取）→ 读后 `lstat` 复验 `dev/ino/size/mtimeMs/ctimeMs` 五元组全等且字节长度等于 size。`O_NONBLOCK` 使终端组件在检查后被换成 FIFO 时 open 不再等待 writer，仍由同 fd 的 `fstat` 拒绝非普通文件（#87）；该标志对普通文件读取无影响。每访问过的目录在子树处理完后复检一次（覆盖「列完 A 后 A 被增删」）。复检错误分两类：**路径移动**（`ENOENT`/`ENOTDIR`/`ELOOP`）标脏并进入有界重扫；**内核拒绝**（`EACCES`/`EPERM` 及其余）是确定性失败，立即返回 `unreadable`，绝不重扫三次后误报 `unstable`（#88）。**确定性失败**（symlink/special/unreadable/too_large/路径拒绝）立即返回；仅当标脏且无确定性失败时整轮丢弃重扫，最多 3 次，仍脏 ⇒ `unstable`。收口由 `normalizeManifestEntries` 完成，它是唯一校验/排序源；`path_never_sync`/`duplicate_path`/`file_dir_conflict`/`hash_size_mismatch`/`hash_malformed`/`size_invalid` 在本地不可达，出现即抛不变量错误（说明扫描器自身不变量被破坏），不伪装成可提交失败。

**容量与 DoS 上界。** 单文件超 10 MiB 在 `lstat` 早检拒绝（不 open）；条目数与聚合字节（按路径累加）早停 ⇒ `too_large`；Daemon 另设 `maxVisitedDirents = 4 × ARTIFACT_MANIFEST_MAX_ENTRIES` 的已访问目录项上限——这是**本地防 DoS 上限，不是 wire 策略上限**，服务端不执行、不感知。

**hash 缓存与复用边界。** 缓存键为绝对路径，条目为文件身份五元组 + hash；`sameArtifactFileIdentity` 要求五元组**全等**才允许复用（绝不 size-only），Map 插入序 FIFO 驱逐，上界 `4 × ARTIFACT_MANIFEST_MAX_ENTRIES`，由调用方持有、无单例。默认（启动/每 60 秒/Run 最终同步）**全量重哈希**；只有片 5 的事件路径增量扫描显式选择复用缓存（本片只交付机制与测试，不预设调用方）。**上传前验证一律重新读取并重算 hash**（对应决策 13「上传前重新读取并验证 hash/size」），验证结果写回缓存；上传前验证先做包含守卫，越界 ⇒ `changed` 且不读取。

**残余边界与 follow-up。** 扫描的 TOCTOU 口径与 `bounded-read.ts` 逐字一致：O_NOFOLLOW 只护终端组件，不宣称同 UID 进程替换**中间目录**时的原子性；扫描一致性截止到读取时刻，读取后至上传间的漂移由上传前验证兜底（片 4 消费）。`artifactDir` 根**自身**落在 never-sync 区域（如 `~/.ssh`）不做检查：共享 policy 只约束 manifest 相对路径（决策 4/17），服务端同样只按条目判断，单侧拒绝会造成两侧口径不一——记为配置面 follow-up，片 3 不拓宽冻结的失败域。

### 24. 同步客户端与恢复状态机（Daemon 本地库模块）

片 4 交付 Daemon 的 artifact 同步客户端（`artifact-client.ts` 传输 + `artifact-sync.ts` 状态机），只提供**可手动驱动**的同步能力：不监听目录、不声明 `artifact-sync-v1`、不接 Run 最终 Report、不接线 `runtime.ts`/`cli.ts`/`index.ts`（片 5/6 各自接线）。一次调用给定 watch 目标（`ArtifactWatchItem`：`loopId`/`artifactDir`/`workdir`/`roots`/`configRevision`）与 `daemonRoots`，返回一个封闭结果：`unchanged｜synced｜failed（本地 7 类）｜config_changed｜stopped｜terminal｜unavailable｜cancelled`。

**幂等身份由 payload 决定。** requestId 是幂等键、不是 payload（决策 6）：客户端用共享的 `preparePayloadFingerprint` 判定——待发 payload 的指纹与 pending 会话相同时复用 requestId（服务端据此复用同一会话），不同时新铸。绝不在 payload 变化时复用 requestId（服务端会判 409 `artifact_manifest_conflict`，决策 9）。prepare 的序列化体在首次发送时冻结，重试逐字节相同（镜像 `SerializedReportRequest`）。

**重试类 → 客户端动作。** 逐字消费决策 13 的 `ARTIFACT_ERROR_RETRY_CLASS`：`idempotent_retry` ⇒ 同请求同身份退避重试；`resume`（commit 409 `artifact_blob_missing`）⇒ **同一 payload 重新 prepare**（服务端对 pending 会话重算 `needHashes`）→ 传缺失项 → 重试同一 commit；客户端因此不需要知道缺哪个 blob，也绝不重传全部协商 hash。`renegotiate` ⇒ 重读服务端基线后按新 payload 重新 prepare；`artifact_session_expired` 与 404 `session_not_found` 走**同一 payload** 路径——服务端对未提交的过期 pending 会话原地续期，**syncId 不变**。`recover_receipt` ⇒ 对同一 syncId 直接 commit 取固定回执（零 PUT）。`terminal` ⇒ 终止结果。畸形 2xx 视为**响应丢失**（可重试），与 poll 的 fatal 判定相反：artifact 的三个操作在冻结身份下全部幂等。无码状态按步判定：PUT/commit 404 ⇒ renegotiate；prepare 404（Loop 不存在或跨机）⇒ terminal；prepare 请求体超 8 MiB（`ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES`）⇒ 本地预检按 `too_large` 上报且不发请求。`artifact_content_mismatch` 是 `terminal` 类中唯一的客户端动作例外：客户端计入重扫预算后整轮重扫，预算耗尽才终止——片 4 的「PUT 的字节就是刚校验过的字节」使它实践上不可达，此路径是纵深防御；wire 侧重试类（决策 13 表）仍是 terminal，未变。

**上传的字节就是校验过的字节。** 决策 23 的「上传前一律重读重算」由 `verifyArtifactEntry` 执行；片 4 在 `artifact-scan.ts`/`artifact-verify.ts` 增加**加法导出**（`readArtifactFileWithBytes`/`readVerifiedArtifactEntry`，现有函数行为逐字不变），使 PUT 的请求体正是刚通过校验的那批内存字节——单次读、单次哈希，**结构上不存在 verify→upload 窗口**；服务端的字节级校验退化为纵深防御。需要上传的 entry 逐条校验（**按 entry 而非按 hash**）：同一 hash 出现在多个路径时逐路径校验、同一 hash 只上传一次（用首个通过校验的字节），任何一条漂移都整轮重扫，不提交过期清单。

**无变化抑制与其失效规则。** 服务端不比较内容等价（决策 11：每次成功提交都新建快照），因此「无变化的后台核对应不新建 manifest」是客户端职责：进程内保留上次成功提交的 `(configRevision, manifestRevision, entries)`，当新扫描逐条相等且代际相同时直接返回 `unchanged`，**零请求**。失效规则：只有 `unchanged`/`synced` 保留并刷新基线；其余任何结果（含瞬态预算耗尽的 `unavailable`、取消、服务端拒绝、回放旧回执）都置 entries 未知并在下次调用前重读 revision——否则「提交已落地但响应丢失，随后内容回退到旧值」会永久抑制出一处真实分歧。**重启残余**：进程重启后没有进程内基线，只能读回 `(configRevision, manifestRevision)` 作为协商基点，因此首轮可能为等价内容新建一次 revision；Daemon 不引入本地持久化状态。

**停止按作用域，且是粘性的。** 401 ⇒ 机器级停止（该客户端全部 Loop）；403 按 code 取作用域——服务端唯一的 403 是 `artifact_attribution_missing`（机器归属级），故为机器级停止，结果联合保留 `"loop"` 选项以备将来。停止后后续调用零请求直接返回 `stopped`；`clearStops()` 供配置换代或凭据轮换后恢复。**拒绝的裁决不因位置或竞争被遮蔽**：上传各组的拒绝在整轮分类之前全部裁决，可停止的一律置停止（一个组的瞬态预算耗尽不得遮蔽另一组的 401/403）；错误上报自身被拒（401/403）同样按作用域记录停止，本轮结果仍以本地失败为主题（上报是 best-effort，不改变结果分类）。

**并发、退避与预算。** 每 Loop 串行（同 Loop 排队、不同 Loop 并发）；Blob 上传经实例级闸，全局在途 ≤ 4（一个客户端实例对应一个 daemon，片 5 只构造一个）——**许可在释放时直接移交给下一个等待者，绝不先减计数再异步唤醒**（后者在「减计数」与「被唤醒者恢复」之间留出一个窗口，新到者可同时取得许可，使在途并发越过上限）；瞬态失败退避 1、2、4、8……封顶 60 秒；预算 `ARTIFACT_SYNC_MAX_ATTEMPTS = 6`（每次操作的尝试总数）、重扫 `ARTIFACT_SYNC_MAX_RESCANS = 2`、重新协商 `ARTIFACT_SYNC_MAX_RENEGOTIATIONS = 3`；PUT 单独 60 秒超时（≤10 MiB 的有界窗口），其余请求 10 秒。每次调用接受 `AbortSignal`：fetch、退避与排队等待都可中止——**同 Loop 排队中被取消的调用立即结束**（不等待前序 PUT 完成），且不发起任何请求；跨 Loop 等待上传许可的调用也可取消，等待者从闸队列移除且不取得许可、不发起 PUT。许可已移交后发生的取消仍须释放所持许可；已开始的上传任务须落定，不以取消脱挂任务；片 3 的扫描/校验不接 signal，取消在文件边界生效。

**排空语义与内部异常。** `settled()` 覆盖排队/在途调用、直接基线读取与**全部在途上传任务（含停在闸前的）**——只计调用会让 drain 在字节仍在网上时报「已完成」。一轮上传用 `Promise.allSettled` 等待全部组：某个组的内部异常（程序错误，非协议结果）绝不脱挂兄弟组，全部落定后先记录所有 401/403 停止，再按原异常身份上抛给调用方，其他组的 HTTP 拒绝不得将其改写成协议结果；该类异常同样使基线记录失效。轮内 `Promise.all` 式的提前拒绝属已修复缺陷（[#92](https://github.com/zhuabo001/loop-platform-zhb/issues/92)）。

**本地失败上报是一次性的。** 只有本地扫描/校验失败（决策 23 的 7 值，含重扫预算耗尽时的 `unstable`）走上报端点；网络、超时与服务端拒绝绝不走（否则等于给断网加一次注定失败的请求）。上报携带**本次尝试实际使用的** `configRevision`/`baseManifestRevision`（否则服务端双匹配门槛会记 `recorded:false`），单次发送不重试，三态结果 `recorded` / `stale`（`recorded:false`，服务端状态已前进）/ `unreported`（传输失败）。**基线读取先于任何可能失败的本地步骤**：重启后的新客户端没有进程内记录，若以猜测的 0 上报，双匹配门槛会永久记 `recorded:false`、Loop 的同步错误态永不落地（[#95](https://github.com/zhuabo001/loop-platform-zhb/issues/95)）；已知且同代的记录仍跳过读取，抑制路径保持零请求。读取同时校验 `configRevision` 与 `artifactDir`：目标与服务端配置不一致归 `config_changed`（不发上报），顺序在本地失败之前。

**freshSession。** `syncLoop(target, {freshSession: true})` 跳过抑制并强制新铸 requestId ⇒ 每次都是新会话（决策 11 的「每次最终同步使用新会话，即使内容相同」），供片 6 使用；本片只交付机制。**新铸只作用于该次调用的首次提议**：同一调用内的恢复轮（过期/丢会话重新 prepare）沿用同一身份，否则 pending 会话会被孤儿化、服务端无法原地续期（[#97](https://github.com/zhuabo001/loop-platform-zhb/issues/97)）。

### 25. WatchManager 生命周期与生产接线（片 5）

**生产启用与 capability（片 5）。** 片 5 起 Daemon 在生产声明 `artifact-sync-v1`（`machineIdentity()` = `terminal-journal-v1` + `artifact-sync-v1`），并按 Poll 下发的 watch 集合为每个已配置 Loop 启动 watcher；`prepareDaemon` 构造**恰好一个** artifact transport、hash 缓存、同步客户端与 WatchManager（单实例 ⇒ 实例级上传闸即 daemon 全局闸）。休眠边界按实际解除范围重写（决策 16）：AD4 daemon 半的 capability pin 与 poll body pin 故意更新，保留「构造零 fs 副作用」「收到 watch 前不开 watcher」「runtime→wire 只走 poll/report」三条断言。

**watcher adapter 与冻结选项。** 锁定 chokidar **4.0.3**（engines ≥14.16；不用要求 Node ≥22.22 的 v6），选项 `{ignoreInitial:true, followSymlinks:false, ignorePermissionErrors:false, persistent:true}`；**不设 `awaitWriteFinish`**——文件稳定性由扫描器判定（决策 23）。chokidar 只出现在 `artifact-watcher.ts`、CLI 装配及其测试，不进入 wrapper bundle 图与 `index.ts` 导出面。

**事件合并与订阅顺序。** **先订阅再全扫描**：打开 watcher → `ready` → 全量扫描；`ready` 前与扫描期间的事件均保留，事件不丢。**`ready` 之前任何扫描都不允许执行**（订阅尚未建立，提前扫描会在订阅与首扫之间留下遗漏窗口，且提前的轮次会走事件路径的缓存复用）；准入/订阅期间只记录待办，`ready` 后的全量重哈希首扫先执行，订阅前的待办事件再由同一驱动链的下一轮处理。`ready` 后的事件按 **250 ms 固定窗口**（自首个事件起算，不做 debounce 重置——重置在分块写入下会饥饿）合并；未到期窗口只合并事件，不形成可执行请求。**每个 Loop 的轮次由一条驱动链保证跑完**：在途轮结束时若仍有**已到期窗口的事件请求**或核对请求，该轮自己立即发起补扫，因此「窗口在轮内到期」不会丢失；轮次结束不能提前消费未到期窗口。可执行待办按请求强度取强（核对请求等价全量重哈希，绝不因同时有已到期事件请求而退化为缓存复用）。`ignoreInitial:true` 使订阅不产生首轮事件洪峰，初扫由管理器自己执行。

**两条扫描路径的分工（消费决策 23）。** 启动首扫、每 60 秒完整核对与片 6 的 Run 最终同步一律全量重哈希（`reuseCachedHashes:false`）；**只有事件路径**显式 `reuseCachedHashes:true`（片 4 客户端新增加法输入，默认 false）。60 秒核对由 WatchManager 的单实例计时器驱动（与 Poll 心跳互不阻塞）；在途扫描时核对记为待办（保持全量重哈希强度），由在途轮的驱动链补跑。watcher 已被拒绝或关闭的 Loop（jail/never-sync 根、以及**根消失 `directory_missing`**）在 tick 只做零网络的本地重验：`directory_missing` 与 `outside_jail` 同样关闭订阅、不再发起网络同步，根恢复后重新订阅并全量扫描。

**配置换代、移除与摘要。** 五字段（`loopId`/`artifactDir`/`workdir`/`roots`/`configRevision`）任一变化 ⇒ **先中止旧代任务、`await` 关闭旧 watcher，再解析新根、订阅并全扫**（顺序即 AS7 证据；旧代响应因中止与代际不可能写新代状态）；集合移除（含 `watch: []`）⇒ 中止 + 关闭 + 丢弃状态，不强制提交。**集合核对全同步**：`apply` 内完成整份集合的核对（无 I/O、无 `await`），因此不存在被挂起的旧集合在稍后覆盖新集合的窗口——旧的「旧代复活／覆盖」缺陷类被结构性地消除，而不是靠事后检查。可失败的工作（根解析、never-sync 守卫、订阅与扫描）全部在核对启动的准入任务里；**每 Loop 的关闭资源被保留**，新代（含移除后重新加入）在订阅前等待其前一代 watcher 关闭完成，任何时刻同一 Loop 至多一个活 watcher。移除在 `apply` 内**同步**生效（集合说移除即移除，关闭在后台完成），`apply` 仍是无 I/O 的同步记账；某个 Loop 的慢关闭或慢准入只推迟它自己，不阻塞其他 Loop 与 Poll 心跳。摘要保留：`watch` 缺席 ⇒ 集合与摘要都不动；收到集合即存摘要（**在 apply 时存**，不等 watcher 起好），否则服务端每轮重发全集。

**粘性停止与恢复。** 观察到 `stopped{machine}` ⇒ 对当时的集合取快照，在任何异步关闭前同步标记全部目标为 parked 并中止，再等待这些旧代 watcher 关闭；`stopped{loop}` ⇒ 仅该 Loop（服务端当前不可达，保留作用域）。关闭完成后不回写 parked，也不重新遍历当前集合。**watch 集合实质变化 ⇒ `clearStops()` 并以新状态对象重新准入 parked Loop**（呼应决策 24 的「配置换代后恢复」）；新代等待同 Loop 的旧 watcher 关闭，但不等待旧同步轮结束，不继承旧驱动链或待办，旧代迟到结果不能影响恢复代。无配置变化时机器级停止保持到进程重启——片 5 无凭据轮换流程（残余）。

**drain（关闭排空）。** 标记 draining（不再接受新事件/新工作）→ 清合并与核对计时器 → 中止全部 Loop 任务并 `await` 关闭全部 watcher → 以 **10 秒**为界竞速等待在途工作与 `settled()`；超时返回未排空并记日志。**从不发起最终提交、无持久 outbox**；中止的轮次在每次操作后复查 signal，结构上不会提交部分清单。

**根 never-sync 防护（[#91](https://github.com/zhuabo001/loop-platform-zhb/issues/91)）。** 判定 = 解析后的根（`resolveArtifactRoot` 已 realpath 化，覆盖根自身、祖先与根 symlink 落点）命中 `NEVER_SYNC_DIRECTORY_RULES` 的**任一连续段窗口**（ASCII 大小写不敏感）——**只用目录规则**；文件规则不适用于目录根（名为 `credentials` 的目录仍允许）。规则以 protocol 的加法导出 `isNeverSyncDirectoryPath` 为单一来源（无 schema 变更 ⇒ tolerant-reader 与 server 不变）。执行两处：① 片 4 状态机在解析根之后、扫描之前拒绝，走既有本地失败路径 ⇒ `failed{outside_jail, reported}`，零扫描零上传（**结构性保护全部调用方**，含片 6 最终同步）；② WatchManager 准入：拒绝则不开 watcher、不枚举，每 60 秒本地重验（零网络），恢复后订阅 + 全扫；每个代际的首次拒绝复用一次同步尝试完成上报，之后不再重复上报。失败码复用 `outside_jail`（taxonomy 冻结，不新增第 10 值）。

**watcher 错误与扫描级取消。** chokidar error 事件按同一 250 ms 窗口合并后经片 4 客户端新增的加法方法 `reportLocalFailure(target, failure, detail)` 上报（复用基线读取、一次性三态与粘性停止；计入 `settled()`/drain 覆盖）。`ArtifactScanOptions.signal?: AbortSignal`（默认 `undefined`，既有行为逐字不变）在重扫循环与目录/条目边界检查，`syncLoop` 透传调用方 signal：中止 ⇒ `cancelled`，结构上无部分清单、无提交——片 5 的 10 秒 drain 与片 6 的 30 秒期限由此可真正取消长扫描。上传前校验的单文件读（≤10 MiB 有界）不加 signal，取消在文件边界生效（残余）。

**片 5 残余。** chokidar 自身遍历无 depth 上限（扫描器的容量上限只管自己的遍历）；roots 重叠的多个 Loop 各自订阅（不共享 watcher，事件冗余）；`directory_missing` 期间不常开 watcher（按 60 秒 tick 重验恢复，最长 60 秒延迟）。

### 26. Run 最终同步与 Report 原子绑定（片 6）

**最终同步编排（Daemon）。** Runner 落定后、Report 序列化前，凡 Delivery 携带 `artifact` 配置的 Run 都执行一次最终同步（`artifact-final-sync.ts`）：目标由 Delivery 组装（决策 20 的代际固定），`freshSession: true`（决策 11——即使内容相同也铸新快照）、`reuseCachedHashes: false`（决策 25——一律全量重哈希）。整个尝试——每 Loop 排队、扫描、上传和重试——共享一个 **30 秒总期限**（`FINAL_SYNC_DEADLINE_MS`），以调用方 AbortSignal 组合实现（既有取消点生效：排队等待、fetch、扫描边界），测试经注入 sleep 确定性驱动。**到期与否由期限 watcher 自行记录，不由落定结果推断**（#106）：正常完成经 done 信号解除 watcher，绝不误判为到期；caller 关闭同样不算到期。到期取消后**等待该次调用落定**再冻结字段：落定若是 `synced`（commit 与期限真实擦肩）仍绑定该合法快照（绑定校验在服务端）；**其余任何落定结果**——包括扫描挂起越期后才以 `failed{unreadable}` 落定、期限 abort 与客户端自身失败分类竞速的情形——一律冻结稳定 `"timeout"`。30 秒之外另设 10 秒补报预算（`FINAL_SYNC_TIMEOUT_REPORT_BUDGET_MS`）：到期向 Loop 补报一次 `reportLocalFailure({failure: "timeout"})`（taxonomy 预留值；客户端自身在已中止 signal 上的失败上报不算数），超预算放弃上报但 Report 字段不变。watcher 的解除在所有落定路径（含内部异常）统一执行，不留任何越期计时器。

**Report 字段映射。** 两字段在 Daemon 侧互斥：`synced` ⇒ `artifactSnapshotId`；其余分支映射为稳定字符串——`failed{failure}` ⇒ taxonomy 字面值；期限自身到期 ⇒ `"timeout"`；`terminal{code}` ⇒ wire code（无 code 时 `"terminal"`）；`unavailable` ⇒ `"unavailable"`；`config_changed` ⇒ `"config_changed"`；`stopped` ⇒ `"stopped"`；内部程序异常 ⇒ `"internal_error"`（free-form 列，不进 taxonomy、不上报 loops 端点）。字段在序列化前合并进 Report 体（含不可序列化 runner 返回的兜底体），Report 只序列化一次、重试字节一致（决策 24 的镜像语义）。

**容量与关闭语义（runtime）。** 最终同步在 in-flight 槽内执行：槽在 runner 落定后保持占用，`pendingReports.set` 之后**同步**释放（set 与 delete 之间无 await ⇒ 并发 1 不变式不因最终同步开窗口）；runner 的 onProgress 汇以 `runnerActive` 布尔 + inFlight 双门（runner 落定后的事件——包括最终同步期间——一律忽略）。关闭中最终同步快路径返回空字段，Report 滞留内存不发送（既有契约，不改）。

**Report 事务绑定（Server，落地决策 19 末段）。** 绑定逻辑在资格判定（finalize/reconcile）之后、v0/v1 分岔之前的**共享位置**执行（v0 从不携带字段 ⇒ 行为不变）。planner 显式接受事务确认的 `eligibility` 参数，不再从 `run.phase` 推导资格。评估序（第一命中胜）：两字段皆缺席 ⇒ skip；同现 ⇒ `ambiguous_artifact_report`（短路，不读 manifest，存在性不在校验前泄漏）；仅 syncError ⇒ daemon 分类原文落 `runs.artifactSyncError`；归属缺失 ⇒ `attribution_missing`（fail-closed）；仅 snapshotId ⇒ 原五连校验 ⇒ bind。**字段出现性按原始可选字段判定，清洗只是存储政策**（#105）：空串、纯空白或纯 NUL 的 `artifactSyncError` 仍是已携带字段，与 snapshot id 同现即 `ambiguous_artifact_report`（短路先于任何 manifest 查询）；仅 error 且清洗后无可用文本时不写任何字面量（skip，绝不臆造）。绑定是**独立 guarded UPDATE**（只写 artifact 两列，不与终态 writeSet 合并），在 Run phase 写入之前执行，与其及 Lease 消费同一事务提交或回滚。`ArtifactBindingGuardLostError` 并入 `withReportCasRetry` 吸收集：整事务重跑一次，重跑重读 Loop 重计划（代际前进 ⇒ `stale_config_generation` ⇒ `record_error`），二次仍失 ⇒ `ReportRaceLostError`（非 401 的 500，daemon 保留未消费报告）。可信归属以事务句柄逐调用重新解析。绑定拒绝只记录 Artifact 错误，永不改变合法 Run 终态。

**片 6 残余。** 关闭中 Report 滞留内存丢失是既有契约（最终同步取消只是让字段缺席）；PGlite 单连接下 bind 的 FOR UPDATE 代际互斥只能经 hooks 交错证明语义，真实多物理连接行锁验收归 [#72](https://github.com/zhuabo001/loop-platform-zhb/issues/72)（片 6 不关闭它）；`internal_error` 字面量只落 Run 字段（不进 taxonomy）。

### 27. 管理读路由与 Dashboard 文件视图（片 7）

**读路由激活（决策 16 解除）。** 片 7 起四个只读管理端点挂载：`GET /api/loops/:id/artifacts`（当前文件视图）、`GET /api/runs/:id/artifacts`（绑定快照或显式 missing）、`GET /api/loops/:id/artifacts/download`（按 snapshotId + manifest path 查表下载）、`GET /api/loops/:id/artifacts/diff`（同 Loop 两快照结构 diff）。读取走 `ArtifactApi` 的扩展管理方法（与 `updateConfig` 同为无凭据 loopback 边界），纯域读收敛在新模块 `artifact/read.ts`，复用 `readCurrentArtifactView`（决策 8 的过期读取时计算）与 `readArtifactSnapshot`（决策 12）。AD1 读路由半的休眠守卫据此翻转为激活语义。

**管理读求值序。** 无凭据管理读的机器身份从 loop 行发现：**loop 行查找即身份发现步**，归属（决策 7）在任何 snapshot/path/blob 解析之前重新解析，任何数据离开之前完成。跨 scope 的 snapshot/path/run 引用与「从未存在」不可区分（无码 404 家族，决策 13）；归属缺失是 403 `artifact_attribution_missing`。

**下载路由组合规则（用户裁决 R3）。** 下载端点开流失败的 `blob_missing`（manifest 有条目、磁盘字节被越外删除）映射为 **404 `path_not_found`**（无码 404 家族，body 与 `app.notFound` 逐字节一致），**不**使用通用冻结表的 `blob_missing → 409 artifact_blob_missing`——客户端视角「该 manifest path 的字节不在了」与 path 缺失不可区分，留在无码 404 家族保持存在性不泄漏。此组合仅属下载路由；通用映射表保持冻结。开流异常 `invalid_key`/`not_regular_file`（凭 resolver 形成的 namespace 与策略校验的 manifest hash 下不可达）防御性归 `storage_error`（500），绝不洗成重传类 409。下载按 **snapshotId + manifest 条目查表**，绝不从 URL 路径拼磁盘路径；blob 键的 namespace 出自归属解析器，不取自 manifest 行。响应固定五头：`application/octet-stream`、`Content-Disposition: attachment`（filename 取 manifest path 末段，控制字符剥离 + RFC 6266 引号转义）、`Content-Length`（真实大小）、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`。**忽略 Range 请求**（始终完整 200；本地回环管理面无断点续传需求）。中流存储失败以终结流元素到达：头发出后状态不可改，响应按截断收尾——HTTP 层唯一剩余的完整性信号是 `Content-Length`，需要确定性的客户端将所收字节与 manifest hash 对摘要。客户端中止（连接关闭）经请求 signal 触发 `close()`，句柄释放与流泵同属路由层职责。

**Run 快照视图判别（用户裁决 V3）。** `missing` 冻结为「从未绑定」：已绑定 Run 的 manifest 行被越外删除（无任何删除 API，纯防御路径）返回 404 `snapshot_not_found`，绝不改写为 missing——把已绑定 Run 呈现为未绑定等于伪造历史。

**结构 diff（用户裁决 V1）。** diff 是纯方向性集合代数，按传入计算（before=from、after=to），冻结失败域不新增乱序拒绝字面量；同快照 ⇒ 全 unchanged ⇒ 空 diff。条目只含新增/删除（完整 path/hash/size）与修改（前后 hash/size），同 hash 条目省略，**不含内容**。省略 `from`（路由层把空串规范化为缺席——HTML 表单空基线项提交 `from=`）= 空集合基线（首个快照约定）。页面默认基线 = revision 更小的最近已绑定 Run 快照，操作者侧顺序由页面默认保证。

**Loop 视图与未配置语义。** 未配置 Loop 不是错误：冻结视图形状的 `artifactDir` 可空，照服 null/零值视图（Dashboard 渲染未配置态）；`artifact_dir_unconfigured` 保持读取失败联合成员，本片无路由返回它（机器侧读取继续返回它）。

**Dashboard。** 四个 SSR 路由（配置表单+当前视图页、Run 快照页、diff 页、CSRF 配置 POST）零客户端 JS：diff 选择是纯 GET 表单，下载是普通链接（query 值服务端百分号编码）。CSRF 原语泛化为 `checkCsrfFormFields`（白名单字段），`checkCsrfForm` 成为其 `allowedFields=[]` 的委托单实现——既有 run 表单的冻结判定逐字不变。配置表单的业务结局镜像 run 表单「一切皆 303」，拒绝经固定 token 映射为固定中文横幅；抛错绝不伪装（500）。无 artifacts 装配时页面不注册、404 不可区分（既有休眠形状对 Dashboard 侧本就是「路由不存在」，片 7 新增激活证据而非翻转守卫）。

**片 7 残余。** 中流截断在 HTTP 层不可检（见下载组合规则）；PGlite 单连接下读路径无行锁需求（只读），下载流式期间不持有 DB 连接；Dashboard 未绑定 Run 的 `artifactSyncError`（free-form 列）不在冻结 run 视图形状内，页面只显示固定「未绑定」文案。

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

- 决策 23 修订（片 3 二轮审查 #89 补修）：roots canonicalize 仅将当前平台 `node:os.constants.errno` 登记的文件系统错误转换为 `JailError`；realpath 与 stat 的无码、未知码及 `ERR_*` 程序异常保留原异常身份，不误报 `outside_jail`。既有首轮修复记录保留为历史，当前异常边界以此修订为准。含 NUL 的 root 是非法配置形状，在 realpath 前以 `JailError` 拒绝，保持 Artifact resolver 的 `outside_jail` 与 workdir jail 的既有错误契约；不将真实非法配置误当程序异常。
- 新增决策 24（片 4）：Daemon 同步客户端的幂等身份规则（payload 决定 requestId、prepare 序列化体冻结）、重试类到客户端动作的映射（`resume` 经同 payload 重新 prepare 重算 `needHashes`；`artifact_session_expired` 与 404 会话丢失原地续期、syncId 不变；`recover_receipt` 零 PUT；畸形 2xx 视为响应丢失可重试）、**已验证字节上传**（片 3 模块加法导出 `readArtifactFileWithBytes`/`readVerifiedArtifactEntry`，PUT 的请求体即刚校验通过的内存字节，结构上消除 verify→upload 窗口）、无变化抑制与失效规则（只有 `unchanged`/`synced` 保留基线；重启只读服务端、首轮可能为等价内容新建一次 revision 的残余）、按 code 取作用域的粘性停止与 `clearStops()`、每 Loop 串行与实例级上传闸 ≤4、退避/预算/超时常数、本地失败上报一次性且三态（`recorded`/`stale`/`unreported`）、`freshSession` 机制。
- 决策 16 更新：片 4 只新增 Daemon 本地同步库模块（可手动驱动、零接线、零依赖、wire 面零变更），休眠边界与片 3 之后逐字相同（AD4 daemon 半 `identity.test.ts` 零修改全绿为证）。
- 决策 24 修订（片 4 首轮三轨审查修复）：**上传许可在释放时直接移交下一个等待者**，消除「减计数—异步唤醒」之间新到者与等待者竞争的窗口（真实 dist 探针曾观测 5 个在途 PUT，上限 4）（[#99](https://github.com/zhuabo001/loop-platform-zhb/issues/99)）；一轮上传改用 `Promise.allSettled` 并让 `settled()` 计入全部在途上传任务（含停在闸前的），某组的内部异常不再脱挂兄弟组、drain 不再在字节仍上网时报完成（[#92](https://github.com/zhuabo001/loop-platform-zhb/issues/92)）；排队中被取消的调用立即结束而不等待前序 PUT（[#93](https://github.com/zhuabo001/loop-platform-zhb/issues/93)）；拒绝的裁决覆盖任意位置——上传各组的拒绝在整轮分类前全部裁决且可停止者优先，错误上报自身被 401/403 拒绝时同样记录停止（[#94](https://github.com/zhuabo001/loop-platform-zhb/issues/94)、[#98](https://github.com/zhuabo001/loop-platform-zhb/issues/98)）；基线读取前移到任何可能失败的本地步骤之前，重启后的本地失败上报不再因猜测的 0 被永久记为 `recorded:false`（[#95](https://github.com/zhuabo001/loop-platform-zhb/issues/95)）；`freshSession` 的新铸只作用于该次调用的首次提议，恢复轮沿用同一身份以支持服务端原地续期（[#97](https://github.com/zhuabo001/loop-platform-zhb/issues/97)）；`artifact_content_mismatch` 的客户端动作例外（计入重扫预算后整轮重扫、预算耗尽才终止）在决策 24 正文写明，消除与决策 13 表的表面矛盾（实现与测试未变，wire 侧重试类仍为 terminal）（[#96](https://github.com/zhuabo001/loop-platform-zhb/issues/96)）。

- 决策 24 补充：跨 Loop 的上传许可等待可取消；取消只移除未取得许可的等待者，移交后的许可仍须释放，已开始的任务须落定。混合上传结果先排空、再记录停止、最后保留原身份传播未知异常，不以 HTTP 拒绝覆盖程序异常。内容拒绝的既有重扫例外、默认 2 次重扫上限和 wire terminal 分类不变；持续拒绝的长期验收锚点补入 Batch 2 计划。
- 新增决策 25（片 5）：Daemon 生产声明 `artifact-sync-v1` 并启动 watcher（单实例装配）；chokidar 4.0.3 与冻结选项（`ignoreInitial`/`followSymlinks:false`/`ignorePermissionErrors:false`/`persistent`，不设 `awaitWriteFinish`）；先订阅再全扫描、250 ms 固定窗口合并、drain 期间忽略新事件；启动/60 秒核对/最终同步全量重哈希与**仅事件路径** `reuseCachedHashes:true` 的分工；五字段换代顺序（中止旧代 → 关旧 watcher → 订阅新根 → 全扫）与移除清理；摘要 apply 时保留（缺席不动、`[]` 清空）；粘性停止的 watcher 处置与「watch 集合实质变化 ⇒ `clearStops()`」；10 秒 drain（不强制提交、无持久 outbox）；根 never-sync 防护（只用目录规则、protocol 加法导出 `isNeverSyncDirectoryPath`、`syncLoop` 内结构性拒绝并映射 `outside_jail`、watcher 准入与 60 秒本地重验）；`reportLocalFailure` 加法上报与扫描级可选 `signal`（默认行为不变）。
- 决策 16 更新：片 5 声明 capability 并启动 watcher；AD4 daemon 半按实际解除范围重写（capability pin 与 poll body pin 故意更新），保留「构造零 fs 副作用」「收到 watch 前不开 watcher」「runtime→wire 只走 poll/report」。
- 决策 23 补充：事件路径的缓存复用与全量重哈希分工在片 5 落地（`ArtifactSyncInput.reuseCachedHashes?`，默认 false）；扫描新增可选 `signal`（默认 `undefined`，既有行为逐字不变），供 drain 与片 6 的最终同步期限协作取消。
- 决策 23 的配置面 follow-up（`artifactDir` 根自身命 never-sync）在片 5 按决策 25 实施（`outside_jail` 映射、watcher 准入与真实临时目录回归）；[#91](https://github.com/zhuabo001/loop-platform-zhb/issues/91) 保持 OPEN，由独立复审按关闭条件核销。

### 2026-10-06

- 决策 25 修订（片 5 首轮三轨审查修复）：**集合核对改为全同步**——原先每次实质变化启动一个异步 reconcile 任务，它在 `await` 关闭旧 watcher 之后无条件写回，因此一次挂起的关闭期间后到的集合会被旧集合覆盖，被覆盖的 watcher 遗留在 `states` 之外（drain 也关不到它），移除的 Loop 也会被复活。现在 `apply` 内同步完成整份集合核对（无 I/O、无 `await`），没有任何挂起点可供旧集合回写；可失败的工作留在准入任务，**每 Loop 的关闭资源被保留**，新代（含移除后重新加入）订阅前等待前一代关闭完成，同一 Loop 任何时刻至多一个活 watcher；移除在 `apply` 内同步生效。旧集合工作被丢弃是结构性的，无需代际检查；某个 Loop 的慢关闭只推迟它自己，不阻塞其他 Loop 与 Poll 心跳。
- 决策 25 修订（同一轮）：**轮次由驱动链跑完**——在途轮结束时若仍有待办事件或核对请求，该轮立即补扫（原先窗口在轮内到期只留一个 dirty 标记，扫描结束后无人再扫，要等到下一次事件或 60 秒核对）；待办按强度取强，核对请求绝不退化为缓存复用。
- 决策 25 修订（同一轮）：**`ready` 前不得扫描**——准入/订阅期间的事件只记录待办，`ready` 后的全量重哈希首扫先执行，待办事件再由驱动链的下一轮处理（原先状态默认为 watching，事件窗口可在订阅建立前发起扫描并使用事件路径缓存）。
- 决策 25 修订（同一轮）：**根消失同样关闭订阅**——`directory_missing` 与 `outside_jail` 一样进入 refused，tick 只做零网络本地重验，根恢复后重新订阅并全量扫描（原先只有 `outside_jail` 关闭 watcher，根消失期间仍持有订阅并持续发起注定失败的同步）。
- 决策 25 补充：机器停止只关闭停止时的集合快照，所有目标在异步关闭前同步 parked 和中止；恢复为新状态对象，旧关闭任务与迟到同步结果不能改动恢复代。事件窗口与可执行请求分开：仅到期窗口可进入驱动链待办，轮末立即补扫只消费已到期事件或核对请求，固定 250 ms 窗口及全量核对优先级不变。驱动链在返回前同步释放在途标记，防止到期窗口在「链已返回、标记尚未释放」的微任务间隙中仅记待办而失去执行者。
- 新增决策 26（片 6）：Run 最终同步编排（30 秒总期限以调用方 signal 组合、`freshSession` 强制新会话铸快照、全量重哈希、到期取消后等待落定再冻结字段、U1 的 10 秒 `timeout` 补报预算）、Report 字段映射表与两字段互斥、runtime 容量槽在最终同步期间保持占用（`pendingReports.set` 后同步释放）与 `runnerActive` 双门、Report 事务内的绑定接线（共享 v0/v1 位置、ambiguous 短路不读 manifest、归属缺失 fail-closed、绑定 UPDATE 与终态/Lease 消费同事务）、绑定守卫丢失并入 `withReportCasRetry` 的单次重跑吸收集（重跑重计划，代际前进降级为 `stale_config_generation`）。
- 决策 19 落地：planner 的 `eligibility` 资格参数替换 `run.phase` 硬门（合法 finalize 与合法 terminal-grace reconcile 均可绑定），正文表述更新为现行契约。
- 决策 16 更新：片 6 消费 Report 的 `artifactSnapshotId`/`artifactSyncError` 字段，AD3 休眠守卫重写为激活语义；片 6 之后休眠仍覆盖读路由与 Dashboard（片 7）。
- 决策 26 修订（片 6 首轮三轨审查修复，[#105](https://github.com/zhuabo001/loop-platform-zhb/issues/105)）：**两字段互斥按原始可选字段的出现性判定**——原先服务端先按存储政策清洗 `artifactSyncError` 再据此判同现，空串／纯空白／纯 NUL 被视为缺席，双字段畸形 Report 反而走 snapshot 校验链并绑定合法 snapshot。现在出现性只看原始 wire 字段（清洗仅决定 error-only 报告记录的文本；清洗后无可用文本时什么都不写），双字段短路保持在任何 manifest 查询之前。
- 决策 26 修订（同一轮，[#106](https://github.com/zhuabo001/loop-platform-zhb/issues/106)）：**期限到期由 watcher 自行记录，不由落定结果推断**——原先只有 `cancelled` 落定进入 timeout 分支，扫描挂起越期后才以 `failed{unreadable}` 落定的 Run 会携带后续结果且缺失 U1 补报。现在正常完成经 done 信号解除 watcher（绝不误判到期），其余任何到期落定冻结 `"timeout"` 并在独立 10 秒预算内补报一次；watcher 解除在所有落定路径（含内部异常）统一执行，不留越期计时器。
- 新增决策 27（片 7）：管理读路由激活（决策 16 的读路由与 Dashboard 休眠解除）与求值序（loop 行=身份发现、归属先行）、下载路由的组合规则（R3：开流 `blob_missing` ⇒ 404 `path_not_found`，仅该路由，通用映射表冻结不动；异常开流归 `storage_error`；五头固定；忽略 Range；中流截断语义）、Run 快照视图判别（V3：绑定行越外消失 ⇒ 404 绝不改写 missing）、结构 diff 按传入计算（V1）与空基线约定、未配置 Loop 照服 null 视图（`artifact_dir_unconfigured` 本片无路由返回）、Dashboard 四路由与 CSRF 字段白名单泛化（`checkCsrfForm` 成为委托单实现）。
- 决策 27 修订（片 7 首轮三轨审查修复，[#109](https://github.com/zhuabo001/loop-platform-zhb/issues/109)）：**释放钩子必须急于流泵注册**——`HEAD`（Hono 以 GET handler 应答后整体丢弃 body，流永不被拉取、signal 永不触发）在组合处即时释放并只回答头部；客户端在首次拉取前取消时，生成器体尚未执行，挂在其内部的钩子永远等不到，故中止钩子必须在返回 `Response` 之前注册于 `c.req.raw.signal`（`close()` 幂等，泵的 finally 折叠为空操作）。
- 决策 27 修订（同一轮，[#110](https://github.com/zhuabo001/loop-platform-zhb/issues/110)）：**Content-Disposition 走 RFC 6266 双形态**——`Headers` 是 ByteString，裸 CJK basename 在组合处抛错（成功开流后 500）。引用回退只带可打印 ASCII（控制字符剥离、`"` `\` 转义、空回退 ⇒ `artifact`）；basename 含非 ASCII 时追加 `filename*=UTF-8''…`（attr-char 之外的 `!'()*` 补百分号编码）。纯 ASCII 路径头部逐字节不变。
- 决策 27 修订（同一轮，[#111](https://github.com/zhuabo001/loop-platform-zhb/issues/111)）：**Dashboard Run 快照页校验父 Loop**——嵌套路由 `/dashboard/loops/:id/artifacts/runs/:runId` 只从归属 Loop 可见；父路径错配与其它 404 同形（决策 13，不泄漏存在性，绝不渲染他 Loop 的文件表）。
- 决策 27 修订（同一轮，[#112](https://github.com/zhuabo001/loop-platform-zhb/issues/112)）：**diff 查询的 `to` 与 `from` 同规格规范化**——路由层把空串 `to=` 归为 undefined（HTML 表单空选项），冻结 schema 拒绝 ⇒ 400，不下游化成 snapshot_not_found；仅路由层改动，protocol 不动。
- 决策 27 修订（同一轮，[#113](https://github.com/zhuabo001/loop-platform-zhb/issues/113)）：**Dashboard 页的裸列表读取在领域判定之后**——`Promise.all` 并行会让列表读取的存储故障覆盖领域 `attribution_missing`（403 被掩成 500）；改为顺序 await：先取视图/diff 判定，通过后才读快照列表（决策 27 求值序在页面组装同样成立）。
- 决策 27 补充（同一轮，P3 建议）：横幅 token 查找为 own-key 检查（`Object.hasOwn`）——普通对象字符串下标会接纳 `__proto__`/`constructor`/`toString` 原型属性，非业务横幅且类型失真。
