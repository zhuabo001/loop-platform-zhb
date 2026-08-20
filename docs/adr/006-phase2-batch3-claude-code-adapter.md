# ADR-006：Phase 2 批次三——Claude Code Adapter 与生产切换

- 状态：Accepted
- 日期：2026-08-20
- 关联：docs/roadmap.md Phase 2 批次三（Day 6–8）；docs/plan/phase2-batch3-plan.md；ADR-001（可靠性约束）；ADR-004（批次一）；ADR-005（批次二）
- 实现：分支 `feat/phase2-batch3`，red→green 成对提交（测试分组 P/S/A/R/PR/L）

## 背景

批次一解决「daemon 何时执行」，批次二解决「如何安全地选择执行环境」，批次三交付**真实 Claude Code Runner** 并把生产 daemon 从 Fake Runner 切换过去。本批的核心是把「真实执行」作为一个完整安全单元落地：adapter、fail-closed OS sandbox、stream-json 解析、runner 事件接入 progress、生产切换与启动探测一起交付——任何一半都不得单独上线（ADR-005 决策 1 的另一半）。

## 决策

1. **Runner seam 从裸 AbortSignal 升级为 RunnerContext（`{ signal, onProgress }`）**。runtime 为当前 Run 提供 `onProgress(label)` sink：仅 Run 仍在 `inFlight` 时接受事件（runner settle 后的迟到 callback 结构性忽略）；label 去 NUL、`\s+` 压单行、截 200 字符；每个被接受的事件递增该 Run 的 step；runner 完成后 step **再 +1** 进入 `reporting result`——reporting 不再是固定 step 2，而是 lastStep+1，保证 step 单调不回退。清洗后为空串的 label 不消耗 step（无信息事件不产生状态迁移，R4）。Fake Runner 只适配签名，不产出事件。

2. **只开放 `Bash` 工具是本批的安全决策**。Claude 内建 sandbox 只对 Bash 及其子进程提供 OS 级边界；内建 `Read/Edit/Write` 不在该边界内，因此整批关闭（`--tools Bash`）。动态 settings 固定 fail-closed 形态：`sandbox.enabled/failIfUnavailable/autoAllowBashIfSandboxed`、`allowUnsandboxedCommands=false`、`excludedCommands=[]`、`filesystem.denyRead=["/"]` + `allowRead/allowWrite=[...effectiveRoots, cwd]`（精确去重）、`network.strictAllowlist` + 空 `allowedDomains`、`disableAllHooks`、`autoMemoryEnabled=false`；permission mode 钉死 `dontAsk`（永不 bypass）。用户/project/local settings 源全部禁用（`--setting-sources ""` + `--safe-mode`）；managed policy 仍是主机管理员的受信面。**配置不可用即失败，禁止降级为 unsandboxed 执行。**

3. **启动探测先于 HTTP client 存在**。composition root 为 `config → startup jail → Claude probe → Machine client → Claude Runner → runtime`（`prepareDaemon`）：probe 以 `shell:false` 执行 `claude --version` 与 `claude --help`，固定 10s 超时（每次调用），版本 ≥ 2.1.219，且 `--help` 必须包含本批固定 argv 依赖的全部 flags（`REQUIRED_CLAUDE_FLAGS`）。探测在首次 poll 之前是结构性的：poll 循环只在 `prepareDaemon` resolve 后才存在。探测使用**与真实运行相同的白名单 env**（在该 env 下起不来的二进制跑每次 Run 也会失败，探测更忠实）。任何探测失败、输出不可解析或平台不支持都直接终止启动。

4. **stream-json parser 是独立的增量 JSONL 模块**，直接接 `spawnWithTimeout.onStdout`：streaming `TextDecoder` 跨 chunk 重组 UTF-8（不合成 U+FFFD）；单行缓冲按**原始字节流**记账，上限 1 MiB；`system/init` 捕获 session（首个非空获胜）；assistant 的 text/tool_use 块按序生成 progress（Bash 摘要 `input.command`，其他工具摘要 JSON input）；`system/api_retry` 生成 provider retry progress；未知事件一律忽略（tolerant reader——parser 只对完全认识的形状行动）。terminal `result` 必须恰好出现一次：成功 ⇔ `subtype==="success"` 且 `is_error===false` 且 `exitCode===0`（三者缺一不可，成功 terminal 与非零退出码的背离判失败）；数值字段仅在有限、非负（token/turns 额外要求整数，对齐 wire schema `costReportSchema`）时保留，非法值只丢弃对应字段。失败态粘性：parser 在 push 时抛错（借 subprocess 的 consumer-error 路径立即终止进程组）并在 finish 时返回同一失败；failure detail 只带行号、**永不引用行内容**（行内可能含 secret）。terminal 之后的尾部宽容：忽略一切非 result 行，第二个 result 才是 duplicate-result 失败。

