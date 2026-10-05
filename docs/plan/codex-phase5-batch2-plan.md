# Phase 5 Batch 2 开发计划：持续同步、Run 快照与文件视图

- 状态：待实施
- 调查基线：`a0bc7c8`（分支 `feat/phase5-batch2-dev`，Batch 1 已通过 PR #68 合入）
- 上位计划：[codex-phase5-dev-roadmap.md](codex-phase5-dev-roadmap.md)
- 前置决策：[ADR-010](../adr/010-phase5-artifact-sync-foundation.md)
- 预计排期：7–11 个开发日，拆成 8 个可独立验收的 slice
- Batch 执行索引：[phase5-batch2-slices.md](../handoff/phase5-batch2-slices.md)（本地 handoff，不入库）

## 1. 目标与固定规则

开放 Artifact 生产接线，实现 idle 编辑持续同步、Run 最终快照、文件下载和结构 diff。继续使用 PGlite、本地 BlobStore、Hono SSR。GitHub 登录、Connect、Team 权限隔离、#56、#61、历史 GC 和真实 Postgres 多连接并发验收仍由路线图指定的后续批次处理。

### 归属、配置与兼容

- Batch 2 使用 **Machine namespace**。可信归属解析器重新查询已验证 Machine，并生成稳定且符合 BlobStore 键规则的 namespace。无归属时拒绝操作；请求不得指定 namespace；不使用默认全局 namespace。
- Batch 3 离线认领须复制并验证 Blob，再事务切换 Artifact 归属元数据；保留 snapshot ID、manifest entries、revision、Run 引用及已提交 session receipt。源 Blob 保留至后续 GC。本批冻结迁移契约，不实现 Team 迁移。
- Artifact 管理读取按 Loop → Machine 解析 namespace。这仍属于当前 localhost／受信网络管理面，不代表用户认证或跨 Team 授权已经完成。
- 新增 sync API 只认证已有 Machine Credential，不注册 Machine。Poll 的既有自注册行为留给 Batch 3 与管理面认证一同关闭。
- Create 接受并持久化可选 `artifactDir`，配置与 Loop 创建原子完成。PATCH 复用 Batch 1 配置 planner/CAS，保持 no-op、配置代际递增和旧视图过期语义。
- Poll watch 集合包含所有已配置 Loop，包括 Paused 和 Completed Loop。仅已配置 Artifact 的 Loop 额外要求 `artifact-sync-v1`；领取事务按权威 Loop 配置复验，缺 capability 的候选被跳过，不阻塞同 Machine 的其他候选。
- Delivery 携带可选 Artifact 配置及 `configRevision`，值来自成功 claim 的权威 Loop 行。最终同步固定使用该代际，不改绑 Run 期间新设置的目录。
- 所有新增 wire object 遵循 tolerant-reader；管理面使用显式字段投影，不返回 namespace、凭据、内部会话字段或 Blob 磁盘路径。

### HTTP 接口

| 接口 | 行为 |
|---|---|
| `PATCH /api/loops/:id/artifact-dir` | 设置、修改或清除 Artifact 目录 |
| `GET /api/machine/loops/:id/artifacts` | Machine 范围读取配置及当前 manifest revision，供启动、重启与冲突恢复 |
| `POST /api/machine/sync` | 以完整 manifest 协商缺失内容 |
| `PUT /api/machine/blob/:hash` | 使用 `X-Artifact-Sync-Id` 上传协商内容 |
| `POST /api/machine/sync/:id/commit` | 原子提交 manifest 并返回固定回执 |
| `POST /api/machine/loops/:id/artifact-sync-error` | 上报扫描、Watcher 等客户端失败 |
| `GET /api/loops/:id/artifacts` | 读取当前文件集合与同步状态 |
| `GET /api/runs/:id/artifacts` | 读取 Run 已绑定快照；无快照时明确返回缺失状态 |
| `GET /api/loops/:id/artifacts/download` | 按 snapshot ID 和 manifest path 下载文件 |
| `GET /api/loops/:id/artifacts/diff` | 返回同 Loop 两个 snapshot 的结构差异；省略 from 时与空集合比较 |

