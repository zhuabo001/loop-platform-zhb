# Phase 4 Batch 3 切片五开发计划：真实验收与阶段收口

## 1. 目标与实施基线

基于 `feat/phase4-batch3-dev@d419a19`，完成 Batch 3 最后一片：以 Dashboard 触发真实 Claude 的两次 Run，验证 Task File 与跨 Run state 的完整 Phase 4 语义，经重启确认 Completed Loop 不会被 Scheduler 再次执行，并完成遗留 Issue、长期文档、PR 与 Phase 4 状态收口。

按当前 Batch 3 总计划，切片五是切片一至五中的最后一个切片。执行开始时重新读取远端分支、PR #55 和 Issue 状态；本计划建立时 #33、#36、#51、#52、#53 仍为 OPEN，#54 已关闭，#56 是 Phase 5 右移项，不属于本切片。

真实 Claude 门为 opt-in，必须校验操作者批准的 Claude SHA-256。实际运行前须取得本次模型费用的明确批准；验收入口不得自动重试或在失败后自动启动额外真实调用。确定性测试不得触发真实 Claude。

## 2. 实施范围

### 2.1 确定性端到端覆盖

- 新增 fake Claude 驱动的 Dashboard 全链路测试，覆盖页面读取、CSRF 表单 POST、Run、Report、state 晋升、Task File 同步、Finish、Completed 页面与管理 API 守卫。
- 使用两项测试期随机标记构造反空转证据：首个 Run 将第一标记写入 state，并从 Task File 中移除；更新后的 Timeline 保留第二标记。第二个 Run 的 finish reason 必须同时报告前次 state 标记与 Timeline 标记。
- 复用文件型 PGlite、真实 loopback HTTP listener、生产 Daemon CLI、真实 Claude runner 和 fake Claude fixture；断言两个 Run 的顺序、终态、state、磁盘 Task File、同步快照、completionReason、schedule enabled 状态及 RunLease 清理。
- 覆盖真实生产 bootstrap 的 Scheduler 启动/停止顺序及同一数据目录连续重启两次。通过测试专用 FakeClock/FakeCronFactory 跨过合法 occurrence；加入未完成的对照 Loop，证明 catch-up 实际执行；证明 Completed Loop 的 Run 数、state 与完成字段在重启期间不变。
- 所有服务、daemon、Scheduler、数据库、临时目录和 Claude 进程组均注册到失败安全的 finally 清理路径；设置有界等待，沿用真实门的注册 30 秒、单次 Run 10 分钟、整测 25 分钟上限。

### 2.2 Opt-in 真实 Claude 验收门

- 新增 `packages/server/src/phase4-batch3-real-claude-e2e.test.ts` 与根脚本 `pnpm test:phase4:e2e`。复用 Batch 2 真实门的 provenance、批准哈希、日志脱敏、进程组观察和资源清理能力；保持 `pnpm test:phase4:batch2:e2e` 原行为不变。
- 使用生产 Daemon CLI、真实 Claude 二进制、真实 OS sandbox、真实 HTTP 和文件型 PGlite；scheduler 使用生产实现。只为确定性重启时间跨越注入 Clock/CronFactory，不替换业务路径或 Claude runner。
- 测试只在 `LOOPZHB_REAL_CLAUDE_E2E=1` 且 `LOOPZHB_EXPECTED_CLAUDE_SHA256` 为 64 位十六进制批准值时运行；默认测试保持跳过，不将凭据写入 argv、prompt、持久日志或验收文档。
- 两次 Run 均通过 Dashboard `POST /dashboard/loops/:id/run` 触发。Dashboard 页面入口是 `GET /`。Run 1 必须读 Task File、记录 state 并更新 Timeline；Run 2 必须读 `prev-state.json` 和更新后的 Timeline，并在 finish reason 中返回两项测试标记。
- 验收断言包括：Run 1 的 state 晋升和 Task File 磁盘/数据库同步；Run 2 原子完成 Loop、保留 state、禁用 schedule、消费 Lease；后续 API Run Now 返回 `loop_completed`，页面显示 Completed 且按钮禁用。
- SIGTERM 后断言 daemon 正常退出、每个观察到的 Claude 进程组均关闭、日志中无 machine/provider secret，控制根与临时资源均已回收。失败时只记录失败原因，不自动重试真实调用。

### 2.3 收口文档与协作状态

- 在 `docs/adr/009-phase4-stateful-loop-semantics.md` 追加 Dashboard、CSRF、Run Now no-supersede 与切片五验收所需的长期裁决；只记录可跨阶段复用的决策。
- 扩展 `docs/tests/phase4-acceptance.md`，保留 Batch 2 历史，新增 Batch 3 / Phase 4 真实验收证据：固定提交、OS/Node/pnpm、Claude 版本与批准 SHA-256、命令、真实门结果、两次 Run 证据、重启结果及资源/秘密检查结果。不得将未执行或失败的验收记为通过。
- 在 README 增加本机 Dashboard 地址、显示范围、Run Now 可用条件及 Completed 行为；纠正 PR #55 描述中的 Dashboard GET 路径，使其与实际 `GET /` 一致。
- 对最终变更进行 Standards、Spec、Adversarial 三轨复审。将 #33、#36、#51、#52、#53 的修复提交/已有修复定位、定向验证与后续独立核销证据分别补入 Issues；只有满足仓库 Issue 流程后才关闭。#56 继续保持 Phase 5 右移状态。
- 更新 PR #55 描述、质量门和关联 Issue；新提交的 CI 通过且所有 Phase 4 阻塞 Issue 已独立核销关闭后，才在 roadmap 将 Batch 3 与 Phase 4 标记完成，并使 PR 具备合入条件。

