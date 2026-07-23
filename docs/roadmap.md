# Loop Platform ZHB — 复刻路线图

> 目标：以「能力复刻」为标准重建 loop-platform（Loopany）的核心——多用户可调度 Agent 循环平台。
> 本文档是仓库的第一份文档，确定实现顺序及其理由。分析底稿：loop-platform-github `docs/retro-roadmap.md`。

---

## 核心原则

这个系统的价值不在 cron，也不在 Agent，而在 **「调度—领取—执行—回报」链路在重试、重启、休眠下不重不漏**。
因此实现顺序服从三条规则：

1. **心脏先行**：Run 状态机 + 原子 claim + RunLease 凭证模型是第一周的产出物，可靠性语义第一天就进入数据模型，而不是事后补丁。
2. **一切皆可假**：Runner、Blob 存储、Dashboard 先全部用最薄实现（Fake Runner、内存 BlobStore、只读 JSON 页面），它们不影响骨架正确性。
3. **链路上做插件**：cron、真实 Agent、artifact 同步都是已验证链路上的插件，排在心脏测试（ADR-001）全绿之后。

## 三条架构不变量

后续所有模块围绕它们设计，任何 PR 不得破坏：

1. Server 只调度、存储、认证、通知，**绝不执行用户代码或调用 LLM**。
2. Agent 只在用户本机由 daemon 启动；代码、凭证、本地工具默认不离开该机器。
3. HTTP 重试、Server 重启、电脑休眠**不导致**重复执行、丢失最终报告或越权操作。

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

目标：端到端闭环跑通，ADR-001 心脏测试全绿。**本阶段不写一行 cron。**

| 时间 | 产出 |
|---|---|
| Day 1 | `packages/protocol`：wire DTO + zod 校验；workspace 骨架 |
| Day 1–2 | 四张表 `machines / loops / runs / run_leases` + 状态枚举（从 loop-platform `db/schema.ts` 提炼语义，不照抄）；lease 状态机 `active → terminal-grace` 此刻定型 |
| Day 3–4 | `POST /machine/poll` 原子 claim + `POST /machine/report`；**先写心脏测试 T1–T3 再写实现** |
| Day 5–7 | daemon 前台 poll 循环 + Fake Runner（假装执行、直接回报），端到端打通 |
| Day 8–10 | 故障注入：心脏测试 T4–T7（server 重启、daemon 休眠迟到 report、取消、supersede） |

触发方式：手动 `POST /loops/:id/run`。
完成标准：ADR-001 全部测试绿，且三者全部成立——重复 poll 不重复执行、server 重启不丢在途 run、迟到的成功 report 能翻正误判的失败。

## Phase 2 — 让 Loop 成为产品（第 3–6 周）

在已验证链路上逐层叠加，每层不动心脏：

| 周 | 内容 | 验收 |
|---|---|---|
| 3 | cron 调度（croner）+ loop 时区 + 离线 pending 保留 + 重叠保护（下一次触发 supersede 未领取的 pending） | server 重启 / 机器离线恢复后最多补跑一次，绝不双跑 |
| 4 | 一个真实 Agent（claude-code 或 codex 选一）：子进程 spawn、进程组 kill、env 白名单、工作目录 jail | agent 无法越出允许的根目录 |
| 5 | Task File + 跨 run state + open/closed loop（goal/finish 语义） | 连续 run 能读到前次状态；closed 达标即停 |
| 6 | 最小 Dashboard：loop 列表、Run Now、run 状态与最终消息 | 只读 + 一个按钮，不做花活 |

## Phase 3 — 存储与协作（第 7–12 周）

按依赖顺序，每层独立可验：

1. **Artifact 同步**（7–9）：chokidar watcher、全量 sha256 manifest（删除=缺席）、增量哈希、协商上传（needHashes + PUT 验哈希）、每文件/每 loop 上限、never-sync 目录双侧一致、run 快照与 diff。
2. **团队与认证**（10–11）：GitHub 登录、Team/Membership、connect key（24h TTL、不存本体）、机器归属、跨团队 fail-closed。
3. **通知**（12）：失败告警 + 连续失败熔断自动暂停。

## Phase 4 — 高阶能力（第 13 周起，按需）

每一项都可独立裁掉，心脏不依赖它们：

- evolve / edit run（自进化与 owner 派发修改）
- 确定性 workflow（async function body）+ `tools.call` MCP 桥
- 模板市场、生成式 Dashboard
- 多 Agent provider（grok 等）与流式 telemetry 适配

## MVP 暂缓清单

第一版只证明「Loop 能可靠地在本机执行并回报」。以下全部后置：
evolve/edit、生成式 Dashboard 与模板、MCP workflow、多 Agent、R2 与复杂 diff、多通知渠道、复杂 Team 管理、daemon 自动升级。

## 与初版路线图（retro-roadmap.md）的两处关键差异

1. **可靠性语义从 Phase 3 提前到 Phase 1 的设计中**（实现仍最薄）：原子 claim、lease 状态机、幂等 report 无法事后 retrofit，事后补的每一步都在打补丁。
2. **真实 Agent 与 cron 都排在心脏测试绿之后**：它们是链路上的插件，不是链路本身。
