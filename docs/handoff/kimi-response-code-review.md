# 对《Day 3–4 Step 1–3 代码审查》的独立复核结论

> 日期:2026-07-30 ｜ 复核人:Kimi(Claude Code)
> 复核对象:`docs/handoff/codex-handoff-code-review-day34.md`(双轴审查,范围
> `origin/main...ccd9772`)的 5 项发现(4 P1 + 1 P2)
> 方法:逐条对照 ADR-001/003 原文、收敛后的 plan/clarify、参考实现
> (`loop-platform-github`)与当前分支代码(`ba81965`)独立取证;不预设审查
> 结论对错。引用行号为当前分支 HEAD。

## 结论总表

| # | 发现 | 复核结论 | 处置建议 |
|---|---|---|---|
| 1 | 未来 `lastSeen` 未按"未来水位纠正"处理 | **部分成立——计划文本自相矛盾,属语义裁决项,非纯代码缺陷** | 先在 clarify 层裁决语义,再改代码+测试 |
| 2 | claim 写时守卫不含 machineId/role | **成立(加固项,当前不可触发)** | 修复批处理 |
| 3 | report 缺覆盖写入窗口的锁/CAS | **成立,且为 ADR 符合性缺陷(必须修)** | 修复批处理(CAS 方案) |
| 4 | terminal-grace expiry 只在事务前检查 | **成立** | 修复批处理 |
| 5 | existing message 复用未统一清理 | **成立(P2)** | 修复批处理 |

---

## 逐项分析

### 发现 1:未来 `lastSeen` 的语义冲突(P1 → 裁决项)

**事实**:plan 原文(§Poll 与 Delivery)同时包含两句话——

1. "`lastSeen` ... null、非法、**未来**或距当前时间已满 10 秒时**刷新**";
2. "并发写必须在数据库 guard 中保证 `lastSeen(new) = max(lastSeen(stored), pollTime)`,**不得倒退**"。

当前实现(`store/machines.ts:132-150`)选择以 (2) 为不变量:未来水位读作
fresh(身份不变时零写入;身份变化时 `GREATEST` 保留较大值),`poll.test.ts`
的"never regresses under skewed clocks"测试把该语义钉绿。审查以 (1) 为
依据,认为未来水位应被纠正为当前 Poll 时间。

**复核判断**:两句话无法同时字面成立——若未来水位无条件纠正为 pollTime,
则一个时钟落后的并发 Poll 必然把水位写回过去,直接违反 (2) 的"不得倒
退"及其配套测试("并发 Poll 不倒写")。A-13 的决议标题是"**单调的** 10
秒持久化水位",单调性(不回退)是其头号属性;而审查担心的"远未来水位使
presence/sweep 长期误判在线"也是真实风险。

**建议裁决(倾向方案 A)**:

- **方案 A(推荐)**:保持单调性为不可打破的不变量;"纠正"只适用于**非法
  (unparsable)** 值(当前行为)。为消解远未来风险,引入一个上限钳制:当
  `stored > pollTime + SKEW_SLACK`(如 5 分钟,远超任何合理 NTP 偏移)时,
  视为垃圾值并纠正为 pollTime。两条计划语句于是同时成立:正常 skew 窗口内
  不倒退,病态远未来被修复。需回写 clarify(A-13 补记)后再改代码与测试。
- **方案 B**:按审查字面改为"未来即纠正",同时删除"不得倒退"及其测试,
  并接受多实例时钟偏移下水位回摆。这会削弱 A-13 的单调性承诺,不建议。

**在裁决前,代码与测试维持现状。**

### 发现 2:claim 写时守卫不完整(P1,成立——加固项)

**事实**:`store/runs.ts:148-180` `claimRunWithLeaseTx` 的条件 UPDATE 只
校验 `run.id + phase='pending'`;lease 的 `loopId/machineId/role` 来自候选
扫描(`store/runs.ts:118`,`coordinator/index.ts` poll 循环)时的快照。

