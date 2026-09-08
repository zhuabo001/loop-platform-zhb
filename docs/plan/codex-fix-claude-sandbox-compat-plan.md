# Claude Runner sandbox 兼容性修复计划

- 状态：实现已完成；2026-09-08 首轮独立复审整改完成，真实拒绝复验与第二轮核销待执行
- 日期：2026-09-07
- 目标分支：`feat/phase4-batch2-dev`
- 关联：Issue #50（阻塞 #49、#38）；ADR-006；ADR-009；`docs/plan/codex-fix-claude-runner-plan.md`

## 1. 目标与执行边界

在当前 Claude Code 二进制上，使生产 runner 能稳定执行普通 Bash 与 terminal wrapper，准确保留命令成功/失败状态，并完成 Batch 2 真实验收。

1. 实施前记录实际 HEAD、工作区差异，以及 Claude、Node 的路径、版本、SHA-256 和 macOS 版本；保留用户已有改动。
2. 先调查当前配置与路径，不预设版本回归，不自动升级、降级或增加版本黑名单。
3. 修复范围为 #50；#49、#38 按各自关闭条件复验。#51–#53 单独跟踪，不能因 #50 通过而视为解决。
4. 保留 Bash-only、`dontAsk`、settings source 隔离、禁止 unsandboxed fallback、文件与网络隔离，以及现有 Journal 唯一性和失败优先规则。
5. 执行 agent 完成实现和证据交付；另一个审查 agent 按固定提交执行三轨审查。Issue 在复审核销后关闭。

第一阶段最多 **8 次真实 Claude 调用、90 分钟诊断时间，累计模型费用目标不超过 3 美元**。每次调用限时 180 秒；已知累计费用达到目标后不再启动下一次。费用通常在调用结束后才完整可见，因此不宣称这是严格账单上限。费用不可获取时停止继续付费实验。完整验收另计，沿用既有超时，不自动循环重跑。

2026-09-08 复审补充：A–D 使用诊断账本；最终生产 P 与拒绝 R 使用独立验收账本，最多 4 次、90 分钟，并且必须由操作者显式设置 `LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD` 正数目标。账本固定在用户持久目录，不随 `--evidence-dir` 改变；检查与 `started` 预留受进程间排他锁保护，完成时按 `runId` 更新最新账本。任一账本出现 started 未完成、费用未知、格式损坏、次数/时间/费用到限，后续调用均 fail-closed；更换 evidence 目录不能作为绕过既有未知费用的核销证据。

## 2. 第一阶段：建立复现与验证修复假设

新增持久化的 opt-in 测试入口 `pnpm test:claude:compat`，复用生产 provider bootstrap、二进制身份检查、runner、wrapper 和进程组回收。诊断变体仅存在于测试辅助代码，不增加生产环境开关。

测试脚本进入仓库；脱敏证据保存在仓库外的持久目录，不能仅依赖 `/tmp`。每轮保存配置摘要、二进制身份、实际 Bash 输入与结果、文件副作用、Journal 判定、耗时和费用。原始 credential 和未经脱敏的 transcript 不落盘。

同一 Claude、Node、工作目录与权限基线下，按以下矩阵逐项执行：

| 实验 | 唯一变化 | 要回答的问题 |
|---|---|---|
| A：生产基线 | 无 | 当前环境是否仍出现 OpenSSL abort、cwd EPERM？ |
| B：临时目录 | 私有短目录及精确授权 | `cwd-*` 是否迁移，Bash 状态是否恢复准确？ |
| C：wrapper 启动 | wrapper 专属 OpenSSL 配置 | Node 是否正常启动并写出合法 Journal？ |
| D：组合验证 | B、C 同时启用 | 真实 terminal 命令是否一次成功、无重试？ |

2026-09-08 复审后的可重放定义：上述“生产基线”只描述最初的实验意图；修复合入后不能再把
当前生产代码称为旧基线。诊断入口现将 A/B/C/D 明确定义为“legacy/fixed wrapper ×
legacy/fixed temp”四象限：A=旧/旧、B=旧/新、C=新/旧、D=新/新；另以 P 表示不修改能力的
当前生产 smoke，以 R 表示当前生产路径上的完整拒绝验收。每份证据必须记录实际 child profile、
源码 HEAD/dirty 摘要及 Claude/Node/脚本/runtime artifact hash，不能仅凭变体名推断配置。

执行规则：

1. 普通 Bash 检查包括成功命令和故意失败命令；分别核对工具结果与文件证据，不能只检查 Claude 最终退出码。
2. 若基线已经通过，再用全新 Run 重复两次；稳定通过时交付“当前未复现”结论，不实施缺乏必要性的补丁。
3. 组合方案通过后，再用两个全新 Run 重复，合计三次独立成功。
4. 剩余调用只用于区分已观测到的路径或权限差异，不用于无目标重试。
5. 如果配置重定向未生效，检查实际 child env、路径 canonicalization、路径长度回退，以及可获取的 sandbox 拒绝证据；每次只改变一个变量。
6. 达到上限或精确修复仍失败时，提交实验矩阵、已排除因素和剩余假设，返回设计讨论。不得自行转向版本切换、广泛放权或终态容错。

第一阶段通过条件：确认必要改动能消除原错误，并且没有将真实失败误判为成功。

## 3. 第二阶段：将通过验证的改动接入生产

### Wrapper 启动依赖

在 `packages/daemon/src/control-root.ts` 中保留构建期自包含 bundle 及其摘要校验，把 `loopzhb` 入口改为 daemon 生成的薄 ESM launcher（不是 shell 脚本）：

