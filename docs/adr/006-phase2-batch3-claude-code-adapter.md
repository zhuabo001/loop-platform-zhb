# ADR-006：Phase 2 批次三——Claude Code Adapter 与生产切换

- 状态：Accepted
- 日期：2026-08-20
- 关联：docs/roadmap.md Phase 2 批次三（Day 6–8）；docs/plan/phase2-batch3-plan.md；ADR-001（可靠性约束）；ADR-004（批次一）；ADR-005（批次二）
- 实现：分支 `feat/phase2-batch3`，red→green 成对提交（测试分组 P/S/A/R/PR/L）

## 背景

批次一解决「daemon 何时执行」，批次二解决「如何安全地选择执行环境」，批次三交付**真实 Claude Code Runner** 并把生产 daemon 从 Fake Runner 切换过去。本批的核心是把「真实执行」作为一个完整安全单元落地：adapter、fail-closed OS sandbox、stream-json 解析、runner 事件接入 progress、生产切换与启动探测一起交付——任何一半都不得单独上线（ADR-005 决策 1 的另一半）。

## 决策

1. **Runner seam 从裸 AbortSignal 升级为 RunnerContext（`{ signal, onProgress }`）**。runtime 为当前 Run 提供 `onProgress(label)` sink：仅 Run 仍在 `inFlight` 时接受事件（runner settle 后的迟到 callback 结构性忽略）；label 去 NUL、`\s+` 压单行、截 200 字符；每个被接受的事件递增该 Run 的 step；runner 完成后 step **再 +1** 进入 `reporting result`——reporting 不再是固定 step 2，而是 lastStep+1，保证 step 单调不回退。清洗后为空串的 label 不消耗 step（无信息事件不产生状态迁移，R4）。生产 adapter 把 assistant/tool/retry 事件分别映射成固定语义标签（`claude response` / `running Bash` / `provider api retry`），不把 child-controlled 文本、命令或 retry 数值送入持续可观测的 progress 通道。Fake Runner 只适配签名，不产出事件。

2. **只开放 `Bash` 工具是本批的安全决策**。Claude 内建 sandbox 只对 Bash 及其子进程提供 OS 级边界；内建 `Read/Edit/Write` 不在该边界内，因此整批关闭（`--tools Bash`）。动态 settings 固定 fail-closed 形态：`sandbox.enabled/failIfUnavailable/autoAllowBashIfSandboxed`、`allowUnsandboxedCommands=false`、`excludedCommands=[]`、`filesystem.denyRead=["/"]` + `allowRead/allowWrite=[...effectiveRoots, cwd]`（精确去重）、`network.strictAllowlist` + 空 `allowedDomains`、`disableAllHooks`、`autoMemoryEnabled=false`；permission mode 钉死 `dontAsk`（永不 bypass）。用户/project/local settings 源全部禁用（`--setting-sources ""` + `--safe-mode`）；managed policy 仍是主机管理员的受信面。**配置不可用即失败，禁止降级为 unsandboxed 执行。**

