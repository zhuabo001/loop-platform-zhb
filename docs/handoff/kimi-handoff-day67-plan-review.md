# Kimi 评审：Day 6–7 开发计划（手动触发与 JSON 观察面）

> 评审对象：`docs/handoff/codex-handoff-day67-work-plan.md`
> 关联：`docs/roadmap.md` Phase 1、`docs/goal/day5-daemon-fake-runner.md`「配套缺口」、ADR-001/002/003。
>
> 总体结论：计划与 roadmap、三份 ADR 及代码现状高度吻合，核心设计决策（复用
> `enqueueExecRun`、不动 schema/claim/report 路径、无认证本地管理面）
> 全部成立，可以执行。原评审提出 2 个需要显式决策的协议纪律问题和 3 个小缺口；
> **2026-08-07 修订版计划已全部裁决落实**（管理 DTO 进 protocol、管理面维持
> tolerant reader、`ts` 排序语义与 malformed JSON 测试补齐、裁决记录入目标文档），
> 未引入新问题。各表「同意/不同意」列已回填为正式裁决。

## 已核实无误的前提（对照代码确认）

- `machineId` 形如 `m-<16位小写hex>`：`machineIdFromToken` = `m-` + sha256 前 16 位
  （`packages/protocol/src/node.ts:19-21`），计划的格式校验规则正确。
- 复用 `coordinator.enqueueExecRun()`、不扩展三方法接口：`EnqueueExecRunResult`
  形状（`packages/server/src/coordinator/index.ts:37-39`）与计划的 202/200/404
  映射一一对应；coordinator 头注释明确 "adapters (owner/manual trigger, machine
  poll, machine report...) each call exactly their own method"——manual trigger 调
  `enqueueExecRun` 正是预留的 seam，无需动接口。
- 重复触发继承 T7：ADR-001 T7 明确「Phase 1 为手动 trigger」；`enqueueExecRunTx`
  （`packages/server/src/store/runs.ts:69`）已实现单事务 supersede+insert、
  running 零写入跳过、guard 失败整体回滚。
- 「不修改 protocol、数据库 schema 或 migration」可行：`loops` 表的
  `agent`/`allowControl`/`enabled` 均有默认值（`packages/server/src/db/schema.ts:125-130`），
  创建只需写 `machineId/name/workdir/taskFile` 并用注入 Clock 打 `createdAt/updatedAt`
  （时间戳无 DB 默认值，写入方打戳——计划已正确要求注入 Clock）。
- 更新非 loopback 警告是必要的：`unauthenticatedExposureWarning`
  （`packages/server/src/config.ts:50-57`）目前只提 `/api/machine/*`，新增的无认证
  管理端点必须纳入同一警告。
- E2E 断言 `"fake runner completed"` 与 `FAKE_RUNNER_MESSAGE`
  （`packages/daemon/src/runner.ts:23`）一字不差。
- `createServerApp` 是纯组装 seam（`packages/server/src/http/app.ts:51`），改为同时
  注入管理模块符合其设计；boot（`packages/server/src/start.ts:37-47`）是唯一接线点。
- lease mint policy 无冲突：Loop 列 `allowControl=true` 是 owner 配置默认值；ADR-003
  的 Phase 1 mint policy（全部 caps 写 false）作用于 lease 行，两者层次不同。

## 需要显式决策（阻塞项）