## 3. 验证与完成条件

先运行确定性定向测试，再运行全量质量门：

```bash
pnpm --filter @loopzhb/server test src/phase4-batch3-e2e.test.ts
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @loopzhb/server db:check
git diff --check "$(git merge-base HEAD main)"...HEAD
```

真实验收在具备 loopback 监听权限、Claude 认证和费用批准的环境单独执行：

```bash
LOOPZHB_PHASE4_ACCEPTANCE_BUDGET_USD=<approved-total-usd> LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256> pnpm test:phase4:e2e
```

全部完成条件：确定性门和全量质量门通过；批准哈希匹配的真实 Claude 两次 Run 与连续两次重启验收通过；Dashboard 仍保持本机可见、服务端渲染、无客户端 JavaScript 和单一 Run Now 控件；没有未经批准的 schema migration、公共 JSON DTO 或对外 Dashboard API 变化；三轨复审没有未解决的 P1/P2；Phase 4 阻塞 Issues 均完成独立核销；ADR、验收记录、README、roadmap、Issue 和 PR 内容互相一致。任一门失败时，roadmap 保持 Batch 3 / Phase 4 进行中，记录实际失败并修复后复验。

## 4. 假设与明确边界

- 本计划创建时远端基线为 `d419a19`；提交前必须同步并核对分支、PR #55、Issue #33/#36/#51/#52/#53 的实时状态与关闭条件。
- 不新增数据库迁移、公共 JSON DTO、客户端 JavaScript、Dashboard 编辑功能或额外产品路由；Dashboard 页面入口保持 `GET /`，Run 表单保持 `POST /dashboard/loops/:id/run`。
- Issue #56 的 API 同源意图校验、JSON Content-Type 门禁与拒绝空请求体由 Phase 5 处理，不作为切片五的隐藏工作。
- 切片五是 Batch 3 最后一个计划切片；若独立复审发现新的 Phase 4 阻塞项，先登记并解决/重新规划后再收口，不能为了维持“五片”而提前标记 Phase 4 完成。

## 2026-09-27 收口补充

- 真实任务仅提交独立的 terminal 命令。移除调试用 `; echo "exit=$?"`：相同 CLI/hash 下其权限检查仍拒绝整个 Bash 调用；不扩展 wrapper 放行到 echo，不改变 reason 的内容。诊断使用工具返回结果，成功以 host Journal 和数据库终态为准。
- marker A 只存在于 Run 1 可删除的 Timeline 行；Run 2 启动前检查 Task File 及工作目录文件不含 A。随机 marker 与前次 state 错误必须使门转红。
- 每 Run 先执行一次显式 record-free help，再提交恰好一条 report/finish，以真实链路核查 #58。
- 用户批准本次一次两 Run 真实验收，总上限 $3；入口必须提供批准总预算，传递每 Run 为总额三分之一的 CLI `--max-budget-usd` 阈值，保留三分之一余量。Run 1 费用缺失或剩余不足时不得触发 Run 2；完成后记录实际两 Run 费用。CLI 阈值按请求检查，不宣称账户级精确硬限额。失败不自动重试。
- 真实门与 secret E2E 使用各自私有的 daemon TMPDIR，避免并行套件误把另一 daemon 的控制根当作自己的资源。shutdown 前确认资源真实存在，再核查关闭后消失。

### 费用取证修订（第六次真实门后）

- 用户已明确接受阈值末次请求可能超额，原预算授权P2核销。
- `runs.costUsd` 的生产契约是parse-only，不能作为验收费用来源；按 #59 改观察已接受的生产Report numeric USD，真实HTTP app和生产daemon路径保持。只保留runId/number，不保留body/Authorization。
- 第六次真实门 Run1正常、Run2未触发；费用未留存记未知，不推定为0。新一次付费复验须重新明确批准，既有门失败不自动重试。

### 第七次真实门与记录限制

- 用户重新授权的一次完整真实门在固定fb2b17e通过，1/1 PASS，全部产品、两次重启、资源与秘密断言完成，后续三轨核销 #57/#58。
- 两Run numeric费用与合计<=3断言通过，但Vitest agent reporter隐藏成功console，精确金额未留存（#60）。后续入口显式default reporter/silent=false，零费用验证成功日志可见；本次记录条件的例外尚待用户裁决，未擅自降低本计划实际费用留存要求，未自动付费复验。

### 最终收口裁决

2026-09-27，用户明确接受本次收口，接受第七次真实门“numeric费用有效、合计<=3美元，但精确金额未留存”的已披露记录限制。该裁决仅是本次费用留存条件例外；后续实际金额记录要求保持。未来日志修复4fa825e已通过零费用验证、后续三轨复审及远端CI，#60核销，Phase4正式收口，不新增模型调用。PR #55待合入，最终文档提交CI以PR Checks为准。
