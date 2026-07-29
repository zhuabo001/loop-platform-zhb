# Handoff：Phase 1 心脏（Day 1–2 完成态）

> 更新日期：2026-07-29 ｜ main @ `2df1050`（PR #2 已合并）
> 用途：让任何新会话/新人在 5 分钟内接上当前进度。路线图全貌见 `docs/roadmap.md`。
>
> **2026-07-28 语义锁定**：Day 3–4 开工前，report/cancel/投递语义已按
> `docs/handoff/codex-handoff-roadmap-adr-adjustment.md` 统一修订进 ADR-001/002/003
> （三份 ADR 文末均有当日修订记录）。要点：T3 = 效果幂等（第二次 report 401，零
> 副作用）；cancel 与 lease 撤销同一事务（不再"取消不 retire"）；claim + lease
> INSERT 同一事务；`run_leases.run_id` 已升级 unique index；`durationMs` 补 `.int()`；
> 新增 `isRunTokenShape`（mint/写入侧形状过滤）；方案 B 落定——预声明的
> protocol/schema 形状 ≠ Phase 1 已支持全部能力（ADR-002 决策 6），handler 不得超前实现。测试基线更新为
> **79 全绿（62 protocol + 17 server）**。此前的三条实现审查意见
> 已全部闭环：Delivery `runToken` 已恢复宽容 reader（opaque，形状校验只留
> mint/写入侧）；`run_leases.run_id` unique 的措辞收窄为"至多一条现存"；
> report/cancel 竞态锁定语义（锁行/CAS）已写进 ADR-001/003。Day 3–4 通过应用层
> gate 编排交错并让 PGlite 事务真实提交，验证事务内二次 guard；真实 Postgres 的
> 多连接锁竞争与隔离级别验证留在 Phase 6。

---

## 一句话现状

Phase 1「心脏」的前两步已完成并合入 main：wire 协议包（Day 1）+ 心脏数据模型
（Day 1–2）。**下一步是 Day 3–4：`POST /api/machine/poll` 原子 claim +
`POST /api/machine/report`，按 ADR-001 纪律先写心脏测试 T1–T3 再写实现。**

## 已完成清单

### 创始文档（根提交 `8e71ac8`）

- `docs/roadmap.md`——复刻路线图：初版四阶段已重排为当前七阶段；保留心脏先行、三条
  架构不变量、MVP 暂缓清单。
- `docs/adr/001-heart-tests.md`——心脏测试 T1–T7 清单（Phase 1 强制验收门为 T1–T6，
  T7 是 coordinator 级测试）+ 三个先行机制：原子 claim / 持久化 RunLease / 幂等 report。

### Day 1：protocol 包（PR #1，`3c583d6` + `cd9579d`）

- `packages/protocol`（`@loopzhb/protocol`）：server/daemon 之间唯一耦合点。
  zod schema 推导 TS 类型，类型与校验同源。
- 模块：`version`（PROTOCOL_VERSION=1 锚点，无协商）、`enums`（全部状态枚举单源）、
  `tokens`（`dk_`/`rk_` 前缀 + 形状过滤）、`poll`（扁平 body + Delivery）、
  `report`（含 REPORT_OUTCOMES 子集：daemon 不可上报 error/skipped）、
  `errors`、`node`（sha256/machineIdFromToken 子路径，主入口保持浏览器纯净）。
- `docs/adr/002-protocol-package.md`——演进规则：tolerant reader（剥离未知键）、
  只增不减、逐字镜像参考 wire、caps 不进 protocol。
- 57 测试；经对抗性审查加固（tolerant-reader 逐 schema 钉、清单钉防自适应失效）。

### Day 1–2：心脏 schema（PR #2，`1e62509` + `16c70f1` + `ea5293c`）

- `packages/server`（`@loopzhb/server`，**目前仅 db 模块**，无 HTTP 层）：
  - `src/db/schema.ts`——四张表 `machines / loops / runs / run_leases`。枚举列
    全部展开 protocol 单源数组（TS-only 无 DB CHECK）；无外键（级联留给 store 层）；
    时间戳一律 ISO text 列。
  - `src/db/index.ts`——pglite 单档句柄工厂（有 dataDir 走文件库 `<dataDir>/pgdata`，
    无则内存）+ 进程内 `runMigrations()`（src 与 dist 双布局均可解析）。
  - `drizzle/0000_*.sql`——基线迁移，含 ADR-001 要求的部分索引
    `runs_pending_idx ON runs(machine_id) WHERE phase='pending'`。
- `docs/adr/003-heart-schema.md`——列裁剪清单（每项归属阶段）、RunLease 状态机
  定型（active → terminal-grace → 删除；`expiresAt` null = active 永不过期；
  幂等是租约级单发删除）。
- 有意的参考偏离：machines 无 `online` 布尔（lastSeen 推导）、无 token 明文列
  （只存哈希）、runs 无 `userId`/`control`。
- `.github/workflows/ci.yml`——typecheck / test / build / `db:check` 四步。

### 质量记录

- 调整前基线：73 测试全绿（57 protocol + 16 server）；CI 通过。当前基线见本文
  顶部的 79 tests（62 protocol + 17 server）。
- **两轮独立对抗性审查**均完成：第一轮（2 MAJOR 级测试缺口 + fresh-clone MAJOR，
  已修）；第二轮 xhigh 复核（MERGE-READY 零 MAJOR，2 MINOR 已修）。审查结论在
  各 PR 评论中。

