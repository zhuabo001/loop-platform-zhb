# ADR-005：Phase 2 批次二——本机执行隔离原语

- 状态：Accepted
- 日期：2026-08-19
- 关联：docs/roadmap.md Phase 2 批次二（Day 3–5）；ADR-001（可靠性约束）；ADR-004（批次一）；docs/plan/codex-phase2-batch2-plan.md（当批计划，不进库）
- 实现：分支 `feat/phase2-batch2`，red→green 成对提交

## 背景

批次一解决了「daemon 何时执行」（容量、心跳、解耦），批次二解决「daemon 如何安全地选择执行环境」：workdir jail、subprocess 生命周期、环境白名单三个原语，外加承载它们的启动配置。本批的核心边界划分是**原语可独立验证，但不做生产切换**——真实 Claude adapter、OS sandbox 与生产 Runner 替换在批次三作为一个完整安全单元交付。

## 决策

1. **批次二不切换生产 Runner，任何 Delivery 都不会启动真实 subprocess**。`productionRunnerFactory` 保持 `createFakeRunner`（pin I6）；jail/subprocess/agent-env 只经 fixture executable 直接组合测试（I1–I4），不经 runtime。理由：jail 只保证 cwd 选择正确（决策 2），在没有 OS sandbox 的窗口期切换真实 Runner 会给人「已隔离」的错误安全感。
2. **workdir jail 是 cwd 选择机制，不是运行时文件系统安全边界**。模块文档与测试注释均明示：阻止运行中进程越界读写是批次三 OS sandbox 的职责（`failIfUnavailable: true`，禁止 unsandboxed fallback）。本批只承诺：spawn cwd 落在 daemon roots ∩ server roots 内，或落在隔离的 per-run scratch。
3. **roots 交集用 `path.relative()` 做边界判断，禁止字符串前缀**（`/foo` vs `/foobar` 必须有测试钉死，J8）。daemon roots 在工厂构造时 canonicalize（realpath、目录校验、去重）一次；server roots **每次 resolve 重新校验**——不信任 server 已规范化（J18）。交集逐对取更窄者、消除被父 root 覆盖的冗余子 root；空交集抛 `JailError`（server 只能收窄，J16）。
4. **per-run scratch 永不复用**：`sha256(loopId+runId)` 只做 mkdtemp 前缀，随机后缀保证同一 runId 重入也得新目录（J21）；权限钉死 `0700`（J22）。`release()` fail-closed：只删本 jail 铸造、仍是 scratchParent 直接子级、未被替换为符号链接的目录——lstat 识别符号链接替换，校验或删除失败一律抛错且什么都不删（J23–J25）。
5. **`loadDaemonConfig()` 纯语法解析，零文件系统副作用**：roots 的存在性/目录性/realpath 归 jail 工厂（J 组），`claude --version` 探测推迟到批次三（届时用 `shell: false` 的 spawn）。配置层与 jail 层的测试职责因此严格分离（C 组不碰 FS）。`LOOPZHB_AGENT_TIMEOUT_MS` 上限 2³¹-1 因为该值要喂 setTimeout。
6. **一个 spawn 一个进程组，终止语义收敛为一条幂等路径**：`detached: true` 使 child 成为组长；timeout、AbortSignal、consumer 抛错三类触发器**先到者决定 completion kind**（S8）；TERM → 5s grace → KILL 对整组生效；直接 child `close` 后再查一次进程组，残留孙进程走同一路径（S9）；返回前 close 已触发、stdio 已排空、进程组不存在（S17）；`ESRCH` 一律视为已结束（S16），其他 kill 错误 reject 传播，绝不静默误报活性。
7. **stdio 每流 1 MiB 上限，头尾各半**：未超 cap 时 head+tail 恰好是完整流（无损），第一次丢字节即翻 truncated 标志（S11–S12）。`onStdout/onStderr` chunk 回调按到达顺序先于捕获触发——批次三的 stream-json 解析器直接复用，不需要改本模块；consumer 抛错记 `consumer-error` 并终止整组（S14）。
8. **环境白名单是 allow-list，缺席即默认拒绝**：系统变量、`LC_*`、大小写代理变量、TLS 证书变量、`ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CONFIG_DIR` 之外一律不进 child——`LOOPZHB_*`、run token、machine credential、`GITHUB_TOKEN`、`AWS_*`、`GOOGLE_*`、`OPENAI_API_KEY` 靠「不匹配」天然排除（E6–E8、E14）。`secretValues` 收全部非空 `ANTHROPIC_*`、OAuth token 与代理值（代理 URL 可能带 userinfo）；脱敏长度降序去重、空串永不参与替换（E11–E13）。macOS 的 `__CF_USER_TEXT_ENCODING` 由 OS 在 Node env 选项之下注入，属 OS 注入宽限而非泄漏（I2）。
9. **原生 Windows 不支持**：返回明确的 unsupported-platform spawn-error（进程组语义是 POSIX 的）；正式支持 macOS、Linux、WSL2。
10. **测试纪律沿用 ADR-004 决策 10**，两处例外已在提交信息中注明：S15–S17 与 I1–I4 的行为先于其 pin 落地（pair 1/2 实现时覆盖），无法构造 red，故为单 pin 提交。另知悉一个观察项：批次二开发中 daemon 全量套件出现一次不可复现失败（其后 6 次同命令全绿），最可疑点是 S8 的 80ms 竞态预算在极端调度下超 2500ms——PR 描述记录，不阻塞本批。

## 修订记录

- 2026-08-19：初始 Accepted。