| 补充内容 | 同意/不同意 | 不同意的理由 |
|---|---|---|
| **管理 API 的 wire DTO 归属——protocol 还是 server 本地？** 计划写「不修改 protocol」，意味着 `POST /api/loops` 的 body schema、`LoopSummary`/`RunSummary` 等 wire 契约将活在 server 包内。但 ADR-002 的立意是 wire 契约单一来源，决策 5 明确 protocol 也服务未来的 client（"server 的 TanStack client 会引用枚举/类型"）；roadmap Phase 1 完成标准恰好要求「CLI 或 JSON 只读观察面」，Phase 4 Dashboard 也会消费这些形状——server-local 是潜在的第二个漂移源。建议二选一并写进目标文档：(a) 管理 DTO 进 protocol（对齐 ADR-002 精神，代价是动 protocol 包）；(b) 显式声明「管理面 wire 暂为 server 内部契约，待 Dashboard 批次再回迁 protocol」，作为有意推迟记录。 | 同意 | 采纳 (a)：管理请求/响应 DTO 与 zod schema 统一放入 `@loopzhb/protocol`（修订版计划 §Public APIs 开篇与 Day 6 实施项），server 只做安全 view mapping，不得 server-local 重定义；新 schema 纳入 protocol 现有 tolerant-reader 穷尽测试。 |
| **「拒绝未知字段」是 strict reader，偏离 ADR-002 制度化的 tolerant reader。** ADR-002 决策 1：「所有 schema…剥离未知键，永不 strict」。计划要求 `POST /api/loops` 拒绝未知字段。对人工驱动的写 API，strict 能早期暴露笔误，本身可辩护；但这是对 tolerant-reader 纪律的首次有意偏离，计划只字未提，实施者会不确定该跟哪条规则。建议在目标文档写明偏离及理由（如「管理写路径 fail-fast 优于静默剥离；machine wire 的 tolerant reader 不变」）。 | 同意，但反向裁决 | 撤销偏离：管理面同样遵守 tolerant reader——剥离未知键、禁用 strict object（修订版计划 §Public APIs 开篇）。同时显式声明 `workflow/model/agent/state/enabled` 等已声明但未开放的字段「即使提交也不产生业务效果」，即 ADR-002 决策 6「镜像形状 ≠ 已支持语义」在管理面的应用；这比 strict 更符合仓库纪律。 |

## 小缺口（不阻塞，建议补写）

| 补充内容 | 同意/不同意 | 不同意的理由 |
|---|---|---|
| **`GET /api/loops/:id/runs` 排序键语义**：`runs.ts` 是「最近一次转换时刻」而非创建时间（ADR-003 决策 6；`packages/server/src/db/schema.ts:149-151` 有醒目注释）。`ts DESC` 意味着 run 列表会随状态迁移重排——对观察面可接受（runs 表没有 createdAt 列，ts 也是唯一选择），但测试应钉住该行为，避免日后误当 createdAt 改回。 | 同意 | 修订版计划在 API 契约中明确定义 `ts` 为「最近状态转换时间」、run 会随 claim/finalize/reclaim/supersede 重排；测试钉住「转换后按新 ts 重排、同 ts 按 id DESC 决胜」。 |
| **测试计划漏 malformed JSON → 400**：创建校验列了畸形 machineId/NUL/超长/未知字段/超大 body，未列「非法 JSON body」。现有 machine 路由对 parse 失败统一 400（`packages/server/src/http/app.ts:42-49`），新路由应继承并钉测试。另建议明确 `POST /api/loops/:id/run` 对「带 body 的请求」是照常受理还是拒绝，免得实现时纠结。 | 同意 | 修订版计划补齐：创建与触发均对 malformed/非 object JSON 返回 400 且零写入；trigger body 语义定为「空 body 与 `{}` 均合法（空归一化为 `{}`）、未知字段剥离」；测试覆盖全部上述分支。 |
| **目标文档惯例**：Day 5 的 goal 文档以「目标review反馈」表（补充内容/同意/不同意/理由）闭环评审。计划 Day 6 第一项是「新增目标文档」，建议将本评审的裁决结果以该表格形式落入 `docs/goal/day6-7-*.md`。 | 同意 | 修订版计划 Day 6 第一项明确：目标文档记录本轮评审对 DTO 归属、tolerant reader、`ts` 排序和请求体语义的裁决。 |

## 确认无问题项（评审中排除的疑点）

- **无认证边界**：符合 roadmap「Phase 5 auth 之前仅 localhost/受信网络，不得公开暴露」
  的部署边界声明；计划同步更新启动警告，覆盖到位。
- **`running_exists` 返回 200 而非 409**：零写入 no-op，语义自洽。
- **create 不承诺幂等**：计划已如实声明「重试不会执行 Run」，Phase 1 可接受。
- **`enabled` 不限制手动触发**：Phase 1 无关闭入口，该假设为空集，留 Phase 4 正确。
- **Loop ID 用 `loop-${randomUUID()}`**：新 ID 前缀惯例（run 为裸 UUID、machine 为
  `m-<hash>`），无害，建议在目标文档顺手记一笔。
- **创建不校验 workdir 绝对性/存在性**：路径语义在机器侧，Phase 1 daemon（Fake
  Runner）不触碰文件系统，jail 属 Phase 2；NUL/长度上限已够。
- **supersede 只作用于 exec pending**：与 T7 范围一致，非 exec role 属 Phase 3。
