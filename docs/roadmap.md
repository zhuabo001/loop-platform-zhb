# Loop Platform ZHB — 复刻路线图

> 目标：以「能力复刻」为标准重建 loop-platform（Loopany）的核心——多用户可调度 Agent 循环平台。
> 本文档是仓库的第一份文档，确定实现顺序及其理由。分析底稿：loop-platform-github `docs/retro-roadmap.md`。

---

## 核心原则

这个系统的价值不在 cron，也不在 Agent，而在 **「调度—领取—执行—回报」链路在
重试、重启、休眠下的精确承诺**：Run 不重复执行；未成功交付或未完成的 Run 最终
进入可观察的失败状态，不得静默消失；已成功提交的最终报告不因 HTTP 重试产生
重复副作用（at-most-once，见 ADR-001「投递保证」）。
因此实现顺序服从四条规则：

1. **心脏先行**：Run 状态机 + 原子 claim + RunLease 凭证模型是第一周的产出物，可靠性语义第一天就进入数据模型，而不是事后补丁。
2. **一切皆可假**：Runner、Blob 存储、Dashboard 先全部用最薄实现（Fake Runner、内存 BlobStore、只读 JSON 页面），它们不影响骨架正确性。「实现最薄」指**行为**最薄，不指 protocol/schema 形状最薄（ADR-002 决策 6）。
3. **链路上做插件**：cron、真实 Agent、artifact 同步都是已验证链路上的插件，排在心脏测试（ADR-001）全绿之后。
4. **跨阶段 Definition of Done**：安全边界、数据上限和可观察性是每个阶段的完成定义的一部分，不是最后的扫除项。

## 三条架构不变量

后续所有模块围绕它们设计，任何 PR 不得破坏：

1. Server 只调度、存储、认证、通知，**绝不执行用户代码或调用 LLM**。
2. Agent 只在用户本机由 daemon 启动；代码、凭证、本地工具默认不离开该机器。
3. HTTP 重试、Server 重启、电脑休眠**不导致**重复执行、丢失最终报告或越权操作。

**部署边界**：认证（Phase 5）完成之前，server 仅允许 localhost / 受信网络使用，
**不得公开暴露**——机器注册与触发端点在 auth 之前没有任何身份边界。

## 里程碑

不以固定周数承诺「接近完整核心能力」；按行为标志划分四个里程碑：

| 里程碑 | 到达标志 |
|---|---|
| 学习骨架 | ✅ Phase 1 完成（2026-08-11）：T1–T6 绿，手动触发端到端跑通 |
| 可演示 MVP | Phase 2 完成：一条真实 Agent E2E |
| 可靠单用户 | Phase 5 完成：artifact 同步 + 单用户使用闭环 |
| 可公开部署多用户 | Phase 6 生产硬化完成 + auth 上线 |

每个阶段用**行为验收标准**收尾（见各阶段「验收」），不用「完成某模块」当作
完成定义；估算保留未知量与生产硬化缓冲。

## 工程结构

```text
packages/
  protocol/   # server/daemon 共用的 wire DTO + zod 运行时校验（唯一耦合点，单一来源）
  server/     # 调度、状态、认证、存储、Dashboard
  daemon/     # poll、Agent 启动、回报、文件同步、本机 jail
docs/adr/     # 架构决策记录
```

复杂逻辑收敛在少量深模块中（RunCoordinator / AgentRunner / ArtifactHome），HTTP route 只做解析与返回。

---

## Phase 1 — 心脏（第 1–2 周）

> 状态：✅ **已完成**（2026-08-11，`feat/day8-10-fault-injection`）——T1–T6 全绿、
> T7 coordinator 测试绿，三条精确承诺成立；完成记录见
> `docs/handoff/005-phase1-day8-10.md`。

目标：端到端闭环跑通，ADR-001 心脏测试全绿。**本阶段不写一行 cron。**

| 时间 | 产出 |
|---|---|
| Day 1 | `packages/protocol`：wire DTO + zod 校验；workspace 骨架 |
| Day 1–2 | 四张表 `machines / loops / runs / run_leases` + 状态枚举（从 loop-platform `db/schema.ts` 提炼语义，不照抄）；lease 状态机 `active → terminal-grace` 此刻定型 |
| Day 3–4 | `POST /api/machine/poll` 原子 claim + `POST /api/machine/report`；**先写心脏测试 T1–T3 再写实现**；交付 T7 coordinator 测试与 report/cancel 应用层交错测试 |
| Day 5–7 | daemon 前台 poll 循环 + Fake Runner（假装执行、直接回报），端到端打通 |
| Day 8–10 | 完整故障注入：心脏测试 T4–T6（server 重启、daemon 休眠迟到 report、取消）；T7 已在 Day 3–4 以 coordinator 级测试交付 |

