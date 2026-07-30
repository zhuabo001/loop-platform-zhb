# 对《Day 3–4 代码审查》的独立复核结论

> 日期:2026-07-30 ｜ 复核人:Kimi(Claude Code)
> 复核对象:`docs/handoff/codex-handoff-code-review-day34.md` 的两轮审查——
> 第一轮 Step 1–3(`origin/main...ccd9772`)5 项发现;第二轮 Step 4–7
> (`ccd9772...ba81965`)4 项新发现(Step 5 零发现)。
> 方法:逐条对照 ADR-001/003 原文、收敛后的 plan/clarify、参考实现
> (`loop-platform-github`)与当前分支代码独立取证;不预设审查结论对错。
> 引用行号为复核时的分支 HEAD。

## 结论总表

| # | Step | 发现 | 复核结论 | 处置建议 |
|---|---|---|---|---|
| 1 | 2 | 未来 `lastSeen` 未按"未来水位纠正"处理 | **语义裁决项——已裁决并落地(codex 接受核心反驳并补充消费侧条款)** | 已完成(`5c8025a` + ADR-003 修订 + A-13 补记) |
| 2 | 2 | claim 写时守卫不含 machineId/role | **成立(加固项,当前不可触发)** | 批次 A |
| 3 | 3 | report 缺覆盖写入窗口的锁/CAS | **成立,ADR 符合性缺陷(必须修)** | 批次 A(CAS 方案) |
| 4 | 3 | terminal-grace expiry 只在事务前检查 | **成立** | 批次 A |
| 5 | 3 | existing message 复用未统一清理 | **成立(P2)** | 批次 A |
| 6 | 4 | reclaim 无 active lease 时仍提交半套状态 | **成立,计划守卫的合取条件未落实** | 批次 A |
| 7 | 4 | Coordinator 越过三方法接口边界(A-02) | **成立(计划符合性)** | 批次 A(收窄回三方法) |
| 8 | 6 | listener 启动失败不关 DB、误报 ready | **成立** | 批次 A |
| 9 | 7 | handoff 完成态声明早于实际验收 | **成立(流程项,随批次 A/B 消解)** | 修复后在 003 补偏差记录 |

---

## 第一轮(Step 1–3)

### 发现 1:未来 `lastSeen` 的语义冲突(P1 → 裁决项)

**事实**:plan 原文同时包含——(a)"`lastSeen` ... null、非法、**未来**或
距当前时间已满 10 秒时**刷新**";(b)"并发写必须在数据库 guard 中保证
`lastSeen(new) = max(lastSeen(stored), pollTime)`,**不得倒退**"。

当前实现(`store/machines.ts:132-150`)以 (b) 为不变量:未来水位读作
fresh(身份不变零写入;身份变化时 `GREATEST` 保留较大值),并有 skewed-
clock 不倒写测试钉绿。审查以 (a) 为依据要求纠正为当前 Poll 时间。

**判断**:两句话无法同时字面成立——未来水位无条件纠正,则时钟落后的并
发 Poll 必然回写过去,直接违反 (b) 及其配套测试。A-13 决议标题是"**单
调的** 10 秒持久化水位",单调性是其头号属性;审查担心的"远未来水位使
presence/sweep 长期误判在线"也是真实风险。

**建议裁决(倾向方案 A)**:

- **方案 A(推荐)**:单调性不可打破;"纠正"只适用于**非法
  (unparsable)** 值(当前行为)。另加上限钳制消解远未来风险:
  `stored > pollTime + SKEW_SLACK`(如 5 分钟,远超合理 NTP 偏移)视为
  垃圾值,纠正为 pollTime。两条计划语句于是同时成立:正常 skew 窗口内不
  倒退,病态远未来被修复。需回写 clarify(A-13 补记)后改代码与测试。
- **方案 B**:按审查字面"未来即纠正",删除"不得倒退"及测试,接受多实例
  时钟偏移下水位回摆。削弱 A-13 单调性承诺,不建议。

