# loop-platform-zhb

多用户可调度 Agent 循环平台的能力复刻（路线图见 `docs/roadmap.md`，决策见 `docs/adr/`）。
仓库为 pnpm workspace：`packages/protocol`（wire DTO 单一来源）、`packages/server`、`packages/daemon`。

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
| `LOOPZHB_CLAUDE_BIN` | 否 | `claude` | Claude Code 二进制名/路径；启动时探测 `--version`（≥2.1.219）与 `--help` flags（词边界匹配），并钉住二进制身份（每次 Run 前复核，漂移即拒绝 spawn）；探测失败即拒绝启动 |
| `LOOPZHB_AGENT_TIMEOUT_MS` | 否 | `1800000` | 严格十进制，1–2147483647 |

**平台**：macOS / Linux / WSL2。原生 Windows 不支持（subprocess 进程组语义是 POSIX 的）。

**Batch 3 状态（当前）**：生产 daemon 已切换到**真实 Claude Code Runner**（ADR-006）。每次 Run 经固定 argv 的 `claude -p --output-format stream-json` 执行，只开放 `Bash` 工具，文件系统与网络由 fail-closed OS sandbox 兜底（sandbox 不可用即失败，绝不降级为 unsandboxed）；jail 在 spawn 前重校验（resolve→spawn 窗口收窄，残余由 sandbox 兜底），per-run scratch 用后即焚且清理失败判 Run 失败。启动顺序：`config → startup jail → Claude 探测 → HTTP client → Claude Runner → runtime`，探测失败时 daemon 不启动。

人工验收（不进默认离线测试套件，使用开发者本机 Claude 认证）：

```bash
LOOPZHB_CLAUDE_SMOKE=1 pnpm --filter @loopzhb/daemon vitest run src/claude-smoke.test.ts
```

## 开发

```bash
pnpm install
pnpm test        # 全部 workspace 测试
pnpm typecheck
pnpm build
```

仓库工作规约（文档四层分流、批次收口仪式）见 `AGENTS.md`。
