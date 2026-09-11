# Phase 4 Batch 3 切片三开发计划：禁止 Dashboard 替换已有 pending

> 上游范围见 `docs/plan/codex-phase4-batch3-plan.md` §3 切片三；本文件是该切片的可执行细化，保留 Q1–Q6 测试锚点。

## 1. Context

切片一交付只读页面，切片二交付两个 HTML 路由与安全装配。切片二有意留下的**临时态**：Dashboard 的 Run Now 走既有 T7 supersede 语义，会取消已存在的 pending exec Run。该临时行为被三处显式标记——`dashboard/routes.test.ts` 的 H4 尾与 H6 尾各有一组断言钉住它，`start.ts:122`、`dashboard/routes.ts:126-128`、`dashboard/view.ts:126-128` 三处注释写着「切片三改这里」。切片三把这条语义翻转成 no-supersede，并让**按钮规则与后端规则同时落地**（批次计划 §3：「按钮规则与后端规则一致」）。

目标产出：Dashboard 触发在 Loop 空闲时创建恰好一条 pending；在**任意 role** 已有 pending/running、或 Loop 已 Completed 时**零写跳过**（不建、不取消、不改 Run，不推进 watermark，**不改 `loops.revision`**）；管理 API、cron、catch-up 的 T7 行为一字不变。

## 2. 已确认边界（本次澄清结论）

1. **禁用按钮的呈现**：保留表单与 CSRF 隐藏字段，`<button>` 加 `disabled`，按钮下方用一行文字说明原因。布局稳定、原因不只靠颜色表达、断言好写。
2. **相邻发现（JSON API 无 Origin/Referer 校验、触发/取消路由接受空体）只记录、不在本切片改代码**：记入下方风险节，切片收尾开 phase-5 加固 Issue 并在 roadmap 加指针。理由：Loop/Run id 是随机 UUID 不可猜，切片二的全局 Host 门禁已封掉能读取 id 的 DNS rebinding 路径，当前不构成可利用漏洞。
3. **本切片不改 `docs/` 的 ADR / roadmap / acceptance**：属切片五收口。

## 3. 交付物

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/server/src/coordinator/index.ts` | 修改 | `PendingPolicy` 类型；`ExecTrigger` 的 manual 分支增可选 `pendingPolicy`；`enqueueExecRun` 文档更新 |
| `packages/server/src/store/runs.ts` | 修改 | 探针统一为 `hasRunInPhase`；manual 分支加 pending 探针（排在 revision CAS **之前**）；`"skip"` 下整块跳过 supersede；结果 union 增 `pending_exists` |
| `packages/server/src/start.ts` | 修改 | Dashboard 缝改为 `{ kind: "manual", pendingPolicy: "skip" }`（唯一生产改动点） |
| `packages/server/src/dashboard/view.ts` | 修改 | `runNowDisabledReason()` 纯函数；`LoopCard` 增 `runDisabled` / `runDisabledReason` |
| `packages/server/src/dashboard/page.ts` | 修改 | `disabled` 属性 + `.run-note` 原因文字；CSS 增两条规则 |
| `packages/server/src/coordinator/enqueue.test.ts` | 修改 | Q1/Q2/Q3/Q4 单元级用例（零写、任意 role、重试后重探） |
| `packages/server/src/phase4-nosupersede.test.ts` | 新增 | Q5/Q6 跨模块竞态（claim / finish / cron 双向 / 水位回归） |
| `packages/server/src/dashboard/routes.test.ts` | 修改 | 翻转 H4 尾、H6 尾、`pending_exists` 假体；default seam 同步 skip |
| `packages/server/src/dashboard/mount.test.ts` | 修改 | **生产装配钉**：两次 POST 只留一条 pending（start.ts 忘传 policy 时必红） |
| `packages/server/src/dashboard/page.test.ts` | 修改 | 翻转「no disabled」；新增可用/禁用矩阵与优先级 |

## 4. 设计

### 4.1 `ExecTrigger` 增可选 `pendingPolicy`

```ts
/** Dashboard 的 pending 策略（批次计划 §3）。刻意不进公共 HTTP DTO。 */
export type PendingPolicy = "skip" | "supersede";

export type ExecTrigger =
  | { kind: "manual"; pendingPolicy?: PendingPolicy }   // 省略 = "supersede"
  | { kind: "scheduled"; scheduledFor: string; scheduleRevision: number };
