# Phase 2 Batch 2 开发计划：本机执行隔离原语

## 一、目标与边界

Batch 2 只交付可独立验证的执行安全基础，不启动真实 Claude，也不修改 `AgentRunner` 接口。生产 daemon 继续使用 Fake Runner；Batch 3 再将 Claude adapter、严格 sandbox、stream-json 解析和生产切换作为一个完整安全单元。

Batch 2 完成后应保证：

- daemon 启动时强制校验本机 allowed roots；
- workdir 只能解析到 daemon roots 与 server roots 的有效交集，或隔离的 per-run scratch；
- subprocess 在退出、超时、abort 和残留孙进程场景下均能完整收口；
- Agent 环境只能来自显式白名单；
- server Delivery 仍不会触发任何真实进程。

本批不声明“Agent 无法访问根外文件”。workdir jail 只负责安全地选择 cwd，不是运行时文件系统安全边界；完整边界由 Batch 3 的 OS sandbox 提供。

## 二、实施内容

### 2.1 配置与启动行为

扩展 `DaemonConfig`：

```typescript
interface DaemonConfig {
  serverUrl: string;
  machineCredential: string;
  pollMs: number;
  allowedRoots: string[];
  claudeBin: string;
  agentTimeoutMs: number;
}
```

规则：

- `LOOPZHB_ALLOWED_ROOTS` 本批即为必填项：非空 JSON 字符串数组，每项必须是无 `..` 段的绝对路径。
- `LOOPZHB_CLAUDE_BIN` 缺失或空白时为 `"claude"`；显式值 trim 后保存。
- `LOOPZHB_AGENT_TIMEOUT_MS` 默认 `1_800_000`，仅接受 `[1, 2_147_483_647]` 范围内的十进制整数。
- `loadDaemonConfig()` 只做语法解析，保持无文件系统副作用；composition root 通过 jail 工厂验证 roots 存在、为目录并取得 canonical realpath。
- Batch 2 不执行 `claude --version`。Batch 3 切换真实 Runner 时再使用 `shell: false` 的 spawn 探测 binary。
- CLI 仍注入 `createFakeRunner()`；不得删除或改变现有 Runner seam。
- README 增加 roots、timeout、binary 示例，并明确 Batch 2 尚未启用真实 Agent。

### 2.2 Workdir jail 深模块

新增 `packages/daemon/src/jail.ts`，公开接口收敛为：

```typescript
interface ResolveWorkdirInput {
  workdir: string | null;
  serverRoots: string[];
  loopId: string;
  runId: string;
}

interface ResolvedWorkdir {
  cwd: string;
  effectiveRoots: string[];
  scratchDir: string | null;
}

interface WorkdirJail {
  resolve(input: ResolveWorkdirInput): Promise<ResolvedWorkdir>;
  release(resolved: ResolvedWorkdir): Promise<void>;
}

function createWorkdirJail(config: {
  allowedRoots: string[];
  scratchBase: string;
}): Promise<WorkdirJail>;
```

行为：

- 工厂 canonicalize daemon roots，拒绝不存在路径、文件、相对路径和包含 `..` 的输入；精确去重。
- `serverRoots = []` 表示不额外收窄；非空时逐 Delivery 验证并 realpath，不能信任 server 已规范化。
- 两组 roots 逐对求目录树交集：一方包含另一方时取更窄路径；使用 `path.relative()` 判断边界，禁止字符串前缀判断。
- 交集结果去重并消除被父 root 覆盖的冗余子 root；空交集抛 `JailError`。
- 非空 workdir 必须是绝对、存在的目录；realpath 后必须位于至少一个 effective root 内。指向根内的符号链接允许，指向根外的符号链接拒绝。
- null workdir 创建 per-run scratch：工厂先在 `scratchBase` 内 mkdtemp 一个不可预测的 per-jail `loopzhb-runs-*` 0700 根目录（防预占/符号链接替换，Round 1 审查），再以 `loopId + runId` 哈希为前缀在其内 mkdtemp per-run 目录，权限 `0700`，不同 Run 永不复用。
- `release()` 只允许删除当前 jail 创建、位于 per-jail scratch 根目录直接子树下且未被替换为符号链接的目录；校验或删除失败必须抛错。
- 模块文档明确：jail 只保证 cwd 选择正确，不是运行时文件系统安全边界。Batch 3 的 OS sandbox 才负责阻止进程越界访问。

