# Phase 2 Batch 2 开发计划：本机执行与强隔离

## 背景与上下文

**Phase 2 目标**：将 daemon 从假 runner 转变为真实的本机 subprocess 执行，具备完整的安全隔离机制。

**Batch 1 状态**：✅ 已完成并合并（2026-08-19，PR #13）
- Poll/heartbeat 与执行解耦，daemon 可在后台执行 Run 的同时持续 poll
- 容量管理：`availableSlots: 0|1` 协作式背压信号
- Progress 心跳：20 条轮询预算，round-robin 公平性
- 执行管线：`inFlight ∪ queue ∪ pendingReports` 背压门控
- `runtime.ts` (18.6KB)、`runtime.test.ts` (29.3KB) 完整实现

**Batch 2 范围**（Day 3-5，约 3-4 个开发日）：
本批次聚焦于**隔离原语**的建立，为 Batch 3 的 Claude Code adapter 打好地基。

核心任务：
1. **Daemon 配置扩展**：新增 3 个环境变量，启动时校验
2. **Workdir jail 深模块**：路径边界验证、符号链接防护、权限交集
3. **通用 subprocess 模块**：进程组管理、timeout、SIGTERM→SIGKILL
4. **环境变量白名单**：显式允许列表、凭证脱敏

**设计原则**（继承 ADR-001, ADR-004）：
- **Fail-closed**：任何隔离失败都拒绝执行，不降级
- **权限只能收窄**：server roots 只能与 daemon roots 求交集，不能扩大
- **协作式信号 ≠ 安全边界**：`availableSlots` 是背压信号，真正的边界在 jail/sandbox

---

## 一、新建模块

### 1.1 `packages/daemon/src/jail.ts`（约 300 行）

**职责**：Workdir 校验与路径边界强制执行（深模块）

**导出接口**：
```typescript
export interface JailConfig {
  allowedRoots: string[];  // 绝对路径，已规范化
}

export class JailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JailError";
  }
}

// 启动时验证与规范化 roots
export function validateJailConfig(config: JailConfig): void

// 计算有效 roots：daemon roots ∩ server roots
// 空交集时抛出 JailError
export function computeEffectiveRoots(
  daemonRoots: string[],
  serverRoots: string[]  // 来自 Delivery.roots
): string[]

// 校验 workdir 在有效 roots 内，返回规范化路径
// workdir 为 null 时生成 per-loop scratch 目录
export function resolveWorkdir(
  workdir: string | null,
  effectiveRoots: string[],
  scratchBase: string  // daemon 临时目录基准
): string
```

**核心行为**：
- 所有 roots 通过 `fs.realpathSync()` 规范化（启动时一次性）
- 拒绝 `..`、符号链接逃逸、前缀碰撞（如 `/foo` vs `/foobar`）
- Server roots 为空数组时：表示不限制（使用全部 daemon roots）
- Server roots 非空但与 daemon roots 不相交时：抛出 JailError
- `loop.workdir` 为 `null` 时：生成 per-run scratch 目录（现行实现：工厂在 `scratchBase` 内 mkdtemp 不可预测的 per-jail `loopzhb-runs-*` 0700 根目录，再以 loopId+runId 哈希前缀在其内 mkdtemp，0700，永不复用）
- Jail 失败直接生成失败 report，不 spawn subprocess

**测试矩阵**（12+ 用例）：
- ✅ 根目录本身
- ✅ 子目录
- ✅ 相似前缀碰撞（`/foo` vs `/foobar`）
- ✅ `..` 逃逸尝试
- ✅ 不存在目录
- ✅ 文件冒充目录
- ✅ 内部符号链接（指向 roots 内）
- ✅ 外部符号链接（指向 roots 外）
- ✅ Server roots 与 daemon roots 不相交 → JailError
- ✅ Server roots 是 daemon roots 子集 → 有效交集
- ✅ Server roots 为空数组 → 使用全部 daemon roots
- ✅ Null workdir → scratch 目录生成

---

### 1.2 `packages/daemon/src/subprocess.ts`（约 250 行）

**职责**：通用子进程生命周期管理，带 timeout 和信号处理

**导出接口**：
```typescript
export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;  // 带内存上限
  stderr: string;  // 带内存上限
  timedOut: boolean;
}

export async function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult>
```

