# ADR-002：protocol 包——wire 契约的单一来源与演进规则

- 状态：Accepted
- 日期：2026-07-23
- 关联：docs/roadmap.md Phase 1 Day 1；ADR-001

## 背景

server 与 daemon 是两个独立部署的进程，唯一耦合点是 HTTP wire 协议。参考实现
（loop-platform）没有 protocol 包：DTO 在 server（`gateway/delivery.ts`）和 daemon
（`runner.ts`）各写一份，靠纪律保持同步——且已经出现过漂移（daemon 的 `create.ts`
重新实现了 `machineIdFromToken`）。本仓库从第一天把 wire 契约收进
`packages/protocol`（`@loopzhb/protocol`），类型与运行时校验同源（zod schema 推导 TS 类型）。

## 决策

1. **tolerant reader（宽容读者）**：所有 schema 用 `z.object` 默认行为——剥离未知键，
   永不 strict。新版对端多发的字段不破坏老读者；这与参考实现"server coerce 一切、
   老 daemon 持续可用"的生产哲学一致，并把它制度化。
2. **演进只增不减**：字段只加可选项、不改名不删；枚举只追加不重排不删。
   因此 **没有版本协商**，`PROTOCOL_VERSION = 1` 仅是锚点常量，不做握手逻辑。
   （参考实现亦无任何协商，全靠增量字段 + 双端宽容。）
3. **逐字镜像参考实现的 wire 形状**（字段名 + 可选性），只裁掉后续阶段子系统
   （watch/sync、CLI 动词、claim/connect-key）。镜像来源逐字段可查：
   - poll 请求体：`packages/daemon/src/daemon.ts` `buildPollBody` +
     `packages/server/src/routes/api.machine.poll.ts:17-27`——**扁平** body，
     认证走 `Authorization: Bearer <dk_…>`，body 无凭证字段；
   - Delivery：`packages/server/src/gateway/delivery.ts:17-41`
     （`loop.agent` 线上可选——老 server 不发，daemon 默认 claude-code）；
   - report 请求体：`packages/daemon/src/runner.ts` `ReportBody` +
     `gateway/index.ts:1291-1316`——`runId` 是回声（租约为准）；
     `outcome` 仅 `direct|silent|exec|evolve` 可上报，`error`/`skipped` 由 server 派生；
     **`status`/`state` 不在此 body**（属 in-run CLI `loopany report` 动词，后续阶段）；
   - report 响应：`{ok:true}`，reconcile 分支附 `reconciled:true`（对应 ADR-001 T5）；
   - 凭证形状：`gateway/tokens.ts:27-50`（`dk_`/`rk_` 前缀、宽松字符集合法）。
   唯一的非镜像字段：`errors.ts` 的 `code?`——经典 machine 路由线上只返回
   `{error}`，`code` 是为编程化调用方预留的可选 slug（对齐 CLI transport 的
   TOON `code:` 惯例），additive optional，老读者剥离它无影响。
4. **caps/裁剪策略不进 protocol**（`WIRE_TEXT_CAP`/`clipText`/条目上限是 server 侧
   策略，且参考实现 server 会对入站再做裁剪）。protocol 只承载形状与枚举。
   例外（有意收紧，记录于此）：基础值域约束 `int`/`nonnegative`（progress.step、
   cost 各 token 计数、durationMs、attempts）——参考 wire 是普通 number，schema
   略严于它；真实 daemon 载荷恒满足，收紧只为让畸形数据在边界即拒。
5. **主入口保持纯净**（无 node 内建依赖，可被浏览器 bundle 引用——server 的
   TanStack client 会引用枚举/类型）；`sha256`/`machineIdFromToken` 放子路径
   `@loopzhb/protocol/node`（node:crypto）。
6. **镜像形状 ≠ 已支持语义**（2026-07-28 澄清，方案 B）。protocol/schema 逐字镜像
   参考 wire，意味着它会提前携带后续阶段的字段与枚举（Task File/workflow/cursor、
   artifacts/transcript/cost、evolve/edit role、grok、lease caps 等）。这些是
   **兼容形状预声明**，不是能力承诺：
   - 「Phase 1 实现最薄」严格指**行为实现最薄**，不指协议与存储形状最薄；
   - 字段或枚举已在 schema 中，不代表当前 server/daemon 已支持其业务语义；
   - handler 不得因为 schema 接受某字段/枚举就提前实现后期功能；
   - 「能解析 wire 形状」与「承诺语义兼容」是两个层次——能力开放由当前阶段的
     应用层 guard 和行为测试决定（如 Phase 1 的 trigger 路径只产出 `exec` role）。

## 后果

- server/daemon 的 wire 漂移在编译期或 schema 解析期暴露，不再靠纪律。
- 加字段的固定动作：改 protocol（可选字段）→ 发版 → 对端按需消费；测试钉住
  tolerant-reader 行为（未知键剥离）使该规则不会退化。
- 代价：多一个包的构建步骤（tsc → dist）；server/daemon 以 workspace 依赖引入。
- zod 版本策略：protocol 直接依赖 zod ^4；下游包如需自建 schema 应复用同一主版本。

## 修订记录

- 2026-07-28：新增决策 6「镜像形状 ≠ 已支持语义」。本次只是澄清镜像纪律与能力
  开放的关系，**没有收缩既有契约**——逐字镜像参考核心 wire 形状、字段/枚举
  只增不减的规则原样保留（方案 A「按当前阶段收缩形状」经评审否决：它会破坏
  镜像纪律、推翻 ADR-003 已接受的全量保留决策，且多数字段两个 phase 内就要
  加回）。
