# ADR-003：心脏 schema——四张表、列裁剪与 RunLease 状态机定型

- 状态：Accepted
- 日期：2026-07-27
- 关联：docs/roadmap.md Phase 1 Day 1–2；ADR-001（心脏测试）；ADR-002（枚举单源）

## 背景

Day 1–2 的产出是把「调度—领取—执行—回报」链路的可靠性语义固化进数据模型。ADR-001
要求三个机制此刻就位：原子 claim 的承载列、持久化 RunLease 及其状态机、幂等 report
的写前拦截所需的 phase 语义。本 ADR 记录 schema 的全部取舍。实现：
`packages/server/src/db/{schema,index}.ts` + `drizzle/0000_*.sql`。

## 决策

1. **pglite 单档，无 `DATABASE_URL` 分层**。`src/db/index.ts` 是唯一分支点：给了
   `dataDir` 走文件库（`<dataDir>/pgdata`），不给走内存（测试）。参考实现的
   postgres-js/Supabase 档推迟到需要托管时再加——store/gateway 只用 drizzle
   查询构造器 API，db 句柄工厂是唯一的驱动分支点；但托管化不止这一个文件，
   还涉及配置、迁移路径、连接生命周期、部署形态与真实 Postgres 的并发验证。
2. **迁移：drizzle-kit generate → 提交的 SQL + 进程内 `runMigrations()`**。无 hosted
   档，故 `drizzle.config.ts` 不配 dbCredentials、无 `db:migrate` CLI。前滚-only：
   列只增不删不改（ADR-002 的 additive 规则应用到 DB）。
3. **枚举单源首次兑现**：所有枚举列的 `{enum}` 直接展开 `@loopzhb/protocol` 的常量
   数组（`{enum: [...RUN_PHASES]}`），TS-only（无 DB CHECK）——扩枚举不需要迁移。
   `schema.test.ts` 逐列钉住 `enumValues` 与 protocol 清单相等，防止有人"顺手"内联
   重声明造成静默分叉。
4. **无外键**。级联删除是 store 层职责（参考实现的 `store.deleteLoop` 模式）：
   写顺序语义显式化，迟到 report 的写入不受 FK 约束顺序干扰。测试钉住
   `pg_constraint` 中 0 条 FK。
5. **时间戳一律 ISO 字符串 text 列**，无 DB 默认值（写入方打戳；两档可移植）。
6. **`runs.ts` 不是创建时间**。它在每次生命周期转换重打（claim/finalize/reclaim/
   supersede），语义是"最近一次转换时刻"；sweep 的不活跃窗口量的是
   `max(ts, progress.at)`。列注释已写明，避免误当 createdAt。
7. **列裁剪**（提炼语义，不照抄；被裁列全部按阶段增量回迁，前滚-only 使其廉价）：
   - `machines`：裁 `user_id`/`team_id`（团队与认证批次）、`token` 明文（无 UI 重显
     需求，只存 `token_hash`——比参考更严）、`online` 布尔（在场状态从 `last_seen`
     推导；参考实现自己也是每次读取时现算，列只是冗余缓存）。
   - `loops`：裁 `cron`/`timezone`/`next_run_at`（cron 批次）、
     `goal`/`completed_at`/`completion_reason`（closed loop 批次）、
     `notify`/`channel_id`/`user_id`/`team_id`（团队与认证批次）、`ui`/`state_schema`/
     `evolve_*`/`edit_request`（高阶能力批次）。
   - `runs`：全量保留（心脏表），仅裁 `user_id`（无用户）与 `control`（高阶能力
     批次的 in-run 动词审计）。
   - `run_leases`：**全量镜像**，包括高阶能力批次才消费的 `can_set_*`/`can_finish`
     caps——租约行形状是 ADR-001 要求此刻定型的东西，列已就位，语义后补。

   注：`runs`/`run_leases` 的全量保留是**兼容形状预声明**（ADR-002 决策 6）——
   列已就位，不等于 Phase 1 已开放其全部字段语义或控制能力。
8. **索引**：`runs_loop_idx`、`runs_loop_ts_idx`、`runs_phase_idx`（sweep 扫 open
   runs），加 ADR-001 明确要求的部分索引
   `runs_pending_idx ON runs(machine_id) WHERE phase='pending'`——poll 的 claim
   扫描是热路径（每台机器每次 poll），pending 行永远寥寥，索引保持极小。
   `run_leases`：`run_idx` 为 **unique index**（数据库级保证一个 run 只有一条
   lease——at-most-once 投递语义下一个 run 终生只 mint 一次；terminalizeLease
   按 runId 打）、`loop_idx`（级联删）。

## RunLease 状态机（定型）

