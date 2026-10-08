# Phase 5 验收测试记录

> 本文档按批次记录 Phase 5 的内部验收证据，各批次一节。各批次的交付范围与完成定义见其权威计划
> （Batch 1：`docs/plan/codex-phase5-batch1-plan.md`；Batch 2：`docs/plan/codex-phase5-batch2-plan.md`）。
> **Phase 5 未收口**：Batch 3（认证）未启动。

## 测试环境

- **日期**: 2026-10-03
- **平台**: macOS (Darwin 25.6.0)
- **Node.js**: v22.17.0
- **pnpm**: 10.6.1
- **分支**: `feat/phase5-batch1-dev`（批次 PR #68，draft）
- **批次基线**: `7681058`；**验收提交**: `ec0e519`（片 6 内部集成验收测试）
- **片 1–5 提交链**（详见当批执行索引，不入库）：片 1 `cdc70a9`→`0ef49f0`；片 2 `1ad8d94`→`4643a4f`（复审修复至 `7700d2b`）；片 3 `0e65eaa`→`95b4548`（复审修复至 `aa8cbfc`）；片 4 `f1e8780`→`831d7fc`（复审修复至 `f88ef18`）；片 5 `4eac19b`→`3f87ac5`（复审修复至 `85e526e`）
- **长期决策**: `docs/adr/010-phase5-artifact-sync-foundation.md`（19 条决策）；ADR-002 修订记录 2026-09-28 条目
- **执行索引**: `docs/handoff/phase5-batch1-slices.md`（当批物流，按约定不入库）

## 验收范围（Batch 1 目标复述）

- 协议与共享 policy 契约冻结：Artifact DTO、`artifact-sync-v1` capability、tolerant-reader 增量、canonical 顺序无关指纹、9 码错误/重试分类、8 MiB 有界解析（ADR-010 决策 1–7、13）。
- 数据模型与迁移：`0005` 前滚、Phase 4 `0000–0004` 冻结 fixture、唯一键与 revision 规则、配置事务与快照绑定计划（决策 8、18、19）。
- BlobStore：内存/本地双 adapter 共享契约；独占临时文件、流式验证、fsync 后 `link(2)` 原子发布、symlink/特殊文件拒绝（决策 14）。
- ArtifactHome 状态机：配置更新、prepare/PUT/commit、Loop CAS、唯一键仲裁、原子提交与有界重试、requestId 幂等、1 小时 pending 过期、固定回执、当前视图/快照读取（决策 9–12）。
- 并发、交错与故障注入验收：PGlite 真实事务 + 可控交错 hook + 故障注入（AC4–AC6、AC9；AB5、AB7）。
- 生产休眠：AD1–AD4（决策 16）——Artifact 路由未挂载、Create/Poll 行为不变、Report 忽略新字段、启动不构造 BlobStore、Daemon 不发同步请求。
- 固定边界：本批不挂 Artifact HTTP 路由、不接生产 Report、无 watcher、无用户认证/Team；不跑真实 Claude/OAuth。

## 测试编组与结果

> 编组编号沿用权威计划 §4（不新增/减少）。文件后括号为该文件测试数（`ec0e519` 的
> 五门与分文件 verbose 运行实测）；总计数见「完整质量门」。

| 编组 | 文件（测试数） | 覆盖 |
|---|---|---|
| AP1–AP11 | `packages/protocol/src/artifact-policy.test.ts`（42）、`node.test.ts`（5） | 路径合法与穿越矩阵、重复路径与文件/目录冲突、NUL/非法 Unicode/UTF-8 长度边界、hash 形状与同 hash 异 size、单文件 10 MiB、按路径累计上限、5000 条上限、8 MiB 原始请求边界与未知字段、never-sync 两组、整单拒绝+规范化+顺序无关指纹；指纹黄金向量（`node.ts` 子入口） |
| AP12 + DTO 形状 | `phase5-compat.test.ts`（6）、`tolerant-reader.test.ts`（42）、`artifact.test.ts`（17） | 冻结 Phase 4 reader 自包含副本双向兼容；7 个新 object schema 登记进 tolerant-reader 清单；Artifact DTO 形状与 9 码错误/重试分类表 |
| AM1–AM3 | `packages/server/src/db/phase5-migration.test.ts`（4）、`phase5-schema.test.ts`（7） | Phase 4 `0000–0004` 冻结 fixture 旧库无损升级（AM1）；旧 Loop 默认关闭、旧 Run/Lease 行为不变（AM2）；新模型往返与安全默认（AM3） |
| AM4–AM5 | 同上 | 唯一键、revision 与关联约束（AM4）；关闭/重开、重复 migration、会话恢复（AM5） |
| **AM6（并账）** | **CAS 半边**：`artifact/config.test.ts`（15）；**session 代际半边**：`sync-prepare.test.ts`（21）、`sync-put.test.ts`（18）、`sync-commit.test.ts`（44）、`sync-concurrency.test.ts`（10） | 配置 set/change/clear/no-op、旧视图过期与 CAS 竞态；旧代请求在 prepare/PUT/commit/失败打账四腿全部失效。**片 2 只取 CAS 层证据、session 代际半边归片 4 的欠债在本收口并账核销** |
| AB1–AB5 | `sync-put.test.ts`（18）、`blob-store-local.test.ts`（28）/`blob-store-memory.test.ts`（17）共享套件、`sync-concurrency.test.ts`（10） | hash 不符、声明/实际 size 不符与流超限、中断与临时文件清理、重复 PUT 正确/错误内容、同 namespace 并发同 hash（PUT 级双 session 交错恰一真一假）；套件本体双 adapter 同跑 |
| AB6–AB10 | `sync-put.test.ts`、`blob-store-local.test.ts`、`blob-store-memory.test.ts`、`contracts.test.ts`（5）、`sync-prepare.test.ts`（21） | 未协商 hash 与跨 Machine/namespace/session 拒绝；发布与数据库故障（AB7 双腿）；元数据在文件缺；空文件/二进制/重启读取；安全存储键、symlink/特殊文件拒绝、双 adapter 契约一致 |
| AC1–AC5 | `sync-commit.test.ts`（44）、`sync-concurrency.test.ts`（10） | 完整替换、缺席删除与合法空 manifest、失败/不完整同步保留旧视图、提交事务回滚矩阵（逐步故障注入：可恢复存储类归稳定 `storage_error`、未识别类保留原始边界、守卫丢失恰一次重跑）、配置切换/移除与 commit 交错（含升代双腿） |
| AC6–AC10 | `sync-commit.test.ts`、`sync-concurrency.test.ts`、`sync-prepare.test.ts`、`binding-plan.test.ts`（19） | base 冲突与会话竞争（含真竞态：胜方落在败方 commit 缝）；重复 commit/丢失响应/重启取回回执/禁止指针回退；prepare 幂等键、载荷冲突与过期；统一 Loop OCC 与调度/Report 双向真实交错（AC9 四腿）；快照不变、绑定成功与跨资源引用拒绝 |
| AD1–AD4 | `packages/server/src/http/app.test.ts`（44）、`coordinator/poll.test.ts`（21）、`coordinator/report.test.ts`（33）、`start.test.ts`（15）、`packages/daemon/src/identity.test.ts`（3） | 路由逐个 404 且与未知路径逐字节一致；Create 不持久化 `artifactDir`、Poll 无 watch/不加 claim 门槛；Report 忽略 Artifact 字段、终态与 Phase 4 一致；启动不构造 BlobStore/不启动 watcher、Daemon capability 精确等值且零 artifact-sync 出站。收口复核复跑 4 个 server 文件 113 项全绿 |
| **内部集成验收（非编组 ID）** | `packages/server/src/phase5-batch1-e2e.test.ts`（1） | 见下节证据链；**不属任何 AM/AP/AB/AC/AD 编组，也不替代任何编组的套件** |