**裁决结果(2026-07-30)**:codex 澄清轮接受本复核的核心反驳(不执行"所有
future 均回写"的原修复建议),并补充两点——(a) 在 A-13 明确有界 skew 容忍
窗口(即上述方案 A);(b) **presence/sweep 消费侧必须采用同一窗口**,把远
未来值判定为异常而非持续 fresh。评估:补充合理且 (b) 是必要补全——方案 A
只修写入侧(下一次 Poll 纠正),而"写入污染值后机器沉默"的场景写入侧永远
触达不到,只能靠消费侧防御。已落地:共享窗口常量与谓词、写入侧远未来纠
正、消费侧分类/年龄钳制(提交 `5c8025a`)、ADR-003 2026-07-30 修订条目、
A-13 补记;测试覆盖近未来不倒写、远未来修复、slack 边界、消费侧四域判定、
并发不回退。

### 发现 2:claim 写时守卫不完整(P1,成立——加固项)

`store/runs.ts:148-180` 的条件 UPDATE 只校验 `run.id + phase='pending'`,
lease 的 `loopId/machineId/role` 来自候选扫描快照。发现属实,但**当前不
可触发**:Phase 1 无任何写入方修改已存在 Run 的 `machineId`/`role`/
`loopId`(创建即固定)。把 `machineId`/`role` 纳入条件 UPDATE、以
`RETURNING` 权威行生成 lease 与 Delivery,成本极低且使"写时仍满足全部领
取条件"成为结构保证——同意修复并补测试。

### 发现 3:report 缺锁/CAS 覆盖写入窗口(P1,成立——ADR 符合性缺陷)

`store/report.ts:112-136` 事务内普通读取、UPDATE 仅按 `run.id`、DELETE 未
校验行数。成立,且比审查表述更硬:ADR-001:36-38 与 ADR-003:80-83 明确
要求"report 与 cancel **必须**在各自事务中锁定同一 Run 行(或使用覆盖整
个写入区间的 CAS)"。当前实现依赖 PGlite 单连接天然串行化,结构上不满足;
真实 Postgres 多连接下两个并发 report 可双双成功(违背 T3 单次消费)。

**修复方案(CAS,无需 FOR UPDATE,PGlite 兼容)**:

1. 终态 UPDATE 加相位 guard(`WHERE id=? AND phase=<入口相位>`)并校验
   `RETURNING` 恰好一行,0 行 → 抛 `RunCapabilityInvalidError` 回滚;
2. lease DELETE 校验恰好一行,0 行 → 回滚;
3. `cancelRunTx` 已是"phase IN (pending,running) 条件 UPDATE + 行数校验"
   的 CAS 形态,**已合规**,修复说明中点名即可;
4. 补守卫形态测试(构造相位已漂移的行证明 guard 拒绝);真实多连接竞争
   按 roadmap 留 Phase 6。

### 发现 4:terminal-grace expiry 只在事务前检查(P1,成立)

读侧 `resolveLiveLease`(`store/leases.ts:27`)与写事务之间存在真实窗口;
边界 `now === expiresAt` 因 `>` 而放行。建议:写事务内以**同一 Clock 快
照**复核 `expiresAt <= now`(取 `>=` 判过期,钉死边界),过期删 lease 并
统一 401;补"resolve 后推进时钟越过过期点"测试。

### 发现 5:existing message 复用未统一清理(P2,成立)

`buildReportWriteSet` 的 `run.message` 分支原样回写,未做 NUL 清理与 2000
截断。影响小(Phase 1 写入方均已清理),但统一过 `cleanText` 幂等无害;
补 existing-message 分支测试。

---

## 第二轮(Step 4–7)

### 发现 6:reclaim 无 active lease 时提交半套状态(P1,成立)

**事实**:`store/runs.ts:224-238` 仅以 `runs.phase='running'` 为 guard;后
续 lease UPDATE 影响 0 行时 Run 的 error/error 仍提交并返回 true。

