# Claude Runner Provider 配置修复计划

- 状态：已裁决，待实施
- 日期：2026-09-02
- 目标分支：`feat/phase4-batch2-dev`
- 问题记录：`docs/handoff/claude-execution-error-record.md`（Issue #38）
- 关联决策：ADR-005、ADR-006、ADR-009

## 1. 背景与根因

真实 Claude 门的 runner 固定传入：

```text
--safe-mode
--setting-sources ""
```

本机直接执行 `claude -p <query>` 可以成功；同一 Claude Code 二进制只增加
`--setting-sources ""` 即返回 `Not logged in · Please run /login`。同时，用户级
`~/.claude/settings.json` 的 `env` 中含有 provider endpoint、认证 token 与模型映射。

因此，失败不表示本机 Claude Code 未登录，而是 runner 为隔离用户行为配置而禁用全部
settings source 时，也一并移除了实际可用的 provider 配置。`claude auth status` 只能
说明本地存在认证状态，不能证明这一被隔离的调用路径仍可获得可用 endpoint/token。

## 2. 目标与固定边界

目标是在不放宽 Claude sandbox、权限模式、用户/project/local 行为配置隔离的前提下，
使 daemon 能安全使用本机用户级 Claude provider 配置。

固定边界：

1. `--safe-mode` 与 `--setting-sources ""` 保持不变；不得通过恢复全部 user settings
   来修复认证。
2. 不加载 project `.claude/settings.json`、`settings.local.json`，也不加载 hooks、plugins、
   memory、permissions 或任意用户行为配置。
3. Machine Credential、Run Credential、Server URL 继续永不进入 Agent env、prompt、argv、
   Journal、控制目录或日志。
4. provider credential 只能经现有 child-env allow-list 进入 Claude；必须同时进入
   `secretValues`，以便报告、日志、Journal 和结构化 state 复用现有脱敏规则。
5. 不把 provider credential 写进 `--settings` JSON 或其他 argv；避免从进程参数泄漏。
6. 显式启动 daemon 时提供的环境变量优先于用户 settings；用户 settings 仅补齐缺失值。

## 3. 已否决方案

### 3.1 直接改为 `--setting-sources user`

该组合与 `--safe-mode` 的最小实测可以成功复用本机 provider 配置，但不采用。它会让
Claude 自己加载整个用户 settings；其中的任意 `env` 字段可能绕过 daemon 的环境白名单和
`secretValues` 收集，进而破坏 Bash 子进程、wrapper 和 report 的秘密边界。

### 3.2 将 token/endpoint 写入 `--settings`

不采用。动态 settings 会进入 Claude 进程 argv，provider credential 可能被同机进程观察到，
且与现有 secret hygiene 原则冲突。

### 3.3 将 daemon 安装目录或用户配置目录扩大加入 sandbox 文件白名单

不采用。认证配置应在 spawn 前收敛为受控环境变量；扩大 sandbox 可读范围既不必要，也会
扩大 Agent 的文件能力。

## 4. 目标设计

新增一个启动期的深模块 `resolveClaudeProviderEnv`。它只向调用方暴露“得到可安全传给
Claude 的环境”，并将 settings 路径解析、JSON 校验、字段筛选、优先级与无敏感错误处理
封装在模块内部。

```text
CLAUDE_CONFIG_DIR/settings.json 或 $HOME/.claude/settings.json
                    │
                    │ 仅读取顶层 env 的允许 provider 字段
                    ▼
          resolveClaudeProviderEnv(processEnv)
                    │ 显式进程环境优先；settings 仅补缺
                    ▼
                 buildAgentEnv()
                    │ allow-list + secretValues + redactSecrets
                    ▼
                Claude 子进程
                    │ --safe-mode + --setting-sources ""
                    ▼
             sandboxed Bash / wrapper / Journal
```

### 4.1 Provider bootstrap 规则

`resolveClaudeProviderEnv(source)`：

1. 配置目录优先使用 `source.CLAUDE_CONFIG_DIR`；未设置时使用 `source.HOME/.claude`。
2. 只读取该目录的 `settings.json`；不递归搜索，也不读取 local/project settings。
3. settings 文件不存在时返回 source 的副本，不把“无用户配置”当作启动错误。
4. 文件存在但不可读、不是 JSON object、`env` 不是 object，或允许字段不是 string 时，
   启动 fail-closed；错误不得含文件内容、字段值或 token。
