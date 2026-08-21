# Phase 2 Batch 3 开发计划：Claude Code Adapter 与生产切换

## 一、目标与完成标志

Batch 3 在 Batch 2 的 jail、进程组生命周期和环境白名单基础上，实现真实 Claude Code Runner，并将生产 daemon 从 Fake Runner 切换到 Claude Runner。

完成标志：

- 缺省或 `claude-code` Delivery 可经真实 subprocess 执行并形成完整 Report。
- Claude 仅获得 `Bash` 工具；文件操作全部经过 fail-closed OS sandbox。
- `stream-json` 被增量解析为 progress、最终文本、session 和 usage。
- sandbox 不可用、越界访问、异常输出、timeout 等场景均稳定失败，不降级执行。
- Batch 1/2 契约和全仓测试保持通过，并补齐 Issue #12 的跨层 liveness 测试。

Batch 4 仍负责完整的 server trigger → real Claude → report → DB E2E；Batch 3 负责 adapter、安全边界和生产切换前的真实 sandbox smoke。

## 二、接口与实现变更

### 2.1 Runner 与 runtime

- 将 `AgentRunner.run(delivery, signal)` 调整为：

  ```ts
  run(delivery, {
    signal,
    onProgress,
  }): Promise<RunnerReport>
  ```

- 新增 `RunnerContext`；Fake Runner 只适配签名，行为不变。
- runtime 为当前 Run 提供 `onProgress(label)`：
  - 仅 Run 仍在 `inFlight` 时接受事件；
  - 去 NUL、压成单行、截断至 200 字符；
  - 每个事件递增该 Run 的 step；
  - runner 完成后再递增一步进入 `reporting result`，保证 step 永不回退。
- runtime 继续独占 `runId`、run token 和最终 Report 身份，Runner 无法替换目标 Run。

### 2.2 Claude adapter 与启动探测

- 新增 `createClaudeRunner({ jail, claudeBin, timeoutMs, envSource })`：
  - `agent` 缺省或为 `claude-code` 时执行；
  - `codex`、`grok` 返回固定 `unsupported agent` 失败，不 spawn；
  - `role=evolve` 报 `outcome=evolve`，其余成功角色报 `exec`。
- daemon 启动、创建 HTTP client 前，以 `shell:false` 执行 `claude --version` 和 `claude --help`：
  - 固定 10 秒探测超时；
  - 要求版本至少 `2.1.219`，并检查本批依赖的 CLI flags；
  - 探测失败、输出不可解析或平台不支持时直接终止启动。
- 生产 composition root 改为：`config → startup jail → Claude probe → Claude Runner → runtime`。
- `WorkdirJail` 增加 `revalidate(resolved)`：
  - spawn 前重新 realpath/lstat；
  - 检查 cwd、effective roots 和 scratch 未被替换或移出边界；
  - 失败时不 spawn；
  - scratch 始终在 `finally` 中 release，安全清理失败会把 Run 判为失败。

### 2.3 命令与 sandbox 策略

每次 Run 使用以下固定 CLI 形态：

```text
claude -p <task>
  --output-format stream-json
  --verbose
  --safe-mode
  --setting-sources ""
  --disable-slash-commands
  --no-chrome
  --no-session-persistence
  --tools Bash
  --permission-mode dontAsk
  --prompt-suggestions false
  --settings <generated-json>
  [--model <delivery.loop.model>]
  [--append-system-prompt <delivery.systemPrompt>]
```

动态 settings 固定包含：

- `sandbox.enabled=true`
- `sandbox.failIfUnavailable=true`
- `sandbox.autoAllowBashIfSandboxed=true`
- `sandbox.allowUnsandboxedCommands=false`
- `sandbox.excludedCommands=[]`
- `sandbox.filesystem.disabled=false`
- `sandbox.filesystem.denyRead=["/"]`
- `sandbox.filesystem.allowRead=[...effectiveRoots, cwd]`
- `sandbox.filesystem.allowWrite=[...effectiveRoots, cwd]`
- `sandbox.network.strictAllowlist=true`
- `sandbox.network.allowedDomains=[]`
- `disableAllHooks=true`
- `autoMemoryEnabled=false`
- 禁止 bypass permission mode。