```text
#!<canonical Node> --openssl-config=<只读配置>
import "./<已校验 bundle>";
```

1. shebang 直接使用 canonical Node 绝对路径；launcher 不重新拼接、求值或转发 shell 字符串，Node 按 shebang 语义保留调用参数。
2. launcher 为 `0500`，bundle 和空配置为 `0400`，所在目录不给 sandbox 写权限。
3. OpenSSL 配置仅作用于 wrapper Node；不写入整个 Claude 的环境，也不修改用户配置。
4. bundle 继续不依赖 daemon 安装目录；launcher 仅包含固定路径和参数，不包含 credential。
5. `ControlRoot` 增加 bundle 和 OpenSSL 配置路径；构造失败及退出时沿用资源回收规则。
6. 默认支持当前普通 Node 环境；若发现需要保留的 FIPS/定制 OpenSSL 要求，该路径拒绝静默覆盖，返回单独兼容性决策。
7. 仅在第一阶段 C 验证有效后合入此实现。

### 每 Run 的临时文件能力

新增内部 `prepareClaudeRunTemp()`，返回 canonical 临时根、环境覆盖和释放能力。

1. macOS 在 canonical `/private/tmp` 下以短前缀 `mkdtemp`；Linux 使用 canonical 系统临时目录。目录 `0700`，名称不包含 credential 或业务文本。
2. 每个 Run 独立创建，与 wrapper、context、outbox 分开；不能把 outbox 当临时目录。
3. 在过滤用户环境之后，由 runner 内部设置 `CLAUDE_CODE_TMPDIR`；不扩大用户环境/settings 白名单。
4. 仅增加该 Run 临时根所需的读写能力；不得授权共享 UID 临时目录或整个 control root 写入。
5. 不假设 `TMPDIR` 与 `CLAUDE_CODE_TMPDIR` 相同；测试检查真实路径。如出现系统目录回退，判定该候选方案未完成验证。
6. 适用于 v0、v1 的 Bash 执行；wrapper 专属配置仍只用于 v1。
7. 所有退出路径回收资源；清理失败仍使 Run 失败，且不得掩盖现有 `ProcessControlError`。
8. 仅在第一阶段 B 验证有效后合入此实现。

不新增公开包 API、wire 字段或数据库迁移；不修改 Journal 协议。若实验表明只需其中一项改动，则仅合入有必要性和有效性证据的部分。

## 4. 回归测试与真实验收

确定性测试覆盖：

1. launcher 经实际入口执行；空格、引号、美元符号等参数原样透传，不发生额外 shell 求值。
2. PATH 中放置错误 Node 时，wrapper 仍使用固定 canonical Node。
3. bundle 缺失/摘要错误、配置创建失败均 fail-closed；构造中的资源被回收。
4. wrapper 启动不依赖 daemon 安装目录，正常调用生成唯一合法记录。
5. 临时目录每 Run 不同；用户提供的路径变量不能覆盖 runner 生成值。
6. 成功、失败、超时、取消、spawn 失败与进程控制异常均有正确清理和错误优先级。
7. settings-derived credential 继续经过既有脱敏链，不进入新 launcher、配置或诊断文件。

真实验收使用最终生产路径，删除测试专用配置覆盖：

1. 成功 Bash 得到成功结果；故意失败的 Bash 保留失败结果。
2. 无 OpenSSL abort、无 cwd EPERM；三次独立最小 Journal smoke 均只调用一次 terminal 命令，恰好一条合法记录，Claude result 和进程退出均成功。
3. 现有根外 symlink 读写拒绝测试继续通过；增加真实尝试访问另一 Run 临时目录的拒绝检查，以及修改只读 wrapper/配置的拒绝检查。每项在同一个 shell 中先写根内 attempt marker，再执行访问并写 allowed/denied completion marker；由 attempt、denied 分支、tool result 与目标完整性共同证明命令进入 shell 后被 OS sandbox 拒绝，Claude 权限层预执行拒绝不能算通过。
4. 脱敏检查和进程组回收通过。

定向测试通过后执行一次完整 `pnpm test`、`pnpm typecheck`、`pnpm build`，再进行三轨审查。修复审查问题后复验受影响项，最后执行 `pnpm test:phase4:batch2:e2e`：验证 Task File、state、下一 Run 的 prev-state、Finish、Completed、调度停止和进程回收。

环境权限错误不得记作代码缺陷，也不得记作通过；真实测试必须在支持所需监听、且不受外层会话 sandbox 干扰的环境运行。

## 5. 交付、核销与停止条件

执行 agent 交付固定修复提交、必要改动说明、实验矩阵、测试结果、持久证据位置及剩余问题。将最终成立的设计写入 ADR，阶段状态写入 roadmap，审查过程追加到 handoff。

核销按最新 Issue 原文执行：

1. #49：自包含 wrapper 的真实执行和关联复审要求满足后核销。
2. #50：两类阻塞消失、确定性与真实隔离检查通过、三轨复审通过，且完整 Batch 2 E2E 通过后核销。
3. #38：完整两 Run 验收及正式证据记录齐备后核销。

以下情况必须返回设计讨论：私有目录方案仍失败；需要扩大文件或网络权限；需要调整 Journal/终态成功规则；需要切换 Claude 或 Node 版本；需要超出诊断预算继续实验。返回时必须提供具体失败证据和下一步选择，不能仅记录“等待上游”。