## 内部集成验收证据链（文件型 PGlite + 本地 BlobStore + 真实临时目录）

`packages/server/src/phase5-batch1-e2e.test.ts`（1 例，单跑 1.85s）——权威计划 L171 段落逐句落地：

1. **真实环境**：一次 `mkdtemp` 临时根；`dataDir` 为根自身（PGlite 库在 `<dataDir>/pgdata`），Blob 根为 `<root>/blobs`；`openMigratedDb({dataDir})` + `createLocalBlobStore({rootDir})`。片 1–5 亦有各自的磁盘触点（AC7 的文件库回执重开、迁移套件的文件库、local store 的重启读取），但**本文件是本批新增、唯一一条全部模块同时落在真实磁盘上的完整跨模块链**。
2. **seed 四方链**（manifest = run = loop = 可信归属，全部 `m-1`），配置经真实 `updateArtifactConfig` 写路径落地（断言 `outcome:"changed"`，代际 0→1；静默 noop 会失败）。
3. **prepare → PUT → commit**：按协商 `needHashes` 上传真实多 chunk 字节流（含 4 KiB 二进制），commit 回执逐字 `{artifactSnapshotId:"amf-1", manifestRevision:1}`；manifest 整行 `toEqual`（namespace/machine/loop/代际/entries/按路径 totalBytes/committedAt）；当前视图全字段；成功三元组（attemptedAt/succeededAt/error）。
4. **binding plan 在测试事务内应用**：`planArtifactSnapshotBinding` 断言 `kind:"bind"`（四方链+代际复验通过），`db.transaction` 内 `applyArtifactBindingPlan` 落 Run `artifactSnapshotId`；blob 字节经 store `read()` 逐元素断言后逐字节等于写入，并与磁盘原始文件比对。
5. **关库 → 同根重开**：`closeDb` → 同一 `dataDir` 重开（migration 二次执行为幂等 no-op）→ 同一 Blob 根的**新** store 实例。同一测试进程内关库重开并重新创建实例（并非新 OS 进程；权威计划亦只要求关库重开）。
6. **持久化复验**：manifest 整行、当前视图、Run 引用与同步错误、会话回执、两份 blob 字节——全部逐项相等。
7. **重试同一 commit**：回执逐字相等、manifest 恰 1 行、会话恰 1 行、`snapshotLoops` 重放前后**逐行相等**（零写入——比只看指针更强的「不创建第二份记录」证据）。
8. **文件变化再提交**：新会话 `sync-2`（换 requestId）、基础 revision 1；`needHashes` **恰为变更文件的 hash**（未变文件跨关库重开仍被协商去重，同时证元数据行与真实文件都在）→ 只 PUT 变更内容 → commit `{amf-2, manifestRevision:2}`。
9. **旧快照不变**：`amf-1` 整行不变、旧内容的旧 Blob 字节仍在（内容寻址、无 GC 的容忍边界在真实磁盘上的体现）、当前视图指向 `amf-2` 且不 stale。
10. **重放旧 commit 不回退指针**：返回旧回执、当前指针仍 `amf-2`/revision 2、再次零写入；真实 Blob 根内恰为三个已发布 blob、无任何 `.tmp-*` 残留。

边界声明：该路径只调用内部模块（`artifact/*`、`db/index`、testkit），不 import HTTP app、`bootstrapServer`、coordinator 或 store 写路径；PGlite 单连接证据**不替代** #11/#72 的真实多物理连接 Postgres 并发验证。

## 完整质量门（`ec0e519`）

```text
$ pnpm test          # EXIT=0
  packages/protocol: 14 files / 248 tests
  packages/daemon:   23 passed + 2 skipped files / 535 passed + 7 skipped tests
  packages/server:   63 passed + 3 skipped files / 810 passed + 3 skipped tests
$ pnpm typecheck     # EXIT=0
$ pnpm build         # EXIT=0
$ pnpm --filter @loopzhb/server db:check   # EXIT=0；drizzle 无新增/改动文件（零 schema 改动）
$ git diff --check   # EXIT=0
```

日志：`/tmp/slice6-gates.log`（逐条记录真实退出码）。server 较片 5 基线（809+3）恰 +1：
`phase5-batch1-e2e.test.ts`。

## 显式边界核对（生产休眠与只由测试接线）

- **AD1**：Artifact 管理/sync/PUT/commit/文件路径逐个探测返回与未知路径逐字节一致的 404。
- **AD2**：生产 Create 不持久化 `artifactDir`；Poll 响应无 `watch`/`watchDigest`、claim 条件不变。
- **AD3**：生产 Report 忽略 `artifactSnapshotId`/`artifactSyncError`，终态行为与 Phase 4 一致。
- **AD4**：生产启动不构造 BlobStore、不启动 watcher；Daemon capability 精确等值、出站 poll/report 零 artifact-sync 流量。
- **只由测试接线**（限定为本批 Artifact 功能的 import 与消费）：片 6 工作树按计划 grep 实测全空——
  - 生产代码零 import artifact 模块（`artifact/sync|config|binding-plan|blob-store-local|attribution`，排除 `src/artifact/` 自身与 `*.test.ts`）；
  - 装配面（`http/`、`coordinator/`、`store/`、`start.ts`）零本批 Artifact 模块引用；更宽松的大小写不敏感 `artifact` 文本匹配仅命中两处无关行——`start.ts:7`（构建产物 "BUILT artifact" 注释）与 `store/report.ts:100`（Phase 1 既有预声明字段 `artifacts`，从不写入）——均非本批接线；
  - `packages/daemon/src` 零 `artifact-sync`/`artifactSnapshotId`/`artifactSyncError`/`watchDigest` 引用。
- **片 6 变更面**：`git diff --stat 85e526e..ec0e519` 仅 `phase5-batch1-e2e.test.ts`（+393）；无生产代码改动。
- **ADR-002 复核确认（片 1 修订，无漂移）**：① protocol 主入口无 `node:` 内建依赖（仅 `./node` 子入口）；② Artifact wire DTO 仍为预声明形状、无生产消费（AD1 + 装配面 grep）；③ 片 3–5 未引入第三个窄例外。
- **已知限制**（计划 L197）：本批只验证 namespace 隔离，未实现用户认证或生产 Team 归属；当前集合限制不等于历史快照、过期 session 和孤立 Blob 的累计磁盘占用有界（留 Phase 6）；PGlite 单连接证据不替代 #11/#72。

## 复审与 Issue 收口

- 片 6 收口三轨复审 Round 1（固定范围 `546703f...5929fe2`；审查记录 `docs/handoff/codex-handoff-phase5-batch1-slice6-code-review.md`，当批物流、按约定不入库）：三轨零阻断——标准 0 违例、规格 0 验收缺项（权威计划 L171 链逐项满足）、对抗 0 项 P2 及以上（独立磁盘探针 1/1 通过：模拟 COMMIT 确认丢失后关库重开同根，原 session 取回原快照与 revision，整行断言，磁盘字节一致）。
- Round 1 唯一发现为一项 P3 非阻断证据措辞（三处）→ 修复提交 `6cc78fe`（注释与文档 only，零断言变更）。2026-10-03 定点复核（`5929fe2...0ffa7c7`）判定该项**核销关闭，片 6 无剩余审查项**；`0ffa7c7`（仓库工作规约 AGENTS.md「输出风格」一节入库）单独识别，不计作 P3 修复。
- 修复后五门复跑（`6cc78fe`，日志 `/tmp/slice6-p3-gates.log`）：protocol 248 / daemon 535 + 7 skipped / server 810 + 3 skipped，全 EXIT=0；`db:check` 无 drift。收口提交（roadmap 状态块、本节与结论、计划头终态）为文档-only，不改动代码或测试。
- 既有 Issue：#72、#11 为 Phase 6 blocker（roadmap 指针在位）；#56、#61 留给 Phase 5 后续批次（#56 认证层加固、#61 验收环境防回归）；Batch 1 各片复审 Issue（#66–#82）全部核销关闭。上述 P3 未创建 Issue，无远程状态需要变更。

