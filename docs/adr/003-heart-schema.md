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
   查询构造器 API，届时只动这一个文件。
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
   - `machines`：裁 `user_id`/`team_id`（Phase 3 团队）、`token` 明文（无 UI 重显
     需求，只存 `token_hash`——比参考更严）、`online` 布尔（在场状态从 `last_seen`
     推导；参考实现自己也是每次读取时现算，列只是冗余缓存）。
   - `loops`：裁 `cron`/`timezone`/`next_run_at`（Phase 2 wk3 cron 批次）、
     `goal`/`completed_at`/`completion_reason`（wk5 closed loop）、
     `notify`/`channel_id`/`user_id`/`team_id`（Phase 3）、`ui`/`state_schema`/
     `evolve_*`/`edit_request`（Phase 4）。
   - `runs`：全量保留（心脏表），仅裁 `user_id`（无用户）与 `control`（Phase 4 的
     in-run 动词审计）。
   - `run_leases`：**全量镜像**，包括 Phase 4 才消费的 `can_set_*`/`can_finish`
     caps——租约行形状是 ADR-001 要求此刻定型的东西，列已就位，语义后补。
8. **索引**：`runs_loop_idx`、`runs_loop_ts_idx`、`runs_phase_idx`（sweep 扫 open
   runs），加 ADR-001 明确要求的部分索引
   `runs_pending_idx ON runs(machine_id) WHERE phase='pending'`——poll 的 claim
   扫描是热路径（每台机器每次 poll），pending 行永远寥寥，索引保持极小。
   `run_leases`：`run_idx`（terminalizeLease 按 runId 打）、`loop_idx`（级联删）。

## RunLease 状态机（定型）

```
active ──[任一 finalize：正常 report / 取消 run 的迟到 report / 恰好一次
          reconcile report]──▶ retired（行删除）
active ──[sweep 回收，且只有 sweep]──▶ terminal-grace（expires_at = now + 24h）
terminal-grace ──[恰好一次 reconcile report]──▶ retired
expires_at 过期 ──▶ resolve 时惰性删除 / sweep 中 prune
```

- `terminal-grace` 唯一标记"被 sweep 回收的 run"——report() 的 reconcile 分支
  （`phase=error 且 lease.state=terminal-grace`）因此对正常失败永不误放行（T5）。
- **幂等是租约级，不是 phase 级**：每条 finalize 路径以 `retireLease`（单发删除）
  收尾，第二次 report 在 resolve 处 401（T3）。取消不 retire——吸收迟到 report
  的那次 finalize 才 retire（T6）。
- `expires_at` null 编码 active 的"永不过期"：机器消失的守卫是 server 的不活跃
  sweep，不是租约过期。
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
