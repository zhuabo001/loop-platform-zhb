/**
 * Jail pins (plan J1–J25). The jail is a cwd-SELECTION boundary, not runtime
 * filesystem confinement (batch 3's OS sandbox owns that). The fixture base
 * is realpath'd up front because macOS tmpdir() is itself behind a symlink
 * (/var → /private/var), and the jail speaks only canonical paths.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkdirJail, JailError } from "./jail.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-jail-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const scratchBase = (): string => path.join(base, "scratch");

describe("createWorkdirJail — root canonicalization", () => {
  it("J1: rejects a non-existent root and an empty roots array", async () => {
    await expect(
      createWorkdirJail({ allowedRoots: [path.join(base, "missing")], scratchBase: scratchBase() }),
    ).rejects.toThrow(JailError);
    await expect(createWorkdirJail({ allowedRoots: [], scratchBase: scratchBase() })).rejects.toThrow(JailError);
  });

  it("J2: rejects a root that is a file, not a directory", async () => {
    const file = path.join(base, "a-file");
    writeFileSync(file, "x");
    await expect(createWorkdirJail({ allowedRoots: [file], scratchBase: scratchBase() })).rejects.toThrow(
      JailError,
    );
  });

  it("J3: rejects relative roots", async () => {
    for (const bad of ["relative/dir", "./also-relative", ""]) {
      await expect(createWorkdirJail({ allowedRoots: [bad], scratchBase: scratchBase() }), bad).rejects.toThrow(
        JailError,
      );
    }
  });

  it("J4: rejects roots containing .. segments", async () => {
    const withDotDot = path.join(base, "sub", "..", "other");
    await expect(createWorkdirJail({ allowedRoots: [withDotDot], scratchBase: scratchBase() })).rejects.toThrow(
      JailError,
    );
  });

  it("J5: canonicalizes and dedupes roots (symlink aliases collapse)", async () => {
    const real = path.join(base, "real-root");
    mkdirSync(real);
    const alias = path.join(base, "alias-root");
    symlinkSync(real, alias, "dir");
    const jail = await createWorkdirJail({
      allowedRoots: [real, alias, real],
      scratchBase: scratchBase(),
    });
    expect(jail.daemonRoots).toEqual([realpathSync(real)]);
  });
});

describe("resolve — daemon ∩ server root intersection", () => {
  let daemonA: string;
  let daemonAChild: string;

  beforeEach(() => {
    daemonA = path.join(base, "daemon-a");
    daemonAChild = path.join(daemonA, "child");
    mkdirSync(daemonAChild, { recursive: true });
  });

  const resolveWith = (
    jail: Awaited<ReturnType<typeof createWorkdirJail>>,
    workdir: string,
    serverRoots: string[],
  ) => jail.resolve({ workdir, serverRoots, loopId: "loop-1", runId: "run-1" });

  it("J14: a server root INSIDE a daemon root narrows to the server root", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchBase: scratchBase() });
    const resolved = await resolveWith(jail, daemonAChild, [daemonAChild]);
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonAChild)]);
  });

  it("J15: a server root CONTAINING a daemon root narrows to the daemon root", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchBase: scratchBase() });
    const resolved = await resolveWith(jail, daemonA, [base]); // base ⊃ daemonA
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonA)]);
  });

  it("J16: fully disjoint server roots → JailError (no permitted workdir)", async () => {
    const disjoint = path.join(base, "disjoint");
    mkdirSync(disjoint);
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchBase: scratchBase() });
    await expect(resolveWith(jail, daemonA, [disjoint])).rejects.toThrow(JailError);
  });

  it("J17: empty server roots impose no narrowing; cwd realpaths, scratchDir stays null", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchBase: scratchBase() });
    const resolved = await resolveWith(jail, daemonA, []);
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonA)]);
    expect(resolved.cwd).toBe(realpathSync(daemonA));
    expect(resolved.scratchDir).toBeNull();
  });

  it("J18: missing, non-directory and relative server roots → JailError (never trusted pre-normalized)", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchBase: scratchBase() });
    await expect(resolveWith(jail, daemonA, [path.join(base, "missing")])).rejects.toThrow(JailError);
    const file = path.join(base, "srv-file");
    writeFileSync(file, "x");
    await expect(resolveWith(jail, daemonA, [file])).rejects.toThrow(JailError);
    await expect(resolveWith(jail, daemonA, ["relative/srv"])).rejects.toThrow(JailError);
  });

  it("J19: intersection dedupes and drops children already covered by a parent root", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA, daemonAChild], scratchBase: scratchBase() });
    const resolved = await resolveWith(jail, daemonAChild, [daemonA]);
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonA)]);
  });
});

describe("resolve — workdir boundary against effective roots", () => {
  let root: string;

  beforeEach(() => {
    root = path.join(base, "root");
    mkdirSync(root);
  });

  const jail = () => createWorkdirJail({ allowedRoots: [root], scratchBase: scratchBase() });
  const resolveWith = (j: Awaited<ReturnType<typeof jail>>, workdir: string) =>
    j.resolve({ workdir, serverRoots: [], loopId: "loop-1", runId: "run-1" });

  it("J6: the effective root itself is a valid workdir", async () => {
    const resolved = await resolveWith(await jail(), root);
    expect(resolved.cwd).toBe(realpathSync(root));
    expect(resolved.scratchDir).toBeNull();
  });

  it("J7: a subdirectory of an effective root is a valid workdir", async () => {
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    const resolved = await resolveWith(await jail(), sub);
    expect(resolved.cwd).toBe(realpathSync(sub));
  });

  it("J8: a similar-prefix sibling (/root vs /root-sibling) is REJECTED", async () => {
    const sibling = path.join(base, "root-sibling");
    mkdirSync(sibling);
    await expect(resolveWith(await jail(), sibling)).rejects.toThrow(JailError);
  });

  it("J9: a .. escape attempt is REJECTED (containment after realpath)", async () => {
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    await expect(resolveWith(await jail(), path.join(root, "..", "outside"))).rejects.toThrow(JailError);
  });

  it("J10: a symlink pointing INSIDE the roots is allowed", async () => {
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    const link = path.join(root, "link-inside");
    symlinkSync(sub, link, "dir");
    const resolved = await resolveWith(await jail(), link);
    expect(resolved.cwd).toBe(realpathSync(sub));
  });

  it("J11: a symlink pointing OUTSIDE the roots is REJECTED", async () => {
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    const link = path.join(root, "link-outside");
    symlinkSync(outside, link, "dir");
    await expect(resolveWith(await jail(), link)).rejects.toThrow(JailError);
  });

  it("J12: a non-existent workdir is REJECTED with a JailError", async () => {
    await expect(resolveWith(await jail(), path.join(root, "missing"))).rejects.toThrow(JailError);
  });

  it("J13: a workdir that is a file is REJECTED", async () => {
    const file = path.join(root, "a-file");
    writeFileSync(file, "x");
    await expect(resolveWith(await jail(), file)).rejects.toThrow(JailError);
  });

  it("J9b: a relative workdir is REJECTED outright", async () => {
    await expect(
      (await jail()).resolve({ workdir: "relative/dir", serverRoots: [], loopId: "loop-1", runId: "run-1" }),
    ).rejects.toThrow(JailError);
  });
});

describe("resolve/release — per-run scratch lifecycle", () => {
  let root: string;
  let scratch: string;

  beforeEach(() => {
    root = path.join(base, "root");
    mkdirSync(root);
    scratch = scratchBase();
  });

  const jail = () => createWorkdirJail({ allowedRoots: [root], scratchBase: scratch });
  const resolveNull = (j: Awaited<ReturnType<typeof jail>>, runId: string) =>
    j.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId });

  it("J20: null workdir mints a per-run scratch dir inside an UNPREDICTABLE per-jail root (round-1 hardening)", async () => {
    await expect(createWorkdirJail({ allowedRoots: [root], scratchBase: "relative/scratch" })).rejects.toThrow(
      JailError,
    );
    const resolved = await resolveNull(await jail(), "run-1");
    expect(resolved.scratchDir).not.toBeNull();
    expect(resolved.cwd).toBe(resolved.scratchDir);
    expect(resolved.effectiveRoots).toEqual([realpathSync(root)]);
    expect(realpathSync(resolved.scratchDir!)).toBe(resolved.scratchDir); // exists & canonical
    // The direct parent is a per-jail mkdtemp root INSIDE the given base:
    // unpredictable (not pre-occupiable), 0700, named loopzhb-runs-*.
    const parent = path.dirname(resolved.scratchDir!);
    expect(path.dirname(parent)).toBe(realpathSync(scratch));
    expect(path.basename(parent)).toMatch(/^loopzhb-runs-/);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  it("J21: scratch dirs are unique per run and never reused; each jail gets its own scratch root", async () => {
    const j = await jail();
    const a = await resolveNull(j, "run-1");
    const b = await resolveNull(j, "run-2");
    const c = await resolveNull(j, "run-1"); // same runId: still a fresh dir
    const dirs = [a.scratchDir, b.scratchDir, c.scratchDir];
    expect(new Set(dirs).size).toBe(3);
    // Two jail instances (≈ two daemon starts) never share a scratch root —
    // a stale directory from an earlier start is never written into.
    const other = await jail();
    const d = await resolveNull(other, "run-1");
    expect(path.dirname(d.scratchDir!)).not.toBe(path.dirname(a.scratchDir!));
  });

  it("J22: scratch dir permissions are 0700", async () => {
    const resolved = await resolveNull(await jail(), "run-1");
    const { mode } = statSync(resolved.scratchDir!);
    expect(mode & 0o777).toBe(0o700);
  });

  it("J23: release() deletes the minted scratch dir; a double release throws", async () => {
    const j = await jail();
    const resolved = await resolveNull(j, "run-1");
    await j.release(resolved);
    expect(existsSync(resolved.scratchDir!)).toBe(false);
    await expect(j.release(resolved)).rejects.toThrow(JailError);
  });

  it("J24: release() on a scratch path swapped for a symlink throws and deletes NOTHING", async () => {
    const j = await jail();
    const resolved = await resolveNull(j, "run-1");
    const dir = resolved.scratchDir!;
    rmSync(dir, { recursive: true });
    const target = path.join(base, "sentinel-target");
    mkdirSync(target);
    writeFileSync(path.join(target, "sentinel.txt"), "must survive");
    symlinkSync(target, dir, "dir");
    await expect(j.release(resolved)).rejects.toThrow(JailError);
    expect(readFileSync(path.join(target, "sentinel.txt"), "utf8")).toBe("must survive");
  });

  it("J25: release() refuses dirs this jail did not mint (forged, non-direct-child, foreign)", async () => {
    const j = await jail();
    const forged = { cwd: "/", effectiveRoots: [], scratchDir: path.join(scratch, "forged-dir") };
    await expect(j.release(forged)).rejects.toThrow(JailError);
    const deep = { cwd: "/", effectiveRoots: [], scratchDir: path.join(scratch, "nested", "deep") };
    await expect(j.release(deep)).rejects.toThrow(JailError);
    const otherJail = await jail();
    const foreign = await resolveNull(otherJail, "run-9");
    await expect(j.release(foreign)).rejects.toThrow(JailError);
    // a non-scratch resolution has nothing to release: a documented no-op
    const plain = await j.resolve({ workdir: root, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    await expect(j.release(plain)).resolves.toBeUndefined();
  });
});

describe("revalidate — the pre-spawn re-check (Phase 2 batch 3, plan §2.2)", () => {
  let root: string;

  beforeEach(() => {
    root = path.join(base, "root");
    mkdirSync(root);
  });

  const jail = () => createWorkdirJail({ allowedRoots: [root], scratchBase: scratchBase() });

  it("S1: an unchanged workdir resolution revalidates cleanly", async () => {
    const j = await jail();
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    const resolved = await j.resolve({ workdir: sub, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    await expect(j.revalidate(resolved)).resolves.toBeUndefined();
  });

  it("S2: an unchanged scratch resolution revalidates cleanly", async () => {
    const j = await jail();
    const resolved = await j.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    await expect(j.revalidate(resolved)).resolves.toBeUndefined();
    await j.release(resolved); // revalidate does NOT consume the release obligation
  });

  it("S3: the cwd swapped for a symlink (even pointing INSIDE the roots) is rejected — the recorded canonical path must still resolve to itself", async () => {
    const j = await jail();
    const sub = path.join(root, "sub");
    const other = path.join(root, "other");
    mkdirSync(sub);
    mkdirSync(other);
    const resolved = await j.resolve({ workdir: sub, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    rmSync(sub, { recursive: true });
    symlinkSync(other, sub, "dir");
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });

  it("S4: a deleted cwd is rejected", async () => {
    const j = await jail();
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    const resolved = await j.resolve({ workdir: sub, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    rmSync(sub, { recursive: true });
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });

  it("S5: the cwd swapped for a symlink pointing OUTSIDE the roots is rejected", async () => {
    const j = await jail();
    const sub = path.join(root, "sub");
    const outside = path.join(base, "outside");
    mkdirSync(sub);
    mkdirSync(outside);
    const resolved = await j.resolve({ workdir: sub, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    rmSync(sub, { recursive: true });
    symlinkSync(outside, sub, "dir");
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });

  it("S6: an effective root swapped for a symlink is rejected — the sandbox profile would otherwise alias the wrong tree", async () => {
    const j = await jail();
    const resolved = await j.resolve({ workdir: root, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(root, { recursive: true });
    symlinkSync(elsewhere, root, "dir");
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });

  it("S7: a deleted effective root is rejected", async () => {
    const j = await jail();
    const resolved = await j.resolve({ workdir: root, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    rmSync(root, { recursive: true });
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });

  it("S8: a scratch dir swapped for a symlink is rejected (lstat sees the swap)", async () => {
    const j = await jail();
    const resolved = await j.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    const dir = resolved.scratchDir!;
    rmSync(dir, { recursive: true });
    symlinkSync(root, dir, "dir");
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });

  it("S9: a deleted scratch dir is rejected — and a release()d resolution no longer revalidates", async () => {
    const j = await jail();
    const resolved = await j.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    rmSync(resolved.scratchDir!, { recursive: true });
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);

    const second = await j.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-2" });
    await j.release(second);
    await expect(j.revalidate(second)).rejects.toThrow(JailError);
  });

  it("S10: a cwd that became a FILE is rejected", async () => {
    const j = await jail();
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    const resolved = await j.resolve({ workdir: sub, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    rmSync(sub, { recursive: true });
    writeFileSync(sub, "x");
    await expect(j.revalidate(resolved)).rejects.toThrow(JailError);
  });
});