## 结论

Batch 1 全部编组（AM/AP/AB/AC 与 AD）与内部集成验收通过，五道质量门全绿；收口三轨复审
Round 1 零阻断，唯一 P3 证据措辞项经定点复核核销关闭；生产仍运行 Phase 4 行为（AD1–AD4 在测）。
**Batch 1 完成（2026-10-03）**，批次 PR #68 已转待合入；Batch 2（watcher、持续同步、Run 快照与
文件视图）与 Batch 3（认证）另行规划。

---

# Batch 2 — Artifact 持续同步、Run 快照与文件视图

## 测试环境（Batch 2）

- **日期**: 2026-10-07
- **平台**: macOS (Darwin 27.0.0)
- **Node.js**: v22.17.0
- **pnpm**: 10.6.1
- **分支**: `feat/phase5-batch2-dev`（批次 PR #84，进行中；8 切片共用）
- **批次基线**: `a0bc7c8`；**验收提交**: `f8b3ba1`（片 8 故障集成验收测试 AI1–AI7）
- **片 1–7 提交链与逐片三轨复核记录**：见当批执行索引 `docs/handoff/phase5-batch2-slices.md`（当批物流，按约定不入库）；各片状态以 roadmap 状态块与 GitHub Issues 为准
- **长期决策**: `docs/adr/010-phase5-artifact-sync-foundation.md`（27 条决策）；ADR-002 修订记录 2026-09-28 与 2026-10-07 条目

## 验收范围（Batch 2 完成定义复述，plan §3）

配置目录后能够持续单向同步，只传缺失内容，删除语义与重启恢复正确；Run 最终 snapshot 固定；同步失败不阻断合法终态；文件下载与结构 diff 可用；未配置 Artifact 的旧 Loop 保持原执行行为。本批未新增数据库 migration（沿用 Batch 1 的 `0005` 列）。

## 测试编组与结果

> 编组编号沿用权威计划 §3。逐编号对应表见计划；本表给组级证据锚点。

| 编组 | 主要证据（文件） | 覆盖 |
|---|---|---|
| AT1–AT10（片 1） | `protocol/src/artifact.test.ts`、`artifact-view.test.ts`、`tolerant-reader.test.ts`；`server/src/artifact/attribution-machine.test.ts`、`error-mapping.test.ts`、`production.test.ts` | 契约冻结、归属解析、HTTP 映射矩阵、生产门面 |
| AH1–AH12（片 2） | `server/src/http/artifact-routes.test.ts`、`phase5-batch2-slice2-e2e.test.ts`、`artifact/sync-error.test.ts`、`artifact/watch.test.ts`、`coordinator/poll.test.ts`、`coordinator/claim.test.ts`、`gateway/delivery.test.ts` | 配置 API、同步 HTTP、Poll/claim/Delivery 接线 |
| AJ1–AJ10（片 3） | `daemon/src/artifact-jail.test.ts`、`artifact-scan.test.ts`、`artifact-hash-cache.test.ts`、`artifact-verify.test.ts` | 安全扫描与上传前验证 |
| AS1–AS6、AS9–AS11（片 4） | `daemon/src/artifact-sync.test.ts`、`artifact-client.test.ts` | 同步客户端与恢复状态机 |
| AW1–AW14、AS7/AS8/AS12（片 5） | `daemon/src/artifact-watcher.test.ts`、`artifact-watch-manager.test.ts`、`artifact-watch-integration.test.ts` | WatchManager 与生命周期 |
| AR1–AR12（片 6） | `daemon/src/artifact-final-sync.test.ts`、`runtime.test.ts`；`server/src/coordinator/report.test.ts`、`artifact/binding-plan.test.ts`；`server/src/phase5-batch2-slice6-e2e.test.ts` | Run 最终同步与 Report 原子绑定 |
| AV1–AV8（片 7） | `server/src/artifact/read.test.ts`、`http/artifact-read-routes.test.ts`、`dashboard/` 套件；`phase5-batch2-slice7-e2e.test.ts` | 读取、下载、快照与 SSR 页面 |
| **AI1–AI7（片 8）** | **`server/src/phase5-batch2-slice8-e2e.test.ts`（7 项）** | 故障集成验收（见下节证据链） |

## 集成验收证据链（AI1–AI7：真实 HTTP + 文件型 PGlite + 本地 BlobStore + 生产形态 daemon + 真实临时目录）

`phase5-batch2-slice8-e2e.test.ts`（7 例，单跑约 21 s）是本批**首个**同时落在真实 127.0.0.1 监听、文件型 PGlite（`<dataDir>/pgdata`）、生产本地 BlobStore（`<dataDir>/blobs`）、生产形态 daemon（`cli.ts` 组合根逐字段镜像——同一份 sync client 同时喂 WatchManager 与 Run 最终同步——仅替换 Fake Runner 与记录/改写型 fetch dial）与真实 chokidar／真实临时目录的集成面：

1. **AI1（idle 编辑与删除）**：poll 投递 watch 集合 ⇒ 订阅 ⇒ 启动全扫提交 revision 1（无 Run）；创建/修改/删除逐次收敛为 revision 2/3/4 且路径精确；静默窗口零 prepare/commit；**同内容改写**（mtime 变、内容同）触发事件但零请求（客户端抑制——M6 变异证明该腿非 vacuous）；已提交 manifest 的 blob 全部落盘（无部分 manifest）。
2. **AI2（两次 Run 与快照冻结）**：两次 Run 经**真实 socket** 完成 claim → 最终同步 → Report 绑定（片 6 同链走 app.request）；snap1 ≠ snap2；Run 1 行与 snap1 manifest 行级冻结；snap1 下载字节与编辑前内容逐字节一致；diff 恰为 added/modified/removed 三类。
3. **AI3（配置变化）**：PATCH 新根在 daemon 知情前视图确定性地 `stale:true`（代际 2）；下一次 poll 换代——旧 watcher 关闭、新根订阅并以 `configRevision:2` 提交；换代顺序有**物理证据**：事件日志按真实关闭完成排序，断言 `close-completed(rootA)` 先于 `subscribed(rootB)`（AS7 固定序，Round1 #114 加固）；PATCH null 后 poll 携带空集合、watcher 关闭、两个旧根再编辑零流量零 revision 移动、视图 `artifactDir:null`。
4. **AI4（断网）**：断网先于编辑开启（开启前先 join 启动轮 `watch.settled()`）；dial 观测到真实失败尝试后在客户端 1 s/2 s 退避窗口内恢复；恰一次 prepare/commit 收敛 revision +1——revision 由服务端应用先于响应落定，统计前先 join `watch.settled()`（AI5 converge 同型，Round1 #116 加固）；零本地失败上报；后续编辑照常。
5. **AI5（响应丢失三腿 + 会话过期；假服务端语义平价核心）**：对**真实服务端**——(a) prepare 响应在应用后丢失 ⇒ 同 requestId 重试得**同一 syncId**；(b) PUT 响应在发布后丢失 ⇒ 重 PUT 得 `published:false`（blob 去重）；(c) commit 响应在回执冻结后丢失 ⇒ 重 commit 取回**逐值相等的同一冻结回执**、revision 恰进一；(d) 服务端时钟拨快 2 小时 ⇒ commit 得 409 `artifact_session_expired` ⇒ 客户端同载荷重 prepare（**原地续期、同 syncId**、重算 `needHashes:[]`、零重复上传）⇒ commit 成功。
6. **AI6（进程重启）**：(a) daemon 重启（生产 drain 后整栈重建，哈希缓存随进程消失）——基线读自服务端，**零 PUT**、恰一轮 prepare/commit、revision 恰 +1（AS6 记录的 U2 残余「等价内容重启首轮铸一次 revision」在集成面复现并钉死）、新 manifest 条目与重启前逐值一致、随后静默；(b) server 重启（生产序关闭、同 `dataDir` 重 boot、dial 重绑）——snap1 manifest 行与下载字节逐值/逐字节不变，新编辑经**新监听**同步，blob 根零 `.tmp-*` 残留，全部 manifest 的 configRevision 与 Loop 当前代际一致（无旧代际提交）。
7. **AI7（生产启用 + 旧 Loop 不上传守卫）**：生产形态 daemon（capability 齐全、artifact 依赖全接线）对**未配置** Loop——零 artifact 流量（无基线读/prepare/PUT/commit/错误上报）、Report 无 artifact 字段（**wire 级**：按 runId 筛选 dial 记录的真实 Report 请求体，断言 `artifactSnapshotId`/`artifactSyncError` 均非 own property——DB null 只是服务端清洗，不能区分 wire 多带空串，Round1 #115 加固）、Run 正常 done/exec、不进 watch 集合、blob 根未创建。此例取代 Batch 1 休眠守卫套件（AD1–AD4 已逐片翻转为激活断言）；旧 Loop 不上传单元钉（runtime/delivery/poll/final-sync 四处）全部保留零改动。