Batch 1 错误映射在 HTTP 接线时补齐：revision 耗尽使用新增 `artifact_revision_exhausted`（409，terminal）；未配置目录映射为 `artifact_config_conflict`（409，重新读取配置）；已提交 session 的 PUT 使用新增 `artifact_session_committed`（409，客户端恢复同 session 的 commit 回执）。客户端失败分类固定为 `directory_missing`、`unreadable`、`outside_jail`、`symlink`、`special_file`、`unstable`、`too_large`、`watcher_error`、`timeout`。错误上报携带配置代际和 base manifest revision，仅在二者仍匹配时更新状态，避免迟到错误覆盖新成功。

### 扫描、重试与最终 Report

- 遍历前排除共享 never-sync 规则。合法空目录可以提交空 manifest；**根自身**是 symlink 时按 `realpath` 落点做 jail 判定（落点在有效 roots 内即通过），**树内**出现 symlink 或特殊文件时整次扫描失败，不读取其目标或内容。扫描失败、目录缺失、文件不稳定或超限均不得提交截断 manifest。
- Artifact jail 复用 Daemon roots ∩ Server roots 计算规则，不创建 Run scratch。相对路径以显式 workdir 解析；无 workdir 时只接受绝对路径。
- 文件读取使用无跟随且非阻塞的打开（终端组件在检查后被换成 FIFO 也不能挂起 open，仍由同 fd 的 `fstat` 拒绝非普通文件）、同 fd 校验及读取前后路径／身份复验。保证范围与现有 Task File 一致；不宣称能在跨平台 Node 路径 API 下防御同 UID 恶意进程并发替换中间目录。
- 启动、每 60 秒及 Run 最终同步执行完整核对并一律重哈希；事件路径**仅**当缓存条目与当前文件的 `dev/ino/size/mtimeMs/ctimeMs` 五元组全等时才可复用其 hash，否则重算——绝不 size-only。读取后的复检把「路径移动」（`ENOENT`/`ENOTDIR`/`ELOOP`）与「内核拒绝」（`EACCES`/`EPERM` 及其余）分开：前者有界重扫，后者立即按确定性 `unreadable` 返回。
- 每 Loop 同步串行，Daemon 全局 Blob 上传并发最多 4。上传前重新读取并验证 hash/size；内容变化时重新扫描，不提交旧清单。
- 瞬态错误按 1、2、4、8……最多 60 秒退避；响应丢失使用原 requestId/session 恢复。配置或 base 冲突以新 requestId 重新协商。401 停止该 Machine 同步，403 停止对应作用域；均不能丢弃合法 Run Report。
- Agent 退出后强制扫描及同步。30 秒总期限包含每 Loop 排队、扫描、上传和重试；到期取消最终同步，冻结稳定错误后提交原 Run 结果。
- 每次最终同步使用新的 session；即使内容相同也生成该 Run 的明确 snapshot。Report 只序列化一次，所有重试复用相同字节。
- 合法 finalize 和合法 terminal-grace reconcile 可以绑定 Report 明确携带且通过校验的 snapshot。取消、superseded、没有合法最终 Report 的 reclaimed Run 不绑定。
- Run phase、合法业务终态、snapshot/error 绑定及 Lease 消费位于同一事务。Artifact 绑定失败只记录 Artifact 错误，不改变合法 Run 结果。Report 同时携带 snapshot 和 sync error 时记录 `ambiguous_artifact_report`、不绑定 snapshot，仍提交合法业务终态。

## 2. 开发切片

### Slice 1 — 契约、归属与生产边界（0.5–1 天）

- **前置：**Batch 1 已合入。
- **交付及范围：**Protocol 增量（冻结全部 10 个端点的 wire 形状，含读取端视图 DTO）、Machine attribution resolver、ArtifactHome 生产门面实现（真装配工厂 + 测试，不接 `start.ts`／路由）、ADR-010 修订。
- **步骤：**冻结 API、错误码及重试、Delivery Artifact 配置、客户端错误上报、reconcile 绑定资格；Blob 根目录定为 `<dataDir>/blobs`。
- **验收：**新增 schema 纳入 tolerant-reader 清单；可信 Machine 映射稳定；缺少归属拒绝（prepare／PUT／commit／上报／读取全域，含读取失败域声明）；wire 无 namespace 字段；错误映射和重试矩阵均有测试。
- **停止边界：**不挂生产路由、不启动 Watcher，不提前创建 Team，不改 Poll 注册行为。