触发方式：手动 `POST /api/loops/:id/run`。
完成标准：ADR-001 心脏测试 **T1–T6 全绿**（T7 为 coordinator 级测试，随
`supersedePendingRun` 一同交付），且三者全部成立——重复 poll 不重复执行、
server 重启不丢在途 run、迟到的成功 report 能翻正误判的失败。阶段末尾提供
**CLI 或 JSON 只读观察面**（loop/run 列表与最终消息），不做 Dashboard。

## Phase 2 — 一个真实 Agent（第 3–4 周）

claude-code 或 codex 选一：子进程 spawn、进程组 kill、timeout、env 白名单、
工作目录 jail、progress heartbeat。

| 验收 |
|---|
| 一条真实 Agent E2E 绿；agent 无法越出允许的根目录 |

### 状态

- **Batch 1 — 执行容量与 progress 心跳（Day 1–2）：已完成**（2026-08-19，分支 `codex/phase2-day-1-2`，ADR-004）
  - 协议：`PollRequest.availableSlots?: 0|1` 协作式背压（additive，无 migration）。
  - server：poll 携带 progress 心跳转正（server 独占 `at`、machine+phase 守卫、last-wins、绝不碰 `ts`）；`availableSlots` 门控（0 跳过扫描、1 成功即停、缺省保持批量）。
  - daemon：poll/heartbeat 与执行解耦；容量固定 1（`inFlight ∪ queue ∪ pendingReports` 背压）；轮转 progress 快照；fatal 终止时丢弃队列、join 活动 pipeline。
  - 兼容：Phase 2 server + Phase 1 daemon 兼容；Phase 2 daemon + Phase 1 server 不承诺长任务/批量队列 liveness；升级先 server 后 daemon。
- **Batch 2 — 本机执行隔离原语（Day 3–5）：已完成**（2026-08-19，分支 `feat/phase2-batch2`，ADR-005）
  - 配置：`LOOPZHB_ALLOWED_ROOTS` 必填（纯语法解析，零 FS 副作用）+ `LOOPZHB_CLAUDE_BIN` / `LOOPZHB_AGENT_TIMEOUT_MS` 默认值。
  - jail：daemon roots 启动 canonicalize；server roots 逐 Delivery 重校验；`path.relative()` 交集（只窄不宽）；per-run scratch（0700、永不复用、release fail-closed）。
  - subprocess：一 spawn 一进程组；TERM → 5s → KILL；先到触发器定 kind；返回前 reap 残留孙进程；stdio 1 MiB 头尾各半 + 有序 chunk 回调。
  - env：allow-list 白名单（`LOOPZHB_*` 与云/CI 密钥天然排除）；secretValues 长度降序脱敏。
  - 边界：**不切换生产 Runner**（Fake Runner 保持，I6 守护）；jail 只选 cwd，不是运行时安全边界——Batch 3 的 OS sandbox 才是。
- **Batch 3 — Claude Code adapter 与生产切换（Day 6–8）：已完成**（2026-08-20，分支 `feat/phase2-batch3`，ADR-006）
  - Runner seam：`run(delivery, { signal, onProgress })`；runtime 拥有 progress sink（inFlight 门禁、child-controlled 事件固定语义标签、去 NUL/单行/200 字符、每事件 step+1、reporting = lastStep+1 单调不回退）。
  - adapter：固定 argv + fail-closed 动态 settings；只开放 `Bash`（内建 Read/Edit/Write 不在 OS sandbox 边界内）；sandbox 不可用即失败，禁止降级；`codex`/`grok` 固定 unsupported 不 spawn。
  - stream-json 增量 parser：跨 chunk UTF-8、1 MiB 行上限、terminal result 恰好一次、数值字段卫生、内容无关的稳定失败。
  - jail `revalidate` 把 resolve→spawn TOCTOU 收窄到最小窗口（残余由 fail-closed OS sandbox 兜底）；scratch finally release，清理失败判 Run 失败。
  - 生产切换：`prepareDaemon` = config → startup jail → 无凭据 Claude 探测（10s、≥2.1.219、flags 检查，每次前后 stat+sha256）→ client → Claude Runner → runtime；真实 Run 在携带凭据前再复核身份，Fake Runner 退为测试 fixture。
  - Issue #12 跨层 round-robin liveness 验收落地（L1–L2：窗口内零误回收 + 对照回收 + 静默后全量回收）；opt-in 真实 sandbox smoke 备妥（默认跳过）。

