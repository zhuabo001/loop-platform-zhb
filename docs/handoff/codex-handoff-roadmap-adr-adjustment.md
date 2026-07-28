# Codex Handoff：Roadmap、ADR 与现有实现调整清单

> 日期：2026-07-28
> 范围：在继续 Phase 1 Day 3–4（poll/report）之前，统一 roadmap、ADR、protocol、
> schema 与 handoff 的语义。
> 当前实现状态与原始交接见
> [`docs/handoff/001-phase1-day1-2.md`](./001-phase1-day1-2.md)；HTTP 框架选型材料见
> [`docs/handoff/002-day3-4-http-framework.md`](./002-day3-4-http-framework.md)。

---

## 1. 已达成的最终共识

### 1.1 正常 report：保持参考实现的 DELETE + 401

- 正常 report 第一次成功后删除 RunLease。
- 同一 token 再次 report 返回 `401`，不返回 `200 no-op`。
- 这里的“幂等”严格指 **效果幂等 / at-most-once effects**：
  - 重复请求不改变已经落库的终态；
  - 不重复推进 Loop state/task file；
  - 不重复产生通知等副作用；
  - 但不保证重复请求获得与第一次相同的成功响应。
- 该行为与 `loop-platform-github` 当前实现一致，不引入 `retired` tombstone。
- 因此本轮 **不新建 ADR-004**。report/cancel 状态机直接同步修订 ADR-001 与
  ADR-003；参考兼容形状与阶段行为的关系同步澄清 ADR-002，三份 ADR 均在文末留下
  修订记录。

### 1.2 canceled Run：不照搬参考实现的薄弱点

- owner cancel 时必须立即撤销/删除该 Run 的 active Lease。
- Run 转为 `canceled` 与 Lease 撤销必须在同一事务中完成。
- report 路径仍必须读取并检查最新 Run phase，在任何 Loop 级写入之前拦截
  `canceled`，用于防御以下竞态：
  1. report 已经解析出 active Lease；
  2. owner 随后 cancel；
  3. report 继续执行。
- cancel 后，run-token 的 report、`set-*`、`reschedule`、`finish` 等所有写操作都必须失效。
- 不等待迟到 report 才 retire Lease；否则 daemon 永不回报时会留下永不过期的 active
  Lease，并可能继续保有控制能力。

### 1.3 投递保证：MVP 采用 at-most-once execution

- poll 的原子 claim 保证同一 Run 不被两台/两个 poll 重复领取。
- 如果 Server 已完成 claim，但 Delivery HTTP 响应丢失，MVP 不自动重新派发该 Run；
  它最终由 sweep 进入可观察的失败状态。
- 原因：Agent 可能产生外部副作用，自动重派比显式失败更危险。
- roadmap 中的“不重不漏”应改成更精确的承诺：

  > Run 不重复执行；未成功交付或未完成的 Run 必须最终进入可观察的失败状态，
  > 不得静默消失。已经成功提交的最终报告不得因 HTTP 重试产生重复副作用。

- 如果未来要求 Delivery 丢包后仍保证执行，需要另行设计 claim request ID、可重放
  Delivery，以及可重建/加密保存 Run Token；不进入当前 MVP。

### 1.4 Protocol/schema：选择参考兼容形状、阶段最薄行为

- `packages/protocol` 继续逐字镜像参考实现已经存在的核心 wire 形状，不收缩为
  Phase 1 当前 handler 所消费字段的节选。
- `runs` 继续全量保留，`run_leases` 继续全量镜像；ADR-003 已裁掉的其他阶段业务列
  仍按既定阶段增量回迁，不把“保留心脏表形状”扩大成“整个数据库无差别照抄”。
- “Phase 1 实现最薄”严格指 **行为实现最薄**，不指协议与存储形状最薄：
  - 字段或枚举已在 schema 中，不代表当前 server/daemon 已支持其业务语义；
  - handler 不得因为字段存在就提前开放后期能力；
  - wire 形状可被识别，不等于当前 peer 承诺对应的语义兼容。