**变异验证**（验收提交 `f8b3ba1`；`cp` 备份 → 变异 → 定向红 → `cp` 恢复 → 复绿）：M1 删 poll 路径 watch apply ⇒ AI1–AI6 红；M2 事件不开窗 ⇒ AI1 红；M3 管线跳过最终同步 ⇒ AI2 红；M4 配置换代不增代际 ⇒ AI3 红；M5 重放铸新回执 ⇒ AI5 红（首次变异落在事务内重放点未转红——本流程的重试在 precheck 重放点即返回，事务内点不可达；更正变异点后转红，如实记录）；M6 删无变化抑制 ⇒ AI1 红；M7 复合变异（runtime 无配置条件 + final-sync 快路径**双拆**——单层各自被另一层拦下，防御纵深如实记录）⇒ AI7 红。7/7 全部被对应场景抓住。

**Round1 复审修复变异验证**（加固提交 `1886409`；同法，变异落 daemon dist 后 `cp` 恢复复绿）：M8 watcher close 在释放前拒绝 ⇒ afterEach 泄漏不变式红（6/7 例，AI7 本就不建 watcher）；M9 复合（300 ms 慢关闭 + 删除 successor 对 predecessor close 的 `await`）⇒ AI3 红（revision 2 提交时旧 watcher 物理未关闭——`closed` 标志先抓住，序断言同为红靶）；单删 `await` 一项在本机未转红（chokidar 关闭快于本地 admission，序上偶然串行——任何事件序断言对纯竞态都不保证检出，故采审查同款慢关闭法定为确定性红）；慢关闭控制（`await` 完整 + 300 ms 关闭）⇒ AI3 绿（不误报）；M10 旧 Loop fallback 携带 `artifactSyncError:""` ⇒ AI7 wire 断言红；M11 控制（commit 响应延迟 300 ms）⇒ AI4 绿（settled join 吸收延迟，不误报；红侧「无 join 则同延迟必红」已由 Round1 审查证明）。

## 假服务端语义平价表

片 4 的内存假服务端（`daemon/src/testkit/artifact-sync-fake.ts`）头部注释把「与真实服务端的语义交叉检查」留给本片。平价为**行为级**（不共享回放 harness——fake 不在 dist，跨包 import 会破坏「verify what ships」公约）：

| fake 接缝 | 真实服务端证据 |
|---|---|
| `failNext(step, throw_after_apply)`（prepare/PUT/commit） | AI5(a)/(b)/(c)：真实应用后丢响应，同 requestId/syncId、`published:false`、冻结回执逐值相等 |
| `offline` | AI4：dial 级断网（请求不出 daemon），退避窗口内恢复收敛 |
| `expireSession` | AI5(d)：真实服务端时钟驱动的到期 + 原地续期 |
| `dropSessions`（服务端重启丢 session） | 部分平价：fake 建模的是更弱服务端，真实对应物是过期（AI5(d)）。session 行的 PGlite 持久化只是 schema 层事实——AI6(b) 只证明 manifest 行与下载字节跨重启稳定，未重放同一 session 的跨重启 commit，故不作「重启不丢 session」的证据（片 8 Round1 复审指针：second boot 实际清空 session 行而 AI6 仍绿；这不声称产品丢 session，仅纠正证据归因） |
| `seedBlob`/`needHashes` 协商去重 | AH5/AH6（片 2 真实 HTTP e2e）+ AI5(d) `needHashes:[]` + AI6(a) 零 PUT |
| `holdPuts`、`before{Prepare,Put,Report}` hooks、`commitSession` | 单元级保留（`artifact-sync.test.ts`、server AC 系套件） |
| `calls`/`stepCalls`/`maxConcurrentPuts` 日志 | dial.calls 日志（AI1–AI7 的流量断言） |

## 完整质量门（`f8b3ba1`）

```text
$ pnpm test          # EXIT=0
  packages/protocol: 15 files / 288 tests
  packages/daemon:   34 passed + 2 skipped files / 790 passed + 7 skipped tests
  packages/server:   76 passed + 3 skipped files / 1001 passed + 3 skipped tests
$ pnpm typecheck     # EXIT=0
$ pnpm build         # EXIT=0
$ pnpm --filter @loopzhb/server db:check   # EXIT=0；drizzle 零文件变动（零 migration）
$ git diff --check   # EXIT=0
```

日志：`/tmp/slice8-gates.log`（逐条记录真实退出码）。server 较片 7 基线（994+3）恰 +7：`phase5-batch2-slice8-e2e.test.ts` 的 AI1–AI7。

Round1 复审修复提交 `1886409` 复跑五门全绿（protocol 288 / daemon 790+7skip / server 1001+3skip——断言硬化未新增用例，计数不变 / typecheck / build / `db:check` 无 drift / `git diff --check`）。

## 显式边界核对

- **变更面**（`c2b1692..f8b3ba1` 代码部分）：仅新增 `phase5-batch2-slice8-e2e.test.ts` 与 `protocol/src/artifact.test.ts` 两行 describe 文案（断言零改动——「Batch 1 不消费」字样已过时）；daemon/server 产品代码、drizzle、lockfile、package.json 零改动：

  ```text
  $ git diff --exit-code c2b1692..f8b3ba1 -- packages/server/drizzle pnpm-lock.yaml package.json packages/server/package.json packages/daemon/package.json packages/protocol/package.json   # 空
  $ git diff --exit-code c2b1692..f8b3ba1 -- packages/daemon/src    # 空
  $ git diff c2b1692..f8b3ba1 -- packages/protocol                  # 仅 artifact.test.ts 两行 describe 文案
  ```