### 右移项

- [ ] **Batch 3 复审核销**：[Issue #15](https://github.com/zhuabo001/loop-platform-zhb/issues/15)——复审 P1/P2/P3 已全部落地（red→green 成对提交），第四轮三轨核销通过；仅剩签字后的 smoke 命令形态修复（纯测试提交）待一轮聚焦复验后关闭。

顺手收口：[Issue #10](https://github.com/zhuabo001/loop-platform-zhb/issues/10)
（Day 8–10 二次审查右移项，不影响正确性）。

## Phase 3 — cron 与离线恢复（第 5–6 周）

cron（croner）+ loop 时区 + DST + 离线 pending 保留 + 重叠保护（下一次触发
supersede 未领取的 pending——T7 语义在 cron 表面继承）+ 重启 catch-up 合并。

| 验收 |
|---|
| server 重启 / 机器离线恢复后最多补跑一次，绝不双跑 |

## Phase 4 — Loop 产品语义（第 7–8 周）

Task File + 跨 run state + open/closed loop（goal/finish 语义）+ 最小 Dashboard
（loop 列表、Run Now、run 状态与最终消息）。

| 验收 |
|---|
| 连续 run 能读到前次状态；closed 达标即停；Dashboard 只读 + 一个按钮，不做花活 |

## Phase 5 — 存储与协作（第 9–14 周）

按依赖顺序，每层独立可验：

1. **Artifact 同步**：chokidar watcher、全量 sha256 manifest（删除=缺席）、增量哈希、协商上传（needHashes + PUT 验哈希）、每文件/每 loop 上限、never-sync 目录双侧一致、run 快照与 diff。
2. **团队与认证**：GitHub 登录、Team/Membership、connect key（24h TTL、不存本体）、机器归属、跨团队 fail-closed。**此层完成前 server 不得公开暴露。**
3. **通知**：失败告警 + 连续失败熔断自动暂停。

## Phase 6 — 生产硬化（独立阶段）

Postgres（托管分层）/R2、迁移预检、body/rate/storage caps、SSRF 防护、GC、
健康检查、部署形态，以及**真实 Postgres 的并发验证**：使用多个物理连接验证行锁
竞争、隔离级别、死锁与重试（PGlite 在 Phase 1 只验证应用层交错编排与真实事务提交，
不代表托管 PG 的并发语义）。

**显式阻塞项**：[Issue #11](https://github.com/zhuabo001/loop-platform-zhb/issues/11)
——Day 8–10 report/reclaim 竞态防护的多物理连接并发验收（ADR-001 修订记录
2026-08-11），关闭前不得进入真实 Postgres。

## Phase 7 — 高阶能力（按需）

每一项都可独立裁掉，心脏不依赖它们：

- evolve / edit run（自进化与 owner 派发修改）
- 确定性 workflow（async function body）+ `tools.call` MCP 桥
- 模板市场、生成式 Dashboard
- 多 Agent provider（grok 等）与流式 telemetry 适配

## MVP 暂缓清单

第一版只证明「Loop 能可靠地在本机执行并回报」。以下全部后置：
evolve/edit、生成式 Dashboard 与模板、MCP workflow、多 Agent、R2 与复杂 diff、多通知渠道、复杂 Team 管理、daemon 自动升级。

## 与初版路线图（retro-roadmap.md）的两处关键差异

1. **可靠性语义从 Phase 3 提前到 Phase 1 的设计中**（实现仍最薄）：原子 claim、lease 状态机、效果幂等 report 无法事后 retrofit，事后补的每一步都在打补丁。
2. **真实 Agent 与 cron 都排在心脏测试绿之后**，且**真实 Agent 先于 cron**——daemon/runner 契约的不确定性高于纯 server 侧的 cron，先验证契约；cron 是链路上的插件，不是链路本身。