5. **失败映射稳定且无内容**：timeout/abort/signal/spawn-error/非零退出/stream 解析失败各有固定句式；CLI 自己的错误叙事（error terminal 的 `result`/`errors`）优先于进程级细节；可附 redact+截断后的 stderr 尾部（≤500 字符）辅助诊断；失败 error 整体截断至 `ERROR_CAP`；**不发送不可信原始 transcript**。成功报告携带 `finalText/sessionId/durationMs/cost`（cost 仅在至少一个字段存在时携带）；`role=evolve` 报 `outcome=evolve`，其余成功角色报 `exec`；失败报告永不携带 outcome。

6. **脱敏在进入 report/log/progress 前完成，且由 adapter 负责**：redact 集合 = env 白名单的 secretValues（全部非空 `ANTHROPIC_*`、OAuth token、代理值）+ run token。顺序固定：parser 产出的原文 → adapter `redactSecrets` → runtime sanitize/cap。machine credential 结构性不进 child env（`LOOPZHB_*` 天然不匹配白名单），runtime 的 `sanitizeRunnerError` 仍对 runner 抛出的错误做 machine credential + run token 兜底。

7. **`WorkdirJail.revalidate(resolved)` 关闭 resolve→spawn 的 TOCTOU 窗口**（ADR-005 修订记录第 3 条的批次三义务）：spawn 前重新 realpath 每个 effective root 与 cwd，要求**仍解析到记录值本身**且仍是目录；scratch 走与 release 相同的 fail-closed 身份检查（本 jail 铸造、仍是 per-jail scratch 根的直接子级、lstat 非符号链接）。任何漂移抛 JailError 且不 spawn。cwd 被替换为指向根内的符号链接同样拒绝——记录值必须自解析。scratch 在 `finally` 中无条件 release；**release 失败判 Run 失败**（已算出的成功报告一并丢弃）。

8. **Issue #12 跨层 liveness 验收落地为单测试文件**（`packages/server/src/roundrobin-liveness.test.ts`）：真实链路 daemon runtime → MachineClient → HTTP → coordinator → applyRunProgress → PGlite；批量交付窗口用「daemon poll 省略 `availableSlots`」复现（server 保持 Phase 1 批量 claim）；25 个 running Run = 1 executing + 24 queued；同一 FakeClock 驱动 coordinator 的 progress `at` 与 sweep 的 inactivity 判定。三层断言：窗口内零误回收 + 从未心跳的对照 Run 被回收（sweep 非空转）+ 心跳停止越过窗口后 25 个全部回收（零回收是新鲜证据挣来的，不是 sweep 死了）。本测试是行为先于 pin 的验收（沿用 ADR-004 决策 10 例外，同批次二 I1–I4）。

9. **opt-in 真实 sandbox smoke 不进默认离线套件**（`claude-smoke.test.ts`，`LOOPZHB_CLAUDE_SMOKE=1` 开启）：真实 Claude Code + 开发者认证下验证根内读写成功、根外 sentinel 读取不泄漏（report 与 progress 均不含内容）、根外覆盖写不发生；断言只依赖文件系统证据与泄漏缺席，不依赖模型措辞。`LOOPZHB_SMOKE_EXPECT_NO_SANDBOX=1` 变体用于无 sandbox 主机：场景 1 必须失败（failIfUnavailable 语义的人工验收）。

10. **测试纪律沿用 ADR-004 决策 10**。本批 red→green 成对：P1–P20（parser）、S1–S10（revalidate）、A1–A19（adapter）、R1–R4（runtime sink，含既有 fixture 契约适配）、PR1–PR8（probe 与生产切换）。L1–L2 为验收 pin-only（决策 8）。A 组经 fake-claude fixture 真实 spawn（argv/settings/env 经 sidecar 取证），不经 mock。

## 边界与显式不做

- 支持 macOS / Linux / WSL2；原生 Windows 不支持。
- 本机 Claude Code 2.1.227；最低版本 2.1.219，辅以 flags 探测（而非纯版本闸）。
- Bash 子进程禁止网络（空域名 allowlist）；Claude 自身仍可访问其认证/provider 控制面。
- 不实现 transient resume、artifact、transcript 持久化、task-file 同步、workflow gate、Codex/Grok adapter（固定 `unsupported agent` 失败，不 spawn）。
- Issue #10 与完整 server trigger → real Claude → report → DB E2E 保留给 Batch 4。
- 不新增 protocol 字段、数据库列或 migration。

## 修订记录

- 2026-08-20：初始 Accepted。