- **守卫处置**：AD1–AD4 已逐片翻转为激活断言（片 2/5/6/7）；`runtime.test.ts` 的「无 finalSync 依赖 ⇒ 零 artifact 字段」是合法可选依赖组合钉，保留；`store/report.ts`/`coordinator/index.ts` 的缺席 `artifactBinding` 路径保持 comment-only（生产自片 6 永远接线，钉一个生产不运行的配置无意义）；AI7 为旧 Loop 不上传的 e2e 级继任守卫。
- **protocol 文案例外**：两行 describe 标签改文案不改断言，为**片 8** 唯一的 protocol 包内改动（Batch 2 全批的 protocol 改动见各片验收段），在此如实声明。
- **已知限制与残余**：U2（等价内容重启首轮铸一次 revision）在真实 HTTP 面复现并钉为恰 +1；中流截断在 HTTP 层不可检（决策 27）；下载忽略 Range（决策 27）；`artifact_dir_unconfigured` 读取域无路由返回（决策 27）；**PGlite 单连接证据不替代 #11/#72 的真实多物理连接 Postgres 并发验证**。

## 复审与 Issue 收口

- 片 1–7 三轨复核的 Issue（#83、#85–#90、#92–#99、#105–#106、#109–#113）全部核销关闭；片 8 的三轨复核在本记录提交后进行，发现项走 Issue Tracker 流程（修复不自行关闭，独立复审核销）。
- 片 8 Round1 三轨复核（2026-10-07，基线 `c2b1692..0945029`）：三轨各 2P2+1P3，主审去重 3 项 P2——**#114**（watcher 关闭完成/顺序验收假绿）、**#115**（AI7 未验证 Report wire 键缺席）、**#116**（AI4 在 commit 响应落定前统计）；2 项 P3（session 持久化证据归因、「本批」措辞）不建 Issue，已直接修正本记录。测试修复提交 `1886409`（验收断言加固），文档修订提交 `54e17cf`（两项 P3 措辞修正与验收记录更新），变异验证 M8–M11 见上节；修复经独立复审核销（2026-10-07），#114/#115/#116 均已 CLOSED。
- 开放 Issue 恰为右移项 #11/#56/#61/#72；**#72 保持 OPEN**（真实多连接验收归 Phase 6，本批不触碰）。

## 结论（Batch 2）

Batch 2 全部编组（AT/AH/AJ/AS/AW/AR/AV）与 AI1–AI7 故障集成验收通过，五道质量门全绿；片 1–7 三轨复核全部收口；片 8 三轨复核 Round1 的 3 项 P2（#114/#115/#116）修复后经独立复审核销关闭，**Batch 2 至此全部完成（2026-10-07）**；**Phase 5 未收口**（Batch 3 认证未启动，本记录不声明 Phase 5 完成）。

# Batch 3 — GitHub 登录、个人团队与旧数据认领

> 权威计划：`docs/plan/codex-phase5-batch3-slices-plan.md`；长期决策：`docs/adr/011-phase5-identity-and-legacy-claim.md`。

## 测试环境（Batch 3）

- **日期**: 2026-10-07
- **平台**: macOS (Darwin 27.0.0)
- **Node.js**: v22.17.0
- **pnpm**: 10.6.1
- **分支**: `feat/phase5-batch3-dev`
- **批次基线**: `4ff517a`（Batch 2 合入后的 main）
- **长期决策**: `docs/adr/011-phase5-identity-and-legacy-claim.md`（片 1 冻结决策 1–7）

## 验收范围（Batch 3 完成定义复述，plan §1）

GitHub 用户登录后获得个人团队；管理 API 和 Dashboard 只显示该团队资源；未知或未认领机器不能通过 poll 注册；运维可在 Server 停止后将旧机器及其 Artifact 历史显式认领给已登录用户。管理面认证与机器自注册关闭是不可拆分的合入与部署单元。

## 片 1 — 身份模型、数据库迁移与认证配置

### 测试编组与结果（片 1）

| 编组 | 主要证据（文件） | 覆盖 |
|---|---|---|
| LM1 | `server/src/db/phase5-batch3-migration.test.ts` | Batch 2（0005）旧库无损升级：7 张旧表全部旧列 item-equal；旧 machines 行 `team_id`/`revoked_at` 落 null（不自动认领）；4 张身份新表存在且为空；artifact 引用链（snapshotId、manifest entries、已提交 session receipt）逐项保持；journal 精确 7 条 |
| LM1-freeze | 同上 | `test-fixtures/phase5-migrations/` 与 committed 0000–0005 字节相等、journal idx [0..5] |
| LM2 | 同上 | 身份四表与 machines（已认领+旧机器）**全行快照、每一列**经两轮 close/reopen + 重复迁移 item-equal；六张旧表全部旧列 item-equal（machines 旧列由全行快照覆盖）；journal 保持 7；表/索引不重复。全字段比较的检测能力见下方变异验证（#117） |
| SC-RT/UQ/CK/ENUM | `server/src/db/phase5-batch3-schema.test.ts`（20 项） | 四表 round-trip；machines 三形态（unclaimed/claimed/revoked）；users PK / teams 部分唯一 / memberships 复合 PK / auth_sessions hash PK 各自仲裁范围；id 格式 CHECK 负例；`TEAM_KINDS`/`MEMBERSHIP_ROLES` server 内部枚举 pin（ADR-011 决策 6 例外） |
| DB-IDX | `server/src/db/index.test.ts` | 新库建表精确 11 张；索引 14 个名称+定义 pin（含 `teams_personal_owner_idx` 的 `WHERE kind='personal'` 谓词）；重复迁移幂等 |
| CF-* | `server/src/config.test.ts`（48 项） | origin 规则全集（https 任意 host、http 仅 loopback、拒绝凭据/path/query/fragment、尾斜杠规范化、loopback 缺省派生、非 loopback 无显式 origin 拒绝）；OAuth 双密钥缺失/全空白合并点名报错；callback URL = origin + 固定路径；**拒绝消息不回显原始输入**——哨兵密码注入六个拒绝分支（不可解析/协议/凭据/path+query/fragment/非 loopback http），消息均不含哨兵（#118） |
| ST-FAIL | `server/src/start.test.ts` | 缺 OAuth 配置或非 loopback 绑定无显式 origin 时 `main()` 在创建 dataDir 之前 rejects（生产启动流程不可进入）；含嵌入凭据的 origin 拒绝时 `main()` 的 rejection 消息（即 `start.ts` 打印到 stderr 的日志边界）不含哨兵密码（#118）；存量 boot/e2e 携带 `makeTestAuthConfig()` 后回归绿 |

### 显式边界核对（片 1）

- **停止边界**：未开放登录路由（`/login`、`/auth/*`、`/api/session` 均不存在）；未实现 ConnectKey；迁移不自动认领（旧机器一律 `team_id=null`）；无生产身份注册入口——身份行只能由 testkit fixture 或未来的片 2 登录事务产生。
- **protocol 包零改动**；daemon 包零改动。
- **既有 pin 的同步更新**：`phase4-migration.test.ts` M5 与 `phase5-migration.test.ts` AM1/AM5 的 journal 计数 6→7（0006 落库的正常结果，注释同步注明 0006 来源）。
- **存量测试改造**：12 个测试文件 19 处 `bootstrapServer` 调用点统一携带 `auth: makeTestAuthConfig()`；`ServerConfig.auth` 为必选字段，遗漏由 typecheck 结构性列全。
- **已知边界**（ADR-011）：users.id 与 GitHub 耦合（多身份提供商需未来迁移）；Session 级 CSRF 列不进 0006（片 2 落地时 0007 加列）；`unauthenticatedExposureWarning` 文案本片不动（启动提示更新是片 7 条目）。