3. **启动探测先于 HTTP client 存在**。composition root 为 `config → startup jail → Claude probe → Machine client → Claude Runner → runtime`（`prepareDaemon`）：probe 以 `shell:false` 执行 `claude --version` 与 `claude --help`，固定 10s 超时（每次调用），版本 ≥ 2.1.219，且 `--help` 必须包含本批固定 argv 依赖的全部 flags（`REQUIRED_CLAUDE_FLAGS`，词边界匹配——`--safe-mode-removed` 之类的形似 flag 不算数）。探测在首次 poll 之前是结构性的：poll 循环只在 `prepareDaemon` resolve 后才存在。探测使用专用的**无凭据 env**：保留 PATH/HOME/locale/TLS/`CLAUDE_CONFIG_DIR` 兼容性，不转发 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN` 或代理变量；任何探测失败、输出不可解析或平台不支持都直接终止启动。**二进制身份绑定**（round-3 加固）：probe 先 realpath+stat+sha256 钉住身份，每一次 `--version` / `--help` 的 spawn 前后都重新 stat+hash 并要求与基线一致，因此停留到两次调用之间的 A→B 切换会在第一次后立即失败。每次 hash 有独立 10s 截止；runner 在真实 Run 携带完整 agent env 之前再做同样的身份复核，同时响应 Run abort，漂移、超时或取消均不 spawn。不复制 executable，以保留 launcher 的相对资源/`$ORIGIN` 语义并避免 `noexec` tmp 差异。残余边界明确接受：同 UID 对手可在 stat→execve→stat 窗口内完成可逆替换，且本就可读取该 UID 文件；daemon 运行 UID 属主机受信基，这不是跨 UID 安全边界。

4. **stream-json parser 是独立的增量 JSONL 模块**，直接接 `spawnWithTimeout.onStdout`：streaming `TextDecoder` 跨 chunk 重组 UTF-8（不合成 U+FFFD）；单行缓冲按**原始字节流**记账，上限 1 MiB；`system/init` 捕获 session（首个非空获胜）；assistant text/tool_use 与 `system/api_retry` 按序生成带 kind 的内部事件，assistant/tool 的原始摘要仅留在 parser 内部/单测，retry 在 parser 层已固定为语义标签；adapter 只向 runtime 暴露决策 1 的固定标签；未知事件一律忽略（tolerant reader——parser 只对完全认识的形状行动）。terminal `result` 必须恰好出现一次：成功 ⇔ `subtype==="success"` 且 `is_error===false` 且 `exitCode===0`（三者缺一不可，成功 terminal 与非零退出码的背离判失败）；数值字段仅在有限、非负（token/turns 额外要求整数，对齐 wire schema `costReportSchema`）时保留，非法值只丢弃对应字段。**session 身份校验**（round-1 复审）：init 与 result 的 `session_id` 均存在且不一致即 fail-closed（第五种失败理由 `session-id-conflict`，detail 只带行号）——单次真实调用的 session 恒定，背离即流异常，Report 绝不指向错误 transcript。失败态粘性：parser 在 push 时抛错（借 subprocess 的 consumer-error 路径立即终止进程组）并在 finish 时返回同一失败；所有失败理由的 detail 只带行号、**永不引用行内容**（行内可能含 secret）。terminal 之后的尾部宽容：忽略一切非 result 行，第二个 result 才是 duplicate-result 失败。

5. **失败映射稳定且无内容**：timeout/abort/signal/spawn-error/非零退出/stream 解析失败各有固定句式；CLI 自己的错误叙事（error terminal 的 `result`/`errors`）优先于进程级细节；可附 redact+截断后的 stderr 尾部（≤500 字符）辅助诊断；失败 error 整体截断至 `ERROR_CAP`；**不发送不可信原始 transcript**。成功报告携带 `finalText/sessionId/durationMs/cost`（cost 仅在至少一个字段存在时携带）；`role=evolve` 报 `outcome=evolve`，其余成功角色报 `exec`；失败报告永不携带 outcome。

6. **child 派生内容在进入外部边界前由 adapter 收口**：progress 不再发送 child-controlled 内容，只发送决策 1 的固定语义标签，从结构上消除跨事件分片重组；finalText/error/sessionId 继续使用 `redactSecrets`。redact 集合 = env 白名单的全部非空 secretValues + run token；原文/JSON 转义对任意非空长度均匹配，长度 ≥8 时另覆盖 base64/base64url/hex/二阶 base64/percent 及分隔符容忍形态。精确趟是单次合并正则，替换结果不再入匹配；每个命中统一替换为一个不存在于任一受保护 raw/派生 form 中（含大小写容忍 needle）、且不会被 tolerant pass 去除的单字节 ASCII 边界 marker；无安全 ASCII marker 时整段丢弃。因此所有非空 secret（含单字符）均可脱敏，且整个过程不会递归、放大 UTF-8 wire 字节，也不会把两侧分片或相邻 marker 重组成另一 raw/派生 form。压缩、加密、自定义字母表、更深嵌套仍为已接受的 terminal/report 残余；结构性缓解是空 Bash 网络 allowlist 与 OAuth keychain 认证。machine credential 不进 child env，runtime 继续对 runner exception 做 machine credential + run token 兜底。

7. **`WorkdirJail.revalidate(resolved)` 把 resolve→spawn 的 TOCTOU 窗口收窄到最小**（ADR-005 修订记录第 3 条的批次三义务）：spawn 前重新 realpath 每个 effective root 与 cwd，要求**仍解析到记录值本身**且仍是目录；scratch 走与 release 相同的 fail-closed 身份检查（本 jail 铸造、仍是 per-jail scratch 根的直接子级、lstat 非符号链接）。任何漂移抛 JailError 且不 spawn。cwd 被替换为指向根内的符号链接同样拒绝——记录值必须自解析。scratch 在 `finally` 中无条件 release；**release 失败判 Run 失败**（已算出的成功报告一并丢弃）。**残余窗口**（round-1 复审措辞修正）：revalidate→execve 之间用户态无法原理性关闭的极小窗口，由 fail-closed OS sandbox 兜底——settings 的 allowRead/allowWrite 按 realpath 计算，软链换目标后的越界访问即被 OS 拒绝；该兜底经 smoke 场景 2/3 真实验证（in-root 软链越界读写均被拒）。

8. **Issue #12 跨层 liveness 验收落地为单测试文件**（`packages/server/src/roundrobin-liveness.test.ts`）：真实链路 daemon runtime → MachineClient → HTTP → coordinator → applyRunProgress → PGlite；批量交付窗口用「daemon poll 省略 `availableSlots`」复现（server 保持 Phase 1 批量 claim）；25 个 running Run = 1 executing + 24 queued；同一 FakeClock 驱动 coordinator 的 progress `at` 与 sweep 的 inactivity 判定。三层断言：窗口内零误回收 + 从未心跳的对照 Run 被回收（sweep 非空转）+ 心跳停止越过窗口后 25 个全部回收（零回收是新鲜证据挣来的，不是 sweep 死了）。本测试是行为先于 pin 的验收（沿用 ADR-004 决策 10 例外，同批次二 I1–I4）。

9. **opt-in 真实 sandbox smoke 不进默认离线套件**（`claude-smoke.test.ts`，`LOOPZHB_CLAUDE_SMOKE=1` 开启）：真实 Claude Code + 开发者认证下验证根内读写成功、根外 sentinel 读取不泄漏、根外覆盖写不发生；断言不依赖模型措辞。`LOOPZHB_SMOKE_EXPECT_NO_SANDBOX=1` 变体用于无 sandbox 主机。场景 2/3 使用 in-root 软链指向根外 sentinel。测试侧用第二个 parser 只读地核对**唯一、完整的 Bash tool input**（生产 progress 仍只有语义标签）；该命令依次写 attempt marker、执行越界访问、捕获 exit status、无条件写 completion marker。测试要求 tool input 精确匹配、attempt/completion 均存在、status 非零，并要求读场景的重定向副本存在且不含 sentinel、写场景 sentinel 原样，从而把命令意图、真实执行与文件系统结果绑定。

10. **测试纪律沿用 ADR-004 决策 10**。本批 red→green 成对：P1–P20（parser）、S1–S10（revalidate）、A1–A19（adapter）、R1–R4（runtime sink，含既有 fixture 契约适配）、PR1–PR8（probe 与生产切换）。L1–L2 为验收 pin-only（决策 8）。A 组经 fake-claude fixture 真实 spawn（argv/settings/env 经 sidecar 取证），不经 mock。复审修复继续成对落地：P21/A20、S22/R5、PR9–PR18/A21–A24、E16–E28；S6 fixture 额外钉住 readiness 跨 stdout chunk。

11. **进程控制失败升级为 daemon-fatal**（round-1 复审）。`spawnWithTimeout` 的两条 kill-failure reject 路径（terminate 中途 failFatally、close 时 reap）统一抛出 `ProcessControlError`；runtime 在 runner rejection 中识别该类型：**先为该 Run 发出终态失败 Report**（fatal 字段先于 abort 落地，挡住 `maybeStartNext` 与下一次 poll，attemptReport 发出后才 abort），再终止 daemon——无法杀死的失控子进程绝不与下一个 Run 并存。普通 runner 抛错仍是 per-run 失败、容量照常恢复（R5 对照 pin）。**release 不掩盖**（round-2 复审）：spawn 路径已抛 `ProcessControlError` 时，finally 的 scratch release 若再抛错，adapter 重抛 `ProcessControlError`（release 失败并入消息、原异常作 cause）——组合路径下 fatal 升级依然成立（A22）。

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
- 2026-08-20：codex 第一轮复审（结论「不建议合并」；审查物流记录为仓库外 handoff，不入库）的全部 10 项修复落地：①sessionId 脱敏 + parser 新增 `session-id-conflict` fail-closed（决策 4/6）；②`ProcessControlError` → daemon-fatal 升级（新增决策 11）；③probe 二进制身份绑定（realpath + inode 指纹，每次 spawn 前 re-stat）与 flag 词边界匹配（决策 3）；④`redactSecrets` 增补 base64/base64url/hex 编码形态并记录残余威胁模型（决策 6）；⑤smoke 场景 2/3 改 in-root 软链形式 + 尝试证据断言，复验 3/3 通过（含 symlink 越界读写拒绝，约 50s）（决策 9）；⑥决策 7 措辞收窄为「最小化 TOCTOU 窗口 + sandbox 兜底」；⑦roadmap 的 Issue #12 标记改回未完成（核销前不打勾）、daemon `package.json` 描述更新。
- 2026-08-20：codex 第二轮复审（结论「仍不建议合并」）修复落地：①probe 身份加固——探测前后双钉 + 内容 sha256，同 inode/同长度/恢复 mtime 的原位覆盖与探测中替换均被拒（决策 3，PR14/A23）；②scratch release 失败不再掩盖 `ProcessControlError`（决策 11，A22，新增 test-only `spawnImpl` seam）；③`redactSecrets` v2——单次合并正则 + 分隔符容忍趟覆盖分块/混合大小写/二阶/percent 形态，单字符 secret 拒配，649× 膨胀结构性消除（决策 6，E18–E22）；④smoke 尝试证据升级为根内 attempt marker（命令先写 marker 再 `&&` 越界访问，marker 存在即证明真实执行），复验 3/3 通过（约 102s）（决策 9）；⑤S6 改 readiness handshake 消除负载相关抖动；⑥roadmap/README 的 TOCTOU 表述同步为「收窄 + 兜底」，ADR 不再引用未入库的审查 handoff。待第三轮复审。
- 2026-08-21：codex 第三轮复审遗留修复落地：①progress 边界对 child-controlled 事件只发布固定语义标签，模型文本/命令/retry 数值不再进入该通道，跨事件 credential 分片结构性失效（A24）；②probe 改用无凭据 env，在 version/help 每次调用前后复核 stat+sha256，每次 hash 限时且 Run 响应 abort（E23/PR15–PR18），同时明确接受同 UID 窗口；③所有非空 secret 恢复脱敏，仍保持单次合并替换，统一使用单字节、非 separator、受保护 raw/派生 form 均不存在的 ASCII 边界 marker，防止 UTF-8 wire 放大、分片重组、跨 marker 重组及 marker 补齐编码形态；候选耗尽时整段丢弃（E18/E24–E28）；④sandbox smoke 以测试侧双 parser 核对唯一完整命令，并绑定同一 shell 的 attempt→访问→exit status→completion 证据链；⑤S6 readiness fixture 主动跨 stdout chunk 拆分且检测端累积后识别。待第四轮复审核销 Issue #15。
- 2026-08-21：Issue 关闭前复验在第四轮固定点上首次实际执行 smoke，发现第三轮重设计的命令形态被真实 CLI 的 dontAsk 权限层整体拒执——`rc=$?` 变量赋值/展开触发预执行拒绝（`permission_denials` 取证），attempt marker 缺失使其当场暴露；该重设计此前仅经静态审查、从未实跑。命令改为无变量形态：attempt marker `&&` 越界访问 `&&`/`||` 分支写入字面 completion 词（`read-denied`/`write-denied`），attempt→访问→exit status→completion 证据链语义不变；实测复验 3/3 通过（约 131s，macOS + Claude Code 2.1.227）。
- 2026-08-24：Batch 4 首次实现——Issue #10 的 sweep 错误分类与 report helper 收拢落地；真实 Claude 全链路 E2E 曾人工运行通过（约 65s）。后续第三轮复审确定旧 harness 的 cleanup、secret 扫描与 provenance 证据存在 false-pass 路径，因此撤回“Phase 2 完成”状态，该次执行只保留为历史记录，不作为最终核销证据。
- 2026-08-24：Batch 4 第三轮整改——E2E 改为消费 daemon **生产 probe 实际钉住**的 realpath/version/sha256，并要求操作者显式批准 hash；测试端删除 shell 解析。日志改为全生命周期、跨 chunk、sticky credential 检测，诊断仅保留 64 KiB 脱敏 tail；daemon 以独立进程组启动，`spawnWithTimeout` 在 Claude 进程组创建与确认关闭时上报结构化生命周期，E2E supervisor 从创建起登记 PGID、幂等执行 TERM→KILL，并等待 ChildProcess `close` 与全部已登记组消失，即使 daemon 提前退出也不会因后代 reparent 而漏检。以上行为由不调用真实 Claude 的确定性测试覆盖，等待后续三轨复审和人工 smoke/E2E 复跑后再关闭 Issue #10、恢复 Phase 2 完成状态。实现历史偏差同时记账：`0104cee` 同时包含 red 测试与生产改动，不作为独立 red commit 证据，也不改写共享 Git 历史。
- 2026-08-24：Batch 4 加固版人工验收完成：同一 production harness 在 Claude Code 执行环境中以 operator-approved SHA-256 通过真实全链路 E2E（1/1，约 51s）与 sandbox smoke（3/3，约 78s）；完整命令、版本与行为证据见 `docs/tests/phase2-batch4-acceptance.md`。结合 Standards / Spec 复核通过与离线回归全绿，Issue #10 关闭，Phase 2 恢复为完成状态。