**核心行为**：
- **POSIX 进程组**：`spawn(..., { detached: true })` 创建独立进程组
- **Timeout/AbortSignal 处理**：
  1. 发送 `SIGTERM` 到进程组（`process.kill(-pid, 'SIGTERM')`）
  2. 等待 5 秒 grace period
  3. 仍存活则发送 `SIGKILL` 到进程组
- **Stdout/stderr 限制**：每个流设置 1MB 内存上限，超出部分截断
- **子进程回收**：返回前必须完全 reap，daemon shutdown 等待所有 child 结束
- **环境变量白名单**（在此模块实现）：
  - 保留：`PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`, `HTTP(S)_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`
  - Claude 专用：`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
  - 排除：machine credential, run token, server URL, `GITHUB_TOKEN`, `AWS_*`, `OPENAI_API_KEY`
- **凭证脱敏**：错误文本进入 report/log 前，替换所有实际转发的 env var 值为 `[REDACTED]`

**测试矩阵**（10+ 用例）：
- ✅ 正常退出（exit code 0）
- ✅ 非零退出码
- ✅ 命令不存在（ENOENT）
- ✅ Timeout：grace period 内正常终止
- ✅ Timeout：忽略 SIGTERM，需 SIGKILL
- ✅ AbortSignal 触发中断
- ✅ 孙进程清理（fork 一个 sleep 子进程）
- ✅ Stdout/stderr 捕获与内存上限
- ✅ 环境变量白名单强制
- ✅ 错误消息中的凭证脱敏

---

## 二、修改现有文件

### 2.1 `packages/daemon/src/config.ts`（+150 行）

**新增字段**：
```typescript
export interface DaemonConfig {
  // 现有字段：serverUrl, machineCredential, pollMs
  allowedRoots: string[];      // 必填，非空，绝对目录
  claudeBin: string;           // 默认 "claude"
  agentTimeoutMs: number;      // 默认 1800000（30 分钟）
}

export type DaemonConfigEnv = {
  // 现有字段...
  LOOPZHB_ALLOWED_ROOTS?: string;         // 必填，JSON 字符串数组
  LOOPZHB_CLAUDE_BIN?: string;            // 可选
  LOOPZHB_AGENT_TIMEOUT_MS?: string;      // 可选
};
```

**解析函数**：
```typescript
function parseAllowedRoots(raw: string | undefined): string[] {
  // 必填：raw 为空或空白 → DaemonConfigError
  // JSON 解析：必须是数组 → 否则抛错
  // 非空数组：长度 > 0 → 否则抛错
  // 每项：绝对路径 → fs.isAbsolute() 校验
  // 存在性：fs.statSync() → 必须是目录
  // 规范化：fs.realpathSync() → 解析符号链接
  // 返回规范化后的绝对路径数组
}

function parseClaudeBin(raw: string | undefined): string {
  // 默认值："claude"
  // 空白 → 默认值
  // 显式值 → 原样返回（启动时再验证可执行性）
}

function parseAgentTimeoutMs(raw: string | undefined): number {
  // 默认值：1800000（30 分钟）
  // 空白 → 默认值
  // 显式值：必须是正整数 → 否则抛错
}
```

**启动时校验**（在 `cli.ts` 或 `index.ts` 主流程）：
```typescript
// 验证 Claude binary 存在且可执行
try {
  execSync(`${config.claudeBin} --version`, { stdio: 'pipe' });
} catch {
  throw new DaemonConfigError(`LOOPZHB_CLAUDE_BIN not executable: ${config.claudeBin}`);
}

// 调用 jail 模块验证 roots
validateJailConfig({ allowedRoots: config.allowedRoots });
```

**测试用例**（8+ 个）：
- ✅ 缺失 `LOOPZHB_ALLOWED_ROOTS` → DaemonConfigError
- ✅ 空 JSON 数组 → DaemonConfigError
- ✅ 非数组 JSON → DaemonConfigError
- ✅ 相对路径 → DaemonConfigError
- ✅ 不存在目录 → DaemonConfigError
- ✅ 文件而非目录 → DaemonConfigError
- ✅ 有效单个 root
- ✅ 有效多个 roots
- ✅ Claude binary 不存在 → DaemonConfigError（集成测试）
- ✅ 有效 Claude binary 路径
- ✅ 无效 timeout（负数/零/非数字） → DaemonConfigError
- ✅ 有效 timeout 覆盖

---

### 2.2 `packages/daemon/src/runner.ts`（从 37 行 → 约 400 行）

**当前状态**（Batch 1）：
```typescript
export interface RunnerContext {
  signal: AbortSignal;
  onProgress: (label: string) => void;
}

