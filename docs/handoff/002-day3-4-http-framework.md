# Handoff：Day 3–4 HTTP 框架选型（Hono vs 裸 node http）

> 日期：2026-07-28 ｜ 状态：**已定（2026-07-28）：Hono**（`hono` + `@hono/node-server`）
> 范围：Day 3–4 只需要 `POST /machine/poll` + `POST /machine/report` 两个端点，
> 但这个选择会影响 Phase 1 后续（`POST /loops`、`POST /loops/:id/run`）和
> Phase 4 的 Dashboard API，所以值得单独留一份决策记录。

---

## 一句话结论

**Hono**（`hono` + `@hono/node-server`），2026-07-28 由 owner 拍板。下方的对比
材料保留为决策依据。

## Hono 是什么

Hono 是一个非常薄的 Web 框架——本质是在 Node 原生 `http` 之上包了一层
"路由 + 请求/响应封装"，薄到常被称为"带路由的 fetch API"。

- API 就是 Web 标准的 `fetch` 模型（Request/Response），学完 Hono 约等于学会标准本身。
- 本体约 14KB，运行时零依赖，Cloudflare 系出身，生产使用广泛、维护活跃。
- 内置：路径路由（含 `:id` 参数）、JSON 解析/响应、中间件机制、`app.onError` 错误兜底。

## 同一个端点的两种写法

裸 node http（Node 自带，零第三方依赖）：

```ts
import http from "node:http";

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/machine/poll") {
    let raw = "";
    for await (const chunk of req) raw += chunk;   // 自己拼流 + 自己计数截断(2MB cap)
    let body;
    try {
      body = JSON.parse(raw);                       // 自己 try/catch 防炸
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    // ... 业务逻辑（gateway）
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }
  res.writeHead(404).end();
});
```

Hono：

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

app.post("/api/machine/poll", async (c) => {
  const body = await c.req.json();   // body 解析内置
  // ... 业务逻辑（gateway）
  return c.json(result);              // JSON 响应内置
});

serve({ fetch: app.fetch, port: 3000 });
```

## 逐项对比（放在本项目的场景里）

| 维度 | 裸 http | Hono |
|---|---|---|
| 第三方依赖 | 零 | 一个小包（`hono` + `@hono/node-server`） |
| 路由 | 手写 if/else 匹配，端点多了变丑 | 声明式，白送 |
| body 解析 + 2MB wire cap | 手写读流 + 计数截断 | `c.req.json()` + 一个中间件 |
| handler 抛异常 → 500 兜底 | 手写全局 try/catch | `app.onError` 一处搞定 |
| 与 protocol 包 zod 校验配合 | 一样（解析后都过 schema） | 一样 |
| Phase 1 后续端点（loops CRUD 等） | 路由表需自己维护 | 自然扩展 |
| Phase 4 Dashboard API | 大概率被迫重写成"自制破框架" | 直接继续用 |
| 测试方式 | 起真端口 或 手搓 req/res mock | `app.fetch(request)` 直接打，免端口 |
| 学习成本 | 零（已在用 Node） | 约半小时 |

## 推荐理由

1. **端点会持续增长**。Day 3–4 只有 2 个，但 Phase 1 还有 `POST /loops` /
   `POST /loops/:id/run`，Phase 4 是整个 Dashboard API。裸 http 的手写路由迟早
   要重写成"自己发明的框架"，那是典型的浪费时间。
2. **不污染心脏**。Hono 足够薄，不会把框架魔法带进核心逻辑——gateway/store
   仍然是纯函数 + 注入式写法，HTTP 层只做解析和返回，符合架构纪律
   "HTTP route 只负责解析与返回"。
3. **安全边界用成熟实现更稳**。body cap、异常兜底这类安全相关的代码，
   手写容易留洞（比如忘记截断读流 = 内存攻击面）。
4. **测试更顺手**。`app.fetch(new Request(...))` 直接在进程内打完整 HTTP 层，
   T1–T3 心脏测试不需要起真端口。

选裸 http 的唯一理由是"零依赖洁癖"，但对一个注定长到 Dashboard 的项目，
这个洁癖的代价随时间递增。

## 决策后如何开工（无论选哪个都不变的部分）

按 ADR-001 纪律，**先写心脏测试 T1–T3，再写实现**：

1. T1：并发 claim 唯一（两个 poll 同时到，只有一个拿到 Run）
2. T2：重复 poll 不重复执行（同一 daemon 重复 poll，不重复发同一个 Run）
3. T3：重复 report 效果幂等——第一次 report 200 落库、lease retire；第二次
   report 在 resolve lease 处 **401**；Run/Loop 状态与全部副作用完全不变

**事务边界**（2026-07-28 ADR-003 定型，先于一切实现顺序；前两条是有意的参考
偏离）：

- claim（pending→running）+ lease INSERT：同一事务——禁止 running Run 无 lease；
- report finalize + lease DELETE：同一事务；
- owner cancel（Run→canceled）+ lease DELETE：同一事务；
- report 与 cancel 在各自事务中锁定同一 Run 行（或使用覆盖整个写入区间的 CAS），
  再检查 phase 并进行任何 Loop 级写入（防"先 resolve、cancel 后提交"竞态）。

**能力 guard 测试**：cancel 后 run-token 的一切写操作失效（Phase 1 的 run-token
表面只有 report；控制动词随其阶段落地时继承此规则）；Phase 1 的 trigger 路径
只产出 `exec` role（ADR-002 决策 6：预声明形状 ≠ 已支持语义）。

随后才是 store 层（`claimPendingRun` 等）→ gateway（claim → mint lease →
buildDelivery；report 按 `run.phase` 分支）→ HTTP 层（本决策的落点）。

如果选了 Hono，T1–T3 直接用 `app.fetch` 打实例；如果选裸 http，建议把
handler 写成 `(req, res) => void` 的纯函数，测试里用 mock req/res。

**Hono / 裸 HTTP / TanStack Start 的选择不影响以上任何核心语义**——它们是
store/gateway 层的契约，HTTP 层只做解析与返回。

## 备选：什么时候重新评估 TanStack Start

TanStack Start（参考实现用的全栈框架）留到 **Phase 4（第 7–8 周）Dashboard** 再评估。
届时如果决定上它，Phase 1 的 Hono 路由可以平移成 server 函数/路由文件，
心脏逻辑（store/gateway/protocol）不受影响——它们本来就没有 HTTP 依赖。