- 保留 `evolve/edit/grok`、notify policy、Task File/workflow/cursor、
  artifact/transcript/cost/usage 和全部 Lease caps；不删除后再按阶段加回。
- 因此不收缩 protocol/schema，不因方案 A 做基线 migration 重生成或
  golden/schema tests 的整体重写；ADR-002 的 additive 演进纪律继续生效。

---

## 2. P0：Day 3–4 开工前必须完成

### 2.1 修订 ADR-001

文件：`docs/adr/001-heart-tests.md`

- [ ] 把“幂等 report”统一改写为“效果幂等 / at-most-once effects”。
- [ ] 明确正常 finalize 消费并删除 Lease；重复 report 返回 `401`。
- [ ] 修改 T3：
  - 第一次 report 成功落库；
  - 第二次相同 report 返回 `401`；
  - Run/Loop 状态及全部副作用保持不变。
- [ ] T5 保持 terminal-grace 只接受一次 reconcile；第二次迟到 report 返回 `401`。
- [ ] 修改 T6：
  - owner cancel 将 Run 转为 `canceled` 并在同一事务中撤销 Lease；
  - 迟到 report 在 token resolve 或 canceled phase 写前拦截处失败；
  - cursor、task file、Loop 配置和通知均不变化；
  - cancel 后所有 run-token 控制动词失效。
- [ ] 明确 claim 与 Lease 持久化属于一个原子领取操作，禁止出现
  `running` Run 没有对应 Lease。
- [ ] 把 Phase 1 强制验收门调整为 T1–T6。
- [ ] 将 T7 移入 cron/scheduler 阶段；如果暂时保留在本文，明确它只是手动
  trigger 的 coordinator 测试，不是 Phase 1 进入 cron 前的循环依赖。
- [ ] 增加一段“投递保证”，记录 MVP 的 at-most-once execution 选择。
- [ ] 文末增加 2026-07-28 修订记录，说明 ADR-003 对 T3 定义的澄清及 cancel
  权限收紧。

### 2.2 修订 ADR-003

文件：`docs/adr/003-heart-schema.md`

- [ ] 保留正常 finalize 后单发 DELETE Lease、第二次 resolve 返回 `401`。
- [ ] 删除“取消不 retire，等待迟到 report 再 retire”的规定。
- [ ] 改为 owner cancel 在同一事务中更新 Run phase 并删除 Lease。
- [ ] 保留 canceled phase 的 report 写前拦截，作为并发竞态的第二道防线。
- [ ] 明确 `expiresAt = null` 只允许仍由 running Run 持有的 active Lease；
  canceled Run 不得留下 active Lease。
- [ ] 保留 `terminal-grace` 只能由 inactivity sweep 写入的唯一性。
- [ ] 建议把 `run_leases.run_id` 改为 unique index，数据库级保证一个 Run
  只有一条 Lease。
- [ ] 明确 claim 的 `pending → running` 与 Lease INSERT 必须在同一事务中。
- [ ] 删除或弱化“未来 hosted Postgres 只需改一个文件”的承诺；托管化还会涉及
  配置、迁移、连接生命周期、部署和真实 Postgres 并发验证。
- [ ] 保留 DB 前滚-only 与已接受的列裁剪决策；明确 `runs`/`run_leases` 的预声明
  形状不等于 Phase 1 已开放全部字段语义或控制能力。
- [ ] 文末增加修订记录，并互相引用 ADR-001。

### 2.3 修订 ADR-002

文件：`docs/adr/002-protocol-package.md`