### Slice 2 — Server 配置、同步 HTTP 与 Poll 接线（1–1.5 天）

- **前置：**Slice 1。
- **交付及范围：**生产 ArtifactHome/BlobStore 装配、配置／同步／状态恢复接口、Create/Poll/claim/Delivery 接线。
- **步骤：**prepare 请求同时使用传输层 8 MiB body limit 与原始文本有界解析；PUT 流式交给 BlobStore；为 sync 提供只验证既有 Machine 的认证读路径；busy Poll 也处理 watchDigest；claim 使用权威配置与 CAS 复验 capability。
- **验收：**真实 HTTP 完成 prepare → PUT → commit；重复请求恢复固定回执；跨 Machine 请求失败零写；未配置 Loop 保持可领取；digest 一致时省略 watch，漂移返回全量 watch，清空返回 `[]`。
- **停止边界：**不消费 Report Artifact 字段、不启动 Daemon Watcher、不增加文件页面。

### Slice 3 — Artifact 安全扫描器（1–1.5 天）

- **前置：**Slice 1。
- **交付及范围：**Daemon 路径解析、完整扫描、hash 缓存和上传前验证。
- **步骤：**复用 jail roots 交集（根自身是 symlink 时按 `realpath` 落点判定；**树内** symlink 不复用 Task File 的跟随行为，一律使整次扫描失败）；遍历前过滤 never-sync；对普通文件非阻塞无跟随有界读取并校验共享 policy；扫描期间文件增删或身份变化时丢弃结果并重新扫描。
- **验收：**AJ1–AJ10 覆盖路径、roots、symlink、特殊文件、缺失目录、空目录、读取失败、文件不稳定、never-sync 和容量上限；失败扫描永远不能产出可提交的部分 manifest。
- **停止边界：**只返回扫描结果，不监听事件、不访问 Server。

### Slice 4 — 同步客户端与恢复状态机（1–1.5 天）

- **前置：**Slice 2、3。
- **交付及范围：**Daemon Artifact HTTP client、每 Loop 串行队列、全局上传并发限制。
- **步骤：**启动时读取服务端 manifest revision；实现按需上传、幂等恢复、冲突重新协商、稳定错误上报和取消；上传前复验内容；无变化的后台核对应不新建 manifest，错误恢复时允许提交新状态。
- **验收：**只上传 `needHashes`；prepare/PUT/commit 响应丢失均收敛；进程重启可重建基线；上传并发不超过 4；变化内容不能进入旧 session；401/403 按作用域停止，瞬态故障可恢复。
- **停止边界：**提供可手动驱动的同步，不监听目录、不接 Run 最终 Report。

### Slice 5 — WatchManager 与 Daemon 生命周期（1–1.5 天）