### 完整质量门（片 1，`1cc201e`）

```text
$ pnpm test          # EXIT=0
  packages/protocol: 15 files / 288 tests
  packages/daemon:   34 passed + 2 skipped files / 790 passed + 7 skipped tests
  packages/server:   78 passed + 3 skipped files / 1051 passed + 3 skipped tests
$ pnpm typecheck     # EXIT=0
$ pnpm build         # EXIT=0
$ pnpm --filter @loopzhb/server db:check   # EXIT=0；schema.ts 与 drizzle/ 零漂移（迁移 0006 已提交）
$ git diff --check   # EXIT=0
```

server 较 Batch 2 基线（1001+3skip）恰 +50：`phase5-batch3-schema.test.ts` 20 项、`phase5-batch3-migration.test.ts` 3 项、config.test.ts 净 +25（42 项替换原 17 项）、start.test.ts +2 项 fail-fast。备注：一次并行负载下的全量 `pnpm test` 曾出现 daemon 单文件瞬态失败，同一代码随后两次独立复跑（daemon 单跑与全量重跑）均全绿，未复现。

### 完整质量门（片 1 复审修复，`1fc3300`）

```text
$ pnpm test          # EXIT=0
  packages/protocol: 15 files / 288 tests
  packages/daemon:   34 passed + 2 skipped files / 790 passed + 7 skipped tests
  packages/server:   78 passed + 3 skipped files / 1058 passed + 3 skipped tests
$ pnpm typecheck     # EXIT=0
$ pnpm build         # EXIT=0
$ pnpm --filter @loopzhb/server db:check   # EXIT=0；schema.ts 与 drizzle/ 零漂移
$ git diff --check   # EXIT=0
```

server 较 `1cc201e` 恰 +7：config.test.ts +6（#118 哨兵非泄漏六分支矩阵）、start.test.ts +1（#118 boot 日志边界非泄漏）；LM2 断言加固不改测试计数。另以真实 `dist/start.js` 携带嵌入哨兵密码的 origin 复验 #118：拒绝启动、退出 1、stderr 不含哨兵、dataDir 未创建。

### 变异验证与独立验收（片 1）

验证日期：2026-10-07；代码与验收记录基线：`0f26505`，行为修复提交：`1fc3300`。