- [ ] 保留“逐字镜像参考核心 wire 形状”和“字段/枚举只增不减”的既有决策。
- [ ] 明确“行为实现最薄”不等于“协议形状最薄”。
- [ ] 明确未来字段和枚举是兼容形状预声明，不代表当前阶段已经支持其业务语义。
- [ ] 明确 handler 不得因为 schema 接受某字段或枚举就提前实现后期功能。
- [ ] 明确“能解析 wire 形状”与“承诺语义兼容”是两个层次；能力开放由当前阶段的
  应用层校验和行为测试决定。
- [ ] 文末增加 2026-07-28 修订记录，说明本次只是澄清镜像与能力开放的关系，
  没有收缩既有契约。

### 2.4 修正 protocol 的两个硬性契约问题

文件：`packages/protocol/src/report.ts`

- [ ] 将 `durationMs` 从 `z.number().nonnegative()` 改为
  `z.number().int().nonnegative()`，与 ADR-002 已写明的约束一致。
- [ ] 在 `report.test.ts` 增加小数拒绝测试。

文件：`packages/protocol/src/tokens.ts`、`poll.ts`

- [ ] 增加 Run Token 的共享形状校验，例如 `RUN_TOKEN_RE`、
  `isRunTokenShape`/Zod schema。
- [ ] `deliverySchema.runToken` 使用该 schema，而不是任意 `z.string()`。
- [ ] 增加合法 `rk_...`、错误前缀、空 payload、非法字符测试。

### 2.5 为即将实现的 gateway/store 固定事务边界

- [ ] `claimPendingRun + insert RunLease`：同一事务。
- [ ] 正常 `report finalize + delete RunLease`：同一事务。
- [ ] `cancel Run + delete RunLease`：同一事务。
- [ ] report 在任何 Loop 级写入之前重新读取/锁定 Run phase。
- [ ] 正常重复 report：`401` 且零副作用。
- [ ] terminal-grace reconcile：只允许一次，完成后删除 Lease。
- [ ] canceled Run：无论 report 与 cancel 如何交错，Loop 级数据都不得被迟到结果修改。

---

## 3. P1：需要在调整 roadmap 时完成

### 3.1 调整阶段顺序

建议顺序：

1. **Phase 1：最小心脏**
   - 参考兼容的 protocol/schema 形状，当前阶段最薄行为；
   - 手动 trigger；
   - poll/report；
   - Fake Runner；
   - T1–T6；
   - CLI 或 JSON 只读观察面。
2. **Phase 2：一个真实 Agent**
   - claude-code 或 codex 选一；
   - spawn、进程组 kill、timeout、env 白名单、workdir jail、progress heartbeat；
   - 一条真实 Agent E2E。
3. **Phase 3：cron 与离线恢复**
   - cron、timezone、DST、offline pending、overlap、catch-up、T7。
4. **Phase 4：Loop 产品语义**
   - Task File、跨 Run state、open/closed、goal/finish；
   - 最小 Dashboard。
5. **后续**
   - Artifact；
   - auth/team/notification；
   - workflow/evolve/edit/templates/multi-agent；
   - 生产硬化。

调整理由：

- [ ] 真实 Agent 的不确定性高于 cron，应先验证 daemon/runner 契约。
- [ ] “每层不动心脏”改为“允许扩展协调模块，但不得破坏既有心脏测试”。
- [ ] Phase 1 结束时提供最薄观察面，避免五周后才首次获得真实使用反馈。
- [ ] 在 auth 完成前明确 server 仅允许 localhost/受信网络使用，不得公开暴露。
- [ ] 恢复独立的生产硬化阶段：Postgres/R2、迁移预检、body/rate/storage caps、
  SSRF、防护、GC、健康检查、部署与真实并发测试。

### 3.2 调整 roadmap 的估算与完成标准

- [ ] 区分“学习骨架”“可演示 MVP”“可靠单用户”“可公开部署多用户”四个里程碑。
- [ ] 不把第 13 周描述成接近完整核心能力；保留未知量和生产硬化缓冲。
- [ ] 每个阶段使用行为验收标准，不使用“完成某模块”作为唯一完成定义。
- [ ] 把安全边界、数据上限和可观察性作为跨阶段 Definition of Done。

