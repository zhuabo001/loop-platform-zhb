# Phase 2：Claude Code 真实 Agent 开发计划

## Summary

Phase 2 以 Claude Code 为唯一正式 provider，把 Phase 1 的 Fake Runner 替换为可长期运行的真实 Agent 链路：

`poll → 限流 claim → 工作目录校验 → Claude Code 子进程 → progress heartbeat → report`

完成标志：

- 一条真实 Claude Code E2E 从手动触发运行到 `done/exec`。
- Agent 对允许根目录之外的读写均被拒绝。
- timeout、daemon 退出会终止整个进程组，不遗留子孙进程。
- Agent 运行期间持续 heartbeat，不被 inactivity sweep 误回收。
- Phase 1 的 T1–T7 和 report 重试语义保持不变。
- 收口并关闭 Issue #10。

预计按 10 个开发日、4 个可独立合并的批次推进。

## 实施批次

### 批次一：执行容量与 progress 心跳（Day 1–2）

- 为 `PollRequest` 增加可选 `availableSlots: 0 | 1`：
  - 新 daemon 空闲且无待确认 report 时发送 `1`。
  - Agent 执行中、队列非空或 report 重试中发送 `0`。
  - 老 daemon 不发送该字段时，server 保留 Phase 1 的批量 claim 行为。
- server 在每次认证成功的 poll 中先写入 progress，再按 `availableSlots` claim：
  - progress 只允许更新同一 machine 的 `running` Run。
  - `at` 必须由 server 时钟生成，daemon 不得提供。
  - Run 已完成、取消或被 sweep 后的迟到 progress 为零写入。
  - progress 更新与 sweep 的 CAS 防护共同保证新 heartbeat 能否决误回收。
- daemon runtime 改为“poll/heartbeat 与 Agent 执行解耦”：
  - runner 在后台执行，poll loop 每 `pollMs` 继续运行。
  - 当前执行、旧 server 批量返回后的排队 Run、等待 report 确认的 Run 都进入 activity 快照。
  - 新 server 每次最多交付一个 Run；旧 server 的批量 delivery 在本地顺序排队——这是防御行为：Phase 2 daemon + Phase 1 server 不承诺长任务与批量队列 liveness（旧 server 忽略 progress 与 availableSlots，排队 Run 可能被 sweep 回收），升级顺序必须先 server、后 daemon。
  - 默认并发固定为 1，本阶段不开放并发配置。
- progress 状态最少包含：`queued`、`starting claude-code`、当前 tool/turn、`reporting result`。
- 增加 progress 条数、label 长度和 NUL 清洗上限，避免 machine credential 被用于无界写入。

### 批次二：本机执行与强隔离（Day 3–5）

- 新增 daemon 配置：
  - `LOOPZHB_ALLOWED_ROOTS`：必填、非空 JSON 字符串数组；每项必须是已存在的绝对目录。
  - `LOOPZHB_CLAUDE_BIN`：默认 `claude`。
  - `LOOPZHB_AGENT_TIMEOUT_MS`：默认 30 分钟，显式正整数。
- daemon 启动时验证 Claude Code binary 和本地 roots；缺失或配置错误直接启动失败。
- 建立 workdir jail 深模块：
  - roots 全部通过 `realpath` 规范化，使用路径边界比较，禁止 `..`、前缀碰撞和符号链接逃逸。
  - server roots 只能与本地 roots 求交集并缩小权限，不能扩大权限。
  - 非空 server roots 与本地 roots 不相交时拒绝该 Run。
  - `loop.workdir` 必须位于有效 roots 内；`null` 使用 daemon 自有的、按哈希命名的 per-loop scratch 目录。
  - jail 失败不 spawn，直接生成失败 report。
- 建立通用 subprocess 模块：
  - POSIX 下以独立进程组 spawn。
  - timeout 或 AbortSignal：先向进程组发送 `SIGTERM`，5 秒后仍存活则 `SIGKILL`。
  - daemon shutdown 必须等待 child 被回收后才能结束。
  - stdout/stderr、单行 JSON 和累计 transcript 都设置内存上限。