5. 仅从 `env` 读取与已有 allow-list 对齐的 provider/TLS/proxy 字段：
   - `ANTHROPIC_*`；
   - `CLAUDE_CODE_OAUTH_TOKEN`；
   - 大小写 proxy 字段；
   - `SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`。
6. `PATH`、`HOME`、locale 和 `CLAUDE_CONFIG_DIR` 只能来自 daemon 启动环境，不能被 settings
   覆盖；`LOOPZHB_*`、cloud/CI credential、任意未知字段一律拒绝提取。
7. 对每一个允许字段，非空的 `source[key]` 优先；只有 source 缺失或为空时才用 settings 值。
8. 返回新的环境对象，不修改 `source`；不记录 provider 字段值或其来源细节。

该模块不会使 Claude 在运行中读取用户 settings。被提取的 token/endpoint 通过既有
`buildAgentEnv()` 转发，因此也由现有 `collectSecretValues()`、`redactSecrets()` 和 wrapper
双层脱敏覆盖。

## 5. 文件级实施计划

### 5.1 新增 provider bootstrap 模块

新增 `packages/daemon/src/claude-provider-env.ts`：

- 定义 `resolveClaudeProviderEnv(source, deps?)`；测试可注入只读文件读取 adapter，生产实现
  使用 Node 文件系统。
- 实现 §4.1 的路径、解析、allow-list、优先级和 fail-closed 规则。
- 定义稳定、无值的错误类型/错误信息，例如 `ClaudeProviderEnvError`。
- 不负责 spawn、argv、红action 或 sandbox 逻辑。

新增 `packages/daemon/src/claude-provider-env.test.ts`：

- `$HOME/.claude/settings.json` 与 `CLAUDE_CONFIG_DIR/settings.json` 的解析优先级；
- 只读取 `settings.json`，明确证明 local/project settings 不参与；
- 每类允许字段被补齐；显式 env 覆盖 settings；
- 非允许字段（`GITHUB_TOKEN`、`AWS_*`、`GOOGLE_*`、`OPENAI_API_KEY`、`LOOPZHB_*`、任意 key）
  不进入结果；
- 缺失文件、错误 JSON、错误 schema、非 string 值、不可读文件的稳定失败语义；
- 所有失败文本均不包含 token、endpoint 或原始 JSON 片段。

### 5.2 统一环境字段分类

修改 `packages/daemon/src/agent-env.ts`：

- 导出单一的 provider 字段分类函数，供 `buildAgentEnv()` 与 provider bootstrap 复用；不得在
  两处复制 allow-list。
- 保持 `buildAgentEnv()` 的现有 allow-list 语义及 `secretValues` 收集范围。
- 维持所有非空 `ANTHROPIC_*`、OAuth token 和 proxy 值均为 secret 的规则。

修改 `packages/daemon/src/agent-env.test.ts`：

- 添加分类函数与 bootstrap 规则一致性的 drift detector；
- 验证 bootstrap 注入的 provider 值仍进入 `secretValues`，未知值仍不进入 child env。

### 5.3 在 composition root 一次性解析

修改 `packages/daemon/src/cli.ts`：

1. startup jail/control root 与 Claude binary probe 保持既有资源回收和身份校验语义。
2. 在构造 production runner 前调用一次 `resolveClaudeProviderEnv(envSource)`。
3. `probeClaudeBinary()` 继续获得无凭据 probe 环境；不得因 provider bootstrap 改为携带 token。
4. production runner 的 `envSource` 改为解析后的副本。
5. provider bootstrap 失败时释放已创建的 startup 资源并拒绝启动；不得创建 poll loop。

修改 `packages/daemon/src/cli.test.ts`：

- bootstrap 失败时已有 jail/control root 仍被回收；
- probe 仍不携带 provider credential；
- runner 收到合并后的环境但不收到任何不允许字段；
- provider settings 缺失时保持现有仅环境变量行为。

### 5.4 保持 runner 隔离参数

修改 `packages/daemon/src/claude-runner.ts` 的模块注释，明确 provider 环境已由启动期 bootstrap
收敛。`buildClaudeArgs()` 继续固定：

```text
--safe-mode
--setting-sources ""
--tools Bash
--permission-mode dontAsk
```

`packages/daemon/src/claude-runner.test.ts` 的 argv golden 不改变；补充断言，确保修复后仍不会
悄然将 `--setting-sources` 改为 `user`、`project` 或 `local`。

### 5.5 真实门与记录

