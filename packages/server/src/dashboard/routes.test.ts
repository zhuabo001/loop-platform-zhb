/**
 * H-group (Phase 4 Batch 3 slice 2): the Dashboard's HTTP surface and its
 * security boundary.
 *
 * H2  dynamic text/attribute escaping over the wire + action encoding
 * H3  security headers on EVERY dashboard response, CSP hash of the rendered
 *     <style> bytes, zero-JS/meta-refresh invariants kept
 * H4  CSRF and form edges (403/400/415/413) — all with ZERO writes
 * H5  instance isolation (one token never authorises another instance)
 * H6  every business outcome is 303 Location: /, exceptions are a fixed 500,
 *     and slice 2's temporary supersede semantics are pinned explicitly
 * H7  the loopback Host gate (DNS rebinding), on both the HTML routes and the
 *     JSON API, unit-driven AND over a real listener
 *
 * `H-group (Batch 3 Dashboard HTTP)` disambiguates these ids from any other
 * H-prefixed block; the JSON API's own (status, code) taxonomy stays pinned in
 * http/app.test.ts and must NOT gain dashboard statuses.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopAdmin, type LoopAdmin } from "../admin/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { runs } from "../db/schema.js";
import { createLifecycleAdmin } from "../loop-lifecycle/admin.js";
import { createOwnerControl } from "../owner/index.js";
import { createScheduleAdmin } from "../schedule/index.js";
import { waitForListening } from "../start.js";
import { FakeClock, seedLoop, seedRun } from "../testkit/index.js";
import { createServerApp } from "../http/app.js";
import { createDashboardRead, type DashboardRead } from "./index.js";
import { dashboardCsp } from "./routes.js";
import { createDashboardRoutes, type DashboardRoutes } from "./routes.js";
import type { EnqueueExecRunResult } from "../store/runs.js";

const TOKEN_A = "token-instance-a";
const TOKEN_B = "token-instance-b";
const FORM = "application/x-www-form-urlencoded";

const handles: DbHandle[] = [];
const servers: ServerType[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let admin: LoopAdmin;
let coordinator: RunCoordinator;
let read: DashboardRead;
let app: ReturnType<typeof createServerApp>;
let enqueueCalls: string[];

/** Per-test override seams for the two failure paths H6 needs. */
interface FreshOptions {
  enqueue?: (loopId: string) => Promise<EnqueueExecRunResult>;
  read?: DashboardRead;
  csrfToken?: string;
}

/** Build an app WITHOUT the dashboard (the pre-Batch-3 shape), for the
 *  "unmounted 404 is indistinguishable" assertions. */
function appWithoutDashboard(): ReturnType<typeof createServerApp> {
  return createServerApp(
    coordinator,
    admin,
    createLifecycleAdmin({ db, clock }),
    createScheduleAdmin({ db, clock }),
    createOwnerControl({ db, clock }),
  );
}

function buildApp(options: FreshOptions & { csrfToken: string }): ReturnType<typeof createServerApp> {
  const routes: DashboardRoutes = createDashboardRoutes({
    read: options.read ?? read,
    enqueue:
      options.enqueue ??
      ((loopId) => {
        enqueueCalls.push(loopId);
        // The SAME policy start.ts wires (Batch 3 切片三): a test seam that
        // kept the default would let every H-group assertion below pass while
        // production superseded — the exact drift mount.test.ts also guards.
        return coordinator.enqueueExecRun(loopId, { kind: "manual", pendingPolicy: "skip" });
      }),
    csrfToken: options.csrfToken,
  });
  return createServerApp(
    coordinator,
    admin,
    createLifecycleAdmin({ db, clock }),
    createScheduleAdmin({ db, clock }),
    createOwnerControl({ db, clock }),
    undefined,
    routes,
  );
}

async function fresh(options: FreshOptions = {}): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  let n = 0;
  admin = createLoopAdmin({ db, clock, newLoopId: () => `loop-${++n}` });
  coordinator = createRunCoordinator({
    db,
    clock,
    newRunId: () => `run-${++n}`,
    mintRunCredential: () => `rk_${"0".repeat(32)}`,
  });
  read = createDashboardRead({ admin, db, clock });
  enqueueCalls = [];
  app = buildApp({ ...options, csrfToken: options.csrfToken ?? TOKEN_A });
}

/** Every gate test sets Host EXPLICITLY: Hono's app.request defaults the URL
 *  host to `localhost` and sends no Host header, so a case that forgot it
 *  would pass even if the gate always returned true. */