- 子进程使用环境变量白名单：
  - 保留运行所需的 PATH、HOME、locale、临时目录、代理/CA，以及 Claude 的 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CONFIG_DIR`。
  - 不传 machine credential、run token、server URL、GitHub/AWS/OpenAI 等无关凭证。
  - 错误文本在进入 report/log 前对所有实际转发的 secret 做脱敏。

### 批次三：Claude Code adapter（Day 6–8）

- 将 Runner interface 调整为：
  - `run(delivery, { signal, onProgress }) → RunnerReport`
  - runtime 继续独占 `runId` 和最终 report 身份；runner 无权选择 report 的 Run。
- 新增 Claude Code adapter，默认处理缺省或 `claude-code` agent；`codex`、`grok` 返回稳定的 unsupported-agent 失败，不尝试套用 Claude 参数。
- 使用当前 Claude Code headless CLI：
  - `claude -p`
  - `--output-format stream-json --verbose`
  - 使用 delivery 的 `model`（非空时）和 `task`。
  - 禁用 user/project/local settings、MCP、plugins、hooks、skills 和自动 memory，避免工作区配置扩大权限。
  - 使用 `dontAsk`、受限 tool 列表和每次 Run 动态生成的 sandbox settings。
- sandbox 策略：
  - `enabled: true`、`failIfUnavailable: true`、`allowUnsandboxedCommands: false`。
  - Read/Edit/Write 只允许 canonical effective roots。
  - Bash 必须在 Claude 原生 OS sandbox 内执行。
  - Bash 网络默认关闭，临时文件只写入 daemon 创建的 per-run temp 目录。
  - sandbox 不可用时 Run 失败，不允许自动降级为非隔离执行。
- 增量解析 stream-json：
  - `system/init` 捕获 session id。
  - assistant/tool 事件生成递增 progress。
  - `system/api_retry` 显示 provider 重试进度。
  - terminal result 提取 success subtype、final text、session id、耗时、USD 估算、token usage 和 turn 数。
  - 未知或新增事件容忍忽略；畸形 JSON、缺少 terminal result、非零退出码、timeout 和 signal 终止均产生稳定失败 report。
- 本阶段不实现 transient session resume、artifact 扫描、task-file 内容同步、Codex adapter 或 workflow gate；这些不属于真实 Claude E2E 的最小闭环。

### 批次四：E2E、回归与阶段收口（Day 9–10）

- 默认测试套件使用可执行的 fake Claude binary，覆盖完整的：
  - server trigger → poll/claim → spawn → JSONL parse → progress poll → report → DB terminal state。
- 增加 `pnpm test:e2e:claude` 本机 opt-in 验收：
  - 使用已登录的真实 Claude Code。
  - 创建临时 git 项目、task file 和允许 root。
  - 触发 Run，让 Claude 生成固定 marker，断言 Run 为 `done/exec`、输出存在、session/usage 可解析。
  - 增加越界对抗场景：允许 root 外放置 sentinel，要求 Agent 尝试读取和覆盖，断言读取被拒绝且文件内容未改变。
- 收口 Issue #10：
  - sweep 日志按白名单区分 `reclaim_guard_lost` 与 `reclaim_failed`。
  - report 最终 lease 删除统一复用 `deleteObservedLease`。
- 新增 ADR-004，记录 Claude-only、容量 1、环境白名单、强 sandbox、timeout/kill 和 fail-closed 决策；必要时修订 ADR-001 的 progress heartbeat 说明。
- 真实 E2E 通过后更新 roadmap：
  - Phase 2 标记完成并记录日期/分支。
  - Issue #10 改为已关闭链接。
  - handoff 仅作当批物流，不提交到仓库。

## Interface 与兼容性

- 协议只增加可选 `PollRequest.availableSlots`；现有 Delivery、Report 和数据库列已足够，无需 migration。
- `progress` 由原来的 parse-only 字段变成正式行为，但 wire shape 不变。
- `AgentRunner` 保持单方法深模块，只增加执行上下文，不暴露 subprocess、stream parser 或 sandbox 内部 seam。
- Loop 创建仍默认 `claude-code`；本阶段不新增 provider 选择 UI/API。
- daemon 的显式 roots 配置是新的启动前置条件；这项变更应在 README/运行手册中给出复制即用示例。

## 测试与验收矩阵

- workdir：根目录本身、子目录、相似前缀、`..`、不存在目录、文件冒充目录、内外部符号链接。
- sandbox：根内读写成功；根外 Read/Edit/Bash 读写失败；sandbox 不可用时 fail-closed。
- process：正常退出、ENOENT、非零退出、timeout、SIGINT/SIGTERM、忽略 SIGTERM 的子进程、孙进程清理。
- stream：分块 JSONL、跨 chunk 行、未知事件、畸形行、超长输出、success/error result、缺失 result、usage 缺字段。
- runtime：执行时仍持续 poll；capacity 按 `1→0→1` 变化；旧 server 批量 delivery 本地顺序排队（仅防御行为，不承诺排队 Run 的 liveness）；report 未确认时不领取新 Run、也不启动本地排队的下一个 Run。
- server：progress 只能更新本 machine 的 running Run；迟到 progress 零写；progress 与 sweep 交错时新鲜 heartbeat 胜出。
- 回归：仓库完整 `test`、`typecheck`、`build`，Phase 1 T1–T7 全绿。
- 最终阶段验收必须包含一次真实 Claude Code E2E，不以 fake CLI 测试代替。

## 假设与默认值

- 正式支持 macOS、Linux 和 WSL2；原生 Windows 因缺少等价进程组与 Claude sandbox 支持，不纳入本阶段。
- 当前开发机 Claude Code `2.1.221` 作为首个支持版本；实现依赖其 headless `stream-json` 与 fail-closed sandbox 能力。
- Claude Code 的 user/project/local 设置属于非受信输入，真实 Run 不加载；企业 managed policy 视为主机管理员的受信策略，允许进一步收紧权限。
- USD 字段仅作为 CLI 估算值记录，不作为计费依据。
- Phase 2 不加入 Codex；现有 provider enum 和 seam 保留，后续可用独立 adapter 扩展。