```

- **可选**：`{ kind: "manual" }`（`scheduler/catchup.test.ts:254,283,307,308`）与 `enqueueExecRun(loopId)`（`http/app.ts:274` 及既有全部测试）保持默认 `"supersede"`，零迁移。
- **只加在 manual 分支**：scheduled 永远 T7——ADR-007 §4 与 ADR-008 已把 cron/catch-up 语义冻结（「较晚写入者 supersede 较早的 pending，包括 manual pending」）。
- `triggerRunRequestSchema`（`protocol/src/admin.ts:150`）与 `triggerRunResponseSchema` **一字不改**；`http/app.ts:274` 仍不传 trigger。

### 4.2 `store/runs.ts`：探针与事务顺序

**探针统一**：`hasRunningExecRun` 之名谎报（`runs.ts:106-113` 没有 role 过滤），改为共用一个实现，running/pending 两处调用：

```ts
async function hasRunInPhase(tx: Db, loopId: string, phase: "pending" | "running"): Promise<boolean>
```

**manual 分支顺序**（顺序即安全属性：跳过必须零写，故 pending 探针必须排在 revision CAS **之前**）：

```ts
} else {
  const policy = trigger?.kind === "manual" ? (trigger.pendingPolicy ?? "supersede") : "supersede";
  if (await hasRunInPhase(tx, loop.id, "running")) {
    return { enqueued: false as const, reason: "running_exists" as const };
  }
  // 任意 role（批次计划 §3）：探针不带 role 过滤，与下面只扫 exec 的 supersede
  // 扫描刻意不对称——Dashboard 宁可被非 exec 的 pending 挡住，也不替换任何 Run。
  if (policy === "skip" && (await hasRunInPhase(tx, loop.id, "pending"))) {
    return { enqueued: false as const, reason: "pending_exists" as const };
  }
  const guarded = await tx.update(loops)
    .set({ revision: sql`${loops.revision} + 1` })
    .where(and(eq(loops.id, loop.id), eq(loops.revision, currentLoop.revision)))
    .returning({ id: loops.id });
  if (guarded.length !== 1) throw new EnqueueLoopGuardLostError(loop.id);
}
```

**supersede 块在 `"skip"` 下整块不执行**（而非「扫到空」）：让「Dashboard 的成功路径不可能取消任何 Run」成为**结构事实**，不依赖探针与扫描之间的巧合。`supersededRunIds` 因此结构上为空。

**重试与 CAS**：`withGuardRetry`（`store/guard-retry.ts:14-30`）整块重跑 → 重新 `getLoop` → 重新探针，满足「CAS 冲突后重新解析并重新检查活跃状态，不复用旧查询结果」。ADR-009 修订 §1 的 revision bump 只在真正插入时发生。

**结果 union** 增 `"pending_exists"`，仅内部可达：公共路由不传 policy，`http/app.ts:285` 的兜底也会把它折叠成 `running_exists`（补一句注释说明该兜底如今是承重的）。

### 4.3 装配：唯一生产改动点

```ts
// start.ts:123
enqueue: (loopId) => coordinator.enqueueExecRun(loopId, { kind: "manual", pendingPolicy: "skip" }),
```

`DashboardRouteDeps.enqueue` 的**一参签名不变**，`routes.ts` 与两个 handler 零改动（切片二已按此预留）。代价：忘传不会编译失败、行为静默退回 supersede——由 `mount.test.ts` 的生产链路用例守住（见 §6）。

### 4.4 按钮规则：视图数据 + 哑模板

`view.ts` 新增纯函数与两个字段，规则**只写一遍**：

```ts
/**
 * Run Now 的禁用原因，null 表示可用。与 store/runs.ts 的 manual 分支**同序**：
 * completed（事务前拒绝，409 loop_completed）> running（running_exists）
 * > pending（pending_exists）。Paused 未完成且无活跃 Run 时可用——manual
 * trigger 有意绕过 enabled 检查。`loops_completion_ck` CHECK 保证完成三元组
 * 原子，故 `lifecycle === "completed"` 与后端的 `completedAt !== null`
 * 对任何可入库的行等价。capability 缺失（升级提示）不改变本规则。
 */