- **前置：**Slice 4。
- **交付及范围：**chokidar adapter、WatchManager、Poll client 和 runtime 集成。
- **步骤：**保留并应用 Poll response 的 watch/watchDigest；先订阅事件再全扫描，扫描期间事件令 Loop 标脏并重扫；事件合并 250 ms；每 60 秒完整核对；配置变化先取消旧代任务并关旧 Watcher，再启动新代。
- **验收：**AW1–AW14 覆盖创建／修改／删除／重命名、idle 编辑、同大小快速改写、原子保存、分块写入、事件合并／遗漏、扫描订阅交错、缓存失效、Paused/Completed Loop；Watch 更新不依赖 Run，Poll 心跳不被扫描／上传阻塞；jail 失效关闭 Watcher并周期重验。
- **停止边界：**退出时停止新事件与计时器、取消并等待在途任务释放资源，最多 10 秒；不强行提交最后清单，不增加持久 Report outbox。
- **依赖选择：**锁定 chokidar 4.0.3，支持当前 Node 22.17.0；不采用要求 Node ≥22.22 的 v6。设置 `followSymlinks:false`、`ignorePermissionErrors:false`，文件稳定性由扫描器判定。[4.0.3 引擎要求](https://raw.githubusercontent.com/paulmillr/chokidar/4.0.3/package.json)、[v6 引擎要求](https://raw.githubusercontent.com/paulmillr/chokidar/main/package.json)。

### Slice 6 — Run 最终同步与 Report 原子绑定（1–1.5 天）

- **前置：**Slice 4、5。
- **交付及范围：**最终同步协调、固定 Report 请求、Server finalize/reconcile 事务接线。
- **步骤：**Runner 返回后、Report 序列化前执行最终同步；超时和异常转成稳定 Artifact 错误；binding planner 显式接受事务已确认的 finalize/reconcile 资格；在 Run phase 写入前生成绑定计划，并在 Report 事务内执行。
- **验收：**AR1–AR12 覆盖快照冻结、固定请求重试、30 秒总期限、同步失败不丢 Report、非法引用、取消／supersede、无 Report reclaimed、合法迟到 reconcile、配置竞争、Finish/Report 交错和事务回滚；绑定拒绝不能阻止合法 Run 终态。
- **停止边界：**后续 idle 同步只能更新当前文件视图，不能改写既有 Run 快照或伪造缺失快照；不自动关闭 #72。

### Slice 7 — 文件读取、下载、快照与 SSR 页面（0.5–1 天）

- **前置：**Slice 2、6。
- **交付及范围：**Artifact 读取门面、文件 API 和 Dashboard 页面。
- **步骤：**添加带 CSRF 的目录配置表单；显示配置路径、同步状态、过期标记、文件数／大小；提供当前视图和 Run 快照；下载仅按 snapshot ID + manifest path 查表，绝不从 URL 路径拼磁盘路径。
- **验收：**AV1–AV8 覆盖权限、跨资源拒绝、HTML/XSS 安全、attachment 和响应头、二进制下载、结构 diff、缺失／过期状态及响应中断时的句柄释放。下载使用 `application/octet-stream`、`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`。
- **停止边界：**diff 只返回新增、修改、删除和前后 hash/size，限同 Loop 两个快照；页面允许显式选择基线，默认选择 revision 较小的最近已绑定 Run snapshot，首个 snapshot 与空集合比较。不提供内容预览或文本 diff。

### Slice 8 — 故障集成验收与批次收口（1–1.5 天）

- **前置：**Slice 1–7。
- **交付及范围：**文件型 PGlite、本地 BlobStore、真实 HTTP、生产 Daemon runtime、Fake Runner 和真实临时目录集成验收。
- **步骤：**覆盖 idle 编辑、两次 Run、删除、配置变化、断网、响应丢失和进程重启；以生产启用及旧 Loop 不上传守卫替换 Batch 1 休眠守卫，同时保留基础回归。
- **验收：**全部 AW/AJ/AS/AR/AV 编组与质量门通过；后续编辑及重启后旧 snapshot 和下载字节不变；不存在部分 manifest、旧代际提交或泄漏句柄。
- **停止边界：**补验收记录、ADR-010/ADR-002、领域词汇和 roadmap；新增需执行事项遵循 Issue Tracker 及复审流程。handoff 不提交；不运行付费 Claude/OAuth，不声明 Phase 5 完成。

执行依赖：Slice 1 → Slice 2、3 → Slice 4 → Slice 5 → Slice 6 → Slice 7 → Slice 8。Slice 2 与 Slice 3 没有实现依赖，可交换顺序。

## 3. 测试编组、质量门与完成定义

沿用 roadmap 的测试编号；每个编号保留可独立定位的场景。

| 编组 | 验收场景 |
|---|---|
| **AT1–AT10** | 契约与归属（片 1）：协议增量与 tolerant-reader 登记、11 码与 5 重试类矩阵、客户端失败分类法、Delivery Artifact 配置、wire 无 namespace、可信 Machine 归属映射、错误映射矩阵、生产门面 |
| **AH1–AH12** | 配置与同步接线（片 2）：PUT 响应冻结、配置 API、Create 原子持久化、既有 Machine 认证读路径、真实 HTTP prepare→PUT→commit 与幂等恢复、8 MiB 双闸、失败面、machine 读取、错误上报、watch 下发与 claim capability 门控、taxonomy |
| **AW1–AW7** | 文件创建、修改、删除、文件重命名、目录重命名、idle 编辑、同大小快速改写 |
| **AW8–AW14** | 原子替换、分块写入、事件合并、遗漏事件补偿、订阅与初扫交错、缓存失效、Paused/Completed 持续同步 |
| **AJ1–AJ5** | workdir 相对路径、无 workdir 的绝对路径、roots 交集及越界、目录 symlink、文件 symlink |
| **AJ6–AJ10** | 特殊文件、目录缺失、合法空目录、读取失败／不稳定扫描、never-sync 和容量边界 |
| **AS1–AS6** | 断网、prepare 响应丢失、PUT 响应丢失、commit 响应丢失、Server 重启、Daemon 重启 |
| **AS7–AS12** | 配置换代、配置移除、roots/jail 变化、401/403、退避和并发上限、关闭 drain |
| **AR1–AR6** | 最终快照、固定 Report 重试、快照不随后续编辑改变、30 秒期限、同步失败不丢报告、非法 snapshot 引用 |
| **AR7–AR12** | 取消／supersede、无 Report 的 reclaimed Run、合法迟到 reconcile、配置与绑定竞争、Finish/Report 原子回滚、旧协议兼容 |
| **AV1–AV8** | 读取接线、跨资源拒绝、HTML/XSS 转义、attachment/响应头、二进制下载、结构 diff、缺失／过期状态、句柄与中断清理 |

片 1 的 AT 编号逐项对应（场景不依赖 handoff 记录）：

| ID | 场景 | 主要证据 |
|---|---|---|
| AT1 | 11 码逐字序；5 重试类逐字；码→重试类穷尽映射 | `protocol/src/artifact.test.ts` |
| AT2 | 客户端失败分类法 9 值；与 wire 码不相交；落库域为有序去重并集 | `protocol/src/artifact.test.ts` |
| AT3 | 读取端视图形状黄金（loop 视图含 stale／未配置、run bound/missing 判别、download/diff 查询、diff 条目只含前后 hash/size） | `protocol/src/artifact-view.test.ts` |
| AT4 | Delivery 携带／省略 `artifact`；错误上报 DTO 往返与 unknown failure 拒绝；响应 `ok+recorded` | `protocol/src/artifact.test.ts`、`poll.test.ts` |
| AT5 | 冻结 Phase 4 reader 剥离 `loop.artifact`；当前 reader 接受旧 delivery 黄金 | `protocol/src/phase5-compat.test.ts` |
| AT6 | 新增 schema 登记 tolerant-reader（CASES 41 → 54） | `protocol/src/tolerant-reader.test.ts` |
| AT7 | wire 无 namespace：schema 声明键遍历 + 注入 `namespaceId` 断言被剥离 | `protocol/src/artifact-view.test.ts` |
| AT8 | 可信 Machine 归属稳定映射；未知／非法键 → `attribution_missing`；resolve 零写入 | `server/src/artifact/attribution-machine.test.ts` |
| AT9 | 20 字面量 HTTP 映射矩阵；逐操作失败域逐字固定（含读取域的 403 归属拒绝）；taxonomy 可达性 | `server/src/artifact/error-mapping.test.ts` |
| AT10 | 生产门面：构造零 fs 副作用、真实落盘 `<dataDir>/blobs/<machineId>/<hash>`、ID 工厂、已配置 Loop 跑通 prepare | `server/src/artifact/production.test.ts` |

片 2 的 AH 编号逐项对应（场景不依赖 handoff 记录）：

| ID | 场景 | 主要证据 |
|---|---|---|
| AH1 | PUT 响应 DTO 冻结：`{ok, size, published}` 往返、未知键剥离、半形拒绝、tolerant-reader 登记（CASES 54 → 55） | `protocol/src/artifact.test.ts`、`tolerant-reader.test.ts` |
| AH2 | PATCH artifact-dir：set/change/clear 代际递增、no-op 零写入、响应携带 `artifactDir`、DTO 400、相对路径无 workdir 400 `artifact_validation_failed`、未知 Loop 404 无码、int32 上界 409 `artifact_revision_exhausted` | `server/src/http/artifact-routes.test.ts` |
| AH3 | Create 原子持久化：合法 `artifactDir` 与 Loop 同 INSERT 落库（`artifactConfigRevision=1`）、相对无 workdir coded 400 零行、省略 = null+0、显式 null 仍 400 | `server/src/http/app.test.ts`（AD2(a) 重写） |
| AH4 | 既有 Machine 认证读路径：未注册/哈希不符/形状不符 token 401 且零注册；跨 Machine 的 loop/session 请求失败且六表 item-equal；被拒 PUT 零拉流；已识别可恢复存储故障（SQLSTATE 08/53/57/58）在凭据、归属、Loop 任一路径均归 `storage_error`（HTTP 500 `artifact_storage_error`），未识别异常保持原样抛出 | `server/src/http/artifact-routes.test.ts`、`artifact/api.test.ts` |
| AH5 | 真实 HTTP E2E（真实监听 + 文件型 PGlite + `<tmp>/blobs`，经生产装配）：prepare → 多块流式 PUT → commit；回执、Loop 指针/代际、manifest 行与落盘字节一致 | `server/src/phase5-batch2-slice2-e2e.test.ts` |
| AH6 | 幂等恢复：重复 prepare 同 syncId 且 `needHashes:[]`；重复 PUT `published:false`；重复 commit 返回同一固定回执、manifest 行数不变 | 同上、`artifact/api.test.ts` |
| AH7 | prepare 双闸：运输层 413（content-length 与 chunked 两路径）、原始文本上限 413（含无效 UTF-8 解码膨胀）、边界内通过、畸形 JSON 400 无码、DTO 拒绝 400 `artifact_validation_failed`（零领域调用、零状态写入） | `server/src/http/artifact-routes.test.ts` |
| AH8 | PUT/commit 失败面：缺同步会话头 400、内容不符 400 `artifact_content_mismatch`、已提交 409 `artifact_session_committed`、过期 409、base 漂移 409 `artifact_manifest_conflict`、未协商 hash 409 | 同上 |
| AH9 | machine 读取：已配置四字段；未配置 409 `artifact_config_conflict`；未知/跨机 404；无凭据 401；wire 无 namespace | 同上 |
| AH10 | 错误上报：双匹配 `recorded:true`（attemptedAt/error/revision+1，succeededAt 不动）；代际/base 漂移、未配置 Loop、守卫零行均 `recorded:false` 零写；成功后的迟到错误不覆盖；跨机/未知 404 零写；可恢复存储故障 500 `artifact_storage_error` | `server/src/artifact/sync-error.test.ts`、路由套件 |
| AH11 | watch：capable 且无 digest ⇒ 全集 + digest；digest 一致 ⇒ 两键缺席；新增/变更/清空配置 ⇒ 全量；清空 ⇒ `watch:[]`；busy Poll 同样携带；Paused/Completed 在集合内；非 capable 完全不发且不查询 | `server/src/artifact/watch.test.ts`、`coordinator/poll.test.ts`（AD2(b) 重写） |
| AH12 | claim 门控与 Delivery：已配置 + 非 capable ⇒ 候选跳过（无 lease、run 仍 pending、零写）且不阻塞其他候选；未配置 Loop 照常领取；capable ⇒ 领取且 Delivery 携带 `{dir, configRevision}`；扫描后配置竞态在 claim 侧被拒 | `coordinator/poll.test.ts`、`coordinator/claim.test.ts`、`gateway/delivery.test.ts` |

片 3 的 AJ 编号逐项对应（场景不依赖 handoff 记录）：

| ID | 场景 | 主要证据 |
|---|---|---|
| AJ1 | workdir 相对路径：显式 workdir 下 `resolve`；`..` 逃出交集、越界 ⇒ `outside_jail`；不存在 ⇒ `directory_missing`；**不**落到 `process.cwd()` | `daemon/src/artifact-jail.test.ts` |
| AJ2 | 无 workdir：绝对路径通过；相对路径 ⇒ `outside_jail`（不隐性取进程 cwd）；绝对越界 ⇒ `outside_jail` | 同上 |
| AJ3 | roots 交集：窄者存活、被父覆盖的子根丢弃、`effectiveRoots` 可观察；`serverRoots=[]` ≡ 全部 daemon roots；不相交或非法 server root ⇒ `outside_jail`；`/foo` vs `/foobar` 非包含 | 同上 |
| AJ4 | 目录 symlink：树内（指向内/外/悬空）⇒ `symlink`，目标内容永不进 entries 且不对其枚举；根自身是 symlink ⇒ 落点在内 `ok`（root = realpath）、越界 `outside_jail`；resolve 后被换成 symlink 的根 ⇒ `symlink` | `daemon/src/artifact-jail.test.ts`（根解析半）、`daemon/src/artifact-scan.test.ts`（树内半） |
| AJ5 | 文件 symlink：指向内/外/悬空 ⇒ `symlink`；`open` 计数为 0（不读目标） | 同上 |
| AJ6 | 特殊文件：FIFO／socket 等非普通文件 ⇒ `special_file`、`open` 计数 0（绝不阻塞在 `O_RDONLY`） | 同上 |
| AJ7 | 目录缺失：不存在、指向普通文件、resolve 后扫描前被删 ⇒ `directory_missing`，绝不当空 manifest | 同上 |
| AJ8 | 合法空目录：纯空树／嵌套空目录 ⇒ `ok` + `entries=[]`；输出排序为 UTF-16 code unit 序（钉 `a.txt < a/b`） | 同上 |
| AJ9 | 读取失败／不稳定：`EACCES` ⇒ `unreadable`；首轮脏次轮净 ⇒ `ok`（attempt=2）；持续脏 ⇒ `unstable`（attempt≤3）；读后身份/尺寸漂移与目录终检捕获增删；失败结果**结构上无 entries 字段** | 同上 |
| AJ10 | never-sync 与容量：`.git`/`node_modules`/`.config/gcloud` 不下降、`.env`/`id_rsa*`/`*.pem` 及大小写变体不读（枚举/`open` 日志为证），纯 never-sync 树 ⇒ `ok []`；单文件超 10 MiB 由 `lstat` 早检拒绝；条目数／聚合字节／已访问 dirent 超限 ⇒ `too_large` 且早停；>1024 UTF-8 字节路径 ⇒ `too_large`；反斜杠与盘符路径 ⇒ `unreadable` | 同上 |

编号外证据：hash 缓存的五元组逐字段失效、FIFO 驱逐与 `clear()`（`daemon/src/artifact-hash-cache.test.ts`）；上传前验证的包含守卫、失败分类、一律重读重算与成功写回缓存（`daemon/src/artifact-verify.test.ts`）。

片 3 首轮三轨审查修复后的回归（编号外；裁决见 ADR-010 决策 23 的 2026-10-05 修订）：

- [#87](https://github.com/zhuabo001/loop-platform-zhb/issues/87)：真实 FIFO 在 `lstat` 与 `open` 之间替换 ⇒ 共享有界读取、扫描与上传前验证都必须**及时**返回（带截止期断言，卡住即失败）`special_file`，且被拒绝的句柄已关闭（`daemon/src/bounded-read.test.ts`、`artifact-scan.test.ts`、`artifact-verify.test.ts`）。
- [#88](https://github.com/zhuabo001/loop-platform-zhb/issues/88)：读后 `lstat` 与目录终检的 `EACCES`/`EPERM` ⇒ 确定性 `unreadable`（单次尝试、单次打开；上传前验证同为 `unreadable`），不再三次重扫后报 `unstable`；`ENOENT` 与身份变化仍走有界重扫（`daemon/src/artifact-scan.test.ts`）。
- [#89](https://github.com/zhuabo001/loop-platform-zhb/issues/89)：server root 在 realpath 成功后 stat 失败（`ENOENT`/`EACCES`/`EPERM`）与非目录 ⇒ 根解析返回封闭结果 `outside_jail`，不抛原异常（`daemon/src/artifact-jail.test.ts`）。

额外覆盖配置 no-op、Create 原子性、busy Poll 的 watch 更新、capability 与 claim 交错、错误 taxonomy、8 MiB 请求边界和迟到错误不得覆盖新状态。

质量门：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check
```

完成定义：配置目录后能够持续单向同步，只传缺失内容，删除语义与重启恢复正确；Run 最终 snapshot 固定；同步失败不阻断合法终态；文件下载与结构 diff 可用；未配置 Artifact 的旧 Loop 保持原执行行为。

本批默认不新增数据库 migration，优先使用 Batch 1 已有列。#11/#72 的真实 Postgres 多物理连接验证继续留在 Phase 6；历史 snapshot、过期 session 和孤立 Blob 的累计存储治理继续由后续 GC 处理。