只开放 `Bash` 是本批的安全决策：Claude 内置 sandbox 只对 Bash 及其子进程提供 OS 级边界，内建 `Read/Edit/Write` 不在该边界内。[Claude Code sandbox 文档](https://code.claude.com/docs/en/sandboxing)

用户、project、local settings 全部禁用；managed policy 仍视为主机管理员的受信策略。配置不可用时失败，禁止放宽为普通权限或 unsandboxed 执行。

### 2.4 Stream parser 与报告映射

- 新增独立增量 JSONL parser，直接接入 `spawnWithTimeout.onStdout`：
  - 使用 streaming `TextDecoder` 正确处理跨 chunk UTF-8；
  - 单行缓冲上限 1 MiB，防止无换行输出导致无界内存；
  - `system/init` 捕获 session ID；
  - assistant 的 `tool_use`/文本块生成 progress；
  - `system/api_retry` 生成 provider retry progress；
  - 未知合法事件忽略。
- terminal `result` 必须恰好出现一次：
  - 仅 `exitCode=0`、`is_error=false`、`subtype=success` 判成功；
  - 提取 `result`、`session_id`、`total_cost_usd`、usage token 字段和 `num_turns`；
  - 所有数值必须有限且非负，否则忽略对应字段。
- 畸形 JSON、超长行、重复或缺失 terminal result、非零退出、signal、timeout、spawn/consumer error 均生成固定失败报告。
- progress、final text、stderr 和错误信息在进入 report/log 前统一经 `redactSecrets`；不得包含 agent credential、machine credential 或 run token。
- 成功报告携带 `finalText/sessionId/durationMs/cost`；失败报告携带稳定、截断后的 `error`，不发送不可信原始 transcript。
- 不修改 protocol DTO、数据库或 migration；现有预声明 report 字段足够。

官方 headless CLI 将 `stream-json` 定义为 JSONL，末行是 terminal result，并定义了 `system/api_retry` 与 `system/init` 事件。[Headless CLI 文档](https://code.claude.com/docs/en/headless)

## 三、实施顺序与测试计划

### Day 1：Parser 红绿提交

- 跨 chunk、UTF-8、无尾换行；
- init、assistant、tool、api_retry、success/error result；
- 未知事件、畸形 JSON、重复/缺失 result、1 MiB 行上限；
- usage 非法值和 secret 脱敏。

### Day 2–3：Sandbox、jail 与 adapter 红绿提交

- 断言完整 argv 和动态 settings；
- 缺省 Claude、unsupported provider 不 spawn；
- daemon/server roots 交集、null workdir scratch、spawn 前符号链接替换；
- fake Claude 的 success、error、非零退出、timeout、abort、无输出；
- scratch 正常清理及 release fail-closed；
- settings 中不存在 MCP、plugins、hooks、skills、网络或非 Bash 工具逃逸口。

### Day 4：Runtime 与生产切换

- 更新所有 Runner fixture；
- 钉死 `starting → runner events → reporting` step 单调递增；
- runner settle 后的迟到 callback 被忽略；
- 执行期间持续 poll，capacity 和 report retry 语义不变；
- CLI 探测必须发生在首次 poll 前；
- production factory 不再返回 Fake Runner。

### Day 5：跨层验收与真实 smoke

- 完成 Issue #12：21+ running Runs 经 daemon round-robin progress、真实 HTTP/store 写入后，在 FakeClock inactivity 窗口内 sweep 零误回收；
- 增加 opt-in adapter sandbox smoke：真实 Claude Code 下验证根内读写成功、根外 sentinel 读取和覆盖失败、sandbox 不可用时失败；
- 不得因失败切换到 unsandboxed 模式。

### 回归与收口

- 执行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`；
- server 测试需允许绑定 `127.0.0.1` 临时端口；
- 新增 `docs/plan/phase2-batch3-plan.md` 和 ADR-006；
- 更新 README 与 roadmap，记录 Batch 3 完成及真实 Runner 启用；
- Issue #12 仅在修复提交、测试和后续复审齐备后关闭。

所有新增行为测试沿用 ADR-004/ADR-005 的 red → green 成对提交纪律。建议测试分组：`P` parser、`S` sandbox/jail、`A` adapter、`R` runtime、`I` integration、`L` liveness。

## 四、假设与边界

- 支持 macOS、Linux、WSL2；不支持原生 Windows。
- 当前本机 Claude Code 为 `2.1.227`；最低版本取 `2.1.219`，并辅以 flags 探测。
- Bash 子进程禁止网络；Claude 自身仍可访问其认证/provider 控制面。
- 不实现 transient resume、artifact、transcript 持久化、task-file 同步、workflow gate、Codex/Grok adapter。
- Issue #10 和完整真实 Claude E2E 保留给 Batch 4。
- 真实 smoke 使用开发者现有 Claude 认证，作为生产切换前的人工验收项，不进入默认离线测试套件。
- 不新增 protocol 字段、数据库列或 migration；`progress` 继续复用 Batch 1 的 wire shape。