## 关键工程规则（后续批次必须遵守）

1. **枚举只从 `@loopzhb/protocol` 导入**，禁止内联重声明（有测试钉，会红）。
2. **`pnpm -r typecheck`/`pnpm -r test` 之前不需要手动 build**——server 的这两个
   脚本自带 protocol 构建前置（干净 clone 安全）。不要用 pnpm pre/post 脚本。
3. **改 `db/schema.ts` 必须同提交重新 `db:generate`**；CI 的 `db:check`
   （generate + `git diff --exit-code`）会抓 schema.ts↔SQL 漂移。注意 db:check
   失败后重跑前需清理 generate 留下的未跟踪文件并还原 `_journal.json`。
4. **迁移前滚-only**：列只增不改不删；推迟列按 ADR-003 的归属阶段增量回迁。
5. **`runs.ts` 指 `runs` 数据库表的 `ts` 列，不是 TypeScript 文件**。它记录“最近
   生命周期转换时刻”（claim/finalize/reclaim/supersede 都更新），不是创建时间；
   sweep 的不活跃窗口量 `max(ts, progress.at)`。
6. lease 语义：每条 finalize 路径以 `retireLease`（单发 DELETE）收尾，第二次
   report 在 resolve 处 401（效果幂等：零副作用，不保证重复成功响应）；
   `terminal-grace` 只能由 sweep 的 reclaim 写入。**cancel 立即 retire**——owner
   cancel 把 run 转 `canceled` 与删除 lease 放在同一事务（有意的参考偏离）；
   report 与 cancel 必须在各自事务中锁定同一 Run 行（或使用覆盖整个写入区间的 CAS），
   再检查 phase 并写入，防"先 resolve、cancel 后提交"竞态。`expiresAt` null 只允许
   running run 持有的 active lease。Day 3–4
   在 store 层补两条测试："terminalize 必带 expiresAt"、"cancel 后不存在
   active lease"。

## 下一步：Day 3–4（poll + report）

按 roadmap 与 ADR-001（2026-07-28 修订后语义）：

1. **先写心脏测试 T1–T3**（并发 claim 唯一 / 重复 poll 不重复执行 / 重复 report
   效果幂等——第一次 200、第二次 401、零副作用）再写实现；T7（supersede 陈旧
   pending）保留为 Phase 1 coordinator 级测试随 `supersedePendingRun` 一同交付；
   Day 8–10 的故障注入覆盖 T4–T6。
2. 需要新建：store 层（`addRun`/`claimPendingRun`（**与 lease INSERT 同一事务**）/
   `supersedePendingRun`/`pendingRunsForMachine`/lease 四函数 + `openRuns`）、
   HTTP 层（`/api/machine/poll`、`/api/machine/report`）、gateway 逻辑
   （claim → mint lease → buildDelivery；report 在事务中锁定/比较 Run phase 后分支：
   canceled/竞态失效拦截 / terminal-grace reconcile / 正常 finalize；finalize + 删
   lease 同一事务）。Phase 1 不实现 `done + active lease` enrich：该组合当前没有合法
   来源，出现时删除残留 lease、零 Run/Loop 写入并返回统一的 capability-invalid 401；
   finish 动词落地时再增加 enrich。
3. **事务边界**（ADR-003 定型，前两条是有意的参考偏离）：claim+lease INSERT
   同事务；report finalize+lease DELETE 同事务；cancel+lease DELETE 同事务。
4. **能力 guard**（ADR-002 决策 6）：Phase 1 的 trigger 路径只产出 `exec` role；
   预声明但未启用的字段（cursor/taskFile/caps…）不得提前产生写入或控制副作用。
5. **HTTP 框架已定：Hono**（`hono` + `@hono/node-server`，2026-07-28 拍板；
   对比材料见 `docs/handoff/002-day3-4-http-framework.md`）。测试用 `app.fetch`
   打实例，不起真端口；TanStack Start 留到 Phase 4 Dashboard 再评估。
6. 协议侧 DTO 已就绪，直接消费：`pollRequestSchema` / `deliverySchema`
   （`runToken` 为 opaque 字符串——宽容 reader，裸 UUID 与 `rk_` 都透传，
   形状校验只在 mint/写入侧）/ `reportRequestSchema`（`durationMs` 已带
   `.int()`）。参考实现语义提取：`loop-platform-github` 的
   `gateway/index.ts`（poll:456-623、report:1291-1558、sweep:354-428）、
   `db/store.ts`（claimPendingRun:200-208）、`gateway/tokens.ts`（lease 四函数）。
7. **Run Capability 失效语义统一**：Report 读取侧不做 `rk_` 前缀预过滤，直接按
   opaque credential hash resolve lease；unknown/expired/consumed/revoked、竞态输家、
   orphaned Run 和 stale phase 对 daemon 统一返回
   `{error:"invalid or expired run capability",code:"run_capability_invalid"}` + 401，
   具体原因只记服务端日志。

## 工作环境备注

- daemon 包尚未创建（Day 5–7：前台 poll 循环 + Fake Runner）。
- 本会话经验：kimi 端点对子代理调用有确定性 `tokenization failed`，对抗性审查
  代理需用 `model: "sonnet"` + `effort: "xhigh"`；代理 verdict 经常不随完成通知
  送达，需用 SendMessage 主动取回。
- 触发方式（Phase 1）：手动 `POST /loops/:id/run`，一个 cron 都不写。