**判断**:成立。计划的事务守卫是**合取条件**——"非 `running Run +
active lease` 不得被 reclaim";`running + active lease`(claim+lease 同事
务保证)之外的 running 行是 invariant 破损态,把它 error 化会制造**没有
terminal-grace capability、迟到 report 永远无法 reconcile 的终态**,正是
计划要避免的。修复:lease UPDATE 校验恰好一行,否则抛内部 guard error 回
滚整个事务;补两个零写入反例(running 无 lease;running + 非 active
lease)。

### 发现 7:Coordinator 越过三方法接口边界(P2,成立——计划符合性)

**事实**:plan §1 与 clarify A-02 锁定包内接口仅 `enqueueExecRun`/`poll`/
`report`;我在 Step 4 为 coordinator 增加了 `cancelRun`/`reclaimStaleRun`。

**判断**:成立。两条路:(a) 收窄回三方法——cancel/reclaim 保持 store
原语,由未来的 owner adapter 与 sweep 编排直接消费,测试改为直接调 store;
(b) 先修订 A-02 与主计划再扩展。**建议 (a)**:Phase 1 没有 adapter,计
划锁定面不应在飞行中修订;Day 8–10 sweep 编排落地时再评估是否以修订
A-02 的方式开放窄方法。配套:接口 keys 结构测试,锁定 `RunCoordinator`
恰好暴露 `{enqueueExecRun, poll, report}`。

### 发现 8:listener 启动失败不关 DB、误报 ready(P1,成立)

**事实**:`start.ts` `main()` 中 `serve()` 在 `server.listen()` 完成前即
返回;`EADDRINUSE` 等错误经异步 `error` 事件报告,`main().catch()` 捕获
不到;"listening" 日志提前输出;失败路径不执行有序 HTTP/DB 清理,DB 句
柄泄漏。

**判断**:成立。修复:以 Promise 等待 `listening`/`error` 事件后再记录
ready;失败时幂等关闭 server(若已创建)与 DB 后以非零退出;补端口占用
测试(先占住端口,证明 boot 以非零失败且 DB 被关闭)。计划"启动失败或
SIGINT/SIGTERM 时幂等地先关闭 HTTP server、再关闭 DB"对失败路径同样
适用。

### 发现 9:handoff 完成态声明早于实际验收(P2,成立——流程项)

`003-phase1-day3-4.md` 的"全量收敛/七步全部交付"声明在第一轮 P1 未决时
已属超前;第二轮发现坐实了偏差。处置:批次 A/B 修复落地后,在 003 增补
"评审与修复记录"小节(两轮发现、裁决、修复提交锚点),完成态声明届时
才成立;修复前 PR #5 不合入。

---

## 修复批次建议(待用户裁决后开工)

- **批次 A(发现 2/3/4/5/6/7/8)**:claim 守卫加固、report CAS、事务内
  expiry 复核、message 统一清理、reclaim 合取 guard、Coordinator 收窄回三
  方法(测试改调 store 原语 + 接口 keys 结构钉)、boot listener 失败有序
  清理;连测试一次或数次提交;
- **批次 B(发现 1)**:裁决方案 A/B 后回写 clarify(A-13 补记),再改
  `applyMachinePollContact` 与测试;
- **收尾(发现 9)**:003 handoff 增补评审与修复记录小节。

另注:两轮验证记录(typecheck/test/build/db:check 通过)与当前分支一致;
绿色套件不覆盖上述边界,与本复核不矛盾。

---

## 二次审核复核(2026-07-31)

对审查稿「二次审核」一节(范围 `ba81965...fd59241`)4 项新发现的独立复核:

| # | 发现 | 复核结论 | 修复 |
|---|---|---|---|
| 10 | 远未来纠正无条件写入,逆序提交可倒写(P1) | **成立**——纠正分支缺 DB guard,违反 A-13「单调条件必须落实到数据库写入 guard」;GREATEST 路径有 guard,纠正路径没有 | `0710ed8`:按观测值 optimistic CAS,落空即重读重决策(有界 3 次);T2→T1 逆序测试 |
| 11 | cancel/reclaim 注释仍写"调 Coordinator"(P3) | **成立**——F7 收窄后注释未同步 | `434cf0b` |
| 12 | waitForListening 残留落选监听器(P2) | **成立**——Node 语义下任一 'error' listener 即视为已处理,残留的 once('error') 会把运行期错误吞进已 settled 的 promise | `55806aa`:具名 handler、settle 时互删;emit('error') 抛出测试 |
| 13 | handoff 再次提前声明闭环(P2) | **成立(流程项)**——本次修复+记录后成立 | 003 已补二次审核记录 |

二次审核的验证记录中,"server 141/142、唯一失败为 EPERM listen 沙箱限制"
系其执行环境所致;本开发环境不受此限,207 全绿(62 protocol + 145
server)已独立确认。审查结论"presence/sweep 消费者接线时须再次验证同一
谓词"已登记进 003 的 Day 5–7 备注。