```
active ──[任一 finalize：正常 report / 恰好一次 reconcile report]──▶ retired（行删除）
active ──[owner cancel：run 转 canceled 与 lease 删除在同一事务]──▶ retired
active ──[sweep 回收，且只有 sweep]──▶ terminal-grace（expires_at = now + 24h）
terminal-grace ──[恰好一次 reconcile report]──▶ retired
expires_at 过期 ──▶ resolve 时惰性删除 / sweep 中 prune
```

- `terminal-grace` 唯一标记"被 sweep 回收的 run"——report() 的 reconcile 分支
  （`phase=error 且 lease.state=terminal-grace`）因此对正常失败永不误放行（T5）。
- **幂等是租约级，不是 phase 级**：每条 finalize 路径以 `retireLease`（单发删除）
  收尾，第二次 report 在 resolve 处 401（T3）。
- **取消立即 retire**（有意的参考偏离）：owner cancel 把 run 转 `canceled` 与
  删除 lease 放在**同一事务**——参考的「取消不 retire」会在 daemon 永不回报时
  留下永不过期且仍具控制能力的 active lease。迟到 report 在 token resolve 处
  401；report 路径在任何 loop 级写入**之前**重读 run phase，作为防御
  「report 已 resolve、cancel 后提交」竞态的第二道防线（T6）。cancel 后
  run-token 的一切写操作失效。
- **claim 与 lease INSERT 同一事务**（有意的参考偏离：参考的 `claimPendingRun`
  与 `registerRunLease` 是两次独立调用）——禁止出现 `running` run 没有对应
  lease 的中间态。
- `expires_at` null 编码 active 的"永不过期"：机器消失的守卫是 server 的不活跃
  sweep，不是租约过期。`expires_at` null **只允许**仍由 running run 持有的
  active lease——canceled run 不得留下 active lease，terminalize 必带 expires_at。
- 只存 sha256(wire token)：DB 泄露不发活凭证。

## 后果

- 正面：T1–T7 需要的全部列与索引已就位；Day 3–4 可以只写 store/gateway 逻辑，
  不再动数据模型。
- 代价：`db/index.ts` 的 `openMigratedDb` 之外还没有真正的 boot；枚举防漂移依赖
  测试钉（无 DB CHECK 是有意的）。
- 已知偏离参考实现（有意）：`machines` 无 `online` 布尔与 `token` 明文列；
  无 `user_id` 系列列（无 Better Auth）。托管分层缺席是推迟而非否决。
- 工具链备注：drizzle-kit 以 CJS 语义解析 workspace 依赖，`@loopzhb/protocol`
  的 exports 因此补了 `default` 条件（纯 additive，无行为变化）。

## 后续批次补记（对抗性审查 #1 之后）

- **构建顺序**：`@loopzhb/server` 的 typecheck/test 脚本自带
  `pnpm --filter @loopzhb/protocol build` 前置——server 经 package exports 解析
  protocol 的 `dist/`，干净 clone 无先验 build 时 typecheck/test 必红。不要用
  pnpm 的 pre/post 脚本（默认不启用）。
- **schema.ts↔SQL 漂移守卫**：测试跑的是提交的迁移 SQL，而 drizzle 的
  `.default()`/索引只进 DDL——schema.ts 可静默偏离 SQL。`db:check`（generate +
  `git diff --exit-code`）在 CI 钉住这一点（`.github/workflows/ci.yml`）。
- **已知继承自参考的松散不变量**：schema 允许 `state='terminal-grace'` 且
  `expiresAt NULL`（一个永不被 prune 的永恒 grace 租约）——不变量只活在
  `terminalizeLease` 的写入路径里。2026-07-28 修订后规则收窄为
  「`expires_at` NULL ⇒ active 且由 running run 持有」；Day 3–4 实现 store 层时
  补两条测试："terminalize 必带 expiresAt"、"cancel 后不存在 active lease"。

## 修订记录

- 2026-07-28（与 ADR-001 同日修订，互引）：（1）cancel 语义收紧——cancel 与
  lease 删除同一事务，替代「取消不 retire，等待迟到 report 再 retire」；写前
  phase 检查保留为竞态第二道防线。（2）claim 的 `pending → running` 与 lease
  INSERT 定为同一事务。（1）（2）均为**有意的参考偏离**（参考是两次独立调用 +
  取消不 retire）。（3）`run_leases.run_id` 升级 unique index。（4）`expires_at`
  NULL 仅限 running run 持有的 active lease。（5）弱化托管 Postgres「只动一个
  文件」的承诺。（6）§7 列归属改用批次名（cron/closed loop/团队/高阶能力），
  配合 roadmap 阶段重排。（7）明确 `runs`/`run_leases` 预声明形状 ≠ Phase 1
  已开放全部字段语义（ADR-002 决策 6）。前滚-only 与已接受的列裁剪决策不变。
