/**
 * H1 + the production half of H5: the Dashboard's ASSEMBLY, driven through the
 * real composition root (`bootstrapServer`) rather than a hand-built app.
 *
 * H1  mount gating: a loopback bind serves the page, a non-loopback bind makes
 *     both routes vanish into the ordinary JSON 404 (byte-identical to any
 *     unknown path), and the JSON API keeps working either way
 * H5  the production CSRF token is minted per boot: a restart invalidates the
 *     token the previous instance handed out, and the new page's token works
 *
 * These are the tests that fail if `bootstrapServer` ever stops constructing
 * the Dashboard — the 7th argument to createServerApp is optional, so nothing
 * else would notice.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, type DbHandle } from "../db/index.js";
import { bootstrapServer, type BootedServer } from "../start.js";
import { makeTestAuthConfig, seedClaimedMachineById, seedLoop, seedRun, snapshotRuns } from "../testkit/index.js";

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

let seq = 0;
async function tmpDataDir(): Promise<string> {
  seq += 1;
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-dash-mount-${process.pid}-${seq}-`));
  dirs.push(dir);
  return dir;
}

async function boot(host: string, dataDir: string): Promise<BootedServer> {
  const booted = await bootstrapServer({ auth: makeTestAuthConfig(), host, port: 0, dataDir });
  handles.push(booted.handle);
  return booted;
}

const FORM = "application/x-www-form-urlencoded";

function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (match === null) throw new Error("no csrf field in the rendered page");
  return match[1]!;
}

/** The two facts every run assertion here needs, ordered by id (testkit's
 *  `snapshotRuns` order), so a snapshot compare is byte-exact. */
async function runPhases(handle: DbHandle): Promise<{ id: string; phase: string; outcome: string | null }[]> {
  return (await snapshotRuns(handle.db)).map((r) => ({ id: r.id, phase: r.phase, outcome: r.outcome }));
}

function postRun(app: BootedServer["app"], body: string): Promise<Response> {
  return Promise.resolve(
    app.request("/dashboard/loops/loop-1/run", {
      method: "POST",
      headers: { "content-type": FORM, host: "127.0.0.1" },
      body,
    }),
  );
}

