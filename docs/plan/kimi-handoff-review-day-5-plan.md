# Kimi 评审：Day 5 开发计划（daemon + Fake Runner）

> 评审对象：`docs/handoff/codex-handoff-day5-plan.md`
> 关联：`docs/goal/day5-daemon-fake-runner.md`（含"目标review反馈"裁决）、ADR-001/002/003。
>
> 总体结论：计划与代码现状高度吻合，大部分细节可直接执行。存在 1 个落地风险、
> 1 处与目标文档的措辞偏差、2 处需要补写的细节，另附 2 条可选说明。

## 已核实无误的前提（对照代码确认）

- `bootstrapServer()`（`packages/server/src/start.ts:37`）、`coordinator.enqueueExecRun`
  （`start.test.ts:106` 已有同款用法）、`apiErrorSchema`（`packages/protocol/src/errors.ts`）、
  PGlite 内存库（`packages/server/src/db/index.ts`）、Node ≥22 原生 fetch
  （根 `package.json` engines）——全部存在，计划的集成路径可行。
- 集成断言与 server 语义一致：report 成功后 `message` 取 body.message、`progress` 置 null、
  lease 同事务删除（`packages/server/src/store/report.ts:83-89,96`），"RunLease 不存在"、
  "progress 清空"均成立。
- 退避重试、"响应丢失后 coded 401 终态确认"、不建 ADR、不开放 server 内部 exports——
  与目标文档及 review 裁决完全对齐。

## 需要澄清/补写（阻塞项）

| 补充内容 | 同意/不同意 | 不同意的理由 |
|---|---|---|
| **E2E 构建顺序（落地风险，必须先定）**：计划 §4 要求 server 测试使用"构建后的 daemon 公共入口"，但 server 现有 test 脚本是 `pnpm --filter @loopzhb/protocol build && vitest run`，没有任何环节保证 daemon 的 `dist/` 先于 server 测试构建（`pnpm -r test` 的拓扑序只定执行顺序，不替 daemon 跑 build）。二选一写明：(a) server 的 test/typecheck 脚本改为 `pnpm --filter @loopzhb/daemon build && vitest run`（沿用 protocol 先例）；(b) E2E 直接引 daemon 源码（vitest alias / tsconfig paths），不依赖构建产物。同时定 daemon 的 `exports` 形状（`types` + `import` 指向 dist，照抄 server 模式）。 | 同意 | 采用 (a)：server 增加 daemon 的 devDependency；server 的 `typecheck` 与 `test` 都先 build daemon，再运行自身检查。daemon exports 用 `types` + `import` 指向 `dist`。否则干净工作区的 server E2E 无法解析 daemon 入口。 |
| **malformed 2xx 的措辞偏差（需裁决，两份文档只能留一种说法）**：目标文档测试清单第 3 条写"malformed poll/report 成功响应……保留可重试路径"，计划 §2 把 malformed 2xx 一律定为协议错误 fail-fast。对 poll 没问题；但对 **report 的 malformed 2xx**，server 很可能已消费 lease，按原 credential/body 重试会收到 coded 401 终态确认，可自愈且不违反 at-most-once；直接停 daemon 会把 run 丢给尚不存在的 sweep。建议：report 的 malformed 2xx 归入瞬态重试，poll 的 malformed 2xx 维持 fail-fast；或反过来明确改写目标文档第 3 条。 | 部分同意 | report 的 malformed 2xx 进入重试：服务端可能已消费 lease，重报可得到 coded 401 终态确认。poll 的 malformed 2xx 保持 fail-fast，但理由不是“无副作用”：poll 可能已经完成 claim，daemon 又无法从损坏响应恢复 Delivery，重试不能安全重派。同步修改两份计划的措辞。 |
| **Runner 抛错时合成失败报告的字段补全**：计划只说"生成 `ok:false` 的失败报告"。已核实 server 映射：`ok:false → error/error`，error 取 `body.error` 否则用通用兜底（`store/report.ts:83-85`）。应补写：daemon 合成 `{ ok: false, error: <异常摘要> }`（截断、不含 credential），**不带 outcome**——Phase 1 的 outcome 由 server 从 `ok` 推导，daemon 声称的 outcome 不落库（`report.ts:68` 注释 "daemon-claimed outcome … never write"）。同理，Fake Runner 发 `outcome: "exec"` 无害，但集成断言不应假设 server 持久化的是 daemon 声称的 outcome。 | 同意 | 固定合成 `{ ok: false, error: sanitizedSummary }`，不带 `outcome`；清除 NUL、截断至 2000 字符，并避免 credential 进入 error/log。Fake Runner 的 `outcome: "exec"` 仅为 wire 兼容；E2E 的 `done/exec` 断言来自 server 的 Phase 1 写入规则。 |
| **版本常量产生机制（小事，定一个即可）**："与 daemon package version 一致的版本常量" + "测试钉住不漂移"——是 `resolveJsonModule` 直接 import package.json，还是 build 期生成常量文件？前者简单但会把 package.json 带入 dist 依赖。不明确则"不漂移"的测试无从写起。 | 同意 | 使用提交的 `src/version.ts` 常量；测试读取 package.json 后断言其等于该常量。避免 runtime package.json import 与 build-time 生成，同时阻止版本漂移。 |

## 可选说明（不阻塞）

| 补充内容 | 同意/不同意 | 不同意的理由 |
|---|---|---|
| `pendingReports` 无上限：server 长时间不可用时集合无界增长。Day 5 每条仅 credential+body、量小且不持久化，可接受；建议在计划 §3 加一句显式承认。 | 同意 | Day 5 显式承认其在 server 长期不可用时可能增长；不得通过丢弃已 claim 的报告限流。容量与背压留待真实 Agent 阶段设计。 |
| `pollOnce` 顺序路径内的首次 report 带 10s timeout，多条 Delivery 时串行拖慢；与"Fake Runner 顺序执行"一致，无需改，知会即可。 | 同意 | Fake Runner 顺序执行是 Day 5 有意范围；首次 report 的串行 timeout 可接受，后续重试已后台化且不阻塞 poll。真实 Agent 的吞吐与并发留给 Phase 2。 |