---

## 4. P1 已决策：采用方案 B——参考 wire/schema 前向兼容

当前 protocol/schema 已提前包含：

- `evolve/edit/grok`、notify policy；
- Task File、workflow、cursor；
- artifact、transcript、cost/usage；
- `canSetUi/canSetSchema/canSetWorkflow/canFinish`。

这些字段与 roadmap 的“Phase 1 最薄实现”存在表面张力，但该张力应通过区分
**兼容形状**与**已支持行为**解决，不通过删除参考实现的真实字段解决。

### 4.1 已接受：方案 B

- [x] 保留当前 protocol 字段、枚举和 DB 列，不做删除迁移。
- [ ] ADR-002、ADR-003 与 roadmap 明确：
  - “行为实现最薄”，而不是“协议与存储形状最薄”；
  - 未落地阶段的字段只是兼容形状预声明，不代表当前 server 支持其语义；
  - handler 不得因字段存在就提前实现后期功能；
  - wire 形状识别不等于语义支持，能力开放由应用层 guard 和测试决定。
- [ ] Phase 1 的创建、claim 和执行路径不得产生未支持的 role/provider。
- [ ] 尚未进入当前阶段的入站字段不得提前触发 Loop/Run 写入或控制副作用。

### 4.2 否决：方案 A（按当前阶段收缩形状）

否决理由：

1. 它与 ADR-002“逐字镜像参考核心 wire 形状”的职责冲突，会把镜像退化成参考
   contract 的阶段性节选。
2. 它会推翻 ADR-003 已接受的 `runs` 全量保留、`run_leases` 全量镜像决策。
3. 多数字段会在后续阶段重新加入，删除会带来 migration、golden/schema tests
   和文档的往返修改，却不增加 Phase 1 行为安全性。
4. “handler 不得超前实现”的风险应在应用层 guard 和行为测试中治理，不应通过
   收缩兼容 interface 治理。

因此，本轮不执行 protocol/schema 收缩，不重生成基线 migration。后续新增参考实现
不存在的字段或扩大已支持语义时，仍须单独给出设计依据。

---

## 5. 无需因本轮讨论改动的部分

以下设计可直接保留：

- `packages/protocol` 作为 server/daemon wire DTO 与枚举单一来源。
- Zod tolerant reader：未知字段剥离，保持新旧 peer 的加法兼容。
- device/run token 只在 wire 上传输，数据库只存 SHA-256 hash。
- PGlite 作为 Phase 1 文件库和测试内存库。
- Drizzle 提交 SQL migration 与 `db:check` 漂移守卫。
- `runs_pending_idx` 部分索引。
- Fake Clock、PGlite、Fake Runner 驱动风险测试。
- HTTP route 只做解析/返回，状态机、权限、幂等和副作用进入 store/gateway。
- Server zero-exec、Agent 本机执行、凭证与本地工具默认不离机三条不变量。

---

## 6. 必须同步更新的 handoff

### `docs/handoff/001-phase1-day1-2.md`

- [ ] 把 T3 描述改成“第二次 report 返回 401，服务端零副作用”。
- [ ] 删除“取消不 retire”的指导。
- [ ] 增加 cancel 与 Lease 撤销的事务要求。
- [ ] 增加 cancel/report 竞态下的写前 phase guard。
- [ ] 明确预声明的 protocol/schema 形状不等于 Phase 1 已支持全部能力。

### `docs/handoff/002-day3-4-http-framework.md`

- [ ] T3 改成第一次 200、第二次 401、状态和副作用不变。
- [ ] gateway/store 实现顺序前加入事务边界。
- [ ] 增加 cancel 后所有 run-token 写操作失败的测试要求。
- [ ] Hono/裸 HTTP/TanStack Start 的选择不影响上述核心语义。