- **LM2 检测能力**（[#117](https://github.com/zhuabo001/loop-platform-zhb/issues/117)）：在独立临时测试副本中，分别将 Session 的 `user_id` 改为 `999999`、`expires_at` 改为 2099 年，以及将历史 Run 的 `artifact_snapshot_id` 设为 NULL。每次仅注入一种变异，LM2 均在对应的全字段比较断言失败（exit 1，1 failed / 2 skipped）；恢复原始代码后通过（exit 0，1 passed / 2 skipped）。
- **实际启动日志边界**（[#118](https://github.com/zhuabo001/loop-platform-zhb/issues/118)）：通过真实 `dist/start.js` 执行 12 个拒绝探针，覆盖用户名/密码、query、path、fragment、协议、非 loopback HTTP、不可解析 URL、非法端口/IPv6、百分号编码及控制字符。全部退出 1，stdout/stderr 不含敏感哨兵值，dataDir 未创建。该证据验证实际进程日志出口，独立于 `main()` rejection 消息断言。
- **定向回归**：`config.test.ts`、`start.test.ts`、`phase5-batch3-migration.test.ts` 共 3 个文件、69 项通过；`pnpm typecheck` 和 `git diff --check` 通过。完整 test/build/db:check 的执行结果见前述 `1fc3300` 质量门，本次独立验证未重复执行这些完整质量门。

### 结论（片 1）

本片验收确认：身份模型及唯一约束有效，旧库升级与重复迁移保持历史数据，LM2 能检测身份归属、有效期及快照引用的变化；非法 origin 和缺失 OAuth 配置在资源打开前拒绝启动，origin 拒绝消息与实际启动日志不回显敏感输入。

## 片 2 — GitHub 登录与持久 Session

### 测试编组与结果（片 2）

| 编组 | 主要证据（文件） | 覆盖 |
|---|---|---|
| AU1/AU3/AU6（存储层） | `server/src/auth/pending-tx.test.ts`（7 项） | 原子一次性消费（二次消费 null）；10 分钟 TTL 边界（恰 10 分钟过期，前 1ms 有效，FakeClock）；未知 txId；过期项由消费删除；有界增长护栏（超 1024 先逐过期再逐最旧） |
| AU5/AU8/AU12（adapter 层） | `server/src/auth/github.test.ts`（10 项） | authorize URL pin（S256 challenge、配置冻结的 redirect_uri、无 scope）；PKCE RFC 7636 Appendix B 测试向量；交换非 2xx 与 2xx+error → exchange_failed；抛错/超时 → network_error；畸形 JSON/缺 access_token/非数字 id/缺 login → response_invalid；**哨兵泄漏断言**：code/token/secret/上游正文不出现在任何返回值与 console.warn 日志 |
| AU9–AU11 | `server/src/auth/identity.test.ts`（5 项） | 首登单事务恰建一行 User/Team/Membership（FakeClock 盖章）；二登刷新 username/updatedAt、team id 不变；Promise.all 并发登录收敛单身份（PGlite 单写者下证明可观测结果，ON CONFLICT+重读为真 Postgres 保险，见下「诚实声明」）；预置非派生 id 个人团队被收养而非重复 |
| AU1–AU8/AU12（路由层） | `server/src/auth/routes.test.ts`（26 项） | 回调失败九分支矩阵（无 cookie/未知 txId/过期/拒绝授权/缺 state/state 不符/缺 code/交换失败/网络失败）逐分支零写入证明（四表行数不变、无 session Set-Cookie、tx cookie 清除）；AU6 重放 → state_unknown 且行数保持；AU12 敌对 Host 不影响 redirect_uri；登录页分类→固定文案、未知值通用文案、原始参数不回显 |
| SE1/SE2/SE3/SE6（服务层） | `server/src/auth/session.test.ts`（7 项） | mint 只存哈希（明文凭据不在库）；未知/空/缺失凭据 → null；到期边界 expiresAt±1ms；revoke 只删当前行且幂等；身份链断裂（无 FK 约定下的直接改库）按未登录处理 |
| SE4 | `server/src/auth/cookies.test.ts`（11 项）+ routes.test.ts | Set-Cookie 串精确 pin（session/tx/clear 三种；Secure 恰好只在 https origin；永不带 Domain）；parseCookieHeader 回环与畸形边界（首个 `=` 切分、重复名先现优先） |
| SE7/SE8 | `server/src/auth/session-csrf.test.ts`（8 项）+ routes.test.ts | verdict 矩阵（ok/不符/缺失/重复/畸形/坏转义/空期望值）；跨 Session token 403 且目标 Session 完好；logout 415/413/400/403 矩阵且失败不撤销任何 Session |
| SE5 + 两条不变量 | `server/src/phase5-batch3-slice2-e2e.test.ts`（3 项） | 真实 `bootstrapServer` + 文件型 PGlite + 脚本化 githubFetch：登录 → 关库重启同 dataDir → /api/session 200（重启持久）；重启前未完成事务 → 重启后回调 state_unknown（内存语义）；失败登录四表零行（不变量 1）；首登后预置未认领机器 teamId 仍 null、新团队无机器（不变量 2） |
| 挂载与接线 | `server/src/http/app.test.ts`（+2 项）、`server/src/start.test.ts`（+1 项） | auth 缺席时五路径与未知路由不可区分（404）；在场时五路由挂载含中间件链；bootstrapServer 从 config.auth 装配 auth 模块；回环 hostGate 先于 auth 路由 404 敌对 Host |
| DTO | `protocol/src/session.test.ts`（4 项） | sessionInfoResponseSchema 必填字段、expiresAt 真 ISO datetime、宽容读者（未知键剥离不拒绝） |

### 显式边界核对（片 2）

- **停止边界**：管理路由 Session 门禁未做（片 5）；Dashboard 登录态与表单未接线、进程级 dashboard CSRF token 未动（片 6）；本片不作为可部署的管理面认证版本（片 7 生产演练）。
- **设计修正（用户确认 2026-10-07，ADR-011 修订决策 11）**：片 1 验收记录预留的「0007 加列存 Session CSRF 哈希」撤销——随机铸造 + 哈希落库与 `/api/session` 明文交付不可兼得；改为凭据派生 `sha256(credential + ":csrf")`，不落库，journal 保持 7 条，phase4-M5/phase5-AM1/AM5/LM1/LM2 pin 不变。
- **诚实声明**：AU9 并发登录在 PGlite 单写者下事务串行，测试钉住可观测契约（单身份、双成功），真实交错仲裁由 ON CONFLICT + 重读路径承担；pending-tx 的有界增长护栏（超惰性语义的逐最旧驱逐）为实现补充，已在此声明。
- **protocol 增量**：仅 `sessionInfoResponseSchema`（wire 惯例）；server 内部枚举例外不受影响。
- **新接缝**：`BootstrapOverrides.githubFetch/githubTimeoutMs` 为 INTERNAL-ONLY 测试接缝，生产不传。

### 完整质量门（片 2，`78e51b7`）

```text
$ pnpm test          # EXIT=0
  packages/protocol: 16 files / 292 tests
  packages/daemon:   34 passed + 2 skipped files / 790 passed + 7 skipped tests
  packages/server:   86 passed + 3 skipped files / 1139 passed + 3 skipped tests
$ pnpm typecheck     # EXIT=0
$ pnpm build         # EXIT=0
$ pnpm --filter @loopzhb/server db:check   # EXIT=0；schema.ts 与 drizzle/ 零漂移（0007 已撤销，无新增迁移）
$ git diff --check   # EXIT=0
```

server 较片 1 复审基线（`1fc3300`，1058+3skip）+81：八个新测试文件（cookies 11、pending-tx 7、session-csrf 8、github 10、identity 5、session 7、routes 26、slice2-e2e 3），app.test.ts +2、start.test.ts +1；protocol 288→292（session DTO 4 项）。

### 结论（片 2）

本片验收确认：GitHub 授权码流程（一次性 state、浏览器绑定、PKCE S256、10 分钟内存事务、原子消费）与持久 Session（哈希即主键、7 天绝对有效期、凭据派生 CSRF、退出删行）按冻结规则实现；失败路径逐分支零写入且无敏感信息泄漏；Session 重启持久、未完成登录重启失效；首次登录不取得旧机器。管理面门禁、Dashboard 接线与生产演练分别留待片 5/6/7。

## 片 3 — 关闭自注册与未认领机器执行隔离

### 测试编组与结果（片 3）

| 编组 | 主要证据（文件） | 覆盖 |
|---|---|---|
| PG2–PG6（存储层） | `server/src/store/machines.test.ts`（15 项，+6） | `verifyEligibleMachineCredential` 五步门：PG3 未知 token → undefined 且零写入；PG4 全量 hash 不符（截断碰撞防御）；PG5 `teamId` 为空（未认领）；PG5b `revokedAt` 非空（已撤销）；PG6 已认领未撤销 → 返回行；PG2 形状非法 token 不触库。未知/未认领/已撤销三类拒绝**返回同一 undefined**，调用方无法区分（无信号泄漏）；只读谓词 `isMachineExecutionEligible` 供 scheduler 复验 |
| PG1–PG6（poll 路径） | `server/src/coordinator/poll.test.ts`（32 项，含新 PG 门控编组） | PG1 缺 Bearer；PG2 形状非法；PG3 未知 token **不再建行**（自注册已删除）；PG4 hash 不符；PG5 未认领；PG5b 已撤销——每条拒绝分支以 `snapshotBusinessState`（machines/loops/runs/run_leases 与三张 artifact 表，全字段、确定性排序）**整体前后相等**证明零业务写入，且比对发生在**非空世界**上（预设 pending Run + progress、lease、已提交 sync session/manifest/blob；PG4 为整行比较而非部分字段），空表之间的相等不作为证据；PG6 已认领机器 poll 成功，且断言**心跳是该次 poll 的唯一写入**（其余六张表逐表相等）。**顺序回归**：畸形、well-shaped 未知、未认领、已撤销四类凭据携带非法 capability 声明一律 401（凭据门整体先于资源策略 400，ADR-011 决策 17），同一声明来自已验证机器才是 400 且同样零写入。原 `poll: self-registration` 编组（4 项）已删除；其身份快照断言由 PG6 与 A-13 编组以显式预置机器承接，字段清洗/封顶（NUL 剥离 → trim → 64 字符上限）覆盖在同一 contact 路径上补回 |
| PG 矩阵（Artifact 路径） | `server/src/http/artifact-routes.test.ts`（27 项，+2） | 未认领机器（`teamId` 置空）与已撤销机器（`revokedAt` 置值）持有效凭据访问 machine Artifact 端点 → 统一 401 `invalid machine credential`，**不存在按机器 namespace 的降级读取**；两者在同一 `snapshotBusinessState` oracle 上比对**非空**自身历史（queued Run + lease + 已提交 session/manifest/blob）前后整体相等；已撤销机器另加 prepare 写入路径的 401 与同一比对 |
| AT9（Team attribution） | `server/src/artifact/attribution-team.test.ts`（7 项） | namespace 取自 `machines.teamId`，跨调用/跨实例稳定；teamId 通过 `NAMESPACE_ID_RE`；机器行缺失、`teamId` 为空、`teamId` 非法三种拒绝均折叠为 `attribution_missing`；`machineId` 与 `namespaceId` 分离；resolve 零写入 |
| AT10（生产装配） | `server/src/artifact/production.test.ts`（5 项） | 生产 ArtifactHome 全链路 prepare → PUT → commit 落在 `<dataDir>/blobs/<teamId>/<hash>`；构造零文件系统副作用；id 前缀与时钟注入不变。AT8（`attribution-machine.test.ts`）保持全绿——旧 resolver 退为片 4 源侧读取 |
| PE1–PE5（Scheduler 资格边界） | `server/src/scheduler/scheduler.test.ts`（28 项，含新资格编组） | PE1 未认领机器 loop：无 job、无 catch-up、无 Run；PE2 已撤销机器同上；PE3 已认领未撤销机器为对照（注册 + 恢复 downtime 的 10:00 occurrence）；PE4 机器行缺失的孤儿 loop 被排除；PE5 注册后转撤销：tick 被 `scheduler: machine_ineligible` 拒绝，**不新增 Run 且 `lastScheduledAt` 游标不推进** |
| PD1–PD2（停机排空，\#121） | 同上文件（+2） | PD1 在 tick 挂起于资格查询时调用 `stopAndDrain`：drain **不提前返回**（放行前断言未 settle），放行后 tick 不发起任何 enqueue——`runs` 仍为 1（时钟已推进到下一次 occurrence，泄漏的 enqueue 会真建 Run）、游标与 revision 不变、零日志；PD2 资格查询抛错：异常不被排空集合吞掉（经 Croner `catch` 收口为固定 `croner_error`），`stopAndDrain` 正常结束且无写入 |
| E1–E4（enqueue 边界资格门，\#122） | `server/src/coordinator/enqueue.test.ts`（19 项，+6） | E1×3 未认领/已撤销/孤儿机器的手动触发 → `machine_ineligible`，且 machines/loops/runs **三表整体相等**（既有 pending 的 `phase/outcome/message/ts` 逐字段不变，即未 supersede、未 bump revision）；E2 直接调用 store 的 `enqueueExecRunTx` 同样拒绝（门在 store 边界，不是 coordinator 的礼节）；E3 scheduled 触发（catch-up/陈旧回调路径）拒绝且 `lastScheduledAt` 不推进；E4 对照：同一 loop 在其机器被认领后正常入队并 supersede 旧 pending |
| 手动触发的 HTTP 映射 | `server/src/http/app.test.ts`（50 项，+1） | 未认领机器 loop 的 `POST /api/loops/:id/run` → **平 404 `not found`**（与未知 loop 同分类，不落入 `running_exists` 200 兜底），runs/loops 前后整体相等、既有 pending 原样保留 |
| Report 独立语义回归 | `server/src/coordinator/report.test.ts`、`lifecycle.test.ts`、`poll-progress.test.ts`（全绿） | 本片未触碰 RunLease 验证与终态语义；既有 lease 的合法 Report 与迟到 reconcile 行为不变 |
| 存量装配改造（自注册假设清理） | coordinator/restart-e2e/daemon-e2e/phase4-*/phase5-batch2-* /integration/start/roundrobin/fault-injection 等 20 余文件 | 所有 poll/claim 类测试改为显式预置**已认领**机器（`seedClaimedMachineForToken` / `seedClaimedMachineIfAbsent` / `seedClaimedMachineById`）；原先以「机器出现在 `/api/machines`」作 daemon 就绪信号的 6 处（phase4-batch2、phase4-batch3、slice4-secret 及三个 opt-in real-Claude E2E）改判 `lastSeen` 非空——机器行现在预先存在，行存在不再证明 daemon 已启动。三个 opt-in real-Claude 文件同步补齐预置与就绪判据，避免人工演练时因 401 卡死 |

### 显式边界核对（片 3）

- **停止边界**：不提供新机器接入（ConnectKey = Batch 4）、不提供在线撤销入口、不通过测试开关恢复自注册。本片删除自注册**连实现一并删除**（`registerMachineOnPoll` 与仅服务于它的 `machineNameFallback` 已移除）。
- **资格复验边界**：启动扫描（SQL JOIN 过滤）+ cron tick（提交前复验）+ **enqueue 边界**（`enqueueExecRunTx` 在事务前以 `isMachineExecutionEligible` 复验，零写入拒绝）三处落地——手动触发、Dashboard、cron 与 catch-up 全部经该唯一写入口，故四条入队路径同受一闸。claim 边界不另加检查：poll 在任何 claim 之前已用同一凭据门验证机器，候选集合 `pendingExecRunsForMachine` 亦由该机器 id 限定，且本片无在线认领/撤销入口（撤销仅经片 4 停服 CLI），不存在并发归属变化窗口（ADR-011 决策 16）。管理面 Session 门禁与创建 Loop 时的机器归属校验仍由片 5 承担。
- **命名空间切换**：生产 Artifact namespace 由机器 id 改为所属 Team id（ADR-011 决策 2 的落实，决策 14 记录）。存储键规则、wire 形状、manifest/session 契约均不变；片 4 认领在复制 Blob 后以单事务切换元数据。
- **protocol 增量**：无。本片不改 wire DTO、不新增迁移（journal 保持 7 条）。
- **测试接缝**：testkit 新增 `TEST_TEAM_ID` 常量与三个已认领机器 fixture（`seedClaimedMachineForToken` 按 token、`seedClaimedMachineIfAbsent` 幂等重启版、`seedClaimedMachineById` 按 id）；`seedMachine` 的三参签名由 `(db, id, tokenHash)` 改为 `(db, id, overrides)`，与 `seedMachineForToken` 统一为 overrides 形式，`teamId`/`revokedAt` 等显式字段由调用点声明。TEST-ONLY，不进构建产物。

### 变异验证（片 3）

每次变异注入后运行定向套件，随后以备份文件 `cp` 恢复并逐字节 diff 确认复原。

| 变异 | 落点 | 结果 |
|---|---|---|
| M1 排空集合不登记 tick | `scheduler/index.ts` 回调去掉 `trackInFlight` | PD1 红（`stopAndDrain` 提前返回：`drained=true`） |
| M2 资格查询后不复检 `stopped` | 同上，删去第二个守卫 | PD1 红（停机后真建 Run：`runs` 长度 2） |
| M3 拒绝前泄漏 Run 写入 | `verifyEligibleMachineCredential` 两个拒绝分支各插入一条真实 runs 行 | poll 编组 6 项全红（同一变异在原 machines 单表 oracle 下曾 4/4 全绿） |
| M4 拒绝前泄漏 Lease 写入 | 同上，插入 run_leases 行 | poll 编组 3 项红（PG1 ordering、PG5、PG5b） |
| M5 Artifact 拒绝前泄漏 session 写入 | `artifact/api.ts` 的 401 前插入 artifact_sync_sessions 行 | artifact 路由 PG5/PG5b 双红 |

M3–M5 覆盖 Run/Lease/Artifact 三类副作用，证明 oracle 对每一类都能检出；M1/M2 证明停机排空的确定性交错测试能检出对应回归。

### 完整质量门（片 3）

```text
$ pnpm test          # EXIT=0
  packages/protocol: 16 files / 292 tests
  packages/daemon:   34 passed + 2 skipped files / 790 passed + 7 skipped tests
  packages/server:   87 passed + 3 skipped files / 1175 passed + 3 skipped tests
$ pnpm typecheck     # EXIT=0
$ pnpm build         # EXIT=0
$ pnpm --filter @loopzhb/server db:check   # EXIT=0；schema.ts 与 drizzle/ 零漂移（本片无新增迁移）
$ git diff --check   # EXIT=0
```

server 较片 2 基线（`78e51b7`，1139+3skip）**+36**，全部为资格门控与归因切换的新证据，无删除后未补偿的覆盖：`store/machines.test.ts` +6（PG2–PG5b、PG6）、`coordinator/poll.test.ts` 净 +7（PG 门控编组 9 项替换自注册编组 4 项、判定顺序回归 1、identity 清洗/封顶补回 1；四类凭据的顺序断言与全表 oracle 不增减项数）、`http/artifact-routes.test.ts` +2（PG5/PG5b）、`artifact/attribution-team.test.ts` +7（新文件 AT9）、`scheduler/scheduler.test.ts` +7（PE1–PE5 + PD1/PD2）、`coordinator/enqueue.test.ts` +6（E1–E4）、`http/app.test.ts` +1（手动入口 machine_ineligible）。protocol 与 daemon 包零改动（292 / 790+7skip 与片 2 一致）。

### 结论（片 3）

本片验收确认：生产自注册已彻底移除——未知、未认领、已撤销三类机器凭据在 poll 与 Artifact 两条路径上统一 401，且凭据门整体先于 capability 资源策略与任何心跳/快照/claim 写入；未认领、已撤销与孤儿机器的 loop 不注册调度、不 catch-up、不在 enqueue 边界新增 Run、不 supersede 既有 pending、游标不推进；生产 Artifact namespace 已切换为所属 Team；拒绝路径的零写入由覆盖全部业务表的非空 oracle 与三类副作用变异证明。机器接入（ConnectKey）、离线认领与在线撤销分别留待 Batch 4 与片 4。
