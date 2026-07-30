# Handoff：Phase 1 心脏（Day 3–4 完成态）

> 更新日期：2026-07-30 ｜ 分支 `feat/day3-4-poll-report`（基于含 PR #4 的 main，待合入）
> 用途：让任何新会话/新人在 5 分钟内接上当前进度。路线图全貌见 `docs/roadmap.md`；
> 上一阶段见 `docs/handoff/001-phase1-day1-2.md`。
>
> Day 3–4 的完整执行计划与全部 22 项决议（4 CONFLICT + 4 GAP + 14 ASSUMPTION）
> 见 `docs/handoff/codex-handoff-pollReport-plan.md` 与
> `codex-handoff-pollReport-plan-clarify.md`（两份均已全量收敛）。本批次按计划
> 七个 step 逐提交交付，随后完成两轮独立代码审查与 7 项修复（见末节
> 「评审与修复记录」）；测试基线更新为 **197 全绿（62 protocol + 135 server）**。

---

## 一句话现状

机器调度心脏链路已交付并可启动：`POST /api/machine/poll`（自注册 + 心跳 +
原子 claim + Delivery）与 `POST /api/machine/report`（finalize + reconcile +
统一 capability invalidation），经 RunCoordinator 深模块 + Hono 适配层 +
`dist/start.js` 零配置启动（默认 `127.0.0.1:3000` + `~/.loopzhb` 文件库）。
**下一步是 Day 5–7：daemon 包（前台 poll 循环 + Fake Runner）。**

## 已完成清单（七步，每步一提交）

