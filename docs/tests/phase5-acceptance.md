# Phase 5 验收测试记录（Batch 1 — Artifact 领域、协议与存储基础）

> 本文档记录 Phase 5 Batch 1 的内部验收证据。Batch 1 的交付范围与完成定义见
> `docs/plan/codex-phase5-batch1-plan.md`（§4 切片表、§5 质量门与完成定义）。
> **Phase 5 未收口**：Batch 2（watcher、持续同步、Run 快照与文件视图）与 Batch 3（认证）未启动；
> 本文件只覆盖 Batch 1，后续批次在此追加。

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

- 片 6 收口三轨复审：进行中（轮次与固定范围在复审完成后补录）。
- 既有 Issue：#72、#11 为 Phase 6 blocker（roadmap 指针在位）；#56、#61 留给 Phase 5 后续批次（#56 认证层加固、#61 验收环境防回归）；Batch 1 各片复审 Issue（#66–#82）全部核销关闭。

## 结论

Batch 1 全部编组（AM/AP/AB/AC 与 AD）与内部集成验收通过，五道质量门全绿；生产仍运行
Phase 4 行为（AD1–AD4 在测）。收口三轨复审完成后在此补最终结论。
