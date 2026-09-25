# Phase 4 Batch 3 切片四开发计划：核销遗留 Issues

## 1. 目标与实施基线

基于 `feat/phase4-batch3-dev@6198680`，完成切片四范围内 Issues #33、#36、#51、#52、#53 的复核、必要修复与后续核销。当前 PR #55 包含切片一至三；本切片继续在同一分支和 PR 上实施，切片五及 Phase 4 阶段收口仍待后续完成。

Issue 状态、评论及关闭条件以 GitHub 为准。实施开始时先用 `gh issue view` 核对五个 Issue 的最新状态和正文；本地审查记录显示 #33/#36 的既有修复已技术满足核销条件，#51/#52/#53 是 Batch 2 复审新增项。若 Issue 已关闭，核对其关闭证据，不重复修复或重开；若 Issue 的最新关闭条件与本计划不同，以 Issue 为准并同步计划。

本切片不新增数据库迁移、公共 JSON DTO 或 Dashboard 行为。确定性验证使用 fake Claude，不执行真实 Claude；真实 Claude 验收属于切片五。

## 2. Issue 处理范围

### #33、#36：复核已有修复

- 对照 Issue 的关闭条件复验深层及共享引用 state 的 stack-safe wire / canonical clone、PostgreSQL JSONB 可写域，以及 Finish 可选 message 的 terminal policy。
- 核对 state 的 NUL、非法 UTF-8 / unpaired surrogate、超限与深度边界；Finish message 的 NUL 和 UTF-8 字节上限；确认验证失败不会消费 Lease 或产生部分写入。
- 优先复用 Batch 1/2 已有测试证据。只有找到具体回归或关闭条件未覆盖项时才补测试或修改生产代码；不为已满足的条件重复实现。
- 技术复核通过后，按仓库流程等待后续独立复审，再决定是否关闭 Issue。

### #51：provider bootstrap 错误不得泄漏配置路径

- 在 `packages/daemon/src/claude-provider-env.ts` 移除所有错误消息中的 `settingsPath`，保持稳定的错误类别；可保留允许字段名，不包含文件路径、文件内容、字段值或底层异常文本。
- 覆盖 unreadable、invalid JSON、顶层 schema 错误、`env` schema 错误及 allow-listed 字段类型错误。缺失 settings 文件继续视为兼容的 env-only 配置。
- 在 `claude-provider-env.test.ts` 与 CLI 启动测试中，将伪 token 放入 `CLAUDE_CONFIG_DIR` 路径，断言异常及 daemon 日志均不回显路径或伪 token。
- 保持 probe 使用无凭据环境、bootstrap 失败时不创建 poll loop，并回收已创建的 control root 与 scratch root。

### #53：settings 来源 secret 的 production CLI 确定性全链路测试

- 扩展 Batch 2 生产 daemon CLI + fake Claude E2E，新增由临时 `CLAUDE_CONFIG_DIR/settings.json` 提供 provider secret 的场景；启动子进程前清除继承的 provider 凭据，确保 sidecar 观测到的值确实来自 settings。
- sidecar 仅作为测试观测点，证明 settings-derived secret 进入 Claude child env；保留显式环境变量覆盖 settings 的独立现有用例。
- 增加正常结果文本含原始 secret 时的脱敏断言；增加派生编码分别进入 state 和 Task File 时的拒绝断言，验证 state 不晋升、Task File 不同步入数据库。
- 对 raw 与测试涉及的派生形式扫描被接受的 Journal、state、Task File 同步快照、Report/数据库、HTTP 响应和 daemon stdout/stderr。伪 secret 仅可存在于临时 fixture、agent env 观测 sidecar 和测试断言输入中。
- E2E 沿用现有资源生命周期与清理方式；fake Claude 场景必须证明错误 Run 的 Journal / Report 分类稳定，且没有敏感值进入对外边界。

### #52：同步 provider 计划与长期记录

- 修正 `docs/plan/codex-fix-claude-runner-plan.md` 中过时的“待实施”状态，准确记录 provider bootstrap 已实现及真实门历史状态。
- 修正 `docs/adr/006-phase2-batch3-claude-code-adapter.md` 决策正文和 `packages/daemon/src/cli.ts` composition 注释中的启动顺序，统一记录为：config → startup jail/control root → 无凭据 Claude probe → provider bootstrap → client → runner → runtime。
- 更新 `docs/roadmap.md`：Phase 4 Batch 3 标记为进行中，记录切片一至三已完成、切片四 Issue 核销进行中，并保留尚未关闭问题的 Issue 指针。不得提前标记 Batch 3 或 Phase 4 已完成。
- 核对 #50、#49、#38 已通过的真实门历史，不恢复已经过时的阻塞关系；保留 `docs/tests/phase4-acceptance.md` 既有 Batch 2 证据，整个阶段的最终扩充仍属于切片五。

## 3. 验证与完成条件

### 定向验证

- #33/#36：运行 protocol terminal-policy / wire 测试及 server 的 Report / Phase 4 live 测试，确认 state 和 Finish policy 边界及失败零写入。
- #51：运行 provider bootstrap、CLI startup 定向测试，覆盖含伪 token 的配置路径、错误分类、无泄漏、缺失文件兼容与启动资源回收。
- #53：运行新增的 settings-derived provider E2E 和显式环境覆盖用例；确认 child env 来源、输出脱敏、state / Task File 拒绝及外部边界无 secret。

### 切片完成门

- 必要代码与测试完成后，运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm --filter @loopzhb/server db:check` 和 `git diff --check origin/main..HEAD`。db:check 应确认无新增 schema migration。
- 对最终切片四提交进行 Standards、Spec、Adversarial 复审；所有 P1/P2 finding 修复并经后续复核。
- 为每个核销 Issue 留下修复提交或既有修复定位、定向验证证据和独立复审核销记录；随后用 `gh` 按 Issue Tracker 流程更新/关闭，不由实现者仅凭自己的修复提交关闭。
- 更新 PR #55 描述，列明切片四范围、验证结果和仍待切片五的事项；PR 保持未合并，直到切片五与 Phase 4 收口条件满足。

## 4. 开工假设

- 开发基线为 `feat/phase4-batch3-dev` 最新提交 `6198680`，对应 PR #55 的切片一至三。
- 本地记录显示 #33/#36/#51/#52/#53 属切片四范围；执行时必须重新读取 GitHub Issue 当前状态和关闭条件。
- 切片五继续负责批准哈希的真实 Claude E2E、Phase 4 验收文档完整扩充，以及最终 roadmap 收口。
