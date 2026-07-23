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
4. **caps/裁剪策略不进 protocol**（`WIRE_TEXT_CAP`/`clipText`/条目上限是 server 侧
   策略，且参考实现 server 会对入站再做裁剪）。protocol 只承载形状与枚举。
5. **主入口保持纯净**（无 node 内建依赖，可被浏览器 bundle 引用——server 的
   TanStack client 会引用枚举/类型）；`sha256`/`machineIdFromToken` 放子路径
   `@loopzhb/protocol/node`（node:crypto）。

## 后果

- server/daemon 的 wire 漂移在编译期或 schema 解析期暴露，不再靠纪律。
- 加字段的固定动作：改 protocol（可选字段）→ 发版 → 对端按需消费；测试钉住
  tolerant-reader 行为（未知键剥离）使该规则不会退化。
- 代价：多一个包的构建步骤（tsc → dist）；server/daemon 以 workspace 依赖引入。
- zod 版本策略：protocol 直接依赖 zod ^4；下游包如需自建 schema 应复用同一主版本。