export interface AgentRunner {
  run(delivery: Delivery, context: RunnerContext): Promise<RunnerReport>;
}

export function createFakeRunner(): AgentRunner {
  // 立即返回假 report，不 spawn
}
```

**Batch 2 变更**：
- 移除 `createFakeRunner()`
- 新增 `createClaudeRunner(config)`，但 Batch 2 **仍不实现完整的 Claude Code 调用**
- Batch 2 的重点是**集成 jail 和 subprocess 模块**，为 Batch 3 铺路

**新接口**：
```typescript
export interface ClaudeRunnerConfig {
  claudeBin: string;
  allowedRoots: string[];
  agentTimeoutMs: number;
  scratchBaseDir: string;  // daemon 临时目录基准（如 os.tmpdir()；工厂在其内 mkdtemp per-jail 根目录）
}

export function createClaudeRunner(config: ClaudeRunnerConfig): AgentRunner {
  return {
    async run(delivery, context): Promise<RunnerReport> {
      // 1. 验证 agent 类型：只支持 "" 或 "claude-code"
      //    其他（codex, grok）返回 unsupported-agent 失败 report
      
      // 2. 计算有效 roots
      try {
        const effectiveRoots = computeEffectiveRoots(
          config.allowedRoots,
          delivery.roots
        );
      } catch (err: JailError) {
        // 空交集或 jail 错误 → 立即返回失败 report，不 spawn
        return {
          ok: false,
          outcome: "fail",
          message: `Jail violation: ${err.message}`,
          durationMs: 0,
        };
      }
      
      // 3. 解析 workdir
      let workdir: string;
      try {
        workdir = resolveWorkdir(
          delivery.loop.workdir,
          effectiveRoots,
          config.scratchBaseDir
        );
      } catch (err: JailError) {
        return {
          ok: false,
          outcome: "fail",
          message: `Invalid workdir: ${err.message}`,
          durationMs: 0,
        };
      }
      
      // 4. 构建环境变量（白名单）
      const env = buildWhitelistedEnv();
      
      // 5. 构建 Claude CLI 参数（Batch 3 完善，Batch 2 简化）
      const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        delivery.task
      ];
      
      // 6. Spawn subprocess
      context.onProgress("starting claude-code");
      const startTime = Date.now();
      
      try {
        const result = await spawnWithTimeout({
          command: config.claudeBin,
          args,
          cwd: workdir,
          env,
          timeoutMs: config.agentTimeoutMs,
          signal: context.signal,
        });
        
        const durationMs = Date.now() - startTime;
        
        // 7. 解析结果（Batch 3 完善 stream-json 解析，Batch 2 简化）
        if (result.timedOut) {
          return {
            ok: false,
            outcome: "fail",
            message: "Agent execution timed out",
            durationMs,
          };
        }
        
        if (result.exitCode !== 0) {
          return {
            ok: false,
            outcome: "fail",
            message: `Claude exited with code ${result.exitCode}`,
            durationMs,
          };
        }
        
        // 简化成功判断（Batch 3 解析 stream-json terminal result）
        return {
          ok: true,
          outcome: "exec",
          message: "Agent execution completed",
          durationMs,
        };
        
      } catch (err) {
        // 8. 凭证脱敏
        const scrubbedMessage = scrubSecrets(err.message, env);
        return {
          ok: false,
          outcome: "fail",
          message: scrubbedMessage,
          durationMs: Date.now() - startTime,
        };
      }
    }
  };
}

// 辅助函数：构建白名单环境变量
function buildWhitelistedEnv(): Record<string, string> {
  const allowed = [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "SSL_CERT_FILE",
  ];
  
  const env: Record<string, string> = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  
  // Claude 专用
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ANTHROPIC_") || 
        key === "CLAUDE_CODE_OAUTH_TOKEN" ||
        key === "CLAUDE_CONFIG_DIR") {
      env[key] = process.env[key]!;
    }
  }
  
  return env;
}

