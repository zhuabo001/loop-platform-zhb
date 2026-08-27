# loop-platform-zhb

多用户可调度 Agent 循环平台的能力复刻（路线图见 `docs/roadmap.md`，决策见 `docs/adr/`）。
仓库为 pnpm workspace：`packages/protocol`（wire DTO 单一来源）、`packages/server`、`packages/daemon`。

## 核心功能

### Loop 调度模式

**手动触发**（Phase 1-2）：
```bash
POST /api/loops/:id/run
```
显式触发单次执行。

**定时调度**（Phase 3 Batch 2）：
创建或更新 Loop 时指定 cron 表达式和时区，系统自动按计划触发执行。

```bash
# 创建定时 Loop（每天 UTC 10:00 执行）
POST /api/loops
{
  "machineId": "m-xxx",
  "name": "daily-report",
  "workdir": "/home/user/project",
  "cron": "0 10 * * *",
  "timezone": "UTC"
}

# 更新 Loop 调度配置
PATCH /api/loops/:id/schedule
{
  "cron": "0 14 * * *",      // 修改执行时间
  "timezone": "Asia/Shanghai"  // 修改时区
}

# 暂停定时调度（保留配置）
PATCH /api/loops/:id/schedule
{
  "enabled": false
}

# 恢复定时调度
PATCH /api/loops/:id/schedule
{
  "enabled": true
}

# 转为手动触发（清除 cron）
PATCH /api/loops/:id/schedule
{
  "cron": null
}
```

**Cron 表达式格式**：标准五段式 `minute hour day month weekday`（不支持秒/年段和宏）。

**时区**：IANA 时区标识符（如 `UTC`、`Asia/Shanghai`、`America/New_York`）。

**调度语义**：
- `nextFireAt` 字段显示下次计划执行时间（计算字段，不持久化）
- 执行中的 Loop 不会积累待执行队列（新的计划触发推进水位但跳过入队）
- 配置更新立即生效（零停机 reconcile）
- 手动触发和定时调度可共存（手动触发不受 cron 配置影响）

详见 `docs/adr/ADR-007-online-scheduler.md`。

## Daemon 运行

daemon 在用户本机执行 Agent Run；server 只调度与存储，绝不执行用户代码。

```bash
LOOPZHB_SERVER_URL=http://127.0.0.1:3000 \
LOOPZHB_MACHINE_CREDENTIAL=dk_xxx \
LOOPZHB_ALLOWED_ROOTS='["/home/you/projects"]' \
pnpm --filter @loopzhb/daemon start
```

| 环境变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `LOOPZHB_SERVER_URL` | ✅ | — | http/https，无 userinfo/query/fragment |
| `LOOPZHB_MACHINE_CREDENTIAL` | ✅ | — | `dk_` 前缀设备令牌（仅形状校验） |
| `LOOPZHB_ALLOWED_ROOTS` | ✅ | — | JSON 字符串数组；绝对路径、无 `..` 段；启动时校验存在且为目录（fail-fast） |
| `LOOPZHB_POLL_MS` | 否 | `3000` | 严格十进制，250–60000 |
| `LOOPZHB_CLAUDE_BIN` | 否 | `claude` | Claude Code 二进制名/路径；启动时以无凭据 env 探测 `--version`（≥2.1.219）与 `--help`，每次调用前后均复核 stat+sha256；真实 Run 的 spawn 前再复核，漂移或探测失败即拒绝执行 |
| `LOOPZHB_AGENT_TIMEOUT_MS` | 否 | `1800000` | 严格十进制，1–2147483647 |

**平台**：macOS / Linux / WSL2。原生 Windows 不支持（subprocess 进程组语义是 POSIX 的）。

**生产 Runner**：生产 daemon 使用真实 Claude Code Runner（ADR-006）。每次 Run 经固定 argv 的 `claude -p --output-format stream-json` 执行，只开放 `Bash` 工具，文件系统与网络由 fail-closed OS sandbox 兜底（sandbox 不可用即失败，绝不降级为 unsandboxed）；child-controlled progress 只暴露固定语义标签，不转发模型文本或命令；jail 在 spawn 前重校验（resolve→spawn 窗口收窄，残余由 sandbox 兜底），per-run scratch 用后即焚且清理失败判 Run 失败。

## 开发

```bash
pnpm install
pnpm test        # 全部 workspace 测试
pnpm typecheck
pnpm build
```

## 验收测试

人工验收测试（不进默认离线测试套件，使用开发者本机 Claude 认证与真实 LLM 调用，会产生费用）：

```bash
# Sandbox smoke：验证 OS sandbox 边界保护
LOOPZHB_CLAUDE_SMOKE=1 pnpm --filter @loopzhb/daemon test src/claude-smoke.test.ts

# 全链路 E2E：验证完整生产链路（HTTP → daemon → Claude → DB）
# 先独立核对本机 Claude realpath/version，并计算、审核其 SHA-256
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-64-hex-sha256> pnpm test:phase2:e2e
```

仓库工作规约（文档四层分流、批次收口仪式）见 `AGENTS.md`。