修改以下真实验收用例，使其经过与 daemon CLI 一致的 provider bootstrap，并在日志脱敏断言中
纳入从测试 settings fixture 得到的 secret：

- `packages/daemon/src/claude-smoke.test.ts`；
- `packages/server/src/phase4-batch2-real-claude-e2e.test.ts`；
- `packages/server/src/real-claude-e2e.test.ts`。

确定性测试必须使用临时 `CLAUDE_CONFIG_DIR` fixture，而非开发者真实 HOME；真实 Claude 门可
读取实际用户配置，但不得将其值输出到测试日志。

更新文档：

- `docs/adr/005-phase2-batch2-execution-isolation-primitives.md`：补充“启动期受控 provider
  bootstrap”与统一 allow-list/secret 分类决策；
- `docs/adr/006-phase2-batch3-claude-code-adapter.md`：保留 settings source 禁用，说明认证
  配置不再由 Claude settings source 加载；
- `docs/handoff/claude-execution-error-record.md`：更正“本机认证不可用”的临时结论，记录
  本次可复现根因、否决方案与修复前置条件；
- 修复后在 `docs/tests/phase4-acceptance.md` 记录真实门的固定 commit、Claude 路径/版本/hash、
  执行命令与结果。

## 6. 实施顺序

1. 先增加 provider bootstrap 模块及纯单元测试，固定解析、优先级和拒绝规则。
2. 提取/复用环境字段分类，确保导入的值必经现有 secret 收集与脱敏。
3. 接入 `prepareDaemon()`，完成 startup 回收和 probe 无凭据回归测试。
4. 更新 runner 注释与 argv golden，确认 `--setting-sources ""` 未被放宽。
5. 添加临时配置目录的确定性集成测试、日志/Journal 脱敏对抗测试。
6. 执行真实 Claude 的最小 Journal smoke；成功后执行 Batch 2 完整真实门。
7. 记录验收证据，复审后再核销 #49/#38 的剩余真实门条件。

完整测试不得与审查任务并发执行。

## 7. 验收标准

### 7.1 确定性验收

- 给定临时 user settings fixture，provider endpoint、认证 token 和模型映射能进入 Claude child env；
  child env 中没有任何不允许字段。
- 给定显式 `ANTHROPIC_*`/OAuth/proxy 环境变量，显式值稳定覆盖 user settings 值。
- 给定 project/local settings、hooks 或任意未知 user `env` 字段，Claude 子进程均不可见。
- settings 中出现 malformed JSON、错误 schema、错误值类型或不可读文件时，daemon 启动失败，且
  jail/control root 被回收；错误、日志与断言输出不含敏感值。
- 所有 bootstrap 获得的 provider/proxy secret 均被 `secretValues` 识别；对 raw、JSON escape、
  Base64、Base64URL、hex、percent、二次编码与分隔符拆分形式，报告、Journal、state、Task File
  同步和日志仍 fail-closed 或脱敏。
- Claude argv 继续包含 `--safe-mode` 与 `--setting-sources ""`，且不含 provider token、endpoint
  或 settings JSON 中的敏感值。
- Claude probe 的环境继续不含 provider credential、OAuth token 或 proxy credential。
- provider settings 缺失时，既有“仅依赖显式环境变量”的部署方式保持兼容。

### 7.2 真实验收

- 同一固定 Claude Code 二进制上，普通 `claude -p` 与 production runner 均能使用已配置的
  provider 路径；runner 不再出现 `Not logged in`。
- 单次真实 sandbox smoke 能运行 `loopzhb report --status nothing-new` 并生成唯一合法 Journal
  record，且没有 secret 写入 outbox、report 或日志。
- 使用批准的 Claude hash 执行：

```bash
LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved-sha256> pnpm test:phase4:batch2:e2e
```

  通过两次 Run 的 Task File → state → `prev-state.json` → Finish 全链路，断言 Completed、调度
  停止、Run Now 409、进程组关闭，以及日志无 provider/machine/run secret。
- 在真实门成功、验收记录与复审结论均已追加前，Issue #38 保持 OPEN；不得以 fake Claude
  确定性测试替代真实 Claude 门。

## 8. 临时运维绕过

在实现完成前，启动 daemon 的父进程可显式提供所需 `ANTHROPIC_*`、OAuth、proxy/TLS 环境变量。
现有 `buildAgentEnv()` 已会按白名单转发，并将敏感值纳入脱敏。不得把实际 token 写入仓库、命令
历史、文档示例或 `--settings` 参数。
