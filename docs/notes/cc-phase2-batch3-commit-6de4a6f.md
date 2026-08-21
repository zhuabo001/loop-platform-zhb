# Commit `6de4a6f` 修改动机分析：smoke 证据链为何放弃 `$?` 变量捕获

> 记录日期：2026-08-21。分析对象：`6de4a6f`（`test(daemon): smoke evidence chain drops shell-variable capture — dontAsk denies it pre-execution`，分支 `feat/phase2-batch3`，第四轮签字 `1ec7506` 之后的 post-sign-off 修复）。
> 关联：[Issue #15](https://github.com/zhuabo001/loop-platform-zhb/issues/15)（已核销关闭）、`docs/adr/006-phase2-batch3-claude-code-adapter.md`、`docs/handoff/codex-handoff-phase2-batch3-code-review.md` 第三/四轮及聚焦复审记录。

## 一句话总结

**让证据链在被测真实环境的权限层下存活。** 第三轮复审的字面要求（completion marker 记录数值 exit status）引导实现走向 `rc=$?` 变量捕获，而这正是真实 CLI 在 `--permission-mode dontAsk` 下预执行整体拒绝的形态——一个为了消灭假阳性而重设计的测试，自己在实跑层面就是假阳性。

## 背景：这个 smoke 测试是干嘛的

`packages/daemon/src/claude-smoke.test.ts` 是 opt-in（`LOOPZHB_CLAUDE_SMOKE=1`）的端到端测试：用**真实 Claude CLI** 在 OS sandbox（`WorkdirJail`，`allowedRoots`）里执行任务，证明越界文件访问（根内软链指向根外 sentinel）真的被内核层拒绝。这是 ADR-006「TOCTOU 残余窗口由 sandbox 兜底」声明的唯一运行时实证。

前三轮复审反复攻击它的假阳性：测试可能「通过」但没证明 sandbox 做过任何事——例如模型直接拒绝执行命令、或两份证据来自不同的工具调用。

## 第三轮的重设计与埋雷

第三轮 Spec 轨 P2 要求把证据**结构性绑定在一条命令里**，当时的实现是：

```sh
printf attempted > marker; cat link > copy; rc=$?; printf '%s' "$rc" > completion
```

- attempt marker 证明命令真实启动；
- completion 文件里写入访问命令的**数值退出状态**，证明该命令真正执行并返回（非零 = 被 sandbox 拒绝）；
- 测试侧双 parser 断言**唯一且精确**的 Bash 输入（`expect(rawToolLabels).toEqual([`Bash: ${command}`])`）。

字面上完全满足第三轮要求，静态审查在第三、四轮都通过了。

## 为什么一直没发现

smoke 是 opt-in 的——它会用开发者凭据发起真实外部 API 请求。第三、四轮复审都明确**没有实跑**（第四轮验证证据：「避免未经授权的外部认证请求」）。所以这个 `$?` 形态从第三轮重设计后**一次都没有真正执行过**，只经过了静态审查。

## 爆雷时刻与机制

Issue 关闭前复验第一次实跑（第四轮固定点 `1ec7506` 上），问题当场暴露。机制在 `packages/daemon/src/claude-runner.ts:109-110`——生产 runner 给 CLI 传了：

```
--permission-mode dontAsk
```

dontAsk 模式下，CLI 的权限层必须**静态**判定每条 Bash 命令，不能弹窗询问。而 `rc=$?` 与 `"$rc"` 这类变量赋值/展开使命令的实际效果不可静态分析（无法确定会执行什么、写哪个路径），于是权限层**预执行整体拒绝**（取证为 `permission_denials`）——整条 Bash 调用根本不会执行：

- attempt marker 不会被写出 → 测试的第一条断言（marker 内容为 `attempted`）失败；
- 换言之，该重设计形态**从未真正到达 sandbox**，「用唯一命令串联 attempt→访问→exit status→completion」的证据链在真实环境中是空转的。

## 讽刺之处

第三轮要求「completion marker **包含 exit status**」本身就引导实现走向 `$?` 捕获，而这正是真实 CLI 拒绝执行的形态。一个为消灭假阳性而重设计的测试，自己在实跑层面就是假阳性——它的命令从未跑过，因此从未证明过关于 sandbox 的任何事。三轮静态审查都没看出来，因为没人真的执行它。

## 修复的取舍

`6de4a6f` 把数值捕获换成控制流分支：

```sh
printf attempted > marker && cat link > copy && echo read-ok > completion || echo read-denied > completion
```

- `&&`/`||` **仍然是按退出状态分支**，证据语义等强：`read-denied` 只可能由访问命令真实执行且返回非零（`||` 分支）写出；断言钉死精确字面词（`expect(...).toBe("read-denied")`），比原来「任意非零整数」还严格；
- 无变量赋值/展开，CLI 静态分析放行，命令真正到达 sandbox——实测复验 3/3（约 131s，macOS + Claude Code 2.1.227）；修复过程还顺带实证了内核确实拒绝越界读（`Operation not permitted`）；
- 文件头新增守护性注释：命令必须保持**无变量形态**，否则会「静默退化回它们本要排除的空洞形式」；
- ADR-006 附当日修订条目，记录发现过程、新形态与实测证据。

场景 3（越界写）同步改造：`write-denied` 只由 append 失败的 `||` 分支写出，另加 sentinel 内容不变的断言。

## 为什么这不构成对第三轮复审的违反

它违背的只是第三轮建议的**字面措辞**（「包含 exit status 的 completion marker」），保住并强化了要求的**实质**——证据与单次真实执行的结构性绑定：

| 第三轮要求 | `6de4a6f` 后的状态 |
| --- | --- |
| 唯一、完整、精确的工具调用断言 | 保持——`rawToolLabels` 全等断言未变 |
| completion 在越界命令返回后写入、结构性绑定 | 保持并强化——`read-denied` 只能由访问命令真实执行且失败时写出，断言钉死精确内容 |
| 跨 progress 事件凭据重组 / probe 身份切换（两个 P1） | 未触及——相关代码路径零改动 |
| S6 readiness chunk 累积（P3） | 未触及 |

且原 `$?` 形态被 dontAsk 预执行拒绝、从未执行 sandbox，恰属第三轮攻击的假阳性类别——本次修改**消除**了一个假阳性，而非引入。

## 经验沉淀

1. **opt-in 测试的静态审查有天花板**：三轮审查都没发现命令从未真正执行，只有实跑暴露。对「证明某事真实发生」的测试，签字前至少需要一次真实执行。
2. **审查建议的字面满足可能不可执行**：当建议（记录数值 exit status）与被测环境约束（dontAsk 静态判定）冲突时，应回到建议的意图（证据绑定）寻找等价可执行形式。
3. **测试命令形态是被测系统的隐式契约**：dontAsk 权限层对变量赋值/展开的预执行拒绝，应作为 smoke 命令设计的永久约束写入文件头注释，防止未来维护者无意识回退。
