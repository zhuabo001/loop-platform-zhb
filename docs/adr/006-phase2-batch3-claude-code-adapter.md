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

3. **启动探测先于 HTTP client 存在**。composition root 为 `config → startup jail → Claude probe → Machine client → Claude Runner → runtime`（`prepareDaemon`）：probe 以 `shell:false` 执行 `claude --version` 与 `claude --help`，固定 10s 超时（每次调用），版本 ≥ 2.1.219，且 `--help` 必须包含本批固定 argv 依赖的全部 flags（`REQUIRED_CLAUDE_FLAGS`，词边界匹配——`--safe-mode-removed` 之类的形似 flag 不算数）。探测在首次 poll 之前是结构性的：poll 循环只在 `prepareDaemon` resolve 后才存在。探测使用**与真实运行相同的白名单 env**（在该 env 下起不来的二进制跑每次 Run 也会失败，探测更忠实）。任何探测失败、输出不可解析或平台不支持都直接终止启动。**二进制身份绑定**（round-1 复审）：probe 先解析 realpath（裸名经 agent env 的 PATH 查找）、用 resolvedPath 跑探测、最后钉住 inode 级身份（dev/ino/mtimeMs/size）；runner 只 spawn resolvedPath（不经 PATH 查找）且每次 spawn 前 re-stat 比对——探测后被替换/原位升级/删除的二进制一律不 spawn 并判 Run 失败，替代程序永远拿不到 agent 凭据；操作员升级 claude 后需重启 daemon 重新探测（fail-closed 的正确方向）。stat→execve 的残余窗口用户态无法原理性关闭，见决策 7 的修订。

4. **stream-json parser 是独立的增量 JSONL 模块**，直接接 `spawnWithTimeout.onStdout`：streaming `TextDecoder` 跨 chunk 重组 UTF-8（不合成 U+FFFD）；单行缓冲按**原始字节流**记账，上限 1 MiB；`system/init` 捕获 session（首个非空获胜）；assistant 的 text/tool_use 块按序生成 progress（Bash 摘要 `input.command`，其他工具摘要 JSON input）；`system/api_retry` 生成 provider retry progress；未知事件一律忽略（tolerant reader——parser 只对完全认识的形状行动）。terminal `result` 必须恰好出现一次：成功 ⇔ `subtype==="success"` 且 `is_error===false` 且 `exitCode===0`（三者缺一不可，成功 terminal 与非零退出码的背离判失败）；数值字段仅在有限、非负（token/turns 额外要求整数，对齐 wire schema `costReportSchema`）时保留，非法值只丢弃对应字段。**session 身份校验**（round-1 复审）：init 与 result 的 `session_id` 均存在且不一致即 fail-closed（第五种失败理由 `session-id-conflict`，detail 只带行号）——单次真实调用的 session 恒定，背离即流异常，Report 绝不指向错误 transcript。失败态粘性：parser 在 push 时抛错（借 subprocess 的 consumer-error 路径立即终止进程组）并在 finish 时返回同一失败；所有失败理由的 detail 只带行号、**永不引用行内容**（行内可能含 secret）。terminal 之后的尾部宽容：忽略一切非 result 行，第二个 result 才是 duplicate-result 失败。

5. **失败映射稳定且无内容**：timeout/abort/signal/spawn-error/非零退出/stream 解析失败各有固定句式；CLI 自己的错误叙事（error terminal 的 `result`/`errors`）优先于进程级细节；可附 redact+截断后的 stderr 尾部（≤500 字符）辅助诊断；失败 error 整体截断至 `ERROR_CAP`；**不发送不可信原始 transcript**。成功报告携带 `finalText/sessionId/durationMs/cost`（cost 仅在至少一个字段存在时携带）；`role=evolve` 报 `outcome=evolve`，其余成功角色报 `exec`；失败报告永不携带 outcome。

6. **脱敏在进入 report/log/progress 前完成，且由 adapter 负责**：redact 集合 = env 白名单的 secretValues（全部非空 `ANTHROPIC_*`、OAuth token、代理值）+ run token，覆盖 child 派生的一切文本——progress、finalText、error 叙事、**session id**（round-1 复审补脱敏）。匹配形态：原文 + JSON 转义 +（长度 ≥8 时）base64 / base64url / hex 双大小写（round-1 复审：Bash 子进程继承 agent env，可对凭据做确定性编码后回传；短 secret 的编码形态会误伤普通文本，故设长度下限）。任意进一步变换（分片/反转/嵌套编码）原理上无法穷举，为**已接受残余**——威胁模型：Bash 网络是空 allowlist，唯一外泄面是回传本机的 report/progress；Phase 5 认证完成前机器归属即 loop 归属，跨主体暴露面不成立。顺序固定：parser 产出的原文 → adapter `redactSecrets` → runtime sanitize/cap。machine credential 结构性不进 child env（`LOOPZHB_*` 天然不匹配白名单），runtime 的 `sanitizeRunnerError` 仍对 runner 抛出的错误做 machine credential + run token 兜底。

7. **`WorkdirJail.revalidate(resolved)` 把 resolve→spawn 的 TOCTOU 窗口收窄到最小**（ADR-005 修订记录第 3 条的批次三义务）：spawn 前重新 realpath 每个 effective root 与 cwd，要求**仍解析到记录值本身**且仍是目录；scratch 走与 release 相同的 fail-closed 身份检查（本 jail 铸造、仍是 per-jail scratch 根的直接子级、lstat 非符号链接）。任何漂移抛 JailError 且不 spawn。cwd 被替换为指向根内的符号链接同样拒绝——记录值必须自解析。scratch 在 `finally` 中无条件 release；**release 失败判 Run 失败**（已算出的成功报告一并丢弃）。**残余窗口**（round-1 复审措辞修正）：revalidate→execve 之间用户态无法原理性关闭的极小窗口，由 fail-closed OS sandbox 兜底——settings 的 allowRead/allowWrite 按 realpath 计算，软链换目标后的越界访问即被 OS 拒绝；该兜底经 smoke 场景 2/3 真实验证（in-root 软链越界读写均被拒）。