### 2.3 Subprocess 生命周期模块

新增 `packages/daemon/src/subprocess.ts`，定义可供 Batch 3 流式解析复用的接口：

```typescript
interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

type SpawnCompletion =
  | { kind: "exited"; exitCode: number }
  | { kind: "signaled"; signal: NodeJS.Signals }
  | { kind: "timed-out"; finalSignal: NodeJS.Signals }
  | { kind: "aborted"; finalSignal: NodeJS.Signals }
  | { kind: "spawn-error"; code?: string; message: string }
  | { kind: "consumer-error"; message: string };

interface SpawnResult {
  completion: SpawnCompletion;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult>;
```

生命周期规则：

- 仅使用 `spawn(command, args, { shell: false, detached: true })`。
- Abort 已触发时不得 spawn，直接返回 `aborted`。
- timeout 与 abort 竞争时第一个触发者决定 completion kind。
- 终止流程幂等：进程组 `SIGTERM`，等待 5 秒，仍存在则 `SIGKILL`。
- 直接子进程正常退出后仍检查进程组；若存在残留孙进程，同样执行 TERM → KILL。
- 返回前同时满足：直接 child 已触发 `close`、stdio 已排空、进程组已不存在；`ESRCH` 视为已结束，其他 kill 错误向结果传播。
- stdout/stderr 持续 drain，每个流最多保留 1 MiB，保存头尾各一半并标记 truncated。
- chunk callback 保持原始顺序；callback 抛错时终止整个进程组并返回 `consumer-error`。
- 原生 Windows 返回明确的 unsupported-platform spawn error；正式支持 macOS、Linux、WSL2。

### 2.4 环境变量白名单与脱敏

新增 `packages/daemon/src/agent-env.ts`，公开：

```typescript
function buildAgentEnv(source: NodeJS.ProcessEnv): {
  env: Record<string, string>;
  secretValues: string[];
};

function redactSecrets(text: string, secretValues: string[]): string;
```

白名单固定为：

- 系统：`PATH`、`HOME`、`LANG`、`LC_*`、`TMPDIR`；
- 网络：大小写代理变量、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`；
- Claude：`ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CONFIG_DIR`。

不得转发 `LOOPZHB_*`、run token、machine credential、`GITHUB_TOKEN`、`AWS_*`、`GOOGLE_*`、`OPENAI_API_KEY`。所有非空 `ANTHROPIC_*`、OAuth token 和代理值均进入 `secretValues`；脱敏前按长度降序去重，绝不替换空字符串，也不把 `PATH/HOME/LANG` 当作 secret。

### 2.5 集成、文档与批次收口

- Batch 2 不修改 `runtime.ts` 的执行流程、progress 状态或 Runner 签名。
- 使用 Node fixture executable 直接集成测试 jail + env + subprocess，不通过 Delivery 或生产 runtime 启动。
- 保留现有 server daemon E2E 的 Fake Runner 行为。
- 新增 ADR，记录“workdir jail 不是安全边界”、roots 交集、per-run scratch、进程组收口、环境白名单及生产切换推迟到严格 sandbox。
- 当批详细计划经裁决入库至 `docs/plan/`（测试用例 ID 编组是 red→green 提交与审查核销的引用锚点，ADR-005 修订记录第 8 条）；合并后同时更新 ADR、roadmap 和 README。

## 三、实施顺序（TDD）

### Day 1：配置与 jail

1. 为配置解析补充 red tests，再实现三个新环境变量的解析。
2. 实现 daemon roots 的 canonicalize 与启动校验。
3. 创建 jail 深模块，完成 roots 交集和 workdir 边界测试。
4. 完成 per-run scratch 创建、权限和安全 release。

### Day 2：subprocess

1. 创建 fixture executable 和 subprocess 测试骨架。
2. 实现正常退出、非零退出、ENOENT、stdio drain 与输出上限。
3. 实现进程组 TERM → 5 秒 → KILL，以及 abort/timeout 竞争。
4. 补充父进程退出但孙进程残留的清理测试。

### Day 3：环境与组合验证

1. 实现环境白名单、secretValues 构造与脱敏。
2. 完成 fixture 的 env 观察、凭证不泄漏和 callback 异常测试。
3. 在 CLI composition root 接入配置和 roots 启动校验，生产 Runner 仍为 Fake Runner。
4. 更新 README、ADR 和 handoff 计划位置。

### Day 4-5：回归与收口

1. 运行 daemon、protocol、server 全量测试。
2. 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`。
3. 检查没有 Delivery 路径会启动真实 subprocess。
4. 更新 roadmap，标记 Batch 2 完成并指向 Batch 3 的 adapter/sandbox 工作。