export function runNowDisabledReason(input: {
  lifecycle: LoopLifecycle;
  pendingCount: number;
  runningCount: number;
}): string | null
```

文案：Completed →「Loop 已完成（Completed），Run Now 会被拒绝。」；Running →「已有 Running Run，避免重复触发。」；Pending →「已有 Pending Run，等待执行。」

`LoopCard` 增 `runDisabled: boolean` 与 `runDisabledReason: string | null`（null ⟺ 可用），在 `toLoopCard` 内由 `entry.lifecycle` / `entry.pending.length` / `entry.running.length` 算出。

`page.ts` 的 `runForm`：

```ts
<button type="submit"${item.runDisabled ? html` disabled` : ""}>Run Now</button>
</form>
${item.runDisabledReason === null ? "" : html`<p class="run-note">${item.runDisabledReason}</p>`}
```

- 可用卡片的字节输出与今天**完全一致**（`<button type="submit">Run Now</button>`），故既有精确匹配断言只需改「无 disabled」那一条。
- 表单内仍恰好一个具名控件（`<p>` 不带 name），「额外字段 → 400」的既有约束不受影响。
- CSS 增 `.run-form button:disabled { cursor: not-allowed; opacity: .6; }` 与 `.run-note { margin: 6px 0 0; color: var(--muted); }`；CSS 仍是纯 ASCII 且不含 `& < > " '`，CSP 哈希由常量派生，H3 自动跟随。

## 5. 复用清单（禁止重写）

| 复用对象 | 来源 |
|---|---|
| `withGuardRetry` 有界重试 | `store/guard-retry.ts` |
| `afterEnqueueLoopResolve` / `beforeEnqueueTx` 测试交错缝 | `store/runs.ts:143` / `coordinator/index.ts:150` |
| `snapshotRuns` / `snapshotLoops` / `seedRun` / `seedLoop` / `testDeps` / `FakeClock` | `testkit/index.ts` |
| G6/G9 的 finish-vs-manual 竞态模板 | `phase4-completed-guards.test.ts:217-259` |
| claim-vs-enqueue 的 app 级门模板 | `coordinator/enqueue.test.ts:136-162` |
| `classifyDisplayLifecycle` | `dashboard/view.ts:74-86` |
| H1–H7 既有用例与其辅助函数 | `dashboard/routes.test.ts` / `mount.test.ts` |

## 6. 测试

**翻转清单（先看它们变红，再改实现）**：

| 位置 | 今天断言 | 切片三改为 |
|---|---|---|
| `routes.test.ts:313-317`（H4 尾） | 第二次 POST 改变 DB | 第二次 POST **零写**且仍 303 |
| `routes.test.ts:358-368`（H6 尾） | 旧 pending 被 canceled/skipped、新增 run-2 | 两条 pending 原样保留、**无 run-2** |
| `routes.test.ts:348-356` | 用 `pending_exists` 当「未知 reason」假体 | 换成真正未知的字面量，保留「未知 reason 仍是业务结果」这条性质 |
| `routes.test.ts:84-89` | default seam 传 `enqueueExecRun(loopId)` | 传 `{ kind: "manual", pendingPolicy: "skip" }`（测试侧对齐生产） |
| `page.test.ts:238-260` | `expect(page).not.toContain("disabled")`，两卡皆可用 | 拆成「可用卡片无 disabled」「禁用卡片有 disabled + 原因文字」 |

**新增用例**：