const LOOPBACK = { host: "127.0.0.1" };

function postForm(
  target: ReturnType<typeof createServerApp>,
  loopId: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    target.request(`/dashboard/loops/${encodeURIComponent(loopId)}/run`, {
      method: "POST",
      headers: { "content-type": FORM, host: "127.0.0.1", ...headers },
      body,
    }),
  );
}

const formBody = (token: string): string => `csrf=${encodeURIComponent(token)}`;

async function runRows(): Promise<{ id: string; phase: string; outcome: string | null }[]> {
  return db.select({ id: runs.id, phase: runs.phase, outcome: runs.outcome }).from(runs);
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe(dashboardCsp());
}

/** A raw HTTP/1.1 request with FULL control over the Host header — the only
 *  way to exercise the production path (app.request never sends one). */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("H-group (Batch 3 Dashboard HTTP): routes and security", () => {
  it("H2: escapes hostile data in the real response and percent-encodes the form action", async () => {
    await fresh();
    const hostileId = `a"/><script>alert(1)</script>`;
    await seedLoop(db, {
      id: hostileId,
      name: `<script>alert("name")</script>`,
      goal: `"><b>bold</b>`,
      taskFile: `/tmp/<img src=x onerror="alert(1)">.md`,
    });

    const res = await app.request("/", { headers: LOOPBACK });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");

    // The action is a path segment: percent-encoded, so no raw quote can
    // terminate the attribute and no second path segment can appear.
    const action = html.match(/action="([^"]*)"/)?.[1];
    expect(action).toBe(`/dashboard/loops/${encodeURIComponent(hostileId)}/run`);
    expect(action).not.toContain("<");
    expect(action).not.toContain('"');

    // No style attributes: CSP hashes never cover them.
    expect(html).not.toContain("style=");
  });

  it("H3: hashes the RENDERED <style> bytes and sets every header on every status", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });

    const ok = await app.request("/", { headers: LOOPBACK });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    const html = await ok.text();

    // Hash what the BROWSER hashes: the exact text between the tags. If the
    // template ever pads the interpolation, this fails instead of silently
    // un-styling the page.
    const styleBody = html.slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"));
    const digest = createHash("sha256").update(styleBody).digest("base64");
    expect(ok.headers.get("content-security-policy")).toContain(`style-src 'sha256-${digest}'`);

    // The zero-JS, self-refreshing document survives slice 2.
    expect(html).toContain('<meta http-equiv="refresh" content="3">');
    expect(html).not.toContain("<script");

    for (const res of [
      ok,
      await postForm(app, "loop-1", formBody(TOKEN_A)),
      await postForm(app, "loop-1", formBody("wrong")),
      await postForm(app, "loop-1", "csrf=a&extra=1"),
      await postForm(app, "loop-1", formBody(TOKEN_A), { "content-type": "application/json" }),
      await postForm(app, "loop-1", `csrf=${"x".repeat(5000)}`),
      await postForm(app, "loop-missing", formBody(TOKEN_A)),
    ]) {
      expectSecurityHeaders(res);
    }
  });

  it("H4: verifies the token before anything else and never writes on a reject", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });

    // The happy path, driven by the action the PAGE rendered (closes the
    // encode → register → decode loop).
    const html = await (await app.request("/", { headers: LOOPBACK })).text();
    const renderedAction = html.match(/action="([^"]*)"/)![1]!;
    const renderedToken = html.match(/name="csrf" value="([^"]*)"/)![1]!;
    expect(renderedAction).toBe("/dashboard/loops/loop-1/run");
    const accepted = await app.request(renderedAction, {
      method: "POST",
      headers: { "content-type": FORM, host: "127.0.0.1" },
      body: formBody(renderedToken),
    });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/");
    expect(enqueueCalls).toEqual(["loop-1"]);

    const before = await runRows();
    expect(before).toHaveLength(1);

    const rejects: [string, Response][] = [
      ["missing token (empty body)", await postForm(app, "loop-1", "")],
      ["duplicate token", await postForm(app, "loop-1", `csrf=${TOKEN_A}&csrf=${TOKEN_A}`)],
      ["same-length wrong token", await postForm(app, "loop-1", formBody("token-instance-X"))],
      ["different-length token", await postForm(app, "loop-1", formBody("short"))],
      ["empty token", await postForm(app, "loop-1", "csrf=")],
      ["token in the query string only", await app.request(`/dashboard/loops/loop-1/run?csrf=${TOKEN_A}`, {
        method: "POST",
        headers: { "content-type": FORM, host: "127.0.0.1" },
        body: "",
      })],
      ["token in a header only", await postForm(app, "loop-1", "", { "x-csrf-token": TOKEN_A })],
    ];
    for (const [label, res] of rejects) {
      expect([label, res.status]).toEqual([label, 403]);
      expect(await res.text()).not.toContain(TOKEN_A);
    }

    // 400: the body is not our single-field form — a stray field, a bad
    // percent escape, or an invalid UTF-8 sequence (all malformed, none of
    // them a "wrong token").
    expect((await postForm(app, "loop-1", "csrf=a&extra=1")).status).toBe(400);
    expect((await postForm(app, "loop-1", "other=1")).status).toBe(400);
    for (const corrupt of ["csrf=%", "csrf=%GG", "csrf=%C3%28"]) {
      expect([corrupt, (await postForm(app, "loop-1", corrupt)).status]).toEqual([corrupt, 400]);
    }

    // 415: not an URL-encoded form (parameters are tolerated when present).
    expect((await postForm(app, "loop-1", "", { "content-type": "application/json" })).status).toBe(415);
    expect((await postForm(app, "loop-1", "", { "content-type": "multipart/form-data; boundary=x" })).status).toBe(415);
    const noContentType = await app.request("/dashboard/loops/loop-1/run", {
      method: "POST",
      headers: { host: "127.0.0.1" },
      body: "",
    });
    expect(noContentType.status).toBe(415);

    // The 4 KiB cap: 4096 bytes is judged as a form (400), 4097 never is (413).
    const atCap = `csrf=${"x".repeat(4096 - "csrf=".length)}`;
    expect(atCap).toHaveLength(4096);
    expect((await postForm(app, "loop-1", atCap)).status).toBe(403);
    expect((await postForm(app, "loop-1", `${atCap}x`)).status).toBe(413);

    // A GET on the write path is not a route at all.
    expect((await app.request("/dashboard/loops/loop-1/run", { headers: LOOPBACK })).status).toBe(404);

    // Every reject above left the database exactly as the happy path did.
    expect(await runRows()).toEqual(before);

    // Only now the one non-reject left: a charset parameter is tolerated
    // (browsers may add one), so the request REACHES the handler. 303 rather
    // than 415 is what proves the media type was accepted — and under Batch 3
    // 切片三 it also finds run-1 still pending, so the skip policy answers 303
    // with ZERO writes (slice 2 pinned the opposite: a supersede).
    const withCharset = await postForm(app, "loop-1", formBody(TOKEN_A), { "content-type": `${FORM}; charset=UTF-8` });
    expect(withCharset.status).toBe(303);
    expect(await runRows()).toEqual(before);
  });

  it("H5: a token from one instance never authorises another", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });
    const other = buildApp({ csrfToken: TOKEN_B });

    expect((await postForm(other, "loop-1", formBody(TOKEN_A))).status).toBe(403);
    expect((await postForm(app, "loop-1", formBody(TOKEN_B))).status).toBe(403);
    expect(await runRows()).toEqual([]);
    // Each instance accepts its own.
    expect((await postForm(other, "loop-1", formBody(TOKEN_B))).status).toBe(303);
  });

  it("H6: maps every business outcome to 303 / and a throw to a fixed 500", async () => {
    await fresh();
    await seedLoop(db, { id: "idle" });
    await seedLoop(db, { id: "completed", goal: "g", completedAt: "2026-07-01T00:00:01.000Z", completionReason: "done", enabled: false });
    await seedLoop(db, { id: "busy" });
    await seedRun(db, { id: "run-running", loopId: "busy", phase: "running" });

    for (const [label, loopId] of [["created", "idle"], ["unknown loop", "nope"], ["completed", "completed"], ["already running", "busy"]] as const) {
      const res = await postForm(app, loopId, formBody(TOKEN_A));
      expect([label, res.status, res.headers.get("location")]).toEqual([label, 303, "/"]);
    }
    // Only the idle loop wrote (one pending exec run); running, completed and
    // unknown all left the database alone.
    expect((await runRows()).map((r) => r.id).sort()).toEqual(["run-1", "run-running"]);
    expect(enqueueCalls).toEqual(["idle", "nope", "completed", "busy"]);

    // A reason the union does not have today is still a business outcome, not
    // an error: the route folds EVERY non-throwing result into 303.
    const future = buildApp({
      csrfToken: TOKEN_A,
      // Deliberately not a member of today's union — that is the point.
      enqueue: async () => ({ enqueued: false, reason: "some_future_reason" }) as unknown as EnqueueExecRunResult,
    });
    expect((await postForm(future, "idle", formBody(TOKEN_A))).status).toBe(303);

    // Batch 3 切片三, FLIPPED from slice 2's pinned temporary behaviour: the
    // Dashboard never supersedes. With run-1 AND run-pending both pending the
    // click is a zero-write `pending_exists` — both rows stay pending, the
    // running one is untouched, and no replacement run is ever created.
    await seedRun(db, { id: "run-pending", loopId: "idle", phase: "pending" });
    expect((await postForm(app, "idle", formBody(TOKEN_A))).status).toBe(303);
    expect((await runRows()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "run-1", phase: "pending", outcome: null },
      { id: "run-pending", phase: "pending", outcome: null },
      { id: "run-running", phase: "running", outcome: null },
    ]);

    // A throw is never disguised as success — and its message never reaches
    // the wire.
    const boom = buildApp({
      csrfToken: TOKEN_A,
      enqueue: async () => {
        throw new Error("pg connection failed: secret-token-abc");
      },
    });
    const failed = await postForm(boom, "idle", formBody(TOKEN_A));
    expect(failed.status).toBe(500);
    expect(failed.headers.get("location")).toBeNull();
    const body = await failed.text();
    expect(body).toBe('{"error":"internal server error"}');
    expect(body).not.toContain("secret-token-abc");
    expectSecurityHeaders(failed);

    const readBoom = buildApp({
      csrfToken: TOKEN_A,
      read: {
        snapshot: async () => {
          throw new Error("db exploded: secret-token-xyz");
        },
      },
    });
    const pageFailed = await readBoom.request("/", { headers: LOOPBACK });
    expect(pageFailed.status).toBe(500);
    expect(await pageFailed.text()).not.toContain("secret-token-xyz");
  });

  it("H8: the rendered button state and the backend outcome agree on every state", async () => {
    await fresh();
    await seedLoop(db, { id: "idle" });
    await seedLoop(db, { id: "paused", enabled: false });
    await seedLoop(db, {
      id: "completed",
      goal: "g",
      completedAt: "2026-07-01T00:00:01.000Z",
      completionReason: "done",
      enabled: false,
    });
    await seedLoop(db, { id: "busy" });
    await seedRun(db, { id: "r-run", loopId: "busy", phase: "running" });
    await seedLoop(db, { id: "queued" });
    await seedRun(db, { id: "r-pend", loopId: "queued", phase: "pending" });

    const html = await (await app.request("/", { headers: LOOPBACK })).text();
    /** The <button>…</button> inside THIS loop's form — disabled or not. */
    const button = (loopId: string): string => {
      const form = html.slice(html.indexOf(`action="/dashboard/loops/${loopId}/run"`));
      const open = form.indexOf("<button");
      return form.slice(open, form.indexOf("</button>", open) + "</button>".length);
    };

    // The two rules are written in different modules (view.ts vs store/runs.ts)
    // and read different sources (the page snapshot vs the live transaction),
    // so this is the test that keeps 「按钮规则与后端规则一致」 true.
    const cases = [
      ["idle", true],
      // Paused-but-not-completed: a manual trigger deliberately bypasses the
      // enablement check (ADR-008), so the button stays available.
      ["paused", true],
      ["completed", false],
      ["busy", false],
      ["queued", false],
    ] as const;

    const before = await runRows();
    for (const [loopId, writable] of cases) {
      expect([loopId, button(loopId).includes("disabled")]).toEqual([loopId, !writable]);
      // A disabled button's POST still redirects — the page never reports a
      // result it cannot verify — but writes nothing.
      expect([loopId, (await postForm(app, loopId, formBody(TOKEN_A))).status]).toEqual([loopId, 303]);
    }

    const after = await db.select({ id: runs.id, loopId: runs.loopId, phase: runs.phase }).from(runs);
    const created = after.filter((row) => !before.some((old) => old.id === row.id));
    expect(created.map((row) => row.loopId).sort()).toEqual(["idle", "paused"]);
    // …and nothing was canceled on the way.
    expect(after.filter((row) => row.phase === "canceled")).toEqual([]);

    // The reason is TEXT, never colour alone.
    expect(html).toContain("已有 Pending Run");
    expect(html).toContain("已有 Running Run");
    expect(html).toContain("Loop 已完成");

    // Staleness: the page lives up to one meta-refresh (3s) behind, so the
    // button it rendered for `idle` still says "available" while the loop now
    // HAS a pending run. The backend is the authority — that click is a
    // zero-write skip, never a replacement.
    expect(button("idle")).toBe('<button type="submit">Run Now</button>');
    const settled = await runRows();
    expect((await postForm(app, "idle", formBody(TOKEN_A))).status).toBe(303);
    expect(await runRows()).toEqual(settled);
  });

  it("H7: gates every route on a loopback Host, and forwarded headers cannot flip it", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });

    // The unmounted shape this must be indistinguishable from.
    const unmounted = appWithoutDashboard();
    const unmounted404 = await unmounted.request("/nope", { headers: LOOPBACK });

    const hostile = [
      "127.0.0.1.evil.com",
      "evil.com",
      "evil.com:3000",
      "localhost.",
      "evil.com@127.0.0.1",
      "",
    ];
    for (const host of hostile) {
      const page = await app.request("/", { headers: { host } });
      expect([host, page.status]).toEqual([host, 404]);
      expect(await page.text()).toBe(await unmounted404.clone().text());

      const post = await postForm(app, "loop-1", formBody(TOKEN_A), { host });
      expect([host, post.status]).toEqual([host, 404]);
    }
    // Absolute-form request line (URL host ≠ Host header): both must be
    // loopback, so a loopback Host cannot rescue a hostile URL.
    expect((await app.request("http://evil.com/", { headers: LOOPBACK })).status).toBe(404);

    // ORDERING: the gate is registered before the 4 KiB body cap, so an
    // oversized hostile request is a 404 — a 413 here would tell the attacker
    // the route exists.
    const oversizedHostile = await postForm(app, "loop-1", `csrf=${"x".repeat(5000)}`, { host: "evil.com" });
    expect(oversizedHostile.status).toBe(404);

    // Forwarded headers are not consulted in either direction.
    expect((await app.request("/", { headers: { host: "evil.com", "x-forwarded-host": "127.0.0.1" } })).status).toBe(404);
    expect((await app.request("/", { headers: { host: "127.0.0.1", "x-forwarded-host": "evil.com" } })).status).toBe(200);

    // Loopback forms that MUST pass (IPv6 bracket form included).
    for (const host of ["127.0.0.1", "127.0.0.1:3000", "localhost", "localhost:3000", "[::1]:3000"]) {
      expect([host, (await app.request("/", { headers: { host } })).status]).toEqual([host, 200]);
    }

    // The gate covers the JSON API too — that is the point: a rebinding
    // attacker reads /api/loops first, then triggers blind.
    expect((await app.request("http://evil.com/api/loops", { headers: LOOPBACK })).status).toBe(404);
    const apiTrigger = await app.request("http://evil.com/api/loops/loop-1/run", {
      method: "POST",
      headers: { "content-type": "text/plain", host: "evil.com" },
      body: "",
    });
    expect(apiTrigger.status).toBe(404);
    expect(await runRows()).toEqual([]);
    expect(enqueueCalls).toEqual([]);
    // …while a loopback Host still reaches the API unchanged.
    expect((await app.request("/api/loops", { headers: LOOPBACK })).status).toBe(200);

    // REAL listener: app.request never sends a Host header, so this is the
    // only case that proves the production path.
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    await waitForListening(server);
    const port = (server.address() as AddressInfo).port;

    const realHostile = await rawRequest(port, "/", { Host: "evil.com" });
    expect(realHostile.status).toBe(404);
    const realHostileApi = await rawRequest(port, "/api/loops", { Host: "evil.com" });
    expect(realHostileApi.status).toBe(404);
    const realHostilePost = await rawRequest(
      port,
      "/dashboard/loops/loop-1/run",
      { Host: "evil.com", "Content-Type": FORM, "Content-Length": String(formBody(TOKEN_A).length) },
      "POST",
      formBody(TOKEN_A),
    );
    expect(realHostilePost.status).toBe(404);
    expect(await runRows()).toEqual([]);

    const realLoopback = await rawRequest(port, "/", { Host: `127.0.0.1:${port}` });
    expect(realLoopback.status).toBe(200);
    expect(realLoopback.body).toContain("Loop Dashboard");
  });
});