---

## 7. 建议新增或调整的测试

### Protocol

- [ ] `durationMs` 接受 `0` 和正整数，拒绝负数、小数、字符串。
- [ ] `runToken` 接受合法 `rk_` token，拒绝 `dk_`、无前缀、空 payload、非法字符。

### Schema/store

- [ ] 每个 Run 最多一条 RunLease。
- [ ] claim 与 Lease INSERT 任一步失败时整个事务回滚，Run 仍为 pending。
- [ ] cancel 后不存在 active Lease。
- [ ] canceled Run 不会留下永不过期 Lease。

### Gateway

- [ ] Phase 1 的创建/trigger 路径拒绝尚未支持的 `evolve`/`edit` role，claim/Delivery
  不会投递它们；未启用的 `grok` provider 同样不得进入执行路径。
- [ ] 预声明但尚未启用的 cursor、taskFile、artifact、transcript、cost/usage 和 Lease
  caps 不得提前产生 Loop/Run 写入或控制副作用。
- [ ] T1：并发 claim 恰好一个成功。
- [ ] T2：重复 poll 不重复领取 running Run。
- [ ] T3：第一次 report 200；第二次 report 401；Run/Loop/副作用完全不变。
- [ ] T4：Server 重启后 active Lease 仍可完成 report。
- [ ] T5：terminal-grace 只接受一次 reconcile，第二次 401。
- [ ] T6：
  - cancel 与 Lease 撤销同事务；
  - cancel 后迟到 report 不写 Loop；
  - cancel 后所有控制动词失败；
  - 构造“report 先 resolve、cancel 后提交”的竞态，写前 phase guard 仍拦截。
- [ ] T7：移到 scheduler 阶段，验证新 trigger supersede 旧 pending。
- [ ] Delivery 响应丢失：Run 不重派，最终由 sweep 进入可观察 error。

---

## 8. 推荐执行顺序

1. [x] 未来字段采用方案 B，并在本文记录 A 的否决理由。
2. [ ] 同步修订 ADR-001、ADR-002、ADR-003。
3. [ ] 修改 protocol 的 `durationMs` 与 run-token 校验。
4. [ ] 评估并记录是否将 `run_leases.run_id` 升级为 unique index；若采纳，再同步
   migration/schema tests。
5. [ ] 更新 001、002 handoff。
6. [ ] 调整 roadmap 的阶段顺序、验收标准、部署边界和生产硬化阶段。
7. [ ] 再开始 Day 3–4，以 TDD 实现 store/gateway/HTTP。
8. [ ] 完成后运行：
   - `pnpm typecheck`
   - `pnpm test`
   - schema/migration 变化时运行
     `pnpm --filter @loopzhb/server db:check`
   - `git status --short`，确认没有混入无关改动。

---

## 9. 当前验证基线

- 本次评审前，现有实现通过：
  - protocol：57 tests；
  - server：16 tests；
  - 合计：73 tests；
  - workspace typecheck。
- 这些测试只覆盖已落地的 protocol/schema；T1–T7 的 gateway/daemon 行为尚未实现，
  不是当前回归。
- `docs/handoff/002-day3-4-http-framework.md` 当前仍是未跟踪文件；后续提交时需要明确
  是否与本 handoff、ADR 和 roadmap 调整一并纳入。

---

## 10. Suggested skills

- `domain-modeling`：在修改 ADR-001/003 前统一 Run、Lease、claim、finalize、
  reconcile、cancel 的术语与状态转换。
- `codebase-design`：设计 store/gateway 的事务边界与深模块接口。
- `tdd`：按 T1–T6 先写失败测试，再实现 poll/report/cancel。
- `implement`：在 ADR 与 roadmap 定稿后执行 protocol/schema/gateway 改动。
- `code-review`：以调整前提交为 fixed point，对 Standards 与 Spec 两条轴做最终复核。