// 辅助函数：脱敏 secret
function scrubSecrets(text: string, env: Record<string, string>): string {
  let scrubbed = text;
  for (const value of Object.values(env)) {
    scrubbed = scrubbed.replaceAll(value, "[REDACTED]");
  }
  return scrubbed;
}
```

**Batch 2 与 Batch 3 边界**：
- **Batch 2**：集成 jail + subprocess，返回简化 report
- **Batch 3**：完整 stream-json 解析、sandbox 设置、session/usage 提取、progress 事件生成

**测试用例**（10+ 个）：
- ✅ Unsupported agent 类型 → 稳定失败 report
- ✅ Server roots 与 daemon roots 不相交 → jail 失败，不 spawn
- ✅ Workdir 在 jail 外 → 失败 report
- ✅ Timeout → 失败 report，`timedOut: true`
- ✅ 非零退出码 → 失败 report
- ✅ Signal 终止 → 失败 report
- ✅ 成功执行 → ok report（Batch 2 简化）
- ✅ Progress callback 被调用
- ✅ 环境变量白名单生效
- ✅ 错误消息中凭证被脱敏

---

### 2.3 `packages/daemon/src/runtime.ts`（约 20 行变更）

**集成点**：
```typescript
// 在 DaemonRuntime 构造函数或工厂函数中
const runner = createClaudeRunner({
  claudeBin: config.claudeBin,
  allowedRoots: config.allowedRoots,
  agentTimeoutMs: config.agentTimeoutMs,
  scratchBaseDir: os.tmpdir(), // 工厂在其内 mkdtemp 不可预测 per-jail 根目录（勿传可预测叶子目录）
});