| ID | 文件 | 场景 |
|---|---|---|
| Q1 | `coordinator/enqueue.test.ts` | skip 策略下 idle 创建、paused（`enabled=false`、无 cron）创建；成功后 `supersededRunIds` 为空、恰好一条 pending |
| Q2 | `coordinator/enqueue.test.ts` | 零写跳过矩阵：pending(exec) → `pending_exists`；pending(**evolve**) → `pending_exists`（任意 role）；running(任意 role) → `running_exists`；completed → `loop_completed`。每条都断言 `snapshotRuns` **与 `snapshotLoops`（含 `revision`）逐字节不变** |
| Q3 | `coordinator/enqueue.test.ts` | 连续两次 skip 触发：第二条 `pending_exists` 且零写 |
| Q4 | `coordinator/enqueue.test.ts` | 竞争 enqueue 在写事务前提交 → 事务内探针**首轮**即命中 → `pending_exists` 零写、竞争者的 pending 原样保留（`hookCalls === 1`）；它证明探针是权威，不靠 supersede |
| Q4 | `coordinator/enqueue.test.ts` | 竞争者是**只改 Loop 的**写（schedule PATCH，bump revision 不留 Run）→ CAS 丢失 → 有界重试重解析重探 → 正常插入（`hookCalls === 2`），证明「不复用旧查询结果」 |
| Q5 | `phase4-nosupersede.test.ts` | 竞争者一律走**真实生产路径**，在 `afterEnqueueLoopResolve` 窗口内提交，且提交瞬间记录 Run/Loop/Lease **三表快照**，收尾断言被测调用在其上零写：① claim 用真实 `poll`（翻 running + bump revision + 铸 Lease）→ `running_exists`；② Finish 用真实 `report`（finalize + 删 Lease）→ 有界重试重解析 → `loop_completed`（`hookCalls === 2`）；③ 两个 Dashboard 交错 → 败者 `pending_exists`，无任何 canceled 行 |
| Q5 | `phase4-nosupersede.test.ts` | cron 双向，**均在 resolve/write 窗口内交错**：① 真实 `scheduler.start()` 恢复通道先提交 → Dashboard `pending_exists` 零写、水位归 catch-up；② Dashboard 在 scheduled 写入窗口内提交 → 水位 CAS 丢失 → 有界重试重解析后 **仍按 T7 替换它**（`hookCalls === 2`；ADR-007 §4 冻结语义）。前一方向比较竞争者提交后的三表零写快照；后一成功方向从 Dashboard 提交后的三表快照推导并比较唯一允许差量：取消旧 pending、插入一个 scheduled pending、仅推进目标 Loop 的 revision/watermark，Lease 不变。 |
| Q6 | 既有用例回归 | 管理 API 仍 supersede（`http/app.test.ts:460-472`）；调度水位不变（`scheduler` R 组）——不重复实现，只加交叉断言 |
| — | `dashboard/routes.test.ts` | 追加：真实 skip seam 下第二次 POST 零写 + 303 |
| — | `dashboard/mount.test.ts` | **生产装配钉**：loopback 启动 → seed loop → 读页面 token → POST → 再 POST → 303 且仍只有一条 pending（不取消、不新增） |
| — | `page.test.ts` | 可用/禁用矩阵：open、paused、completed、pending、running、completed+running（优先级 completed > running > pending）；禁用卡片仍恰好一个具名控件 |
| — | 一致性 | 同一状态集上跑页面规则与后端规则，断言同结论（按钮禁用 ⟺ 后端拒绝或 skip） |

**注释陈旧清单**（切片三交付后不得再描述「未来」）：`start.ts:122`、`routes.ts:126-128`、`view.ts:126-128`、`page.test.ts:257-258`、`routes.test.ts:348-360`。

## 7. 验证

```bash
pnpm --filter @loopzhb/server test src/dashboard src/coordinator src/scheduler src/http/app.test.ts src/phase4-nosupersede.test.ts
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

手工确认（可选，走生产装配而非 `app.request`）：`LOOPZHB_DATA_DIR=$(mktemp -d) pnpm --filter @loopzhb/server start` → 建 Loop → 页面取 token → POST 两次，确认第二次不取消也不新增；`LOOPZHB_HOST=0.0.0.0` 时页面本就不存在。

## 8. 风险与留意处

1. **装配缝无声失败（最高风险）**：policy 写在 `start.ts`，忘传不会编译报错，行为静默退回 supersede。缓解：`mount.test.ts` 的生产链路用例必红；`routes.test.ts` 的 default seam 同步 skip，避免 H 组在错误策略下全绿。
2. **翻转清单是硬约束**：H4 尾与 H6 尾今天钉的正是临时语义，必须同步翻转；漏翻会红，翻错方向（把 skip 写成 supersede）会静默放过。
3. **任意 role 的不对称**：pending 探针不带 role 过滤，supersede 扫描只扫 exec。将来若真出现 evolve/edit 的 pending，Dashboard 会被完全挡住（保守，符合批次计划 §3）；管理 API 不受影响。
4. **公共契约不变**：`triggerRunRequestSchema` / `triggerRunResponseSchema` 不改；`pending_exists` 仅内部可达（`http/app.ts:285` 兜底折叠为 `running_exists`）。切片四/五不得把它加进 DTO。
5. **相邻观察（本次澄清，切片三不改代码）**：JSON API 无 Origin/Referer 校验，触发/取消路由接受空体；因 id 为随机 UUID 且全局 Host 门禁封住 rebinding 读取路径，当前不构成可利用漏洞。切片收尾开 phase-5 加固 Issue 并在 roadmap 加一行指针。
6. **3 秒 meta refresh 与陈旧按钮**：页面最多陈旧 3 秒，用户可能在按钮刚该禁用时点下去；后端 skip 是权威，结果仍是「不替换已有 pending」。这是设计而非缺陷，测试应覆盖「页面说可点、后端仍 skip」的组合。
