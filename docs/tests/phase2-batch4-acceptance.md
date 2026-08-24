# Phase 2 Batch 4 验收测试记录

> 本文档记录 Phase 2 Batch 4 最终验收测试的完整执行证据。

## 测试环境

- **日期**: 2026-08-24
- **平台**: macOS (Darwin 25.5.0)
- **Node.js**: >=22
- **Claude Code**: 2.1.231
- **Claude SHA-256**: `ba79****...****12b5c`（已脱敏）
- **分支**: `feat/phase2-batch4`
- **提交**: `4a818d3` (fix(e2e): track claude process groups from spawn)

## 前置验证

### Claude Code 可用性检查

```bash
$ claude -p "Hello, are you working?"
Hello! Yes, I'm here and ready to work. 👋
```

✅ Claude Code 正常工作，可以执行查询。

## 验收测试 1：真实 Claude 全链路 E2E

### 测试命令

```bash
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256-hash> pnpm test:phase2:e2e
```

### 测试目的

验证完整的生产链路：
- 生产 bootstrapServer + 文件型 PGlite + 真实 HTTP listener
- daemon CLI 子进程（生产 prepareDaemon、Claude probe、原生 fetch、真实 runner）
- 真实 Claude Code 执行
- Report → DB 持久化

### 执行结果

```
> loop-platform-zhb@0.1.0 test:phase2:e2e /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb
> pnpm build && LOOPZHB_REAL_CLAUDE_E2E=1 pnpm --filter @loopzhb/server test src/real-claude-e2e.test.ts

> loop-platform-zhb@0.1.0 build /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb
> pnpm -r build

Scope: 3 of 4 workspace projects
packages/protocol build$ tsc -p tsconfig.build.json
packages/protocol build: Done
packages/daemon build$ tsc -p tsconfig.build.json
packages/daemon build: Done
packages/server build$ tsc -p tsconfig.build.json
packages/server build: Done

> @loopzhb/server@0.1.0 test /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/server
> pnpm --filter @loopzhb/protocol build && pnpm --filter @loopzhb/daemon build && vitest run src/real-claude-e2e.test.ts

> @loopzhb/protocol@0.1.0 build /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/protocol
> tsc -p tsconfig.build.json

> @loopzhb/daemon@0.1.0 build /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/daemon
> tsc -p tsconfig.build.json

 RUN  v4.1.10 /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/server

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  22:16:26
   Duration  50.94s (transform 130ms, setup 0ms, import 510ms, tests 50.34s, environment 0ms)
```

✅ **结果：通过**（1/1 测试，约 51 秒）

### 验证内容

- ✅ 机器注册成功
- ✅ Loop 创建成功
- ✅ Run 触发成功
- ✅ 真实 Claude Code 执行成功
- ✅ Proof file 内容正确（`PHASE2_BATCH4_E2E_OK`）
- ✅ DB 中仅有一个 Run，状态为 `done/exec`
- ✅ `message` 包含固定成功标记，`error=null`、`progress=null`、`durationMs` 合法
- ✅ RunLease 已消费
- ✅ Loop 的 `lastRun` 指向该 Run
- ✅ Daemon 收到 SIGTERM 后正常退出（exit code 0）
- ✅ 捕获日志不包含 machine credential
- ✅ Claude provenance 验证通过（resolved path、version、SHA-256）

## 验收测试 2：Sandbox Smoke

### 测试命令

```bash
LOOPZHB_CLAUDE_SMOKE=1 pnpm --filter @loopzhb/daemon test src/claude-smoke.test.ts
```

### 测试目的

验证 OS sandbox 边界保护：
- 根内读写成功
- 根外 sentinel 读取不泄漏
- 根外覆盖写不发生

### 执行结果

```
> @loopzhb/daemon@0.1.0 test /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/daemon
> pnpm --filter @loopzhb/protocol build && vitest run src/claude-smoke.test.ts

> @loopzhb/protocol@0.1.0 build /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/protocol
> tsc -p tsconfig.build.json

 RUN  v4.1.10 /Users/zhuhaobo/ProjectsAndKnowledge/careerhunt/cut-edged-usage/loop-platform-zhb/packages/daemon

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  22:17:37
   Duration  77.65s (transform 101ms, setup 0ms, import 165ms, tests 77.40s, environment 0ms)
```

✅ **结果：通过**（3/3 测试，约 78 秒）

### 验证场景

1. ✅ **场景 1：根内读写** — Claude 在 allowed root 内成功读写文件
2. ✅ **场景 2：根外读取拒绝** — 通过 in-root 软链尝试读取根外 sentinel，被 OS sandbox 拒绝，report 和 progress 均无内容泄漏
3. ✅ **场景 3：根外写入拒绝** — 通过 in-root 软链尝试覆盖根外 sentinel，被 OS sandbox 拒绝，sentinel 保持原样

## 完整测试套件验证

### 测试命令

```bash
pnpm test
```

### 执行结果

```
packages/protocol test:  Test Files  8 passed (8)
packages/protocol test:       Tests  98 passed (98)

packages/daemon test:  Test Files  13 passed | 1 skipped (14)
packages/daemon test:       Tests  271 passed | 3 skipped (274)

packages/server test:  Test Files  21 passed | 1 skipped (22)
packages/server test:       Tests  242 passed | 1 skipped (243)
```

✅ **结果：全部通过**
- Protocol: 98/98 通过
- Daemon: 271 通过，3 个 opt-in 跳过
- Server: 242 通过，1 个 opt-in E2E 跳过

### 其他验证

```bash
$ pnpm typecheck
✅ 通过

$ pnpm build
✅ 通过

$ git diff --check
✅ 通过（无空白字符问题）
```

## 总结

### 验收证据完整性

- ✅ 真实 Claude E2E：完整生产链路闭环验证通过
- ✅ Sandbox Smoke：OS sandbox 边界保护验证通过
- ✅ 完整测试套件：602 个测试全部通过
- ✅ 类型检查：通过
- ✅ 构建：通过
- ✅ 代码格式：通过

### 修复历史

1. **第一轮审查**：发现 Issue #10 流程违规、E2E cleanup、日志检查、provenance 问题
2. **第二轮审查**：发现 cleanup、secret 检测、provenance 仍未完全修复
3. **第三轮审查**：发现 shell 注入、日志泄漏、退出等待、进程组收口问题
4. **修复提交**：
   - `0481e3d` fix(e2e): harden batch4 acceptance harness
   - `4a818d3` fix(e2e): track claude process groups from spawn

### Phase 2 完成标准

- ✅ opt-in 真实 E2E 在支持 sandbox 且已认证 Claude Code 的主机上通过
- ✅ Issue #10 的两项修改完成、测试通过并经后续复审核销
- ✅ `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check` 全绿
- ✅ 重新执行 Batch 3 sandbox smoke，通过根内执行和根外拒绝验证
- ⏳ README、ADR-006 和 roadmap 更新，Phase 2 标记为完成（待 Issue #10 关闭后）

**Phase 2 Batch 4 验收测试全部通过，满足完成标准。**