describe("H-group (Batch 3 Dashboard mount): assembly through bootstrapServer", () => {
  it("H1: mounts on a loopback bind and disappears entirely on a non-loopback bind", async () => {
    const loopback = await boot("127.0.0.1", await tmpDataDir());
    const page = await loopback.app.request("/", { headers: { host: "127.0.0.1" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await page.text()).toContain("Loop Dashboard");
    // The write route exists too (403 = mounted but untokened, not 404).
    expect((await postRun(loopback.app, "")).status).toBe(403);

    const exposed = await boot("0.0.0.0", await tmpDataDir());
    const unknown = await exposed.app.request("/nope", { headers: { host: "127.0.0.1" } });
    expect(unknown.status).toBe(404);

    for (const res of [
      await exposed.app.request("/", { headers: { host: "127.0.0.1" } }),
      await postRun(exposed.app, ""),
    ]) {
      expect(res.status).toBe(404);
      // Byte-identical to any unknown path: a non-loopback bind must not
      // advertise that a Dashboard exists at all.
      expect(await res.text()).toBe(await unknown.clone().text());
      expect(res.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
      expect(res.headers.get("content-security-policy")).toBeNull();
    }

    // The JSON API is untouched on both binds.
    for (const booted of [loopback, exposed]) {
      const loops = await booted.app.request("/api/loops", { headers: { host: "127.0.0.1" } });
      expect(loops.status).toBe(200);
    }
  });

  it("H5: a restart mints a new token and the previous one stops working", async () => {
    const dataDir = await tmpDataDir();

    const first = await boot("127.0.0.1", dataDir);
    // The token rides on a card's form, so the page needs a loop to render.
    await seedLoop(first.handle.db, { id: "loop-1" });
    const firstToken = csrfFrom(await (await first.app.request("/", { headers: { host: "127.0.0.1" } })).text());
    expect(firstToken.length).toBeGreaterThanOrEqual(32);
    expect((await postRun(first.app, `csrf=${encodeURIComponent(firstToken)}`)).status).toBe(303);

    // Close the handle exactly once before re-opening the same data dir.
    await closeDb(first.handle);
    handles.splice(handles.indexOf(first.handle), 1);

    const second = await boot("127.0.0.1", dataDir);
    const secondToken = csrfFrom(await (await second.app.request("/", { headers: { host: "127.0.0.1" } })).text());
    expect(secondToken).not.toBe(firstToken);

    // The stale token is refused (and wrote nothing)…
    expect((await postRun(second.app, `csrf=${encodeURIComponent(firstToken)}`)).status).toBe(403);
    // …while the instance's own token still works.
    expect((await postRun(second.app, `csrf=${encodeURIComponent(secondToken)}`)).status).toBe(303);
  });

  it("H9: a second Run Now leaves the queued run alone — the skip policy is really assembled", async () => {
    const booted = await boot("127.0.0.1", await tmpDataDir());
    // The loop's machine must be execution-eligible (Phase 5 Batch 3 slice 3:
    // the enqueue boundary refuses orphan/unclaimed/revoked machines).
    await seedClaimedMachineById(booted.handle.db, "m-test");
    await seedLoop(booted.handle.db, { id: "loop-1" });
    const token = csrfFrom(await (await booted.app.request("/", { headers: { host: "127.0.0.1" } })).text());

    const first = await postRun(booted.app, `csrf=${encodeURIComponent(token)}`);
    expect(first.status).toBe(303);
    const afterFirst = await runPhases(booted.handle);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ phase: "pending", outcome: null });

    // THIS is the assertion that fails if `start.ts` ever drops the
    // `pendingPolicy: "skip"` argument: the type checker cannot see the
    // difference, and no other test drives the REAL composition root.
    const second = await postRun(booted.app, `csrf=${encodeURIComponent(token)}`);
    expect(second.status).toBe(303);
    expect(await runPhases(booted.handle)).toEqual(afterFirst);
  });
});

describe("slice 7 (决策 27): the artifact pages through the REAL composition root", () => {
  it("the loop artifact page serves, the config form round-trips, and the run page shows the missing state", async () => {
    const booted = await boot("127.0.0.1", await tmpDataDir());
    // The production attribution resolver reads the machines row — the loop's
    // machine must exist AND be claimed (Phase 5 Batch 3 slice 3: the
    // namespace is the owning Team) or every read is the 403.
    await seedClaimedMachineById(booted.handle.db, "m-test");
    await seedLoop(booted.handle.db, { id: "loop-1", machineId: "m-test", artifactDir: "/data/out" });
    await seedRun(booted.handle.db, { id: "run-1", loopId: "loop-1", machineId: "m-test", artifactSnapshotId: null });

    const pageRes = await booted.app.request("/dashboard/loops/loop-1/artifacts", {
      headers: { host: "127.0.0.1" },
    });
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain("/data/out");
    // run-1 is UNBOUND — it appears on its own snapshot page, not in the
    // bound-snapshot table.
    expect(html).toContain("尚无已绑定快照的 Run");
    expect(html).not.toContain("<script");
    const token = csrfFrom(html);

    // The config form saves through the SAME facade and redirects with the
    // outcome banner; following the redirect renders it.
    const saved = await booted.app.request("/dashboard/loops/loop-1/artifacts/config", {
      method: "POST",
      headers: { "content-type": FORM, host: "127.0.0.1" },
      body: `csrf=${encodeURIComponent(token)}&artifactDir=${encodeURIComponent("/data/moved")}`,
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/dashboard/loops/loop-1/artifacts?config=updated");
    const after = await booted.app.request(saved.headers.get("location")!, { headers: { host: "127.0.0.1" } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain("Artifact 目录已更新。");
    expect(afterHtml).toContain("/data/moved");

    // The unbound run's snapshot page is the explicit missing state.
    const runPage = await booted.app.request("/dashboard/loops/loop-1/artifacts/runs/run-1", {
      headers: { host: "127.0.0.1" },
    });
    expect(runPage.status).toBe(200);
    expect(await runPage.text()).toContain("未绑定 Artifact 快照");
  });

  it("on a non-loopback bind the artifact pages vanish into the ordinary 404", async () => {
    const exposed = await boot("0.0.0.0", await tmpDataDir());
    const unknown = await exposed.app.request("/nope", { headers: { host: "127.0.0.1" } });
    const page = await exposed.app.request("/dashboard/loops/loop-1/artifacts", {
      headers: { host: "127.0.0.1" },
    });
    expect(page.status).toBe(404);
    expect(await page.text()).toBe(await unknown.clone().text());
  });
});