**复核判断**:发现属实,但需指出**当前不可触发**:Phase 1 没有任何写入方
会修改已存在 Run 的 `machineId`/`role`/`loopId`(schema 语义上这些是创建
即固定的列),快照与写时之间不可能漂移。不过把 `machineId`/`role` 一并纳入
条件 UPDATE、并以 `RETURNING` 的权威行生成 lease 与 Delivery,成本极低且
使"写时仍满足全部领取条件"成为结构保证而非约定——同意按建议修复,并补
一条"守卫纳入归属/角色"的测试。

### 发现 3:report 缺锁/CAS 覆盖写入窗口(P1,成立——ADR 符合性缺陷)

**事实**:`store/report.ts:112-136` 事务内普通读取 lease/Run,终态 UPDATE
仅按 `run.id`,lease DELETE 未校验受影响行数。

**复核判断**:成立,且比审查表述更硬——ADR-001:36-38 与 ADR-003:80-83
明确要求"report 与 cancel **必须**在各自事务中锁定同一 Run 行(或使用覆
盖整个写入区间的 CAS),锁定/比较后才检查 phase"。当前实现依赖 PGlite 单
连接的天然串行化,结构上不满足 ADR 的强制要求;真实 Postgres 多连接下两
个并发 report 确实可能双双成功(违背 T3 单次消费)。

**建议修复(CAS 方案,无需 PG FOR UPDATE,PGlite 兼容)**:

1. 终态 UPDATE 加 phase guard(`WHERE id=? AND phase=<进入事务时的相位>`),
   并校验 `RETURNING` 恰好一行;0 行 → 抛 `RunCapabilityInvalidError` 回滚;
2. lease DELETE 同样校验恰好删除一行(0 行 → 回滚);
3. cancel 路径(`cancelRunTx`)已有 phase IN (pending,running) 条件 UPDATE +
   行数校验,符合 CAS 形态——无需改动,但应在修复说明中点名它已合规;
4. PGlite 单连接无法触发真竞争,故补充**守卫形态测试**(直接构造相位已漂移
   的行,证明 UPDATE guard 拒绝),真实多连接竞争按 roadmap 留 Phase 6。

### 发现 4:terminal-grace expiry 只在事务前检查(P1,成立)

**事实**:`coordinator/index.ts` report 的读侧 `resolveLiveLease`
(`store/leases.ts:27`)做过期判断后,写事务内重读 lease 不再复核
`expiresAt`;且边界 `now === expiresAt` 因使用 `>` 而放行。

**复核判断**:成立。读侧 resolve 与写事务之间存在真实窗口(FakeClock 可
在推进后证明)。建议:写事务内以**同一 Clock 快照**复核
`expiresAt <= now`(取 `>=` 判过期,与"past expiresAt ⇒ dead"的语义一致,
顺带钉死边界),过期则删除 lease 并以统一 401 拒绝;补"resolve 后推进时钟
越过过期点"的测试。

### 发现 5:existing message 复用未统一清理(P2,成立)

**事实**:`store/report.ts` `buildReportWriteSet` 在选择 `run.message` 分支
时原样回写,未做 NUL 清理与 2000 截断。

**复核判断**:成立但影响小——Phase 1 写入 `run.message` 的路径(本模块自
身)均已清理,只有未来 in-run 动词或外部写入才可能带入脏值。建议按审查
方案:先完成优先级选择,再对最终值统一 `cleanText`(幂等,对干净值无副
作用),并补 existing-message 分支的清理测试。

---

## 建议的修复批次(待用户裁决后开工)

1. **批次 A(发现 2–5)**:claim 守卫加固 + report CAS + 事务内 expiry 复核
   + message 统一清理,连同各自测试,一次提交;
2. **批次 B(发现 1)**:用户裁决方案 A/B 后,回写 clarify(A-13 补记),
   再改 `applyMachinePollContact` 与对应测试。

另注:审查验证记录(typecheck/test/build 通过)与当前分支一致;绿色套件
不覆盖上述边界,与本复核不矛盾。
