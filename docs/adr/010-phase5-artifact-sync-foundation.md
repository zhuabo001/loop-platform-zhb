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

### 8. 配置代际与过期

`artifactConfigRevision` 单调递增：等值更新零写入，有效 set/change/clear 递增代际。修改或移除 `artifactDir` 后保留最后成功的 manifest 指针与 manifest revision，读取时按配置代际计算过期状态；新配置的首次成功提交才替换当前视图。配置变化清除上一代的同步尝试状态，旧代请求不能更新新代状态。

`artifactDir` 的 workdir-相对/绝对路径规则是 Server 单侧 policy：相对路径基于显式 workdir 解析，无 workdir 时必须是绝对路径。该规则不进入共享 policy，Server 不解析机器上的文件系统路径。配置更新允许用于 completed Loop，沿用 `updateTaskFile` 的运维重定向语义。

配置 planner 的求值序固定为 validate → noop → exhaustion。等值合法命令在 int32 上界仍为 noop；非法值即使与存储值相等也拒绝。有效变更遇上界返回 `config_revision_exhausted`，零写入。

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

内部失败字面量细于 wire 码。`config_revision_exhausted`、`manifest_revision_exhausted`、`artifact_dir_unconfigured`、`session_committed` 的 wire 映射留 Batch 2 路由接线时裁决；其中耗尽分类在本批为稳定结果联合、零写入。`loop_not_found`/`session_not_found` 沿用不存在与跨归属统一 404 的规则，避免泄漏存在性。

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

### 15. 可信归属解析器接口契约

服务端内部接口（`packages/server/src/artifact/attribution.ts`），片 1 冻结契约，生产 Team 接线仍留后续认证批次。`resolve(machine: TrustedMachineIdentity): Promise<ArtifactAttribution>`：输入是 store 已从 Bearer 凭证解析出的可信 Machine 身份（永非 wire 输入）；异步（生产 Team 归属需要查库）；缺失归属是预期域结果（联合返回 `{ok:false, failure:"attribution_missing"}`），不抛异常。每次操作重新解析，不从请求缓存。接口的输入/输出、职责与失败语义即决策 7 与本文；TSDoc 与本文不得矛盾，漂移时以本文为准并同步修订。

### 16. Batch 1 休眠边界

本批不挂载任何 Artifact HTTP 路由、不启动 watcher、Daemon 不声明 `artifact-sync-v1`、Report 不消费 `artifactSnapshotId`/`artifactSyncError`、Run claim 条件不变、旧 Loop 默认未配置 Artifact 目录且不开始上传、生产装配不构造 BlobStore。

Daemon 的 poll 出站体仅包含既有五个静态字段与 `availableSlots`，不发送 `watchDigest`；poll/report 请求仅使用 `/api/machine/poll` 与 `/api/machine/report`。Batch 2 watcher 接线时须显式更新该边界。AD1–AD4 休眠守卫覆盖路由、Create/Poll/Report、出站请求及启动装配，长期验收要求以 Batch 1 计划为准。

### 17. 共享 policy 的 ADR-002 窄例外记录

`artifact-policy.ts` 是 ADR-002 决策 4「裁剪策略不进 protocol」的第二个记录在案窄例外（第一个是 terminal-policy.ts）：manifest 条目校验、容量上限、never-sync 规则、canonical 规范化与有界解析必须由 Daemon（扫描本地预分类）与 Server（防御层收口）逐字一致地执行，两份拷贝必然漂移，故单一来源放 protocol 包。模块保持纯函数、无 I/O、无 Node 内建依赖，主入口浏览器可 bundle 性不变。ADR-002 修订记录同步登记。

### 18. 持久化形状与仲裁键

模型使用 `artifact_sync_sessions`、`artifact_manifests`、`artifact_blobs` 三张表，Loop 保存配置、当前 manifest 指针与同步尝试状态，Run 保存快照绑定与同步错误。migration `0005` 前滚，沿用无外键、无新 CHECK、ISO text 时间戳和 jsonb 规范化 manifest/回执的仓库纪律；revision 非负、单调和上界由写路径保证。

唯一键作为仲裁依据：session `(namespaceId, machineId, requestId)`、manifest `(loopId, manifestRevision)`、Blob 复合主键 `(namespaceId, hash)`。

### 19. Run 快照绑定与配置互斥

绑定仅适用于 `run.phase === "running"`；canceled/superseded 不绑定，reclaimed（terminal-grace 唤醒报告）路径在本层保守排除。Batch 2 将 binding plan 接入 Report 事务的 reconcile 分支时，须显式裁决 reclaimed 是否放行。

绑定必须确认已提交 manifest 的 `id === snapshotId`，namespace 匹配可信归属，manifest / Run / Loop / 可信归属四方 machineId 相等，manifest / Run / Loop 的 Loop ID 一致，manifest 配置代际等于当前 Loop 代际。写入已验证的 `manifest.id`。内部拒绝分类为 `snapshot_not_committed` / `cross_namespace` / `cross_machine` / `cross_loop` / `stale_config_generation`；Batch 2 拥有最终接线分类法。

bind 计划携带解析时的 `guardConfigRevision`。落库的 Run UPDATE 守卫 Run `(id, phase)`，并在同一语句的代际子查询中以 `FOR UPDATE` 锁定 Loop 行、复验当前代际。锁持续到该语句或外层 Report 事务提交，与配置 UPDATE 互斥：配置先提交时绑定看到新代际并守卫失败；绑定先取得锁时配置等待绑定提交。普通无锁子查询的语句快照不足以保证此互斥。

守卫零行抛 `ArtifactBindingGuardLostError`，调用方须重解析、重计划；代际前进后转为 `stale_config_generation`。`record_error` 仍守卫 Run `(id, phase)`，但不锁 Loop、不加代际守卫：`cross_*` 与 `snapshot_not_committed` 不受配置代际影响，`stale_config_generation` 在代际单调递增下仍成立。

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
