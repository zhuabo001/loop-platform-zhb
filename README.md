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
- **重启 catch-up（Phase 3 Batch 3）**：Server 停机跨越任意多次 occurrence，重启后只恢复**最新一次**（不补跑历史 backlog）；同一 occurrence 经水位去重绝不双跑；连续重启不重复恢复；执行中的 Run 不被重新投递

详见 `docs/adr/008-phase3-batch2-online-scheduler.md` 与 `docs/adr/007-phase3-batch1-schedule-foundation.md`（批次三追加裁决）。

## Dashboard（本机）

仅当 server 绑定**回环地址**时存在，入口是 `GET /`（例如 `http://127.0.0.1:3000/`）；绑定非回环地址时完全不挂载——`GET /` 与写路由都落回普通 404，与任意未知路径不可区分。

- **只读页面，单一动作**：服务端渲染、无客户端 JavaScript、每 3 秒 meta refresh；单页最多显示 100 条 Loop（按最近更新时间倒序），页面自己写明当前条数与排序口径。
- **Run Now**：每张卡片一个按钮（`POST /dashboard/loops/:id/run`，表单带每 boot 一枚的 CSRF token，重启即失效）。按钮可用条件与后端规则同源、同序：已完成（Completed）禁用 → 已有 Running Run 禁用 → 已有 Pending Run 禁用；Paused 且无活跃 Run 仍可用。页面最多陈旧 3 秒，**后端才是权威**：按钮可点但后端判定已有 Run 时，结果是零写跳过而不是替换。
- **不替换已有 Run**：Dashboard 触发的 Run Now **不会**取消或替换任何已排队的 Run——任意 role 的 pending/running 都会让它零写跳过（不改 Run、不推进 revision 与调度水位）。cron 与重启 catch-up 的 T7 supersede 语义不受影响（ADR-007 §4 / ADR-008）。
- **Completed 行为**：Loop 完成后页面显示 Completed、按钮禁用并给出原因；`POST /api/loops/:id/run`、重新启用调度与修改 Goal 均为 `409 loop_completed`（只有 Reopen 能恢复）。
- **信任模型**：回环绑定时生效的全局 Host 门禁只封 DNS rebinding，**不是认证**——本机上的其他进程仍可直接请求，与 JSON API 的既有边界一致。Dashboard 不是对外服务。

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

# Phase 4 Batch 3 全链路门：从 Dashboard 页面触发两次真实 Run
# （state 晋升 → Task File 改写 → Finish 完成）并连续重启两次
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-64-hex-sha256> pnpm test:phase4:e2e
```

权限层探针（opt-in，**不调用模型、零费用**，但依赖本机安装的 Claude Code 内部判定）：

```bash
# 用生产 argv/settings 驱动真实 CLI（mock provider 提供 canned Bash tool_use），
# 断言"含 ;/= 的终局命令在无放行规则时被拒、有规则时执行且 outbox 记录逐字节相符"
LOOPZHB_CLAUDE_PERMISSION_PROBE=1 pnpm --filter @loopzhb/daemon test src/claude-permission-probe.test.ts
```

仓库工作规约（文档四层分流、批次收口仪式）见 `AGENTS.md`。