// 传给 runtime
new DaemonRuntime({ client, runner, pollMs: config.pollMs });
```

**行为保持**：
- Batch 1 的 `onProgress` callback 已就绪，runner 直接调用
- Poll/heartbeat/dispatch 逻辑**完全不变**
- Runner 失败仍生成 report，带 `delivery.runId`
- 容量门控（`availableSlots: 0|1`）继续工作

**测试调整**：
- 现有 runtime 测试适配真实 runner（mock subprocess 调用）
- 创建 fake Claude binary fixture（返回确定性 stream-json）
- E2E：trigger → poll → spawn → report → terminal state

---

## 三、实施顺序（TDD 红-绿-重构）

### Day 3（周三）：隔离原语

**上午**：
1. 创建 `jail.ts` 骨架与测试文件
2. TDD 实现 `validateJailConfig()` + 12 个测试用例
3. TDD 实现 `computeEffectiveRoots()` + 交集/空集测试
4. TDD 实现 `resolveWorkdir()` + 符号链接防护测试

**下午**：
1. 创建 `subprocess.ts` 骨架与测试文件
2. TDD 实现基础 `spawnWithTimeout()` + 正常退出/ENOENT
3. TDD 实现 timeout 与信号处理 + SIGTERM/SIGKILL
4. TDD 实现环境变量白名单 + 凭证脱敏

### Day 4（周四）：Runner 集成

**上午**：
1. 扩展 `config.ts` + 8 个新测试用例
2. CLI 启动校验：Claude binary + roots
3. 创建 `runner.ts` 新实现骨架
4. 实现 jail 集成：`computeEffectiveRoots` + `resolveWorkdir`

**下午**：
1. 实现 subprocess 调用 + 错误处理
2. 实现环境变量白名单调用
3. 实现凭证脱敏
4. Runner 单元测试：jail 失败、timeout、成功场景

### Day 5（周五）：集成与回归

**上午**：
1. 修改 `runtime.ts`：替换 fake runner 为 Claude runner
2. 适配现有 runtime 测试（mock subprocess）
3. 创建 fake Claude binary fixture（`test-fixtures/fake-claude`）
4. E2E 测试：完整流程走通

**下午**：
1. 回归测试：Phase 1 T1-T7 + Batch 1 所有测试
2. `pnpm test`、`pnpm typecheck`、`pnpm build` 全绿
3. 文档更新：README 添加 `LOOPZHB_ALLOWED_ROOTS` 示例
4. 提交 PR，标记 Batch 2 完成

---

## 四、测试矩阵总结

### 4.1 单元测试

| 模块 | 测试文件 | 用例数 |
|------|---------|--------|
| jail | `jail.test.ts` | 12+ |
| subprocess | `subprocess.test.ts` | 10+ |
| config | `config.test.ts` | 8+ 新增 |
| runner | `runner.test.ts` | 10+ |
| **总计** | | **40+** |

### 4.2 集成测试

- `runtime.test.ts`：适配真实 runner，mock subprocess
- Fake Claude binary：确定性 stream-json 输出
- 完整流程：poll → claim → jail 校验 → spawn → report

### 4.3 回归测试

- ✅ Phase 1 T1-T7（7 个端到端测试）
- ✅ Batch 1 capacity/heartbeat 测试（不变）
- ✅ Server coordinator 测试（不变）
- ✅ `pnpm test` 完整套件
- ✅ `pnpm typecheck` 无错误
- ✅ `pnpm build` 成功

---

## 五、完成定义（Definition of Done）

Batch 2 视为完成当且仅当：

1. ✅ `jail.ts` 创建，12+ 测试通过
2. ✅ `subprocess.ts` 创建，10+ 测试通过
3. ✅ `config.ts` 扩展，8+ 新测试通过
4. ✅ `runner.ts` 替换为 Claude runner，10+ 测试通过
5. ✅ `runtime.ts` 集成 Claude runner
6. ✅ Fake Claude binary 创建于 `test-fixtures/`
7. ✅ E2E 测试通过：trigger → spawn → parse → report → done/exec
8. ✅ Jail 逃逸测试：sentinel 文件在 roots 外保持不变
9. ✅ Phase 1 回归测试全绿
10. ✅ Batch 1 容量/心跳测试不变且全绿
11. ✅ `pnpm test` 完全通过
12. ✅ `pnpm typecheck` 完全通过
13. ✅ `pnpm build` 成功

**进入 Batch 3 的前置条件**：
- 至少一次 E2E 执行产生 `done/exec` 报告（使用 fake Claude）
- Agent 无法读写 allowed roots 外的文件（测试验证）
- Timeout 终止整个进程组（测试验证）

---

## 六、依赖与前置条件

### 已完成
- ✅ Batch 1 poll/heartbeat 解耦
- ✅ Batch 1 容量管理
- ✅ `Delivery.roots` 协议字段就绪
- ✅ `AgentRunner` 接口定义
- ✅ 分支 `feat/phase2-batch2` 存在

### 无阻塞项
- Node.js `child_process` 标准库
- 无需新增 npm 依赖
- Claude Code binary（opt-in E2E 用，默认测试用 fake binary）

### 风险与缓解

**风险 1：进程组语义在 Windows**
- **决策**：Batch 2 不支持原生 Windows
- **范围**：macOS, Linux, WSL2 only
- **文档**：在 README 明确说明

**风险 2：Claude CLI 破坏性变更**
- **缓解**：Batch 2 只使用基础 CLI 参数
- **容错**：Batch 3 会实现未知事件容忍
- **Fallback**：Fake binary 让默认测试不依赖真实 Claude

**风险 3：Sandbox 不可用**
- **行为**：Fail-closed，拒绝执行（Batch 3 实现）
- **测试**：验证 sandbox 不可用 → 失败 report

---

## 七、右移项（Phase 2 后续批次处理）

- **Issue #10**（Day 8-10）：sweep 日志分类、report lease 删除统一
- **Issue #12**：跨层 round-robin liveness 验收（测试缺口，不阻塞 Batch 2）
- **Batch 3**：完整 Claude Code adapter、stream-json 解析、sandbox 集成
- **Batch 4**：E2E with 真实 Claude、越界对抗测试、ADR-004 文档

---

## 八、关键设计决策参考

| 主题 | 来源 | 决策 |
|------|------|------|
| Fail-closed | ADR-001, ADR-004 | 任何隔离失败都拒绝执行 |
| 权限交集 | plan.md:50 | Server roots 只能收窄，不能扩大 |
| 协作式背压 | ADR-004 决策 2 | `availableSlots` 不是安全边界 |
| Realpath 规范化 | plan.md:48 | 防止符号链接逃逸 |
| 进程组清理 | plan.md:56 | SIGTERM → 5s → SIGKILL |
| 环境白名单 | plan.md:59 | 显式允许列表，不是黑名单 |
| Sandbox 策略 | plan.md:76 | `failIfUnavailable: true` |

---

## 九、下一步行动

1. **立即开始**：创建 `packages/daemon/src/jail.ts`
2. **Day 3**：完成 jail + subprocess 模块与测试
3. **Day 4**：实现 Claude runner with jail/subprocess 集成
4. **Day 5**：集成 runtime、E2E、回归验证
5. **提交 PR**：标记 Batch 2 完成，准备进入 Batch 3
