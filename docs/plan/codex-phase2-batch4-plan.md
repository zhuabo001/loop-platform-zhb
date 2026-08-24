# Phase 2 Batch 4 开发计划：真实 Claude 全链路验收与阶段收口

## 一、摘要与完成标准

Batch 4 负责完成 Phase 2 的最终验收：让一次手动触发的 Run 经真实 HTTP、生产 daemon、真实 Claude Code、Report 和文件型 PGlite 完整闭环，并收口 Issue #10。

完成标准：

- opt-in 真实 E2E 在支持 sandbox 且已认证 Claude Code 的主机上通过；
- Issue #10 的两项修改完成、测试通过并经后续复审核销；
- `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check` 全绿；
- 重新执行 Batch 3 sandbox smoke，通过根内执行和根外拒绝验证；
- README、ADR-006 和 roadmap 更新，Phase 2 标记为完成。

## 二、实现变更

### 2.1 真实 Claude 全链路 E2E

新增 `packages/server/src/real-claude-e2e.test.ts`：

- 使用 `LOOPZHB_REAL_CLAUDE_E2E=1` 控制；默认 `pnpm test` 发现但跳过，避免 CI 依赖认证、费用和模型稳定性。
- 启动生产 `bootstrapServer`、文件型 PGlite 和绑定随机端口的真实 HTTP listener。
- 以子进程运行构建后的 daemon CLI，不直接导入 Claude Runner，也不注入 fake fetch，确保经过生产 `prepareDaemon`、Claude probe、原生 `fetch` 和真实 runner。
- 使用临时 allowed root 创建 workdir、task file 和 proof file；task 要求 Claude 写入固定证明内容并返回 `PHASE2_BATCH4_E2E_OK`。
- 通过真实 HTTP 完成：等待机器注册 → 创建 Loop → 手动 trigger → 等待 Run 终态。
- 断言：
  - proof file 内容准确；
  - DB 中仅有一个 Run，状态为 `done/exec`；
  - `message` 包含固定成功标记，`error=null`、`progress=null`、`durationMs` 合法；
  - RunLease 已消费，Loop 的 `lastRun` 指向该 Run；
  - daemon 收到 SIGTERM 后正常退出；
  - 捕获日志不包含 machine credential。
- 使用有界等待：注册最多 30 秒，Agent 最多 10 分钟，整测试最多 12 分钟；失败时输出有大小上限的 daemon 日志尾部。
- `finally` 始终按 daemon → HTTP listener → DB → 临时目录顺序清理。
- 根目录增加 `test:phase2:e2e` 脚本，负责先构建 protocol/daemon，再显式启用该测试。

### 2.2 收口 Issue #10

在 sweep 中增加内部、可单测的固定分类函数：

- `ReclaimGuardLostError` → `reclaim_guard_lost`；
- 其他 Error、伪造对象及未知抛出值 → `reclaim_failed`；
- 日志只拼接 Run ID 与固定 classification，绝不包含 `err.message`、stack 或数据库文本。
- 更新现有“不变量违例不阻塞后续 candidate”测试，精确断言 `reclaim_guard_lost`。
- 增加 fallback 分类测试，使用含 credential/newline 的错误文本验证不会进入日志。

在 report transaction 中：

- 最终成功路径的 lease 删除改为调用既有 `deleteObservedLease()`；
- 不改变 CAS guard、事务边界、重试次数或异常类型；
- 复用现有 finalize、reconcile、第二次 report 401 和事务回滚测试证明行为不变，不添加源代码文本断言。

### 2.3 文档与收口

- 本计划作为 Batch 4 的长期引用锚点，为真实 E2E 和 Issue #10 测试编组。
- 在 ADR-006 修订记录中登记完整真实 E2E 的验收形态和结果；本批没有新的架构裁决，不新建 ADR。
- README 将“Batch 3 当前状态”更新为 Phase 2 完成状态，并记录 opt-in E2E 与 sandbox smoke 命令、认证和费用提示。
- roadmap 增加 Batch 4 完成记录并标记 Phase 2 完成；Issue #10 关闭后移除开放右移项指针。
- 向 Issue #10 追加修复提交、测试命令和复审证据；只有后续复审通过后才关闭。

## 三、接口与兼容性

- 不修改 protocol DTO、HTTP API、数据库 schema、migration 或 daemon/server 的生产 package exports。
- 不放宽 jail、sandbox、Claude 工具、网络或权限策略。
- 唯一新增的开发接口是 opt-in 测试命令；默认测试和生产启动行为保持兼容。
- artifact、task-file 同步、transcript 持久化、cron、Codex/Grok adapter 继续保持范围外。

## 四、测试与实施顺序

1. 提交本 Batch 4 计划文档。
2. 为 Issue #10 日志分类添加红测，再实现固定分类；完成 report helper 收拢。
3. 运行 sweep/report/coordinator 聚焦测试。
4. 添加真实 E2E 验收 pin；它验证已有生产组件的组合，不要求为了制造 red commit 人为破坏代码。
5. 执行：
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm build`
   - `git diff --check`
   - `LOOPZHB_CLAUDE_SMOKE=1 pnpm --filter @loopzhb/daemon vitest run src/claude-smoke.test.ts`
   - `pnpm test:phase2:e2e`
6. 进行后续代码复审并核销发现；复审通过后关闭 Issue #10。
7. 最后更新 ADR、README 和 roadmap，完成 Phase 2 收口。

## 五、假设

- 真实 E2E 按已确认方案作为 opt-in 验收测试，不进入默认 CI。
- 验收主机需为 macOS、Linux 或 WSL2，安装兼容版本 Claude Code、具备有效认证和可用 OS sandbox。
- 真实 E2E 只验证成功闭环；根外读写对抗继续由现有三场景 sandbox smoke 负责，两者必须共同通过才能宣布 Phase 2 完成。
- 如果 E2E 暴露生产缺陷，应在现有安全与协议不变量内修复，不允许通过 fake runner、mock transport 或 sandbox 降级绕过。