1. **Step 1 — RunCoordinator 骨架 + T7**(`dffa399`):`src/coordinator` 深模块
   （接口仅 `enqueueExecRun`/`poll`/`report`，不含 HTTP 权限面）+ 注入式
   `RunCoordinatorDependencies`（db/clock/newRunId/mintRunCredential 分离）+
   per-Loop 进程内串行化；`enqueueExecRunTx` 单事务原子 supersede(T7 八条测试，
   含 insert 失败回滚与 Poll 抢先 claim 应用层门）。
2. **Step 2 — Poll 路径**(`5999771`):machine 自注册（派生 id + 全 hash 校验，
   PK 竞争幂等收敛）、A-13 心跳水位（10s 单调 GREATEST guard，垃圾纠正、未来
   值读 fresh、身份变化合并单 UPDATE、NUL/255-64-64-64 清洗）、
   `claimRunWithLeaseTx`（条件 UPDATE + lease INSERT 同事务，mint 在事务内，
   caps 全 false 显式写入）、`buildExecTask` 双模板黄金测试。T1/T2 落地。
3. **Step 3 — Report 状态机**(`ccd9772`):`executeReportTx` 两阶段 resolve
   （事务内重解析 + phase 重查）；active+running→finalize、terminal-grace+
   error→恰一次 reconcile、orphaned/stale→fail-closed 清理后以 denied outcome
   提交再抛 401（清理不被回滚）；A-08 字段策略全实现。T3/T5 落地。
4. **Step 4 — cancel/reclaim 原语**(`04eecbf`):`cancelRunTx`(canceled + lease
   DELETE 同事务）与 `reclaimStaleRunTx`（仅 sweep 可调用；terminalize 为事务内
   私有步骤，公开面无通用 `terminalizeLease`——有结构钉）；report/cancel 应用
   层门交错测试；delivery 丢失→sweep→恰一次 wake-report 全链路。
5. **Step 5 — HTTP 适配层**(`9165832`):`createServerApp(coordinator)` 纯装配
   seam（不读环境/不开 DB/不监听/独立实例）;2MiB body cap;400/401/401+code/
   413/404/500 全过 `apiErrorSchema`，唯一 code `run_capability_invalid`;500
   不泄漏异常/stack/DB 细节。
6. **Step 6 — boot**(`6337973`):纯函数 `loadServerConfig`（三项空白即默认、
   port 严格 1–65535、相对 DATA_DIR 绝对化、非 loopback 警告）+ `start.ts`
   唯一 composition root(`bootstrapServer` 可测核心 + `main()` 监听/幂等有序
   关停）;T4 重启持久化测试（active lease 跨重启可 report)；真实冒烟通过。
7. **Step 7 — 收尾**：本 handoff + package 描述更新；全量验证见下。

## 关键工程规则（后续批次必须遵守）

1. **所有生命周期时间写入必须走注入 Clock**(`src/time.ts`)，禁止
   `new Date()`/`Date.now()` 直连；Coordinator 与 store 无一例外。
2. **hooks 是测试专用交错门**(`beforeEnqueueTx`/`afterReportResolve`/
   `insideReportTx`):PGlite 单连接下的竞态测试通过"读侧 resolve 后暂停 →
   竞争者真实提交 → 事务内二次验证"编排；production boot 永不注入 hooks。
3. **capability 失效统一 401 + `run_capability_invalid`**，具体 reason 只进
   服务端日志；读取侧永不做 `rk_` 形状预过滤（legacy bare UUID 必须可解析）。
4. **lease mint 全部 caps 显式 false**(ADR-003),Delivery 的
   `loop.allowControl` 是真实配置而非授权；能力开放必须与 route+mint policy+
   测试同批，不追溯旧 lease。
5. **package exports 保持仅 `./db`、`./db/schema`**;Coordinator/HTTP/配置均
   为包内模块（测试相对路径 import)，未来嵌入方出现再 additive 开放。
6. **production 永不内存启动**:`bootstrapServer` 始终传文件 dataDir；无
   dataDir 的 `createDb()` 只供测试 fixture。启动日志不含 secret。
7. **事务边界**(ADR-001/003 有意的参考偏离）：claim+lease INSERT、
   finalize+lease DELETE、cancel+lease DELETE、reclaim(run error + lease
   terminal-grace）各自单事务；fail-closed 清理用 denied outcome 提交后再抛
   错（避免回滚清理）。

## 完成验证（分支 HEAD)

- `pnpm -r typecheck` ✅
- `pnpm -r test` ✅ **204 全绿（62 protocol + 142 server)**
- `pnpm -r build` ✅（产物含 `dist/start.js`)
- `pnpm --filter @loopzhb/server db:check` ✅（无 schema 变更）
- 冒烟：`node dist/start.js` 真实启动 → poll 自注册 200、未知 credential
  统一 401+code、SIGTERM 有序关停 ✅

## 评审与修复记录

两轮独立代码审查（`codex-handoff-code-review-day34.md`，双轴：plan 一致性 +
对抗性）共 9 项发现；独立复核结论见 `kimi-response-code-review.md`。
7 项成立并已逐项修复（每项一提交）:

| 发现 | 修复 | 提交 |
|---|---|---|
| #2 claim 写时守卫不含 machineId/role | 条件 UPDATE 纳入全量领取条件，lease/Delivery 用 RETURNING 权威行 | `8a09c0c` |
| #3 report 缺覆盖写入窗口的 CAS(ADR 符合性） | 终态 UPDATE 相位 guard + 两写均校验行数，0 行即回滚 | `57a640a` |
| #4 terminal-grace expiry 只在事务前检查 | 事务内同一 Clock 快照复核；边界 `now >= expiresAt` 钉死 | `b7edeb4` |
| #5 existing message 复用未统一清理 | 最终选中值统一 cleanText | `1c521d7` |
| #6 reclaim 无 active lease 提交半套状态 | 合取守卫：lease 恰一行否则抛错回滚，两个零写入反例 | `7093dfb` |
| #7 Coordinator 越过 A-02 三方法边界 | 收窄回三方法；cancel/reclaim 留 store 层；接口 keys 结构钉 | `e2fe462` |
| #8 listener 启动失败不关 DB、误报 ready | 等待 listening/error，失败有序清理后非零退出；端口占用测试 | `1eba754` |
| #1 未来 lastSeen 纠正 vs 单调水位（语义裁决） | 有界 skew 窗口:近未来不倒写、远未来写入侧纠正 + 消费侧共享谓词;ADR-003 修订 + A-13 补记 | `5c8025a` |

**语义裁决项 #1 亦已收口**:codex 澄清轮接受复核的核心反驳并补充消费侧条
款（合理且必要——写入侧纠正触达不到"污染后沉默"的场景）。裁决落地为有界
clock-skew 窗口（`HEARTBEAT_SKEW_SLACK_MS = 5min`）:窗口内近未来保持单调
不倒写，超窗远未来视为污染——写入侧纠正（`5c8025a`),presence/sweep 消费
侧共用同一谓词判定为无存活证据。ADR-003 已补 2026-07-30 修订条目，A-13 已
补记。至此两轮审查 9 项发现全部闭环（8 项修复 + 1 项裁决落地）。

## 下一步：Day 5–7（daemon)

按 roadmap:daemon 包（前台 poll 循环 + Fake Runner)。已具备的对接面：
poll 请求体扁平可选字段（host/platform/arch/version)、Delivery 全字段消费
（roots 空=[] 不限、taskFile 模板二选一）、report `ok`+message/finalText/
error/durationMs/sessionId(`durationMs` 已带 `.int()`)。Fake Runner 允许
接收无 task-file 的 Delivery（模板已诚实标记无任务来源）;Phase 2 真实
Agent E2E 必须使用配置了本地 taskFile 的 Loop。T4–T6 的故障注入（sweep
编排推进 Fake Clock）在 Day 8–10 收口；`reclaimStaleRun` 原语已就绪。

## 工作环境备注

- 测试基线命令：`pnpm -r test`；server 单包 `pnpm vitest run <path>`。
- PGlite 实例是全测试套件最稀缺资源：多子例测试共享单实例播种，套件级
  `testTimeout` 已调至 20s(`packages/server/vitest.config.ts`)。
- 启动：`pnpm --filter @loopzhb/server build && pnpm start`（只跑构建产物，
  无隐式 build);env 覆盖 `LOOPZHB_HOST/PORT/DATA_DIR`。
- 勿提交：`.serena/`（已 gitignore)、`docs/handoff/codex-handoff-code-review-day34.md`
  （外部评审稿，待处理）。
