# Phase 5 验收测试记录

> 本文档按批次记录 Phase 5 的内部验收证据，各批次一节。各批次的交付范围与完成定义见其权威计划
> （Batch 1：`docs/plan/codex-phase5-batch1-plan.md`；Batch 2：`docs/plan/codex-phase5-batch2-plan.md`）。
> **Phase 5 未收口**：Batch 3 片 1–7 已实现，片 7 待独立三轨复审；Batch 4–6 未开始。

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
**Batch 1 完成（2026-10-03）**，批次 PR #68 已转待合入。Batch 2（watcher、持续同步、Run 快照与
文件视图）已完成；Batch 3（认证）片 1–7 已实现、片 7 待独立复审，证据见下文各批次段。

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
- **批次 PR**: [#119](https://github.com/zhuabo001/loop-platform-zhb/pull/119)（保持 OPEN，合入另行授权）
- **片 7 环境**: 2026-10-20，Node.js v24.21.0，同一分支；验收时 `feat/phase5-batch3-dev` @ `3852539` + 本片工作区
- **长期决策**: `docs/adr/011-phase5-identity-and-legacy-claim.md`（决策 1–38；片 7 增补 34–38）

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

## 片 4 — 离线认领与 Artifact namespace 迁移

> 权威计划：`docs/plan/codex-phase5-batch3-slices-plan.md` 第 50–70 行与 Slice 4 节；长期裁决：`docs/adr/011-phase5-identity-and-legacy-claim.md` 决策 20–22。

### 测试编组与结果（片 4）

**LM3–LM10 映射**：计划原文列出 9 个短语但只给 8 个编号，按列表序把「重复/跨团队认领」并入 LM5；映射如实记录于此。

| 编号 | 场景 | 文件 |
|---|---|---|
| LM3 | 未知目标（用户缺失 / 无个人团队 / 团队缺 owner membership） | `claim/args.test.ts`、`claim/slice4-refusal-e2e.test.ts` |
| LM4 | 错误机器（机器缺失 / 已撤销） | `claim/slice4-refusal-e2e.test.ts` |
| LM5 | 重复认领幂等 no-op + 跨团队整组拒绝 + 重复 `--machine-id` 用法错 | `claim/slice4-e2e.test.ts`、`claim/slice4-refusal-e2e.test.ts` |
| LM6 | 停服要求（真实 Server 持锁 ⇒ 退出 3 且数据库未被打开；停服后同一命令成功） | 同上 + `data-dir-lock.test.ts` |
| LM7 | 活跃 Run 拒绝（`running` 拒绝 / `done` 放行 / `pending` 只警告） | `claim/slice4-refusal-e2e.test.ts` |
| LM8 | 复制失败（源缺失 / 源损坏 / 目标既存但损坏且不被覆盖 / 注入 storage_error 且第五个之后失败） | 同上 |
| LM9 | 事务回滚 + 规划后被抢注的守卫 | 同上 |
| LM10 | 断点重试、同 hash 复用、历史完整性与原凭据恢复 | `claim/slice4-e2e.test.ts` |

**编组明细**：

- **参数层**（`claim/args.test.ts`，14 项，纯单测无 I/O）：文档化调用形态、`--data-dir` 相对路径按 cwd 解析、`--machine-id` 可重复且保序、单个前导 `--` 容忍、`--dry-run` 默认假、帮助探针在 flag 槽生效而**值槽不生效**（`--data-dir --help` 是畸形值而非探针）、未知 flag/位置参数/`--dry-run=true`/重复单值 flag/重复 `--machine-id` 值/缺值/`--` 形状值/空值/非十进制 uid/零个 `--machine-id` 全部拒绝；USAGE 文本钉住锁路径、`rm` 恢复行与四个退出码。
- **锁**（`data-dir-lock.test.ts`，8 项，真实临时目录无接缝）：持有者记录（pid/role/startedAt/主机名）与 0600 权限、释放后文件消失且二次释放幂等、第二次获取被拒并报出持有者、手写陈旧锁被拒且拒绝文本含 `rm <路径>`（损坏记录**仍是锁**）、**释放的 inode 守卫**（锁文件被换掉后释放不动新文件）、Server 启动以 `role: server` 记录、被锁时 `bootstrapServer` 拒绝**且未创建 pgdata**、`closeDb` 释放锁后同一 dataDir 可再次启动、取锁后开库失败也归还锁。
- **dry-run**：报告目标账号/团队/机器/计数/需复制字节数，`<root>/<teamId>` 不产生目录，11 表 oracle 前后相等，源字节仍在。
- **认领全链路**（`claim/slice4-e2e.test.ts`，6 项）：manifest `namespaceId` 迁移且 `id`/`entries`/`manifestRevision`/`committedAt` 逐字不变；两 session（含已提交）迁移且 receipt 逐字不变；机器 `id`/`tokenHash` 不变、仅 `team_id` 变化；团队 namespace 与源 namespace 各 3 个文件**并存**；源元数据行 3 行**保留**；二次运行是 no-op（11 表 + 目录列表不变）；两机器同 hash 单次运行只发布一次（计数装饰器断言恰好 1 次）、分两次运行第二次报 `0 copied / 3 reused` 且零发布；原凭据 `verifyEligibleMachineCredential` 返回同一行、`isMachineExecutionEligible` 为真、认领后新一轮 prepare→PUT→commit 落在 `<dataDir>/blobs/<teamId>/<hash>`。
- **拒绝矩阵**（`claim/slice4-refusal-e2e.test.ts`，17 项）：LM3 三变体、LM4 两变体、LM5 整组拒绝、LM6 真实 Server 持锁（退出 3，且经 Server 自己的 handle 断言其机器行未被触碰）、LM7 的运行中 Run（拒绝并在终态后放行、残留 pending 计入警告）、LM8 四变体（源文件缺失、源同长度异内容、**目标既存损坏且逐字节未被覆盖**、注入 storage_error 在第 6 次写时失败——前 5 个已落盘而**没有任何机器被认领**）、LM9 两项（注入回滚；规划后机器被另一团队抢注 → `claim_guard_lost` 且另一台机器同样未被认领）、LM10 三项链不一致（manifest namespace 漂移、manifest entry 无 blob 行、loop 快照游标悬空）。

**零写入 oracle**：拒绝路径一律在**非空世界**（预置已认领前置状态、loop、Run、真实落盘的 blob 与行、manifest、已提交与 pending session）上比对 `snapshotBusinessState`（7 张业务表）**加**新增的 `snapshotIdentityState`（users/teams/memberships/auth_sessions，共 11 张表，全字段、确定性排序）。

### 显式边界核对（片 4）

- **停止边界**：不在线认领、不迁移已归属机器、不删除源 Blob（文件与元数据行均保留）、不预建 GitHub 身份、不实现 ConnectKey（Batch 4）。管理面 Session 门禁与团队过滤 = 片 5；Dashboard 登录态 = 片 6；真实 HTTP 升级演练与跨进程锁断言 = 片 7。
- **偏差点（如实登记）**：计划第 227 行把「dataDir 锁接入实际生产组合根」列为片 7 收口项，本片**提前接入 `bootstrapServer`**（ADR-011 决策 20 记录理由：PGlite 0.5.4 无跨进程文件锁，只有 CLI 持锁等于没有锁）。片 7 保留真实 HTTP 演练、进程级跨进程断言与 README 之外的运维收口。
- **未覆盖的分支（如实声明）**：`target_team_namespace_invalid` 在 `teams_id_namespace_ck` 下**构造性不可达**，作为防御性拒绝保留但**没有测试**（本记录不声称有覆盖）。dry-run **不做内容校验**（用户裁定：只做元数据行 + 存在性 lstat），损坏的源 Blob 只在执行阶段暴露。CLI 与 Server 共用 `openMigratedDb`，故 **CLI 可能顺带应用迁移**——升级顺序保证 Server 先启动过，这是已披露行为而非缺陷。
- **仅证到模块/HTTP 层**：LM10 的「原 Daemon 可恢复同步和执行」在本片以凭据门、执行资格谓词与真实 prepare→PUT→commit 落盘证明；**进程级**的「Daemon 子进程重启后继续同步与执行」属片 7（BI1–BI6），本片不声称。
- **无新迁移**：所需列全部来自 0005/0006，journal 保持 7 条，`db:check` 零漂移，三处 `count = 7` 的钉桩测试无需改动。
- **protocol/daemon 零改动**：本片只动 `packages/server`。
- **测试接缝**：testkit 新增 `artifact-history.ts`（真实 `writeVerified` 落盘、真实 sha256、可注入撒谎行与原始写文件）与 `claim-fixtures.ts`（世界夹具、CLI 调用器、11 表 oracle、注入失败/计数装饰器）；两者经 `tsconfig.build.json` 排除，不进 dist。`claim-fixtures` **刻意不由 testkit 桶文件再导出**（它 import 桶文件，再导出会形成模块环），两个 e2e 文件直接 import。

### 变异验证（片 4）

八项变异，全部被对应用例抓住（每项恢复后逐字节复核）：

| 变异 | 目标用例 |
|---|---|
| M1 锁获取由 `"wx"` 改为 `"w"`（不再互斥） | LM6（真实 Server 持锁时 CLI 仍应退出 3） |
| M2 事务提到拷贝之前 | LM8「第六次写失败时全部机器未认领」 |
| M3 复用路径信任目标、不回读验证 | LM8「目标既存损坏」 |
| M4 session 的 `namespace_id` 不迁移 | 全链路「receipt 逐字不变」 |
| M5 删除跨团队拒绝 | LM5「整组拒绝」 |
| M6 删除 `machines.team_id IS NULL` 守卫 | LM9「规划后被抢注」（本项**首轮未被抓住**，为此补 `beforeClaimTx` 接缝与该用例后才转红——缺口由变异验证自身发现，如实记录） |
| M7 接受无 blob 行的 manifest entry | LM10「manifest entry 无 blob 行」 |
| M8 `closeDb` 不释放锁 | 锁「关库释放后同一 dataDir 可再次启动」 |

### 完整质量门（片 4）

```bash
pnpm test                                   # protocol 292 / daemon 790 + 7 skipped / server 1220 + 3 skipped，EXIT=0
pnpm typecheck                              # EXIT=0
pnpm build                                  # EXIT=0（产出 dist/claim/main.js）
pnpm --filter @loopzhb/server db:check      # 零漂移（本片无新增迁移），EXIT=0
git diff --check                            # EXIT=0
```

server 较片 3 基线（1175 + 3 skipped）**+45**，恰为新增的四个套件：参数 14 + 锁 8 + 认领全链路 6 + 拒绝矩阵 17。protocol 与 daemon 计数不变（本片零改动这两个包）。

**构建产物烟测（真实进程，非单元层）**：以真实 `dist/start.js` 启动 Server（临时 dataDir、真实 HTTP 端口），在另一个进程执行 `dist/claim/main.js`——退出码 **3**，stderr 为固定的锁拒绝文本（含持有者 pid/role/时间与 `rm` 恢复行）；SIGTERM 停止 Server 后锁文件消失，同一命令再次执行进入业务判定并以 `target_user_missing` 退出 **1**。该烟测另抓出「锁拒绝文本缺尾换行导致 shell 提示符粘连」并已修复（拒绝矩阵中以 `endsWith("\n")` 钉住）。

### 结论（片 4）

片 4 交付离线认领命令与 dataDir 独占锁。LM3–LM10 全覆盖，五道质量门全绿，八项变异全部被对应用例抓住。三条如实登记：**dataDir 锁从片 7 提前接入 `bootstrapServer`**（ADR-011 决策 20 记录理由与偏差）、**`target_team_namespace_invalid` 构造性不可达因而无测试**、**LM10 的「原 Daemon 恢复」只证到模块/HTTP 层**（进程级证据属片 7）。本片未关闭任何既有 Issue，也无需新建：实施过程中的两处真实缺口（M6 守卫无覆盖、拒绝文本缺尾换行）由变异验证与真实进程烟测自身发现并当轮补齐。

## 片 5 — 管理 API Session 门禁与团队过滤

> 权威计划：`docs/plan/codex-phase5-batch3-slices-plan.md` Slice 5 节（行 170–190）；长期裁决：`docs/adr/011-phase5-identity-and-legacy-claim.md` 决策 23–28。

### 测试编组与结果（片 5）

**MG1–MG10 映射**：

| 编号 | 场景 | 文件 |
|---|---|---|
| MG1 | 匿名访问全部 15 条管理路由 + 未知 `/api/*` → 401；`/api/session`、`/api/machine/*` 豁免；认证先于 body 解析 | `http/management-routes.test.ts`、`management/access.test.ts`、`phase5-batch3-slice5-e2e.test.ts`、`start.test.ts`（生产组合根 pin） |
| MG2 | 过期边界（恰在到期时刻 401、前一毫秒 200）、未知/空/畸形 cookie、身份链断裂 → 401 | `management/access.test.ts`、`testkit/management-session.test.ts`（fixture 的时钟推算） |
| MG3 | A/B/未认领三世界的 machines、loops、runs 列表隔离；summary 同规则 | `admin/team-scope.test.ts`、`http/management-routes.test.ts` |
| MG4 | 过滤先于排序与限量：B 团队 100+ 条更新更晚的 loop / 排序更靠前的 machine，A 团队的唯一条目仍返回 | `admin/team-scope.test.ts` |
| MG5 | 创建 Loop：他团队、未认领、不存在机器 → 扁平 404，零写入 | `admin/team-scope.test.ts`、`http/management-routes.test.ts` |
| MG6 | trigger、cancel、schedule、goal、task-file、reopen、artifact-dir 的全部跨团队/未认领/缺失组合 → 404 且与 `/nope` 逐字节相等；11 表快照不变 | `http/management-routes.test.ts`、`phase5-batch3-slice5-e2e.test.ts` |
| MG7 | `/api/loops/:id/runs`、artifacts、diff、download 的跨团队读取 → 404 | 同上 |
| MG8 | Artifact 归属检查先于 attribution / snapshot / blob：跨团队 download 的 store `read` 调用数不增加（对照 unscoped 路径证明 blob 真实存在） | `artifact/scope.test.ts`、`http/management-routes.test.ts` |
| MG9 | 未认领机器的完整历史（pending Run + lease + 历史行）在全部拒绝路径后逐字节保留；它不出现在任何列表；trigger 不新增/不 supersede | `phase5-batch3-slice5-e2e.test.ts` |
| MG10 | 机器 Bearer 打管理路由 401、Session cookie 打 `/api/machine/poll` 401、同时携带互不提升 | `management/access.test.ts` |

**编组明细**：

- **归属链查询**（`store/scope.test.ts`，7 项）：own/foreign/unclaimed/missing 四态；孤儿 loop 与孤儿 run 折叠为 `found:false`；**run 的归属经其 loop 推导而非 `runs.machine_id`**（刻意让冗余列指向他处的回归）；`teamMatches` 拒绝 null/空串。
- **门禁**（`management/access.test.ts`，11 项）：豁免谓词逐路径（含 `/api/machines` 与 `/api/machine` 的斜杠边界）；13 条管理路由匿名 401；过期边界；四种坏凭据与身份链断裂；凭据混用三方向；**Hono 路径参数绑定证明**（自有 loop 的 `POST /api/loops/:id/run` 返回 200，陌生 loop 返回 404——绑定失效时自有 loop 也会 404）。
- **testkit**（`testkit/management-session.test.ts`，3 项）：会话过期按调用方时钟推算（而非 FIXTURE_T0）；A/B 两会话同库并存；请求包装器只补 cookie、不覆盖调用方显式 cookie。
- **团队查询**（`admin/team-scope.test.ts`，5 项）：MG3/MG4/MG5 的查询级证据；Dashboard 临时无 scope 出口仍可见全部 loop。
- **Artifact 归属**（`artifact/scope.test.ts`，6 项）：他团队与未认领 loop/run 的 view/run/diff/download 全部折叠为既有 404 字面量；跨团队时 **attribution 解析次数为 0**；download 在拒绝路径上 **store `read` 次数不增加**；自有团队四条读取正常。
- **HTTP 矩阵**（`http/management-routes.test.ts`，9 项）：15 条路由匿名 401；豁免面；认证先于畸形 body；写矩阵逐字节 404；非空世界（run + lease + manifest + 真实 blob）的 11 表零写入；创建 Loop 的三类拒绝 + 零写入；跨团队 download；列表隔离。
- **生产根 E2E**（`phase5-batch3-slice5-e2e.test.ts`，5 项）：经 `bootstrapServer` + 文件型 PGlite；匿名 401；A/B/未认领矩阵；MG9 历史逐字节保留；A 团队 trigger 正常（旧 pending 被 supersede、新 run pending）；B 会话只见 B 且无法操作 A。

**既有测试迁移（如实记录）**：`createServerApp` 改为 options object（20 个调用点由 typecheck 逐一列出），管理请求统一经 testkit 的 `withManagementSession` 注入会话；管理路径涉及的机器夹具改为已认领（`TEST_TEAM_ID`），而 PG5/PG6 等「未认领拒绝」负例**保留未认领机器**。迁移中钉住的两个时钟陷阱：`seedSession` 的默认过期是 FIXTURE_T0+7d，使用其他 FakeClock 的 bootstrap 测试必须按调用方时钟推算（`seedManagementSession` 已内建）；`bootstrapServer` 的生产默认时钟是 `systemClock`，Dashboard 挂载测试必须用同一时钟种会话。

### 显式边界核对（片 5）

- **停止边界**：Dashboard 登录态（片 6）、ConnectKey/在线接入（Batch 4）、在线撤销与团队迁移、Batch 4 的深模块/事务权限隔离均未实现；**#56 保持 OPEN 不核销**（同源意图校验、`Content-Type` 门禁、拒绝空体仍未做）。
- **Dashboard 仍未认证（如实声明）**：`GET /`、Run Now 与 artifact config 表单在片 5 仍只有回环 Host 边界；未认领机器与旧 Artifact 仍可能出现在 Dashboard 页面，直到片 6。
- **归属中间件的前提**：依赖「Server 运行期间归属不可变」——认领只能由片 4 的停服 CLI 发生，本批无在线撤销。Batch 4 引入在线归属变更时必须重审中间件读取与处理器写入之间的 TOCTOU。ADR-011 决策 25 已登记。
- **行为变化（如实披露）**：未知 `/api/*` 的匿名响应由 404 变为 401（默认拒绝的后果）；匿名畸形/超大管理请求由 400/413 变为 401（认证先于解析）；`createServerApp` 的装配形状变化不构成 wire 变化。
- **写归属只在 HTTP 边界**：`updateArtifactConfig` 等域函数不加 teamId；`PATCH /api/loops/:id/artifact-dir` 由 loopGate 在处理器前拦截。这是 D2 的直接后果，已记录。
- **不在本片核验**：真实 HTTP 升级演练与生产认证不可旁路的完整验收属片 7（BI1–BI6）；真实 GitHub OAuth 与真实 Claude 未执行。MG 矩阵使用预置 Session 与测试时钟。
- **无新迁移**：本片不新增迁移，journal 保持 7 条，`db:check` 零漂移。

### 变异验证（片 5）

八项变异，全部被对应用例抓住（每项恢复后复跑）：

| 变异 | 击红的用例 |
|---|---|
| M1 删除 `app.use("/api/*", sessionGate)` | 匿名矩阵 11 项失败（MG1） |
| M2/M3 豁免谓词改为 `startsWith("/api/machine")`（丢失斜杠边界） | `/api/machines` 匿名不再 401；豁免谓词单测与 MG3 列表同时变红 |
| M4 删除 `listMachines` 的 team 过滤 | MG3 与列表隔离用例 |
| M5 `listLoops(teamId)` 退化为无 scope 查询 | MG3 + **MG4「A 团队唯一条目仍返回」** |
| M6 loopGate 永远放行 | MG6 写矩阵、零写入 oracle、MG9 历史保留、B 会话无法操作 A |
| M7 `resolveLoopScope` 删除团队比较 | MG8 的 view/download/diff/镜像四面（management-routes 因 loopGate 先行仍绿，证明纵深是两道） |
| M8 sessionGate 改读 `Authorization` 而非 Cookie | MG1 认证用例、MG2 过期边界、MG10 三方向、MG9 |

### 完整质量门（片 5）

```bash
pnpm test                                   # protocol 292 / daemon 790 + 7 skipped / server 1267 + 3 skipped，全绿
pnpm typecheck                              # EXIT=0
pnpm build                                  # EXIT=0
pnpm --filter @loopzhb/server db:check      # 零漂移（本片无新增迁移），EXIT=0
git diff --check                            # EXIT=0
```

server 较片 4 基线（1220 + 3 skipped）**+47**，恰为新增的七个套件与一处生产 pin：归属链 7 + 门禁 11 + testkit 3 + 团队查询 5 + Artifact 归属 6 + HTTP 矩阵 9 + 生产根 E2E 5 + `start.test.ts` 的生产门禁 pin 1。protocol 与 daemon 计数不变（本片零改动这两个包）。

**一次真实抖动（如实记录）**：首次全仓 `pnpm test` 中，daemon 的 `artifact-watcher.test.ts`「原子保存」用例以 5 秒超时失败；单独复跑该文件 6/6 通过，随后全仓复跑全绿。该用例依赖真实 chokidar 的文件系统事件，在并行负载下抖动；与本片改动无关（本片未触碰 daemon）。

### 结论（片 5）

片 5 结束了「机器自注册已关、管理面仍匿名」的中间态：管理 JSON API 默认拒绝、只认 Session；登录后只能看见与操作自己团队；未认领、跨团队与不存在的资源在管理入口统一扁平 404；归属检查先于 attribution、快照与 blob。MG1–MG10 全覆盖，五道质量门全绿，八项变异全部被抓住。如实登记四条：**生产组合根从片 7 提前接线**（ADR-011 决策 28）、**Dashboard 在片 6 前仍未认证**、**未知 `/api/*` 的匿名响应由 404 变 401**、**归属中间件依赖本批「无在线归属变更」的不变量**。本片不核销 #56。

### 三轨审查 Round 1 与修复（2026-10-20，片 5）

审查记录：`docs/handoff/codex-handoff-phase5-batch3-slice5-code-review.md`（按约定 gitignore，不入库）。固定范围 `f646b4f...b48e918`。结论：Standards 0 项 P1/P2 + 1 项 P3，Specs 0 项 P1/P2 + 1 项 P3，Adversarial 0 项发现。两项 P3 均已在实现侧修复并各自经变异证明。

**Standards P3 — `withManagementSession` 丢弃 Request 自身头部。** 原因：helper 无条件下 `new Headers(init?.headers)` 并把结果塞回 `init.headers`；Hono 对 `Request` 输入执行 `new Request(input, init)`，而 fetch 规范规定 init 的 headers **整体替换** 输入的头部列表。于是 `app.request(new Request(...))` 形态下，调用方显式设置的 cookie 与全部其他头部被丢弃，负例身份可被注入会话静默认证（违反 helper 自述契约）。修复：`init.headers` 显式给出时以其为基线（保留 Hono 的 init 覆盖语义）；未给出且输入为 `Request` 时以该 Request 的头部为基线；否则空基线。只在基线没有 cookie 时才注入。新增 2 项回归：Request 携带显式 cookie + 其他头（必须都保留）、Request 无 cookie（注入且保留其他头）、以及 init 覆盖 Request 的 Hono 语义。变异：把 helper 退回旧的一行实现 ⇒ 新用例红（1 项），恢复后绿。

**Specs P3 — 零写入 oracle 的 Artifact 历史 fixture 为空。** 原因：`snapshotBusinessState` 已包含 `artifact_sync_sessions`，但 `http/management-routes.test.ts` 的夹具只有 manifest/blob 没有 sync session，生产根 E2E 的三张 Artifact 表全空；空表相等无法证明拒绝路径没有 UPDATE 既有 receipt 或 DELETE pending session（计划要求非空世界）。修复：management-routes 夹具在 A/B/未认领三个世界各补 manifest + sync session（A、B 为带 receipt 的 committed；未认领为 pending，即「清理式 bug」会删的那一行）；生产根 E2E 经 `createProductionArtifactHome` 的真实 LocalBlobStore 在 `<dataDir>/blobs` 下补齐 A/B/未认领的 blob + manifest + sync session（B 用 `TEAM_B` namespace；未认领沿用片 4 之前的每机器 legacy namespace，且 session 保持 pending）。变异：在拒绝 helper 内注入 `delete artifactSyncSessions` ⇒ MG6 零写入与 MG9 历史保留各红一项，恢复后全绿。

**复审后质量门**：`pnpm test` server **1269 + 3 skipped**（较修复前 +2，为 helper 的两项新回归）、daemon 790 + 7 skipped、protocol 292，全绿；`pnpm typecheck`、`pnpm build`、`db:check`（零漂移，journal 仍 7 条）、`git diff --check` 全部 EXIT=0。修复仅触及测试与 testkit，生产代码零改动，wire 与迁移均无变化。

## 片 6 — Dashboard 登录态与团队视图

> 权威计划：`docs/plan/codex-phase5-batch3-slices-plan.md` Slice 6（行 192–213）。长期裁决：ADR-011 决策 29–33。

### 测试编组与结果（片 6）

| 编号 | 场景 | 文件 |
|---|---|---|
| DG1 | 匿名 GET/HEAD 的全部 Dashboard 路径 → 303 `/login`，带安全头、无 Set-Cookie；`/dashboardX` 不被门禁匹配；非回环仍 404 | `dashboard/access.test.ts`、`dashboard/routes.test.ts`、`dashboard/mount.test.ts`、slice6 e2e |
| DG2 | 匿名 POST（Run Now、Artifact 配置、非 loop 路径的 dashboard 写）→ 401，认证先于 415/413，零写入（`snapshotBusinessState` 7 张业务表 + `snapshotIdentityState` 4 张身份表，均于匿名 POST 前采集、循环后比较） | `dashboard/access.test.ts`、`dashboard/routes.test.ts`、slice6 e2e |
| DG3 | 登录后 A 只见 A 的 Loop 与账号块；B 只见 B；空团队 C 显示认领指引；列表限量发生于团队过滤之后 | `dashboard/index.test.ts`、`dashboard/page.test.ts`、`dashboard/routes.test.ts`、slice6 e2e |
| DG4 | A 会话访问 B/未认领/不存在/孤儿 Loop → 与 `/nope` 逐字节相同的 404（页面与写入）；零写入 | `dashboard/access.test.ts`、`dashboard/routes.test.ts`、slice6 e2e |
| DG5 | 跨 Session CSRF → 403 零写入；`/api/session` token 与页面隐藏值相等；重启后同 Session token 仍有效；另一 Session 的 token 被拒 | `dashboard/routes.test.ts`、`dashboard/mount.test.ts`、slice6 e2e |
| DG6 | 退出 → 303 `/login` 并清 cookie；旧 cookie 页面 303、`/api/session` 401；同用户第二 Session 仍有效 | `dashboard/page.test.ts`、`auth/routes.test.ts`、slice6 e2e |

**编组明细**：

- **门禁**（`dashboard/access.test.ts`，8 项）：`/` 与 `/dashboard/*` 的路径绑定证明（含 `/dashboardX` 不匹配）；匿名 GET/HEAD 303 与无 Set-Cookie；匿名非 GET 401（含一条非 loop 路径，防止归属门禁的 401 掩盖 pageGate 回归）；过期、未知、身份链断裂与空凭据均视为匿名；Loop 归属门禁的自有/跨团队/未认领/孤儿/缺失五面，404 与 `app.notFound` 逐字节一致且无 Dashboard 头；无 pageGate 时 loopGate fail-closed 401。
- **读模型**（`dashboard/index.test.ts`，7 项）：`snapshot(teamId)` 的排序、限量与生命周期语义不变；新增 D6「A 的旧 Loop 在 B 的 100 条更新更晚的行之后仍出现」与 D7「boundSnapshots 的 SQL 团队过滤」；孤儿 Loop 从 fail-safe 渲染改为被排除。
- **页面**（`dashboard/page.test.ts`，24 项）：账号/团队渲染与转义；退出表单 action `/auth/logout`、唯一具名 `csrf` 控件；空团队的 `claim:legacy` 指引与占位符转义；Run 表单断言改为按 action 定位（页头新增了退出表单）。
- **HTTP 矩阵**（`dashboard/routes.test.ts`，27 项）：H2 XSS、H3 每状态安全头、H4 CSRF/表单边界、H5 跨 Session、H6 业务 303/固定 500/未知 loop 改 404、H7 Host 门禁、H8 按钮与后端一致、H9 不替换 pending；新增 DG1/DG2 与 DG4 两条矩阵；Artifact 页面测试补 owned Loop 夹具，错误路径仍钉 403/404 与「先取领域判定再读快照列表」。
- **生产装配**（`dashboard/mount.test.ts`，5 项）：经 `bootstrapServer` 的匿名 303/401、非回环完全缺席；H5 改为「重启后同 Session token 仍有效 + 另一 Session token 403」；Run Now 与 Artifact 配置全程带 cookie。
- **生产根 E2E**（`phase5-batch3-slice6-e2e.test.ts`，1 项，含 DG1–DG6）：脚本化 GitHub adapter 登录 A/B/C，A、B 各一台已认领机器与 Loop，U 未认领；匿名跳转、团队视图、跨团队扁平 404、跨 Session CSRF、退出后第二 Session 仍有效。DG2 与 DG4 的零写入均同时比较业务与身份两半 oracle；DG2 的两次快照都取自匿名 POST 之前，身份表在三次登录后已非空。
- **登录页**（`auth/routes.test.ts`，+1）：已登录 `GET /login` → 303 `/`；未知 cookie 仍 200。

**既有测试迁移（如实记录）**：`dashboard/routes.test.ts` 改为真实 Session + `createDashboardAccess`，请求默认携带 cookie，token 常量换成 `deriveSessionCsrfToken`；`mount.test.ts` 的「重启使 token 失效」断言**反转**为「重启不改变派生 token」；匿名页面 200 改 303、匿名 POST 403 改 401；`artifact/read.test.ts` 的 `UNSCOPED` 常量整体替换为 `{ kind: "team", teamId: TEST_TEAM_ID }` 且机器夹具改为已认领（约 35 处机械替换）；`artifact/scope.test.ts` 的对照从「unscoped 可读他团队 blob」改为「他团队自己的 scope 可读」，比原对照更强；`admin/team-scope.test.ts` 删除临时无 scope 读取测试；`phase4-batch3-e2e.test.ts` 的页面 GET 与表单 POST 补 Session cookie；opt-in 的真实 Claude E2E 同步补 cookie，但本片未执行。

### 显式边界核对（片 6）

- **停止边界**：Connect UI、成员管理、通知、在线认领/撤销、团队迁移均未实现；Dashboard 仍只在回环绑定挂载；不新增迁移（journal 7 条）；不改 wire DTO；BI1–BI6 与真实 HTTP 升级演练仍属片 7。
- **行为变化（如实披露）**：孤儿 Loop 与未认领机器的 Loop 从 Dashboard 消失（团队 INNER JOIN 的必然结果，与 JSON API 一致）；未知 Loop 的 `POST /dashboard/loops/:id/run` 由业务 303 变为路径门禁 404；重启不再使 CSRF token 失效（派生自持久 Session，跨 Session 才是拒绝边界）。
- **账号/退出控件只在索引页**：四个 Artifact 页面仍受两道门禁保护，但不显示账号与退出按钮。
- **每请求一次 Session 解析**：页面每 3 秒刷新都会读取 user/team；单用户本地服务可接受，未做缓存。
- **归属门禁的不变量**：依赖本批「Server 运行期间归属不可变」；Batch 4 引入在线归属变更时必须重审 TOCTOU。
- **不在本片核验**：真实 GitHub OAuth、真实 Claude、真实 HTTP 升级链路；DG 矩阵使用脚本化 adapter 与测试时钟。#56/#61 保持 OPEN。

### 变异验证（片 6）

十一项变异，全部被对应用例抓住（每项恢复后复跑）：

| 变异 | 击红的用例 |
|---|---|
| M1 删除 `/dashboard/*` 的 pageGate 注册（只留 `/`） | `routes.test.ts` DG1/DG2（artifact 路径匿名请求） |
| M2 匿名非 GET 时 pageGate 直接放行 | `access.test.ts`「匿名非 GET 401」（含非 loop 路径探针） |
| M3 `snapshot()` 忽略 teamId | `index.test.ts` D6 |
| M4 loopGate 只验存在、不验团队 | `access.test.ts` 两条归属用例 |
| M5 loopGate 的 404 换状态/形状 | `access.test.ts` 逐字节 404 与团队 B 用例 |
| M6 Run Now 跳过 Session CSRF | `routes.test.ts` H4 |
| M7 Artifact 配置去掉 `artifactDir` 白名单 | `routes.test.ts`「valid token saves」 |
| M8 `boundSnapshots` 去掉团队 join | `index.test.ts` D7 |
| M9 删除退出表单 | `page.test.ts` 账号/退出用例 |
| M10 重新引入 `{ kind: "unscoped" }` 读取 | `tsc --noEmit`：`Type '"unscoped"' is not assignable to type '"team"'`（编译期） |
| M11（片 6 复审补强）在匿名拒绝返回 401 前 UPDATE `users.updatedAt` | slice6 e2e 的 DG2 身份快照断言（差异列出 alice/bob/carol 三人的 `updatedAt`） |

### 完整质量门（片 6）

```bash
pnpm test                                   # protocol 292 / daemon 790 + 7 skipped / server 1284 + 3 skipped，全绿
pnpm typecheck                              # EXIT=0
pnpm build                                  # EXIT=0
pnpm --filter @loopzhb/server db:check      # 零漂移（本片无新增迁移），EXIT=0
git diff --check                            # EXIT=0
```

server 较片 5 审后基线（1269 + 3 skipped）**+15**：新增 16 项（门禁 8、生产根 E2E 1、读模型 +2、页面 +2、HTTP 矩阵 +2、登录页 +1），删除临时无 scope 用例 1 项，净 +15。protocol 与 daemon 计数不变（本片零改动这两个包）。

### 结论（片 6）

片 6 结束了 Dashboard 的匿名窗口：页面未登录跳转 `/login`、表单未登录 401；登录后只显示本团队资源；跨团队、未认领与不存在的 Loop 在页面与写入上统一扁平 404；所有表单使用当前 Session 派生的 CSRF token；页头显示账号并可退出。DG1–DG6 全覆盖，十一项变异全部被抓住（含一项编译期证明），五道质量门全绿。如实登记：孤儿/未认领 Loop 不可见、重启不再使 token 失效、Artifact 页面暂无账号/退出控件、每请求解析一次 Session。本片不核销 #56/#61，不宣称 Phase 5 完成。

## 片 7 — 生产装配、升级演练与批次收口

> 权威计划：`docs/plan/codex-phase5-batch3-slices-plan.md` Slice 7 节（行 215–237）；长期裁决：ADR-011 决策 34–37。

### 测试编组与结果（片 7）

| 编号 | 场景 | 文件 | 结果 |
|---|---|---|---|
| PG7 | 新库生产启动与连续两次重启：未知/未认领/已撤销凭据均 401，业务 + 身份 11 表零写；已认领控制机 200 | `phase5-batch3-slice7-pg7-pg8-e2e.test.ts` | 通过 |
| PG8 | Batch 2 旧库经 0006 升级并连续重启：旧 token 401；离线认领后同一 token 200，未知 token 仍 401 且零写 | 同上 | 通过 |
| BI1–BI6 | 完整升级链：旧库升级 → 首次登录 → 旧数据不可见 → 停服认领 → 重启 → 原 Daemon 执行与同步 → 旧快照下载 | `phase5-batch3-slice7-e2e.test.ts` | 通过 |
| LOCK-CP1 | 父进程持锁时真实子进程 `open("wx")` 得 EEXIST；释放后可获取 | `data-dir-lock-cross-process.test.ts` | 通过 |
| LOCK-CP2 | 子进程持锁时真实 claim 退出 3、boot 在 `pgdata` 出现前抛 `DataDirLockError`；SIGTERM 后可重新获取 | 同上 | 通过 |
| DRILL | 构建产物子进程：`dist/start.js` 持锁 → `dist/claim/main.js` 3→0 → 内置 daemon CLI 执行并同步 | `phase5-batch3-slice7-subprocess-drill.test.ts`（opt-in） | 通过（单独记录，不计入默认门禁） |
| SD1/SD2 | 停止有界：空闲 keep-alive 不阻塞 close；永不完成的请求在宽限期被强制关闭 | `http/server-shutdown.test.ts` | 通过 |

### BI1–BI6 映射与链（片 7）

单个顺序用例，真实 `127.0.0.1` 监听、文件型 PGlite、本地 BlobStore、脚本化 GitHub adapter、Fake Runner；claim 为进程内调用。

| 阶段 | 断言 | 编号 |
|---|---|---|
| A 升级 | 旧库 journal 6 → 7；七张业务表旧列逐项相等；旧机器 `team_id/revoked_at = null`；身份表为空 | BI1 |
| B 首次登录 | 真实 `/auth/github` + callback（脚本化 adapter）→ 303 `/`；`/api/session` 返回个人团队；未自动认领机器 | BI1 |
| C 旧数据不可见 | `/api/machines` 与 `/api/loops` 为空；旧 Loop 的 Run/下载与 `/nope` 逐字节同 404；Dashboard 200 且显示空团队 + `claim:legacy`、不含旧 Loop；旧 token poll 401；登录后 11 表快照前后相等；`blobs/<teamId>` 不存在 | BI2、BI6 |
| D 服务中拒绝认领 | Server 持锁时 claim 退出 3，stderr 含本进程 pid 与 `rm` 恢复行；机器仍未认领 | BI3 |
| E 迁移失败恢复 | 目标 Blob 长度正确、内容错误 → claim 退出 1、`target_blob_corrupt`；11 表零写；损坏文件未被覆盖；源 Blob 完好 | BI3 |
| F 认领成功 | 退出 0；`machines.id`/`token_hash` 不变、`team_id` 切到个人团队；manifest/session `namespace_id` 切换；snapshot id、entries、revision、committed receipt 逐项不变；源 namespace 保留；目标 Blob 验证通过 | BI1、BI4、BI5 |
| G 重启与保真 | journal 仍 7；原 Session 200；旧 Loop 可见；旧 token 200（`availableSlots:0`，不领取 pending Run）；无重复机器行；旧快照下载字节与头（attachment/nosniff/no-store/content-length）完全一致；旧 Bearer 重放 committed commit 返回精确 receipt 且零写；另一用户 Session 访问旧 Loop → 扁平 404 | BI1、BI4、BI5、BI6 |
| H 原 Daemon 执行与同步 | 生产 daemon 模块执行旧 pending Run → done/exec；绑定新 snapshot（≠ `amf-1`）且 `artifactSyncError = null`；`amf-1` 行与字节冻结且仍可下载；团队 namespace 新增 Blob；机器行不重复；再次 poll 不重复执行 | BI1、BI5 |
| I 认证不可旁路 | 匿名管理读/写 401 `{"error":"not authenticated"}`；Session cookie 打机器端点 401；Bearer 打管理端点 401；匿名 Dashboard 303 `/login` 且不 Set-Cookie；匿名表单 POST 零写 | BI6 |

**BI3 的如实定义**：本片把「迁移故障恢复」验证为（i）另一路径持锁时的认领拒绝，以及（ii）Artifact namespace 迁移中目标 Blob 损坏时整组拒绝、零 DB 写、修复后可重试成功；**不是** SQL migration 中途失败的注入。

### 跨进程锁证据（片 7）

- LOCK-CP1：生产 `acquireDataDirLock` 持锁时，`node -e` 真实子进程 `open(<dataDir>/data-dir.lock, "wx")` 返回 EEXIST（探针退出 0）；释放后同一探针成功并自行清理。
- LOCK-CP2：真实子进程持锁并写入合法 holder 记录；进程内 `runClaimForTest` 退出 3，stderr 含子进程 pid 与 `rm <path>`；`bootstrapServer` 抛 `DataDirLockError`，且 `<dataDir>/pgdata` 不存在；SIGTERM 子进程后锁文件消失，下一次获取成功。

### 子进程构建产物 drill（opt-in，单独记录）

- 命令：`LOOPZHB_SUBPROCESS_DRILL=1 pnpm --filter @loopzhb/server exec vitest run src/phase5-batch3-slice7-subprocess-drill.test.ts`（前置 `pnpm build`）。
- 日期：2026-10-20；结果：1/1 通过，耗时约 4.9s。
- 观测：真实 `dist/start.js` 启动并持有 `<dataDir>/data-dir.lock`；真实 `dist/claim/main.js` 在服务运行时退出 **3**，SIGTERM Server 退出 **0** 且锁移除后同一命令退出 **0**；重启后旧 Loop 可见、旧快照下载字节与升级前一致、未知 token poll 401；内置 daemon CLI（fake-Claude 夹具）在 60s 内为旧 pending Run 绑定新 snapshot（≠ `amf-1`），SIGTERM 后退出 **0**。
- 该结果不计入默认 `pnpm test` 通过数；未设置门闩时该套件 skip。

### 真实 GitHub OAuth 人工 smoke

- 执行方式：真实 `dist/start.js`、临时 dataDir、`LOOPZHB_HOST=127.0.0.1`、固定端口、`LOOPZHB_ORIGIN=http://127.0.0.1:<port>`、真实 OAuth App client id/secret；OAuth App 回调精确为 `<origin>/auth/github/callback`。
- 检查点：私密窗口打开 `/login` → GitHub 授权 → 跳转 `/` 显示当前账号/团队；`/api/session` 200；另一匿名窗口 `/` 303 `/login`、`/api/machines` 401；停止后退出 0、锁文件移除；日志无 `gho_` 或 secret 泄漏。
- 结果（2026-10-20，用户执行）：
  - 登录、跳转 `/`、页头账号/团队、`/api/session` 200、匿名窗口 303 与 401：**PASS**。
  - 停止检查点：**首次 FAIL**——Ctrl+C 后进程仍存活，`data-dir.lock` 保留。定位见下节「人工 smoke 发现的停止缺陷」。
  - 独立 dataDir 核对：`users=1 / teams=1 / memberships=1 / auth_sessions=1 / machines=0 / loops=0`——真实登录只建立身份链，不自动认领旧数据。仅记录行数，不记录账号标识。
  - 日志泄漏扫描：终端日志未留存文件；实现路径只输出固定的 host/port/dataDir 与固定分类行，不输出 token 或 secret。该项以代码路径与未留存日志如实登记，不作为独立扫描通过。
- 本节与脚本化 adapter 结果严格分开；脚本 adapter 通过不构成真实 OAuth 验收。

### 人工 smoke 发现的停止缺陷与修复（片 7，Issue #124）

- **现象**：真实 OAuth smoke 中按 Ctrl+C 后，Node 进程仍存活，`data-dir.lock` 未删除。`lsof` 显示 Chrome 与该 Server 保持一条 ESTABLISHED keep-alive 连接。
- **根因**：`main()` 的停止顺序在 `server.close(callback)` 内执行 `closeDb`（它同时释放 dataDir 锁）。`server.close()` 的回调等待既有连接结束；浏览器 keep-alive 连接不主动断开，回调永不执行。
- **修复**：新增 `http/server-shutdown.ts`：关闭监听 → 立即关闭空闲 keep-alive 连接 → 5 秒宽限期后强制关闭剩余连接并继续关闭 DB/释放锁。生产 `main()` 与测试台架共用；ADR-011 决策 38 记录裁决。
- **验证**：
  - `http/server-shutdown.test.ts` SD1/SD2 通过（空闲 keep-alive 不阻塞；活跃未完成请求在宽限期被强制关闭）。
  - 真实 `dist/start.js` 重放：另开 keep-alive 客户端持有连接，SIGTERM 后 `SERVER_EXIT=0`、`LOCK_REMOVED`。
  - 构建产物 drill 与 BI/PG/跨进程锁套件在修复后复跑全绿。
- **Issue**：[#124](https://github.com/zhuabo001/loop-platform-zhb/issues/124) 已创建并保持 OPEN；修复与测试已具备，按仓库规则待独立复审后再关闭。

### 显式边界核对（片 7）

- 生产接线（认证、团队过滤、机器准入、Team attribution、dataDir 锁）已在片 1–6 完成；本片只验证与记录，不重复实现。
- 默认 BI 的「原 Daemon」是生产 daemon 模块在测试进程内运行；真实 CLI 子进程证据由 DRILL 单独提供。
- 不新增迁移（journal 保持 7 条）、不改 wire DTO；生产行为改动只有两项并已披露：内部警告函数改名（`nonLoopbackExposureWarning`，仅文案）与 HTTP 有界停止（`http/server-shutdown.ts`，Issue #124 / ADR-011 决策 38，修复真实 OAuth smoke 发现的停止不释放锁缺陷）；其余为注释与文案修正。
- 三个 opt-in real-Claude 套件只做机械 Session 迁移（匿名管理调用改为真实 Session 头、两处相对 URL 修正），本片**未执行**；不得描述为真实 Claude 验收。
- `docs/handoff/` 未提交；PR 描述只引用 ADR、验收记录与真实 Issue。
- #56（Batch 4）与 #61（Batch 6）保持 OPEN，本片不核销；不宣称 Phase 5 完成或可公开部署。

### 变异验证（片 7）

| 变异 | 击红的用例 |
|---|---|
| M12 在凭据门失败处恢复自注册（按 token 派生 id 插入机器行并继续） | PG7 与 PG8 均转红（未知/旧 token 不再 401） |
| M13 `queryMachines`/`queryLoops` 忽略 teamId | slice7 BI（首次登录看到旧数据）与 `admin/team-scope.test.ts`，共 4 项转红 |
| M14 `management.sessionGate` 无条件注入固定团队并 `next()` | slice7 BI 的匿名 401/零写与 `management/access.test.ts`，共 8 项转红 |
| M15 `verifyExisting` 不读目标字节、直接信任文件名 | slice7 BI 的 `target_blob_corrupt` 与 `claim/slice4-refusal-e2e.test.ts`，共 2 项转红 |

四项均遵循「复制 → 注入 → 记录红色 → 恢复 → SHA-256 逐字节一致 → 复跑绿色」；变异未提交。

### 完整质量门（片 7）

```bash
pnpm test                                   # protocol 292 / daemon 790 + 7 skipped / server 1291 + 4 skipped，EXIT=0
pnpm typecheck                              # EXIT=0
pnpm build                                  # EXIT=0
pnpm --filter @loopzhb/server db:check      # 零漂移（本片无新增迁移），EXIT=0
git diff --check                            # EXIT=0
```

server 较片 6 基线（1284 + 3 skipped）**+7 passed、+1 skipped**：新增跨进程锁 2、PG7/PG8 2、BI 1、停止有界 SD1/SD2 2；opt-in drill 以 skipped 计入默认套件。Batch 2 世界构建器抽取不改变迁移测试用例数（LM 仍为 3 项）。protocol 与 daemon 计数不变（本片不改变两包行为）。

### 迁移与认领保真的 oracle 验证（片 7）

| 契约 | 实现与范围 | 变异验证 |
|---|---|---|
| LM 默认夹具保留非空 schedule（[#125](https://github.com/zhuabo001/loop-platform-zhb/issues/125)） | 默认 `cron='0 3 * * *'`；`cron?: string \| null` 允许 BI/PG8/drill 显式传 `null`；LM1 在迁移前断言默认夹具契约 | 迁移 0006 注入 `UPDATE loops SET cron = NULL` → LM1/LM2 红；把 helper 默认改为 `null` → LM1 红；两次均恢复并 SHA-256 一致，复跑绿 |
| 认领仅改 Artifact namespace，保留 manifest 与 committed session 的其他字段 | 升级后、停服前采集 manifest 与 committed session 全行；认领后比较除 `namespaceId` 外全部字段，namespace 另有正向断言 | 认领 UPDATE 同时写 `committedAt=2099-01-01` → BI 在整行比较处红；恢复后绿 |

定向验证：migration + BI + PG7/PG8 三文件 **6/6 通过**；`LOOPZHB_SUBPROCESS_DRILL=1` 的构建产物 drill **1/1 通过**（fake-Claude，未访问真实 GitHub）。测试用例数不变，仅加强既有断言。完整质量门见上节。

### 结论（片 7）

片 7 以真实 HTTP、文件型 PGlite、本地 BlobStore、生产 daemon 模块与 Fake Runner 走通完整升级链，PG7/PG8 钉住新库、旧库与连续重启均不恢复自注册，跨进程锁获得 OS 级证据，构建产物 drill 以真实 CLI 复核同一链路，M12–M15 全部被抓住。真实 GitHub OAuth 人工 smoke 的登录与隔离检查点通过，并发现「浏览器 keep-alive 使停止回调不返回、锁不释放」的缺陷；修复后 SD1/SD2、真实进程重放与全部相关套件通过。LM 迁移夹具的非空 schedule 与认领前后 manifest/session 全字段保真分别由迁移和 BI oracle 验证。如实登记：终端日志未留存文件，未做独立 secret 扫描；三个 opt-in real-Claude 套件未执行；#56/#61 不在本片核销范围；Phase 5 仍待 Batch 4–6，不宣称可公开部署。