8. **Issue #12 跨层 liveness 验收落地为单测试文件**（`packages/server/src/roundrobin-liveness.test.ts`）：真实链路 daemon runtime → MachineClient → HTTP → coordinator → applyRunProgress → PGlite；批量交付窗口用「daemon poll 省略 `availableSlots`」复现（server 保持 Phase 1 批量 claim）；25 个 running Run = 1 executing + 24 queued；同一 FakeClock 驱动 coordinator 的 progress `at` 与 sweep 的 inactivity 判定。三层断言：窗口内零误回收 + 从未心跳的对照 Run 被回收（sweep 非空转）+ 心跳停止越过窗口后 25 个全部回收（零回收是新鲜证据挣来的，不是 sweep 死了）。本测试是行为先于 pin 的验收（沿用 ADR-004 决策 10 例外，同批次二 I1–I4）。

9. **opt-in 真实 sandbox smoke 不进默认离线套件**（`claude-smoke.test.ts`，`LOOPZHB_CLAUDE_SMOKE=1` 开启）：真实 Claude Code + 开发者认证下验证根内读写成功、根外 sentinel 读取不泄漏、根外覆盖写不发生；断言只依赖文件系统证据与泄漏缺席，不依赖模型措辞。`LOOPZHB_SMOKE_EXPECT_NO_SANDBOX=1` 变体用于无 sandbox 主机：场景 1 必须失败（failIfUnavailable 语义的人工验收）。**round-1 复审重设计**：直给根外绝对路径时**模型层会先拒答**（CLI 在上下文中告知边界），OS sandbox 从未被触发——空转通过。场景 2/3 改为 **in-root 软链指向根外 sentinel**：模型只见根内路径，尝试真实发生（断言 progress 中出现指向该链接的 Bash 标签——无尝试即失败），越界读写只能被 OS 边界拦下；场景 2 另有文件系统拒读证据（`cat link > copy` 永不产生非空副本）。该形式同时覆盖了 symlink-escape 这一经典沙箱逃逸向量，也是决策 7 残余窗口兜底声明的运行时证据。

10. **测试纪律沿用 ADR-004 决策 10**。本批 red→green 成对：P1–P20（parser）、S1–S10（revalidate）、A1–A19（adapter）、R1–R4（runtime sink，含既有 fixture 契约适配）、PR1–PR8（probe 与生产切换）。L1–L2 为验收 pin-only（决策 8）。A 组经 fake-claude fixture 真实 spawn（argv/settings/env 经 sidecar 取证），不经 mock。round-1 复审修复同样成对落地（P21/A20、S22/R5、PR9–PR13/A21、E16–E17）。

11. **进程控制失败升级为 daemon-fatal**（round-1 复审）。`spawnWithTimeout` 的两条 kill-failure reject 路径（terminate 中途 failFatally、close 时 reap）统一抛出 `ProcessControlError`；runtime 在 runner rejection 中识别该类型：**先为该 Run 发出终态失败 Report**（fatal 字段先于 abort 落地，挡住 `maybeStartNext` 与下一次 poll，attemptReport 发出后才 abort），再终止 daemon——无法杀死的失控子进程绝不与下一个 Run 并存。普通 runner 抛错仍是 per-run 失败、容量照常恢复（R5 对照 pin）。

## 边界与显式不做

- 支持 macOS / Linux / WSL2；原生 Windows 不支持。
- 本机 Claude Code 2.1.227；最低版本 2.1.219，辅以 flags 探测（而非纯版本闸）。
- Bash 子进程禁止网络（空域名 allowlist）；Claude 自身仍可访问其认证/provider 控制面。
- 不实现 transient resume、artifact、transcript 持久化、task-file 同步、workflow gate、Codex/Grok adapter（固定 `unsupported agent` 失败，不 spawn）。
- Issue #10 与完整 server trigger → real Claude → report → DB E2E 保留给 Batch 4。
- 不新增 protocol 字段、数据库列或 migration。

## 修订记录

- 2026-08-20：初始 Accepted。
- 2026-08-20：opt-in 真实 sandbox smoke 在 macOS + Claude Code 2.1.227 上执行通过（3/3，约 63s）：根内读写成功、根外 sentinel 读取不泄漏（report 与 progress 均无内容）、根外覆盖写不发生。生产切换的人工验收项达成。
- 2026-08-20：codex 第一轮复审（`docs/handoff/codex-handoff-phase2-batch3-code-review.md`，结论「不建议合并」）的全部 10 项修复落地：①sessionId 脱敏 + parser 新增 `session-id-conflict` fail-closed（决策 4/6）；②`ProcessControlError` → daemon-fatal 升级（新增决策 11）；③probe 二进制身份绑定（realpath + inode 指纹，每次 spawn 前 re-stat）与 flag 词边界匹配（决策 3）；④`redactSecrets` 增补 base64/base64url/hex 编码形态并记录残余威胁模型（决策 6）；⑤smoke 场景 2/3 改 in-root 软链形式 + 尝试证据断言，复验 3/3 通过（含 symlink 越界读写拒绝，约 50s）（决策 9）；⑥决策 7 措辞收窄为「最小化 TOCTOU 窗口 + sandbox 兜底」；⑦roadmap 的 Issue #12 标记改回未完成（核销前不打勾）、daemon `package.json` 描述更新。待第二轮复审。