## 四、测试计划

### 配置

- 缺失、空白、非法 JSON、非数组、空数组、非字符串成员；
- 相对路径、包含 `..`、不存在目录、文件路径；
- 重复 roots、多个有效 roots、timeout 边界、默认值；
- `claudeBin` 空白默认值和显式值 trim；
- 不执行 shell，不在错误消息中回显 credential。

### Jail

- 根目录本身、子目录、相似前缀碰撞；
- `..` 逃逸、内部符号链接、外部符号链接；
- server root 为 daemon root 的父目录、子目录、完全不相交；
- server roots 为空、无效或不存在；
- null workdir 的每 Run 唯一性、`0700` 权限和 release；
- release 目标被替换为符号链接时 fail-closed。

### Subprocess

- exit 0、非零退出、ENOENT；
- abort-before-spawn；
- timeout 后 SIGTERM 正常退出；
- 忽略 SIGTERM 后 SIGKILL；
- 父进程正常退出但孙进程残留；
- stdout/stderr 超过 1 MiB 仍持续 drain 且正确标记截断；
- chunk callback 抛错时进程组收口；
- signal/timeout/abort completion kind 正确。

### Environment

- 白名单完整性和禁用变量不泄漏；
- `LC_*`、`ANTHROPIC_*`、大小写代理变量匹配；
- 空 secret、重叠 secret、多个 secret 的脱敏；
- machine credential、run token、server URL 不进入 child。

### 回归

- 现有 daemon runtime、server daemon E2E 和 Fake Runner 测试保持通过；
- `pnpm test`、`pnpm typecheck`、`pnpm build` 全绿；
- Batch 2 不新增真实 Claude E2E，真实 Claude E2E 放入 Batch 3/4。

## 五、Definition of Done

1. 配置、jail、subprocess、env 模块及测试全部完成。
2. `LOOPZHB_ALLOWED_ROOTS` 已成为 daemon 启动必填项。
3. roots 交集、canonical workdir、per-run scratch 和安全 release 有行为测试。
4. timeout、abort、SIGTERM、SIGKILL 和残留孙进程场景均有测试。
5. child 环境只包含白名单变量，secret 不进入错误文本。
6. 生产 CLI 仍使用 Fake Runner，任何 Delivery 都不会启动真实 subprocess。
7. 现有 Phase 1 / Batch 1 测试无需改变 Runner 契约且全绿。
8. `pnpm test`、`pnpm typecheck`、`pnpm build` 全部通过。
9. ADR、roadmap、README 已更新；详细计划经裁决入库 `docs/plan/`（ADR-005 修订记录第 8 条）。

## 六、明确假设

- Scratch 按 Run 隔离并在使用后清理，不承担跨 Run 状态；跨 Run 状态继续走 server protocol。
- Batch 2 不承诺 Agent 根外读写安全，只承诺 workdir 选择和 subprocess 原语正确。
- Batch 3 必须显式启用 fail-closed sandbox、禁止 unsandboxed fallback，并配置读写限制；不能依赖 Claude sandbox 默认策略作为根外读取边界。[Claude Code sandbox 文档](https://code.claude.com/docs/en/sandboxing)
- `LOOPZHB_CLAUDE_BIN` 和 `LOOPZHB_AGENT_TIMEOUT_MS` 本批纳入配置，但 binary 可执行性探测和真实命令参数组装延后到 Batch 3。
